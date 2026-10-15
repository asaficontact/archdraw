import type { Attrs, Kind, DefaultTarget, Document, EdgeStmt, Mark, Stmt } from './ast.js';
import {
  ALL_ATTR_KEYS,
  ATTR_KEYS,
  MARKS,
  COLOR_KEYS,
  COLOR_PARTS,
  CONTENT_ALIGNMENTS,
  CONTENT_WIDTHS,
  LINE_VALUES,
  describePlacement,
} from './ast.js';
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_MARGIN,
  ICON_GAP,
  ICON_LINES,
  PAD,
  THICKNESS,
  fontSizeFor,
  widestLine,
} from './constants.js';
import { SourceError } from './errors.js';
import { type Body, bodyFor, type Icon, pastedIcon } from './icons.js';
import { monospaceMeasurer, type Measurer } from './measure.js';
import { markupStyles, parseMarkup, plain, splitRuns, wrapLine, type Line } from './text.js';
import type { Layout, LayoutEdge, LayoutNode, LayoutPass, LayoutPassage, LineLook } from './model.js';
import { gapPixels, Placer, type Layout as ChildLayout, type NodeFacts, type TitlePlace } from './place.js';

/**
 * What a node's own contents make of it, before anything is placed: a leaf's
 * size from its text, a picture's size, and for a container its title, its
 * padding and its layout. A container's size comes from its children, in the
 * placing pass.
 */
function factsFor(node: LayoutNode, measurer: Measurer, fontSize: number): NodeFacts {
  const textSize = fontSizeFor(node.kind, node.textAttrs, fontSize, node.line);
  const lineHeight = measurer.lineHeight(textSize);
  const hasText = node.lines.some((line) => plain(line).length > 0);
  const textWidth = hasText ? widestLine(node.lines, measurer, textSize) : 0;
  const textHeight = hasText ? node.lines.length * lineHeight : 0;
  const glyphSide = ICON_LINES * lineHeight;
  const title = titlePlaceOf(node);
  const layout = layoutOf(node);
  const circle = isCircle(node);
  const padding =
    node.body.kind === 'none'
      ? 0
      : node.appearance['padding'] !== undefined
        ? gapPixels(node.appearance['padding'], `"${node.name}" padding:`, node.line)
        : PAD;
  node.textSide = 'center';
  const measures = { lineHeight, charWidth: measurer.measure('0'.repeat(10), textSize).width / 10 };

  if (node.body.kind === 'icon') {
    if (node.children.length > 0) {
      throw new SourceError(
        `"${node.name}" is drawn as a picture and has children. A picture is not a box, so nothing can go inside it`,
        node.line,
      );
    }
    const width = Math.max(glyphSide, textWidth);
    return {
      natural: { width, height: glyphSide + (hasText ? ICON_GAP + textHeight : 0) },
      textBox: { x: (width - textWidth) / 2, y: glyphSide + ICON_GAP, width: textWidth, height: textHeight },
      hasText,
      padding,
      ...measures,
      title,
      ...(layout ? { layout } : {}),
      circle,
    };
  }
  if (node.children.length === 0 && circle) {
    const side = Math.hypot(textWidth, textHeight) + padding * 2;
    return {
      natural: { width: side, height: side },
      textBox: { x: (side - textWidth) / 2, y: (side - textHeight) / 2, width: textWidth, height: textHeight },
      hasText,
      padding,
      ...measures,
      title,
      circle,
    };
  }
  if (layout && node.children.length === 0) {
    throw new SourceError(`"${node.name}" has layout: but no children — a node with no children is not a container`, node.line);
  }
  return {
    natural: { width: textWidth + padding * 2, height: textHeight + padding * 2 },
    textBox: { x: padding, y: padding, width: textWidth, height: textHeight },
    hasText,
    padding,
    ...measures,
    title,
    ...(layout ? { layout } : {}),
    circle,
  };
}

/**
 * Where a container's title sits: `(inside top)` by default, `(on top)`,
 * `(outside top)`, or `(center)`, with `align:` saying where along the side.
 * `at:` is gone from a node's text, refused with the side form.
 */
function titlePlaceOf(node: LayoutNode): TitlePlace {
  const at = node.textAttrs['at'];
  if (at !== undefined) {
    throw new SourceError(
      at === 'center'
        ? `"${node.name}": at: is gone from a node's text — a leaf's text is centered with nothing written, ` +
            "and a container's title goes in the middle with (center)"
        : `"${node.name}": at: is gone from a node's text — a title says which side it sits against, ` +
            'such as (inside top, align: left), (on top) or (outside bottom)',
      node.line,
    );
  }
  const written = node.textAttrs['place'] ?? (node.attrs['badge'] !== undefined || node.appearance['badge'] !== undefined ? 'center' : 'inside top');
  if (written === 'center') return { how: 'center', side: 'center', along: 'center' };
  const [how, side] = written.split(' ') as [TitlePlace['how'], TitlePlace['side']];
  const across = side === 'top' || side === 'bottom';
  const words = across ? ['left', 'center', 'right'] : ['top', 'center', 'bottom'];
  const align = node.textAttrs['align'] ?? 'center';
  if (node.children.length > 0 && !words.includes(align)) {
    throw new SourceError(
      `"${node.name}": a title on the ${side} side takes align: ${words.join(', ')} — not ${align}`,
      node.line,
    );
  }
  const along = align === words[0] ? 'start' : align === words[2] ? 'end' : 'center';
  return { how, side, along };
}

