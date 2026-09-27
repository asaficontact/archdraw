// Parses every reladraw snippet in the given Markdown files and reports the ones
// the current parser refuses. Run it through `./dev.sh snippets`.
//
// The documents that teach the language — the README, the agent skill, the
// llms.txt page — are written by hand, and nothing else notices when one keeps
// showing a construct the language has since renamed or removed. A snippet is
// usually a fragment that names nodes it never declares, so this parses and does
// not resolve: it catches a word the language no longer accepts, not a picture
// that would fail to lay out.
//
// A fenced block counts as a snippet when its first statement opens with a
// statement keyword and it carries no `<placeholder>`, which is how the grammar
// summaries are told apart from examples; a block labeling a statement's parts
// with carets is skipped too. A block written to show an error on purpose is
// marked by a comment line containing `error:` and skipped.

import { readFileSync } from 'node:fs';
import { parse } from '../dist/index.js';

const KEYWORDS = /^(node|edge|style|diagram|default)\s/;
// The caret-and-bar lines that label the parts of a statement in SYNTAX.md.
const ANNOTATION = /^\s*[\^|]/;
const FENCE = /^```/;

let checked = 0;
let refused = 0;

for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      if (block === null) {
        block = { start: i + 2, body: [] };
      } else {
        checkBlock(file, block);
        block = null;
      }
    } else if (block !== null) {
      block.body.push(lines[i]);
    }
  }
}

console.log(`${checked} snippets parsed, ${refused} refused`);
process.exit(refused > 0 ? 1 : 0);

function checkBlock(file, { start, body }) {
  const statements = body.map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
  if (statements.length === 0 || !KEYWORDS.test(statements[0])) return;
  if (body.some((l) => /<[a-z][a-z -]*>/.test(l) || ANNOTATION.test(l))) return;
  if (body.some((l) => /^\s*\/\/.*\berror:/.test(l))) return;
  checked++;
  try {
    parse(body.join('\n'));
  } catch (e) {
    refused++;
    console.log(`${file}:${start}: ${e.message}`);
  }
}
