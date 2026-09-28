// Builds docs/index.html: the playground page with the compiled library inlined.
//
// ES modules do not load over file://, so a page that imports dist/ is neither
// double-clickable nor hostable without a server. Inlining the JavaScript into
// one <script> is what makes the page both, and it is the only reason this
// script exists. Run it through `./dev.sh playground`.
//
// The inlining is a flat concatenation, not a bundler. tsc emits one shape of
// module here — static single-line imports at the top, `export` on top-level
// declarations, no defaults, no cycles — so dropping the import lines and the
// `export` keywords and joining the files in dependency order gives one scope
// that behaves identically. The one thing that would break it silently is two
// modules declaring the same top-level name, so that is checked and refused.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const examples = join(root, 'examples');
const template = join(root, 'tools', 'playground.html');
// A path argument writes the page somewhere else, which is how `./dev.sh stale`
// compares a fresh build against the committed one.
const target = process.argv[2] ? resolvePath(process.argv[2]) : join(root, 'docs', 'index.html');

/**
 * What the page is allowed to reach: the pipeline, what it needs to report an
 * error, and the line scanner behind the editor's syntax coloring.
 */
const EXPOSED = ['compile', 'SourceError', 'highlightLine', 'THEME_NAMES', 'DEFAULT_THEME'];

// The examples the page offers, in the order its picker lists them. Every
// construct in the language is demonstrated by one of these files and by nothing
// else the page can reach, so leaving them out makes the playground a five-line
// demo. The list is stated rather than globbed: the order is the point (the
// benchmark first, then placement, appearance, edges), and a new file under
// examples/ is not automatically something a stranger should be handed.
//
// Each file is listed under the name a stranger sees, with one short sentence
// shown above its preview. The file names are coverage and are referred to
// elsewhere; these are for someone who has not read the syntax yet, and say what
// the picture shows. Keep the sentence to one line: the file's own opening
// comment is there for anyone who wants more.
const OFFERED = [
  ['arch', 'architecture', "A home network's file sync and backups, redrawn from a draw.io diagram."],
  ['regions', 'beside a group', 'A node placed against several others at once.'],
  ['gaps', 'gap sizes', 'Tight and wide gaps, and which one wins when both ends ask.'],
  ['snug', 'as close as allowed', 'A node sits as close to what it names as its placements allow.'],
  ['separation', 'no overlaps', 'Nodes never overlap, even where nothing says which way to move.'],
  ['contents', 'inside a container', 'How children line up in a container wider than they are.'],
  ['shapes', 'shapes', 'The outlines a node can be drawn with, and the pictures it can be drawn as.'],
  ['icons', 'icons', 'The seven icons, and the ways to use one.'],
  ['overlays', 'sides and corners', 'Nodes placed against part of another node: a side, a corner, or its text.'],
  ['frames', "on the parent's edge", "A child placed on its own container's side or corner."],
  ['text', 'edge labels', "An edge's text widens the gap it crosses."],
  ['lanes', 'nested edges', 'Edges between the same two sides nest instead of crossing.'],
  ['coincident', 'parallel edges', 'Several edges between the same two nodes stay parallel.'],
  ['corridors', 'through a gap', 'Edges sent through the gap between two named nodes.'],
  ['overhang', 'outside the nodes', 'Edges that run past the nodes, and the page grows to hold them.'],
  ['routing', 'going round boxes', 'Every routing bug reported so far, each line now going the shortest way round.'],
  ['lines', 'line styles', 'Curved, square and straight lines, dashes, and how crossings are drawn.'],
];

const IMPORT = /^import\s+[\s\S]*?\s+from\s+'([^']+)';$/gm;
const REEXPORT = /^export\s+(?:\*|\{[\s\S]*?\})\s+from\s+'([^']+)';$/gm;
const EMPTY_EXPORT = /^export\s*\{\s*\};$/gm;
// Every top-level declaration, exported or not. The `export` used to be
// required here, which left the check blind to exactly the collision it exists
// to catch: `SIDES` was exported from ast.ts and private in render.ts, the
// bundle threw `Identifier 'SIDES' has already been declared`, and the hosted
// playground drew nothing at all.
const DECLARATION = /^(?:export\s+)?(?:async\s+)?(function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm;

function read(name) {
  return readFileSync(join(dist, name), 'utf8');
}

/** Depth-first over the import graph, so a module is emitted after everything it uses. */
function order(entry) {
  const emitted = [];
  const seen = new Set();
  const open = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    if (open.has(name)) throw new Error(`import cycle at ${name} — flat concatenation cannot express it`);
    open.add(name);
    const source = read(name);
    // Re-exports count as edges too. index.js reaches most of the library
    // through `export * from`, and a module that nothing else happens to import
    // would otherwise be left out of the bundle with no complaint until the
    // page called something that was not there.
    for (const match of [...source.matchAll(IMPORT), ...source.matchAll(REEXPORT)]) {
      visit(match[1].replace(/^\.\//, ''));
    }
    open.delete(name);
    seen.add(name);
    emitted.push([name, source]);
  };
  visit(entry);
  return emitted;
}

const modules = order('index.js');

// Two modules declaring one name would quietly shadow each other in a single
// scope, and the failure would be a wrong diagram rather than an error.
const owner = new Map();
for (const [name, source] of modules) {
  for (const match of source.matchAll(DECLARATION)) {
    const declared = match[2];
    const first = owner.get(declared);
    if (first) throw new Error(`${declared} is declared in both ${first} and ${name}`);
    owner.set(declared, name);
  }
}

for (const wanted of EXPOSED) {
  if (!owner.has(wanted)) throw new Error(`${wanted} is not exported by the library`);
}

const body = modules
  .map(([name, source]) =>
    [
      `// ---- ${name} ----`,
      source
        .replace(IMPORT, '')
        .replace(REEXPORT, '')
        .replace(EMPTY_EXPORT, '')
        .replace(/^export\s+/gm, '')
        .trim(),
    ].join('\n'),
  )
  .join('\n\n');

const bundle = [
  '(function () {',
  "'use strict';",
  body,
  `globalThis.reladraw = { ${EXPOSED.join(', ')} };`,
  '})();',
].join('\n');

const catalogue = OFFERED.map(([file, name, about]) => ({
  name,
  about,
  source: readFileSync(join(examples, `${file}.reladraw`), 'utf8'),
}));

const page = readFileSync(template, 'utf8');

function fill(text, marker, replacement) {
  if (!text.includes(marker)) throw new Error(`${template} has no ${marker} to replace`);
  // A literal </script> in the inlined text would close the tag early. Nothing
  // emits one today; escaping it costs nothing and removes the whole class.
  return text.replace(marker, `<script>\n${replacement.replace(/<\/script/gi, '<\\/script')}\n</script>`);
}

const catalogueScript = `globalThis.reladrawExamples = ${JSON.stringify(catalogue)};`;

writeFileSync(
  target,
  fill(
    fill(page, '<!-- RELADRAW_EXAMPLES -->', catalogueScript),
    '<!-- RELADRAW_BUNDLE -->',
    bundle,
  ),
);

console.log(
  `${target}  (${modules.length} modules, ${bundle.length} bytes inlined; ` +
    `${catalogue.length} examples, ${catalogueScript.length} bytes)`,
);