/** `layout: column (gap: 0, widths: match, align: center)`, read and checked. */
function layoutOf(node: LayoutNode): ChildLayout | undefined {
  const kind = node.appearance['layout'];
  if (kind === undefined) return undefined;
  if (kind !== 'column' && kind !== 'row') {
    throw new SourceError(`"${node.name}" has layout: ${kind}, which is not one of column, row`, node.line);
  }
  const bracket = bracketOf('layout', node.appearance);
  const widths = bracket['widths'] ?? 'natural';
  if (!(CONTENT_WIDTHS as readonly string[]).includes(widths)) {
    throw new SourceError(`"${node.name}" has layout: (widths: ${widths}), which is not one of ${CONTENT_WIDTHS.join(', ')}`, node.line);
  }
  if (widths === 'fill' && kind === 'row') {
    throw new SourceError(
      `"${node.name}" has layout: row (widths: fill), and children side by side can't all be the full width — use widths: match`,
      node.line,
    );
  }
  const alignWord = bracket['align'] ?? 'left';
  if (!(CONTENT_ALIGNMENTS as readonly string[]).includes(alignWord)) {
    throw new SourceError(`"${node.name}" has layout: (align: ${alignWord}), which is not one of ${CONTENT_ALIGNMENTS.join(', ')}`, node.line);
  }
  const align = alignWord === 'left' ? 'start' : alignWord === 'right' ? 'end' : 'center';
  const centers = bracket['centers'];
  if (centers !== undefined && bracket['gap'] !== undefined) {
    throw new SourceError(`"${node.name}": layout: says gap: and centers:, which is the spacing said twice — keep one`, node.line);
  }
  if (centers !== undefined) {
    return { kind, centers: gapPixels(centers, `"${node.name}" layout: (centers: …)`, node.line), widths, align } as ChildLayout;
  }
  const gap = bracket['gap'] === undefined ? PAD : gapPixels(bracket['gap'], `"${node.name}" layout: (gap: …)`, node.line);
  return { kind, gap, widths, align } as ChildLayout;
}

export interface ResolveOptions {
  measurer?: Measurer;
  fontSize?: number;
  /** Blank space kept around the whole diagram. */
  margin?: number;
  /**
   * Read the file an `icon` declaration names, as text. The command-line tool
   * supplies it, reading relative to the diagram's own file; without it, as in
   * a browser, an icon has to be pasted in rather than named by file.
   */
  readIconFile?: (path: string) => string;
}

/**
 * Turn a parsed document into solved geometry.
 *
 * Three passes: build the containment tree, size every node bottom-up, then
 * turn each node's placements into minimum distances and solve for the tightest
 * arrangement that satisfies them. That last pass also adds the separations
 * that keep boxes off each other, and solves again until none is left to add.
 *
 * It is a constraint solve, of the kind that computes rather than searches. It
 * works out how far apart things are; nothing about which side of what a node
 * sits on is ever decided here, because the author wrote it down.
 */
export function resolve(doc: Document, options: ResolveOptions = {}): Layout {
  const measurer = options.measurer ?? monospaceMeasurer();
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const margin = options.margin ?? DEFAULT_MARGIN;

  const styles = collectStyles(doc.statements);
  checkStyleKeys(doc.statements);
  const defaults = collectDefaults(doc.statements, styles);
  const icons = collectIcons(doc.statements, options.readIconFile);
  const { nodes, byName, roots } = buildTree(doc.statements, styles, defaults, icons);

  // Edges are resolved to nodes before anything is sized, because a labeled
  // edge claims room in the gap it crosses and so has to be in hand while the
  // gaps are being worked out. Nothing here reads geometry.
  const edges = buildEdges(doc.statements, byName, styles, defaults);

  const facts = new Map(nodes.map((node) => [node, factsFor(node, measurer, fontSize)]));
  new Placer(roots, byName, facts).run();
  normalize(nodes, margin);

  const extent = bounds(nodes);

  return {
    nodes,
    roots,
    edges,
    markup: markupColors(nodes, edges, styles),
    diagram: collectDiagram(doc.statements),
    width: Math.ceil(extent.maxX + margin),
    height: Math.ceil(extent.maxY + margin),
    margin,
  };
}

