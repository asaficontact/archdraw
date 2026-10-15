/**
 * Findings: things about a drawn picture that may look wrong. An error means
 * the file can't be drawn; a finding means "look at this". A render with
 * findings succeeds.
 *
 * Every finding is measured off the solved layout, never fixed by moving
 * anything: the picture is drawn as written, and this says where it may not
 * read as the writer meant.
 */
import type { Layout, LayoutNode } from './model.js';
import { UNIT } from './constants.js';

/**
 * The kinds of finding, each with whether it is on when nothing says. Named in
 * the language's own nouns, since the name is what a writer types to turn one
 * off. Crossings are often fine, so they are off; the rest are almost always a
 * fault, so an agent that never thinks to ask still hears about them.
 */
export const CHECK_DEFAULTS = {
  'text-overlap': true,
  'text-overflow': true,
  'edge-node-overlap': true,
  'crowded-edge-ends': true,
  'node-overlap': true,
  'edge-no-length': true,
  'edge-crossings': false,
} as const;

export type CheckKind = keyof typeof CHECK_DEFAULTS;

export const CHECK_KINDS = Object.keys(CHECK_DEFAULTS) as CheckKind[];

/** Which kinds run. */
export type Checks = Record<CheckKind, boolean>;

export function isCheckKind(word: string): word is CheckKind {
  return Object.hasOwn(CHECK_DEFAULTS, word);
}

/** One finding: the statement at fault, the kind, and what happened. */
export class Finding {
  constructor(
    readonly kind: CheckKind,
    readonly message: string,
    readonly line: number,
  ) {}

  /** `diagram.reladraw:12: warning(node-overlap): …` — the form compilers and editors already read. */
  format(file?: string): string {
    const where = file ? `${file}:${this.line}` : `line ${this.line}`;
    return `${where}: warning(${this.kind}): ${this.message}`;
  }
}

/**
 * `edge-crossings: on, crowded-edge-ends: off` — the inside of a `checks:`
 * bracket, as `--checks` takes it, laid over `base`. A kind not mentioned
 * keeps what `base` says.
 */
export function readChecks(text: string, base: Checks): Checks {
  const checks = { ...base };
  for (const entry of text.split(',')) {
    const match = /^\s*([^:\s]+)\s*:\s*(\S+)\s*$/.exec(entry);
    if (match === null) {
      throw new Error(`checks are written "kind: on" or "kind: off", found "${entry.trim()}"`);
    }
    const [, kind, value] = match;
    setCheck(checks, kind!, value!, (message) => new Error(message));
  }
  return checks;
}

/**
 * The checks a layout asks for: the defaults, then the file's
 * `diagram checks: (…)`, which arrives flattened as `checks.<kind>` and was
 * refused by the parser if it named no kind.
 */
export function fileChecks(layout: Layout): Checks {
  const checks: Checks = { ...CHECK_DEFAULTS };
  for (const [key, value] of Object.entries(layout.diagram)) {
    const kind = key.slice('checks.'.length);
    if (key.startsWith('checks.') && isCheckKind(kind)) checks[kind] = value === 'on';
  }
  return checks;
}

/** One `kind: on|off`, refused by name if either word is wrong. */
export function setCheck(checks: Checks, kind: string, value: string, fail: (message: string) => Error): void {
  if (!isCheckKind(kind)) {
    const near = nearMatch(kind, CHECK_KINDS);
    throw fail(
      `there is no check called "${kind}"` +
        (near ? ` — did you mean ${near}?` : ` — the checks are ${CHECK_KINDS.join(', ')}`),
    );
  }
  if (value !== 'on' && value !== 'off') {
    throw fail(`${kind}: takes on or off, not "${value}"`);
  }
  checks[kind] = value === 'on';
}

/** Every finding the layout has, for the kinds that are on, in line order. */
export function findings(layout: Layout, checks: Checks): Finding[] {
  const found: Finding[] = [];
  if (checks['node-overlap']) found.push(...nodeOverlaps(layout));
  if (checks['text-overflow']) found.push(...textOverflows(layout));
  return found.sort((a, b) => a.line - b.line);
}

/**
 * A text that runs out of the box it belongs inside: a leaf's text, or a
 * title placed inside the border or in the middle. A stated size is kept even
 * when the text needs more, so the text is drawn spilling and this says so.
 */
function textOverflows(layout: Layout): Finding[] {
  const found: Finding[] = [];
  for (const node of layout.nodes) {
    if (node.body.kind !== 'shape') continue;
    const text = node.textBox;
    if (text.width <= 0 || text.height <= 0) continue;
    const place = node.textAttrs['place'];
    if (node.children.length > 0 && place !== undefined && place !== 'center' && !place.startsWith('inside')) continue;
    const spill = {
      left: Math.max(0, -text.x),
      right: Math.max(0, text.x + text.width - node.width),
      top: Math.max(0, -text.y),
      bottom: Math.max(0, text.y + text.height - node.height),
    };
    const sides = (Object.keys(spill) as (keyof typeof spill)[]).filter((side) => spill[side] > EPSILON);
    if (sides.length === 0) continue;
    const wider = spill.left + spill.right;
    const taller = spill.top + spill.bottom;
    const needs = [
      wider > EPSILON ? `${units(wider)} more width` : '',
      taller > EPSILON ? `${units(taller)} more height` : '',
    ].filter((part) => part.length > 0);
    const named =
      sides.length === 4
        ? 'every side'
        : sides.length === 1
          ? `the ${sides[0]} side`
          : `the ${sides.slice(0, -1).join(', ')} and ${sides[sides.length - 1]} sides`;
    found.push(
      new Finding(
        'text-overflow',
        `the text of node ${node.name} runs past ${named} of its box; it needs ${needs.join(' and ')}`,
        node.line,
      ),
    );
  }
  return found;
}