// --- pass one: the containment tree -----------------------------------------

function collectStyles(statements: Stmt[]): Map<string, Attrs> {
  const styles = new Map<string, Attrs>();
  for (const stmt of statements) {
    if (stmt.kind !== 'style') continue;
    if (styles.has(stmt.name)) {
      throw new SourceError(`style "${stmt.name}" is declared twice`, stmt.line);
    }
    styles.set(stmt.name, stmt.attrs);
  }
  return styles;
}

/** The file's own icons, by name, each pasted in or read from its file. */
function collectIcons(statements: Stmt[], readIconFile: ((path: string) => string) | undefined): Map<string, Icon> {
  const icons = new Map<string, Icon>();
  for (const stmt of statements) {
    if (stmt.kind !== 'icon') continue;
    if (icons.has(stmt.name)) {
      throw new SourceError(`icon "${stmt.name}" is declared twice`, stmt.line);
    }
    let svg = stmt.source.trim();
    if (!stmt.pasted) {
      if (readIconFile === undefined) {
        throw new SourceError(
          `icon "${stmt.name}" names a file, "${svg}", and files can be read only by the ` +
            'command-line tool — paste the SVG itself between """ marks instead',
          stmt.line,
        );
      }
      try {
        svg = readIconFile(svg);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        throw new SourceError(`icon "${stmt.name}" could not read "${svg}": ${why}`, stmt.line);
      }
    }
    icons.set(stmt.name, pastedIcon(svg, stmt.name, stmt.line));
  }
  return icons;
}

/**
 * Each kind's default, with any style it names already folded in beneath its
 * own words, so a default arrives at a node as one flat bundle. The same kind
 * written twice is refused, as a second `diagram` is: nothing says which was
 * meant.
 */
function collectDefaults(
  statements: Stmt[],
  styles: Map<string, Attrs>,
): Map<DefaultTarget, Attrs> {
  const defaults = new Map<DefaultTarget, Attrs>();
  const seen = new Map<DefaultTarget, number>();
  for (const stmt of statements) {
    if (stmt.kind !== 'default') continue;
    const earlier = seen.get(stmt.target);
    if (earlier !== undefined) {
      throw new SourceError(
        `default ${stmt.target} is written twice, here and on line ${earlier} — keep one`,
        stmt.line,
      );
    }
    seen.set(stmt.target, stmt.line);
    const { style: _named, ...flat } = appearanceOf(stmt.attrs, styles, stmt.line);
    defaults.set(stmt.target, flat);
  }
  return defaults;
}

/**
 * One bundle laid over a weaker one, key by key — except the body, which is
 * one thing said by either of two words. A default's `shape: cylinder` under
 * a style's `icon: disk` is not a node with two bodies; the style said what
 * this node is drawn as, and that settles it.
 */
function over(base: Attrs, top: Attrs): Attrs {
  if (top['shape'] === undefined && top['icon'] === undefined) return { ...base, ...top };
  const { shape: _shape, icon: _icon, ...rest } = base;
  return { ...rest, ...top };
}

/** A file holds one diagram, so a second `diagram` statement is a mistake. */
function collectDiagram(statements: Stmt[]): Attrs {
  let found: Attrs | undefined;
  for (const stmt of statements) {
    if (stmt.kind !== 'diagram') continue;
    if (found) throw new SourceError('the diagram is described twice', stmt.line);
    found = stmt.attrs;
  }
  return found ?? {};
}

function buildTree(
  statements: Stmt[],
  styles: Map<string, Attrs>,
  defaults: Map<DefaultTarget, Attrs>,
  icons: ReadonlyMap<string, Icon>,
) {
  const nodes: LayoutNode[] = [];
  const byName = new Map<string, LayoutNode>();
  const roots: LayoutNode[] = [];
  /** Each badge child's name, and the node whose `badge:` it was written out from. */
  const badges = new Map<string, string>();

  // Which nodes will hold children has to be known before any node is built,
  // because it decides which default a node wears, and its children are
  // declared after it. A child is a dotted name, or a badge the node's own
  // line or styles give it; a default cannot give a leaf a badge, so what
  // the defaults say cannot change the answer.
  const parents = new Set<string>();
  for (const stmt of statements) {
    if (stmt.kind !== 'node') continue;
    const cut = stmt.name.lastIndexOf('.');
    if (cut !== -1) parents.add(stmt.name.slice(0, cut));
    if (appearanceOf(stmt.attrs, styles, stmt.line)['badge'] !== undefined) parents.add(stmt.name);
  }

  for (const stmt of statements) {
    if (stmt.kind !== 'node') continue;

    if (byName.has(stmt.name)) {
      const owner = badges.get(stmt.name);
      if (owner !== undefined) {
        throw new SourceError(
          `"${stmt.name}" is the child that "${owner}"'s badge: is written out as. Drop badge: from ` +
            `"${owner}" and write the icon here yourself, or give this node another name`,
          stmt.line,
        );
      }
      throw new SourceError(`"${stmt.name}" is declared twice`, stmt.line);
    }

    // Weakest first: every node's default, then the leaf's or the container's,
    // then the node's own styles and words over both.
    const appearance = over(
      over(defaults.get('node') ?? {}, defaults.get(parents.has(stmt.name) ? 'container' : 'leaf') ?? {}),
      appearanceOf(stmt.attrs, styles, stmt.line),
    );
    const body = bodyFor(stmt.attrs, appearance, stmt.line, icons);
    const kind = KIND_OF_BODY[body.kind];
    // A node with no text of its own is labelled with its name, because the
    // first lines anybody types are `node a` and `node b right of a` and they
    // mean the boxes to read "a" and "b". A node drawn as a *picture* is the
    // exception: a picture usually is the statement, and the default would
    // caption a row of cubes a, b, db1, c, db2. `""` then says what writing
    // nothing says, which is only true here — on a box it carries information.
    const text = body.kind === 'icon' && !stmt.statedText ? '' : stmt.text;
    // A style has no string of its own, so it says what it has to say about a
    // text through `text: (…)`, which arrives here under dotted keys. What the
    // node wrote in its own brackets wins, key by key, exactly as its own
    // attributes win over the style's.
    const textAttrs = { ...bracketOf('text', appearance), ...stmt.textAttrs };

    const node: LayoutNode = {
      name: stmt.name,
      kind,
      body,
      text,
      lines: linesFor(text, textAttrs, `"${stmt.name}"`, stmt.line),
      children: [],
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      inset: 0,
      deckTexts: [],
      headerHeight: 0,
      reach: { left: 0, top: 0, right: 0, bottom: 0 },
      banded: false,
      textBox: { x: 0, y: 0, width: 0, height: 0 },
      textSide: 'left',
      textAttrs,
      attrs: stmt.attrs,
      appearance,
      placements: stmt.placements,
      line: stmt.line,
    };

    checkAttrs(kind, node.name, stmt.attrs, stmt.line);
    checkStyleUse(kind, node.name, stmt.attrs, styles, stmt.line);

    // `deck:` holds one text per copy, joined on a line break the source cannot
    // contain. Like a badge, only a box has an outline to repeat.
    const deck = appearance['deck'];
    if (deck !== undefined && body.kind === 'shape') node.deckTexts = deck.split('\n');

    const cut = stmt.name.lastIndexOf('.');
    if (cut === -1) {
      roots.push(node);
    } else {
      const parentName = stmt.name.slice(0, cut);
      const parent = byName.get(parentName);
      if (!parent) {
        throw new SourceError(
          `"${stmt.name}" is inside "${parentName}", which is not declared yet`,
          stmt.line,
        );
      }
      node.parent = parent;
      parent.children.push(node);
    }

    nodes.push(node);
    byName.set(stmt.name, node);

    // `badge: X` is a shorthand, and this is its expansion:
    //   node <self>.badge  icon: X  right of <self> text
    // set at the parent's text size, so the picture is two of the parent's
    // lines tall. Read from the merged appearance, so a style carrying a badge
    // gives one to every box wearing it. Only a box has a text to be beside;
    // the other kinds refuse the word in `checkAttrs`, and a style's is unused.
    const named = appearance['badge'];
    if (named !== undefined && body.kind === 'shape') {
      const badge = badgeChild(node, named, icons);
      badges.set(badge.name, node.name);
      node.children.push(badge);
      nodes.push(badge);
      byName.set(badge.name, badge);
    }
  }

  return { nodes, byName, roots };
}

/** The child `badge:` writes out, as `buildTree` describes. */
function badgeChild(parent: LayoutNode, named: string, icons: ReadonlyMap<string, Icon>): LayoutNode {
  const icon = { icon: named };
  const size = parent.textAttrs['size'];
  return {
    name: `${parent.name}.badge`,
    kind: 'icon',
    body: bodyFor(icon, icon, parent.line, icons),
    text: '',
    lines: linesFor('', {}, `"${parent.name}.badge"`, parent.line),
    children: [],
    parent,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    inset: 0,
    deckTexts: [],
    headerHeight: 0,
    reach: { left: 0, top: 0, right: 0, bottom: 0 },
    banded: false,
    textBox: { x: 0, y: 0, width: 0, height: 0 },
    textSide: 'center',
    textAttrs: size === undefined ? {} : { size },
    attrs: icon,
    appearance: icon,
    placements: [
      {
        kind: 'offset',
        direction: 'right',
        targets: [{ name: parent.name, part: 'text' }],
        line: parent.line,
      },
    ],
    line: parent.line,
  };
}