/**
 * Two nodes on one spot that nothing accounts for. A node and what it holds
 * overlap by being nested; one placed `on` or `inside` another overlaps it
 * because the file said so; `overlap: allow` says so for every pair a node is
 * in. Anything else sharing space is reported, against the later of the two,
 * since that is the statement that put it there.
 *
 * Found with a sweep across the page rather than by trying every pair, so a
 * large diagram costs little more than the overlaps it actually has.
 */
function nodeOverlaps(layout: Layout): Finding[] {
  const byName = new Map(layout.nodes.map((node) => [node.name, node]));
  const stated = new Map<LayoutNode, Set<LayoutNode>>();
  for (const node of layout.nodes) {
    for (const placement of node.placements) {
      if (placement.kind !== 'on' && !(placement.kind === 'offset' && placement.written === 'inside')) continue;
      for (const target of placement.targets) {
        const other = byName.get(target.name);
        if (other === undefined) continue;
        const set = stated.get(node) ?? new Set();
        set.add(other);
        stated.set(node, set);
      }
    }
  }
  const lineage = (node: LayoutNode): LayoutNode[] => {
    const chain: LayoutNode[] = [];
    for (let at: LayoutNode | undefined = node; at; at = at.parent) chain.push(at);
    return chain;
  };
  const accounted = (a: LayoutNode, b: LayoutNode): boolean => {
    const upA = lineage(a);
    const upB = lineage(b);
    if (upA.includes(b) || upB.includes(a)) return true;
    if (upA.some(saysOverlapAllowed) || upB.some(saysOverlapAllowed)) return true;
    const placedOn = (over: LayoutNode[], under: LayoutNode[]) =>
      over.some((node) => under.some((target) => stated.get(node)?.has(target)));
    return placedOn(upA, upB) || placedOn(upB, upA);
  };

  const pairs: Array<{ earlier: LayoutNode; later: LayoutNode; width: number; height: number }> = [];
  const sorted = [...layout.nodes].sort((a, b) => a.x - b.x);
  let active: LayoutNode[] = [];
  for (const node of sorted) {
    active = active.filter((other) => other.x + other.width > node.x + EPSILON);
    for (const other of active) {
      const width = Math.min(node.x + node.width, other.x + other.width) - Math.max(node.x, other.x);
      const height = Math.min(node.y + node.height, other.y + other.height) - Math.max(node.y, other.y);
      if (width <= EPSILON || height <= EPSILON) continue;
      if (accounted(node, other)) continue;
      const [earlier, later] = other.line <= node.line ? [other, node] : [node, other];
      pairs.push({ earlier, later, width, height });
    }
    active.push(node);
  }

  // A box over a container is over whatever of its children it reaches too,
  // and saying so for each child repeats the one fact. Only the outermost
  // pair is reported.
  const reported = new Set(pairs.map(({ earlier, later }) => namePair(earlier, later)));
  const inner = ({ earlier, later }: (typeof pairs)[number]): boolean =>
    lineage(earlier).some((a) => lineage(later).some((b) => (a !== earlier || b !== later) && reported.has(namePair(a, b))));
  return pairs
    .filter((pair) => !inner(pair))
    .map(
      ({ earlier, later, width, height }) =>
        new Finding(
          'node-overlap',
          `node ${later.name} covers ${coveredPart(earlier, later)}node ${earlier.name}; ${size(width, height)}`,
          later.line,
        ),
    );
}

function namePair(a: LayoutNode, b: LayoutNode): string {
  return a.name < b.name ? `${a.name}\n${b.name}` : `${b.name}\n${a.name}`;
}

/** Shared space smaller than this is two edges meeting, not an overlap. */
const EPSILON = 0.5;

function saysOverlapAllowed(node: LayoutNode): boolean {
  return node.attrs['overlap'] === 'allow';
}

/**
 * Which of the nine positions of `under` that `over` covers, worded to go
 * before the node: "the top-left corner of ", "the left side of ", "all of ".
 * Along each axis the covered stretch is at the near end if it reaches that
 * edge and not the far one, the far end the other way round, and the middle
 * otherwise.
 */
function coveredPart(under: LayoutNode, over: LayoutNode): string {
  const along = (start: number, extent: number, overStart: number, overExtent: number) => {
    const near = overStart <= start + EPSILON;
    const far = overStart + overExtent >= start + extent - EPSILON;
    if (near && far) return 'all';
    if (near) return 'near';
    if (far) return 'far';
    return 'middle';
  };
  const x = along(under.x, under.width, over.x, over.width);
  const y = along(under.y, under.height, over.y, over.height);
  if (x === 'all' && y === 'all') return 'all of ';
  const across = { near: 'left', far: 'right', middle: '', all: '' }[x];
  const down = { near: 'top', far: 'bottom', middle: '', all: '' }[y];
  if (across && down) return `the ${down}-${across} corner of `;
  if (down) return `the ${down} of `;
  if (across) return `the ${across} side of `;
  if (x === 'all') return 'a band across the middle of ';
  if (y === 'all') return 'a band down the middle of ';
  return 'the center of ';
}

/** "the overlap is 3 units wide and 2 units tall", in the file's unit. */
function size(width: number, height: number): string {
  return `the overlap is ${units(width)} wide and ${units(height)} tall`;
}

function units(pixels: number): string {
  const count = Math.round(pixels / UNIT);
  if (count === 0) return 'less than a unit';
  return count === 1 ? '1 unit' : `${count} units`;
}

/** The one word in `words` a slip of a letter or two away from `word`, if there is one. */
export function nearMatch(word: string, words: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of words) {
    const distance = editDistance(word, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}