/**
 * "a node", "an edge". Only the kind words are ever passed here and only `edge`
 * begins with a vowel, but writing `a ${word}` produced "a edge" the day the
 * keyword changed, so the article follows the word rather than being assumed.
 */
function article(word: string): string {
  return `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
}

/** The same phrase opening a sentence. */
function capital(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** Which kind a body makes the node. */
const KIND_OF_BODY: Record<Body['kind'], Exclude<Kind, 'edge'>> = {
  shape: 'shape',
  icon: 'icon',
  none: 'none',
};

/** How each kind reads in an error, and what it is actually made of. */
const KIND_WORD: Record<Kind, string> = {
  shape: 'node',
  icon: 'node drawn as a picture',
  none: 'node with no body',
  edge: 'edge',
};
const KIND_PARTS: Record<Kind, string> = {
  shape: 'a fill, a border and text',
  icon: 'a picture and the text under it',
  none: 'text and nothing else',
  edge: 'a line and its text',
};

/**
 * An attribute is refused on a kind that has no use for it — the same rule as
 * an unknown `diagram` key, and for the same reason: a key that silently does
 * nothing looks like the tool being broken. A color names a part and so is a
 * special case of this, which is why the two checks are one.
 *
 * What is checked is what the author wrote *on this statement*, not what a
 * style contributed. A style is a bundle meant to be shared across kinds — the
 * benchmark's `synced` carries a fill and a border for the green boxes and a
 * line for the four edges joining them — so a key it carries that this kind has
 * no part for is simply unused, and is not a mistake anybody made here. That is
 * forced rather than chosen: checking the merged appearance would refuse the
 * benchmark's own central idiom four times over. `checkStyleUse` is what keeps
 * the permissiveness honest.
 */
function checkAttrs(kind: Kind, name: string, attrs: Attrs, line: number): void {
  const allowed = ATTR_KEYS[kind];
  // In the author's own order, so the error names the first offending word as
  // it is read rather than the first in some list of ours.
  for (const [written, value] of Object.entries(attrs)) {
    const key = topKey(written);
    if (allowed.includes(key)) continue;

    // Quoted back the way it was written. A bracketed value arrives one dotted
    // key at a time, and `contents: match` is not a line anybody could look for.
    // A deck's texts are stored joined on a line break; quote them back as written.
    const shown = key === 'deck' ? value.split('\n').map((text) => `"${text}"`).join(' ') : value;
    const wrote =
      written === key ? `${key}: ${shown}` : `${key}: (${written.slice(key.length + 1)}: ${shown})`;

    if (!ALL_ATTR_KEYS.includes(key)) {
      // Nothing anywhere in the language answers to this word, so the only
      // remedy is the vocabulary itself.
      throw new SourceError(
        `"${name}" has ${wrote}, which is not an attribute. ${capital(article(KIND_WORD[kind]))} takes ${allowed.join(', ')}`,
        line,
      );
    }

    // A real word in the wrong place, and the two sorts of word want different
    // explanations. A color names a *part*, so saying what the kind is made of
    // is the whole reason it has no such color, and the remedy is the narrower
    // list of parts it does have: `line:` on a box is a different mistake from
    // `border:` on a note, and one hint cannot serve both.
    if ((COLOR_KEYS as readonly string[]).includes(key)) {
      const parts = COLOR_PARTS[kind].map((part) => `\`${part}\``).join(', ');
      throw new SourceError(
        `"${name}" is ${article(KIND_WORD[kind])} and has ${wrote}. ${capital(article(KIND_WORD[kind]))} is ${KIND_PARTS[kind]}, so it has no ${key} — it takes ${parts}`,
        line,
      );
    }

    // A word only the whole drawing takes, such as a theme.
    if (belongTo(key).length === 0) {
      throw new SourceError(
        `"${name}" is ${article(KIND_WORD[kind])} and has ${wrote}. \`${key}:\` is said about the ` +
          `whole drawing — write \`diagram ${key}: ${shown}\``,
        line,
      );
    }

    // Anything else names no part, so what the kind is made of explains
    // nothing. What does explain it is where the word *does* belong, which is
    // also the more useful thing to be told: the author has usually written a
    // real statement about the wrong half of the diagram.
    throw new SourceError(
      `"${name}" is ${article(KIND_WORD[kind])} and has ${wrote}. \`${key}:\` belongs to ` +
        `${listKinds(belongTo(key))} — ${article(KIND_WORD[kind])} takes ${allowed.join(', ')}`,
      line,
    );
  }
}

/**
 * A style may carry keys this kind has no use for, but it may not carry *only*
 * those. Partial overlap is the normal case and the reason styles exist; zero
 * overlap is a style name written on the wrong sort of thing, and nothing else.
 *
 * This is the check that lets `checkAttrs` ignore style-contributed keys
 * without the silence coming back. It cannot catch a style that names every key
 * in the language, since such a style contributes to everything by
 * construction — that hole is left open, because nobody writes one by accident.
 */
function checkStyleUse(
  kind: Kind,
  name: string,
  attrs: Attrs,
  styles: Map<string, Attrs>,
  line: number,
): void {
  // Each style in a list is checked on its own: one that gives this thing
  // nothing is a name written on the wrong sort of thing, whatever its
  // neighbours in the list carry.
  for (const named of styleNames(attrs)) {
    const base = styles.get(named);
    if (base === undefined) continue; // `appearanceOf` reports the missing style.

    // A style naming another style is the one way to carry nothing at all: the
    // parser already refuses one with no attributes, and `appearanceOf` does not
    // recurse, so the name would sit there doing nothing.
    const carried = [...new Set(Object.keys(base).map(topKey))].filter((key) => key !== 'style');
    if (carried.length === 0) {
      throw new SourceError(`style "${named}" carries nothing but a style name`, line);
    }
    if (carried.some((key) => ATTR_KEYS[kind].includes(key))) continue;

    throw new SourceError(
      `style "${named}" gives "${name}" nothing. It carries ${carried.join(' and ')}; ` +
        `${article(KIND_WORD[kind])} is ${KIND_PARTS[kind]}`,
      line,
    );
  }
}

/**
 * A style is a bundle spanning kinds, so its keys cannot be checked against any
 * one of them — but a word that is an attribute of *nothing* is a misspelling
 * wherever it sits, and a style was the last place in the language where one
 * could hide.
 */
function checkStyleKeys(statements: Stmt[]): void {
  for (const stmt of statements) {
    if (stmt.kind !== 'style') continue;
    for (const [key, value] of Object.entries(stmt.attrs)) {
      if (ALL_ATTR_KEYS.includes(topKey(key))) continue;
      throw new SourceError(
        `style "${stmt.name}" has ${key}: ${value}, which is not an attribute. ` +
          `The attributes are ${ALL_ATTR_KEYS.join(', ')}`,
        stmt.line,
      );
    }
  }
}

/**
 * The attribute a key belongs to. A bracketed value arrives under dotted keys —
 * `text: (color: theme-muted)` is stored as `text.color` — so that a style merges into
 * a node exactly the way every other attribute does; every check above asks
 * about the part, which is the half before the dot.
 */
function topKey(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

/** Which kinds understand an attribute, in the order the table declares them. */
function belongTo(key: string): Kind[] {
  return (Object.keys(ATTR_KEYS) as Kind[]).filter((kind) => ATTR_KEYS[kind].includes(key));
}

/** "an edge", "a node or a glyph body", "a node, a note or a glyph body". */
function listKinds(kinds: Kind[]): string {
  const words = kinds.map((kind) => article(KIND_WORD[kind]));
  if (words.length <= 1) return words[0] ?? 'nothing';
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/** The styles a `style:` names, in the order written. The parser joins them on a space. */
function styleNames(attrs: Attrs): string[] {
  const named = attrs['style'];
  return named === undefined ? [] : named.split(' ');
}

/**
 * The styles in the order written, a later one winning where two set the same
 * key, and then the statement's own words over all of them — a word written on
 * the line was meant for this thing, wherever `style:` sits.
 */
function appearanceOf(attrs: Attrs, styles: Map<string, Attrs>, line: number): Attrs {
  const merged: Attrs = {};
  for (const named of styleNames(attrs)) {
    const base = styles.get(named);
    if (!base) throw new SourceError(`no style named "${named}"`, line);
    Object.assign(merged, base);
  }
  return { ...merged, ...attrs };
}

/**
 * What is drawn at one end of an edge. A mark written in the arrow is final:
 * the edge's own `from-mark:` or `to-mark:` may repeat it but not contradict
 * it, since both halves are on one line and whichever lost would be dead text.
 * An end the arrow leaves blank is unsaid, and the edge's attribute, then its
 * style, then nothing, fills it. Layering is between places, never within one.
 */
function markAt(end: 'from' | 'to', stmt: EdgeStmt, appearance: Attrs, what: string): Mark {
  const key = `${end}-mark`;
  const check = (value: string): Mark => {
    if (!(MARKS as readonly string[]).includes(value)) {
      throw new SourceError(
        `edge ${what}: "${key}: ${value}" is not a mark — use ${MARKS.join(', ')}`,
        stmt.line,
      );
    }
    return value as Mark;
  };
  const written = stmt.marks[end];
  const own = stmt.attrs[key];
  if (written !== undefined) {
    if (own !== undefined && check(own) !== written) {
      throw new SourceError(
        `edge ${what}: the arrow already puts ${written === 'none' ? 'nothing' : `a${/^[aeiou]/.test(written) ? 'n' : ''} ${written}`} ` +
          `at ${stmt[end]}, and "${key}: ${own}" says otherwise. Say it once: leave that end of the ` +
          `arrow blank and keep "${key}: ${own}", or drop "${key}:"`,
        stmt.line,
      );
    }
    return written;
  }
  const given = appearance[key];
  return given === undefined ? 'none' : check(given);
}

function buildEdges(
  statements: Stmt[],
  byName: Map<string, LayoutNode>,
  styles: Map<string, Attrs>,
  defaults: Map<DefaultTarget, Attrs>,
): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  for (const stmt of statements) {
    if (stmt.kind !== 'edge') continue;
    const from = byName.get(stmt.from);
    const to = byName.get(stmt.to);
    if (!from) throw new SourceError(`edge from "${stmt.from}", which does not exist`, stmt.line);
    if (!to) throw new SourceError(`edge to "${stmt.to}", which does not exist`, stmt.line);
    const between: LayoutPassage | undefined = stmt.between && {
      nodes: stmt.between.targets.map(({ name, part }) => {
        if (part !== undefined) {
          // A passage is the gap between two boxes, and a side or a point has
          // no gap on either hand. Refused by name rather than dropped.
          throw new SourceError(
            `edge passes between "${name} ${part}", and a passage runs between two whole boxes ` +
              `— drop "${part}"`,
            stmt.line,
          );
        }
        const node = byName.get(name);
        if (!node) {
          throw new SourceError(`edge passes between "${name}", which does not exist`, stmt.line);
        }
        return node;
      }) as [LayoutNode, LayoutNode],
      ...(stmt.between.axis !== undefined ? { axis: stmt.between.axis } : {}),
    };
    const passes: LayoutPass[] | undefined = stmt.passes?.map((placement) => {
      const written = describePlacement(placement);
      return {
        direction: placement.direction,
        written,
        nodes: placement.targets.map(({ name, part }) => {
          if (part !== undefined) {
            // The line passes a box, and a side or a point has no side of its
            // own to be passed on. Refused by name rather than dropped.
            throw new SourceError(
              `edge passes "${written}", and a line passes a whole box — drop "${part}"`,
              stmt.line,
            );
          }
          const node = byName.get(name);
          if (!node) {
            throw new SourceError(`edge passes "${written}", and "${name}" does not exist`, stmt.line);
          }
          return node;
        }),
      };
    });
    const appearance = { ...defaults.get('edge'), ...appearanceOf(stmt.attrs, styles, stmt.line) };
    const what = `${stmt.from} ${stmt.arrow} ${stmt.to}`;
    checkAttrs('edge', what, stmt.attrs, stmt.line);
    checkStyleUse('edge', what, stmt.attrs, styles, stmt.line);
    if (stmt.attrs['url'] !== undefined && stmt.text === undefined) {
      // Wrapping the line works, and `LINE_WIDTH` is 1.5 — a destination that
      // technically has a target and practically has none. That is the silent
      // defect shape the language refuses everywhere else, so it is refused
      // here rather than shipped and explained.
      throw new SourceError(
        `edge ${what} has a url and no text. A destination needs something to click, and a line ` +
          'is too thin to be it — give the edge a text, or put the url on one of the nodes',
        stmt.line,
      );
    }
    const textAttrs = { ...bracketOf('text', appearance), ...stmt.textAttrs };
    edges.push({
      from,
      to,
      marks: {
        from: markAt('from', stmt, appearance, what),
        to: markAt('to', stmt, appearance, what),
      },
      textAttrs,
      ...(stmt.text !== undefined
        ? { text: stmt.text, lines: linesFor(stmt.text, textAttrs, `edge ${what}`, stmt.line) }
        : {}),
      ...(between ? { between } : {}),
      ...(passes ? { passes } : {}),
      look: lineLook(stmt.attrs, appearance, what, stmt.line),
      attrs: stmt.attrs,
      appearance,
      line: stmt.line,
    });
  }
  return edges;
}

/**
 * The line's bracket, checked, with a default for everything unsaid. A value is
 * checked wherever it came from — a style's `path: squar` is as much a typo as
 * an edge's — but `corners: rounded` is refused only when the edge itself says
 * it on a curved line, which has no corners. From a style or a default it
 * applies to the edges that have corners, the way a style's `fill:` lands on
 * the nodes that have an inside.
 */
function lineLook(written: Attrs, appearance: Attrs, what: string, line: number): LineLook {
  const word = <K extends keyof typeof LINE_VALUES>(property: K): (typeof LINE_VALUES)[K][number] => {
    const value = appearance[`line.${property}`];
    if (value === undefined) return LINE_VALUES[property][0];
    if (!(LINE_VALUES[property] as readonly string[]).includes(value)) {
      throw new SourceError(
        `edge ${what}: "${property}: ${value}" is not a ${property} — use ${(property === 'thickness' ? ['thin', 'normal', 'thick'] : LINE_VALUES[property]).join(', ')}` +
          (property === 'thickness' ? ', or a number of pixels' : ''),
        line,
      );
    }
    return value as (typeof LINE_VALUES)[K][number];
  };

  const thickness = ((): number => {
    const value = appearance['line.thickness'];
    if (value !== undefined && /^[0-9.]/.test(value)) {
      if (!/^\d*\.?\d+$/.test(value) || Number(value) <= 0) {
        throw new SourceError(
          `edge ${what}: "thickness: ${value}" — a thickness is thin, normal, thick, ` +
            'or a plain number of pixels greater than zero, such as `thickness: 3`',
          line,
        );
      }
      return Number(value);
    }
    return THICKNESS[word('thickness')]!;
  })();

  const look: LineLook = {
    path: word('path'),
    corners: word('corners'),
    crossing: word('crossing'),
    pattern: word('pattern'),
    thickness,
  };
  if (look.path === 'curved' && written['line.corners'] === 'rounded') {
    throw new SourceError(
      `edge ${what}: a curved line has no corners to round — \`corners: rounded\` takes a ` +
        '`path: square` or `path: straight` line',
      line,
    );
  }
  return look;
}

// --- pass two: sizes, bottom-up ---------------------------------------------

function isCircle(node: LayoutNode): boolean {
  return node.body.kind === 'shape' && node.body.outline === 'circle';
}

// --- pass three: solve for positions -----------------------------------------


// --- shared helpers ----------------------------------------------------------

/** The keys a bracketed attribute contributed, with its prefix taken off. */
function bracketOf(key: string, attrs: Attrs): Attrs {
  const found: Attrs = {};
  for (const [written, value] of Object.entries(attrs)) {
    if (written.startsWith(`${key}.`)) found[written.slice(key.length + 1)] = value;
  }
  return found;
}

/**
 * Every style the markup in this file names, resolved to the color it lends.
 *
 * A style is the only thing markup may name — never a color — so that a marked
 * word borrows a meaning the file already has instead of restating a value that
 * goes stale the day the thing it means is recolored. Both ways that can fail
 * are refused by name: a style nobody declared, and one that says nothing about
 * text and so would lend nothing.
 */
function markupColors(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  styles: Map<string, Attrs>,
): Record<string, string> {
  const colors: Record<string, string> = {};
  const used: Array<{ lines: Line[]; what: string; line: number }> = [
    ...nodes.map((node) => ({ lines: node.lines, what: `"${node.name}"`, line: node.line })),
    ...edges.flatMap((edge) =>
      edge.lines ? [{ lines: edge.lines, what: `edge ${edge.from.name} -> ${edge.to.name}`, line: edge.line }] : [],
    ),
  ];
  for (const { lines, what, line } of used) {
    for (const name of markupStyles(lines)) {
      const style = styles.get(name);
      if (style === undefined) {
        throw new SourceError(
          `${what}: its text marks [${name}], and there is no style called "${name}"`,
          line,
        );
      }
      const color = style['text.color'];
      if (color === undefined) {
        throw new SourceError(
          `${what}: its text marks [${name}], and style "${name}" says nothing about text — ` +
            `write \`style ${name}  text: (color: …)\``,
          line,
        );
      }
      colors[name] = color;
    }
  }
  return colors;
}

/**
 * Split a text into the lines that get drawn. ` / ` always breaks a line, and
 * `(wrap: n)` additionally folds each of those at word boundaries, which is
 * what stops a long note running across the whole diagram.
 *
 * The wrap is a character count rather than a distance. It says how much text
 * fits on a line, not where anything sits, so it stays a property of the text
 * and never becomes a coordinate in disguise.
 *
 * Markup is read off first, so everything downstream works in runs: a break or
 * a fold inside a marked-up stretch carries the mark onto both lines, which is
 * what makes markup general where the `subtext:` slice it replaced could only
 * ever reach the tail of a text.
 */
function linesFor(text: string, textAttrs: Attrs, subject: string, line: number): Line[] {
  const lines = splitRuns(parseMarkup(text, subject, line));
  const stated = textAttrs['wrap'];
  if (stated === undefined) return lines;

  const columns = Number(stated);
  if (!Number.isInteger(columns) || columns < 1) {
    throw new SourceError(`wrap must be a whole number of characters, not "${stated}"`, line);
  }
  return lines.flatMap((part) => wrapLine(part, columns));
}

function bounds(nodes: LayoutNode[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { minX, minY, maxX, maxY };
}

/** Shift everything so the diagram starts at the margin rather than wherever the anchor fell. */
function normalize(nodes: LayoutNode[], margin: number): void {
  const { minX, minY } = bounds(nodes);
  const dx = margin - minX;
  const dy = margin - minY;
  for (const node of nodes) {
    node.x += dx;
    node.y += dy;
  }
}
