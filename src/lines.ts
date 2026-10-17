/**
 * Where every line goes (design.org section 6).
 *
 * A line is worked out from the things its statement names and nothing else:
 * its two boxes, the sides or points it names, the places it passes, and its
 * own bracket. Nothing is avoided and nothing is searched for, so the same
 * statement draws the same line wherever it sits, and adding a box elsewhere
 * never moves it. Two things are shared between lines: a side, where several
 * ends spread (6.2), and a named line or leg, which others may end on or pass
 * beside, so it is drawn first.
 *
 * The renderer draws what this returns and the findings measure it, so the two
 * can't disagree about where a line is.
 */
import { GAPS } from './constants.js';
import { PART_SIDES, WAYS, isPosition, type Position, type ViaStop, type Way as WayWord } from './ast.js';
import { SourceError } from './errors.js';
import type { Attrs } from './ast.js';
import type { Layout, LayoutEdge, LayoutNode, Rect } from './model.js';
import { gapPixels } from './place.js';

export interface Point {
  x: number;
  y: number;
}

/** A rectangle as drawn: the node's face, which differs from its box only for a deck. */
export interface Face {
  x: number;
  y: number;
  width: number;
  height: number;
  /** A circle is drawn in this square, so a line meets the circle. */
  round: boolean;
}

export type Side = 'top' | 'bottom' | 'left' | 'right';

/** One piece of a drawn line, from where the last one ended: straight, or a cubic. */
export type Piece = { to: Point } | { c1: Point; c2: Point; to: Point };

/** One line, worked out. */
export interface Route {
  edge: LayoutEdge;
  /** Where the line starts; each piece runs on from the end of the one before. */
  start: Point;
  pieces: Piece[];
  /**
   * The line's corners, ends included: two points for a straight line, the
   * square route's corners for a square one, and for a curved one the points
   * the curve passes through.
   */
  points: Point[];
  /** Each named leg, as drawn, in the direction the line travels. */
  legs: Map<string, Point[]>;
  /** Each stop the line passes, as written, and the points it put on the line: `req b top` finds its run here (4.6). */
  stops: { written: string; points: Point[] }[];
}

/** What an end says, read from `from:` or `to:`. */
type EndSpec =
  | { kind: 'side'; side: Side; implied: boolean; after?: { name: string; way: OrderWay } }
  | { kind: 'point'; position: Position }
  | { kind: 'fraction'; side: Side; value: number; written: string }
  | { kind: 'center' }
  /** `to: down from z3`: where the line straight down from z3's center meets this end's box or line. */
  | { kind: 'aligned'; way: WayWord; name: string; written: string }
  /** `straight down` on the edge, at its start: leaving its own box that way, from its center. */
  | { kind: 'own-way'; way: WayWord }
  /** `to: at 1/3`, `to: climb at 1/3`, `from: req end`: a point on a line or a leg. */
  | { kind: 'online'; line?: string; at: number | 'start' | 'end'; written: string }
  /** Nothing said, and the far end is on a line: the side facing that point, once the line is drawn. */
  | { kind: 'facing-point' };

type OrderWay = 'left of' | 'right of' | 'above' | 'below';

/** One end of one line, as it is being worked out. */
interface End {
  edge: LayoutEdge;
  which: 'from' | 'to';
  node: LayoutNode;
  face: Face;
  far: LayoutNode;
  spec: EndSpec;
  /** The line this end stands on, when the statement names a line rather than a box. */
  onLine?: LayoutEdge;
  /** The point it lands on, once known. */
  at?: Point;
  /** The headings it may take, pointing out of its box: one for a side, two for a bare corner, none for a straight line. */
  headings: Point[];
}

/** Where every line in the layout goes. */
export function planLines(layout: Layout): Map<LayoutEdge, Route> {
  return planSides(layout).routes;
}

/** The ends sharing one side of one box, in their order along it. */
export interface SideEnds {
  node: LayoutNode;
  side: Side;
  /** Where each end landed, in order along the side, and the line it belongs to. */
  ends: { at: Point; edge: LayoutEdge }[];
}

/** Every line, and every side two or more ends share, for the findings to measure. */
export function planSides(layout: Layout): { routes: Map<LayoutEdge, Route>; sides: SideEnds[] } {
  const legs = legOwners(layout);
  const lines = new Map(layout.edges.filter((edge) => edge.name !== undefined).map((edge) => [edge.name!, edge]));
  const ends = new Map<LayoutEdge, [End, End]>();
  for (const edge of layout.edges) ends.set(edge, [endOf(edge, 'from'), endOf(edge, 'to')]);

  // Ends spread along a side first, since where an end lands on a shared side
  // depends on the others there.
  const sides = spreadSides([...ends.values()].flat());
  const routes = new Map<LayoutEdge, Route>();
  const context: Context = { layout, legs, lines, ends, routes };

  // A line others end on or pass beside is drawn before them (6.2). A loop of
  // lines each needing the next has no first line, and is refused.
  const done = new Set<LayoutEdge>();
  const working: LayoutEdge[] = [];
  const draw = (edge: LayoutEdge): void => {
    if (done.has(edge)) return;
    if (working.includes(edge)) {
      const loop = [...working.slice(working.indexOf(edge)), edge].map((one) => one.name ?? describeEdge(one));
      throw new SourceError(
        `line ${loop[0]} needs ${loop.slice(1).join(', which needs ')} to be drawn first — a loop of lines each ending on or running beside the next can't be drawn`,
        edge.line,
      );
    }
    working.push(edge);
    for (const other of needs(edge, context)) draw(other);
    working.pop();
    const [start, end] = ends.get(edge)!;
    for (const one of [start, end]) placeEnd(one, context);
    for (const [own, other] of [[start, end], [end, start]] as [End, End][]) faceThePoint(own, other);
    for (const [own, other] of [[start, end], [end, start]] as [End, End][]) aimCenter(own, other);
    routes.set(edge, route(edge, start, end, context));
    done.add(edge);
  };
  for (const edge of layout.edges) draw(edge);
  // Back in the order written, which is the order lines are drawn and cross.
  return { routes: new Map(layout.edges.map((edge) => [edge, routes.get(edge)!])), sides };
}

interface Context {
  layout: Layout;
  /** Every leg name, and the line it belongs to. */
  legs: Map<string, LayoutEdge>;
  /** Every line name, and the line. */
  lines: Map<string, LayoutEdge>;
  ends: Map<LayoutEdge, [End, End]>;
  routes: Map<LayoutEdge, Route>;
}

/** Every named leg, refusing a name used twice or already a box's or a line's. */
function legOwners(layout: Layout): Map<string, LayoutEdge> {
  const owners = new Map<string, LayoutEdge>();
  const boxes = new Set(layout.nodes.map((node) => node.name));
  const lines = new Set(layout.edges.map((edge) => edge.name).filter((name) => name !== undefined));
  for (const edge of layout.edges) {
    for (const entry of edge.via ?? []) {
      const name = entry.leg?.name;
      if (name === undefined) continue;
      if (owners.has(name) || boxes.has(name) || lines.has(name)) {
        const was = owners.has(name) ? `a leg of line ${describeEdge(owners.get(name)!)}` : boxes.has(name) ? "a node's name" : "a line's name";
        throw new SourceError(`edge ${describeEdge(edge)}: leg ${name} is already ${was} — a name belongs to one thing`, edge.line);
      }
      owners.set(name, edge);
    }
  }
  return owners;
}

/** The lines a line needs drawn before it: those it ends on, passes a point of, or runs beside. */
function needs(edge: LayoutEdge, context: Context): LayoutEdge[] {
  const named = (name: string | undefined): LayoutEdge | undefined =>
    name === undefined ? undefined : (context.lines.get(name) ?? context.legs.get(name));
  const found: LayoutEdge[] = [];
  for (const end of context.ends.get(edge)!) {
    if (end.onLine) found.push(end.onLine);
    if (end.spec.kind === 'online') {
      const line = named(end.spec.line);
      if (line) found.push(line);
    }
    if (end.spec.kind === 'aligned' && context.lines.has(end.spec.name)) found.push(context.lines.get(end.spec.name)!);
  }
  for (const entry of edge.via ?? []) {
    const stop = entry.stop;
    if (stop?.kind === 'online') {
      const line = named(stop.line);
      if (line) found.push(line);
    }
    if (stop?.kind === 'alongside') {
      const line = context.legs.get(stop.leg);
      if (!line) {
        throw new SourceError(`edge ${describeEdge(edge)}: "via: ${stop.written}" — there is no leg named ${stop.leg}; name one in a via: list with \`leg ${stop.leg}\``, edge.line);
      }
      found.push(line);
    }
  }
  return found.filter((other) => other !== edge || refuseOwn(edge));
}

function refuseOwn(edge: LayoutEdge): never {
  throw new SourceError(`edge ${describeEdge(edge)}: a line can't end on, pass a point of, or run beside itself`, edge.line);
}

// --- reading an end -----------------------------------------------------------

const SIDE_NORMAL: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** The way a line goes, as a unit vector. */
const WAY_VECTOR: Record<WayWord, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** The side a line traveling one way meets first: going down, a box's top. */
const MET_SIDE: Record<WayWord, Side> = { down: 'top', up: 'bottom', left: 'right', right: 'left' };

/** The drawn rectangle of a node. */
export function faceOfNode(node: LayoutNode): Face {
  return {
    x: node.x + node.inset,
    y: node.y + node.inset,
    width: node.width - node.inset,
    height: node.height - node.inset,
    round: node.body.kind === 'shape' && node.body.outline === 'circle',
  };
}

function endOf(edge: LayoutEdge, which: 'from' | 'to'): End {
  const node = which === 'from' ? edge.from : edge.to;
  const far = which === 'from' ? edge.to : edge.from;
  const onLine = edge.onLine?.[which];
  const face = faceOfNode(node);
  const written = edge.attrs[which];
  const subject = `edge ${describeEdge(edge)}`;
  if (edge.straight !== undefined && written !== undefined) {
    throw new SourceError(
      `${subject}: "straight ${edge.straight}" says where both ends are, so "${which}: ${written}" says it twice — keep one`,
      edge.line,
    );
  }
  let spec: EndSpec;
  if (edge.straight !== undefined) {
    spec = which === 'from'
      ? { kind: 'own-way', way: edge.straight }
      : { kind: 'aligned', way: edge.straight, name: edge.from.name, written: `straight ${edge.straight}` };
  } else if (onLine) {
    spec = written === undefined ? { kind: 'online', at: 1 / 2, written: 'its middle' } : readEnd(written, edge, which);
    if (spec.kind !== 'online' && spec.kind !== 'aligned') {
      throw new SourceError(
        `${subject}: "${which}: ${written}" names a part of a box, and ${node.name} is a line — say how far along it, such as ${which}: at 1/3`,
        edge.line,
      );
    }
  } else {
    const farOnLine = edge.onLine?.[which === 'from' ? 'to' : 'from'] !== undefined;
    spec = written !== undefined
      ? readEnd(written, edge, which)
      : farOnLine
        ? { kind: 'facing-point' }
        : facingSpec(edge, which, node, far);
  }
  const end: End = { edge, which, node, face, far, spec, ...(onLine ? { onLine } : {}), headings: [] };
  if (spec.kind === 'side' || spec.kind === 'fraction') end.headings = [SIDE_NORMAL[spec.side]];
  if (spec.kind === 'fraction') end.at = fractionPoint(face, spec.side, spec.value);
  if (spec.kind === 'point') {
    end.at = positionPoint(face, spec.position);
    const [vertical, horizontal] = cornerSides(spec.position);
    if (vertical && horizontal) end.headings = [SIDE_NORMAL[vertical], SIDE_NORMAL[horizontal]];
    else if (vertical) end.headings = [SIDE_NORMAL[vertical]];
    else if (horizontal) end.headings = [SIDE_NORMAL[horizontal]];
  }
  if (spec.kind === 'own-way') {
    // Out of its own side that way, from the middle of it.
    const side = MET_SIDE[opposite(spec.way)];
    end.at = onSide(face, side, side === 'top' || side === 'bottom' ? face.x + face.width / 2 : face.y + face.height / 2);
    end.headings = [SIDE_NORMAL[side]];
  }
  return end;
}

function opposite(way: WayWord): WayWord {
  return ({ up: 'down', down: 'up', left: 'right', right: 'left' } as const)[way];
}

/**
 * `top`, `left 3/4 down`, `bottom 1/4 across from right`, `top, right of z`,
 * `bottom-center`, `center`, `down from z3`, `at 1/3`, `climb at 1/3`,
 * `req end`, as the parser stored them.
 */
function readEnd(written: string, edge: LayoutEdge, which: 'from' | 'to'): EndSpec {
  const subject = `edge ${describeEdge(edge)}`;
  const [head, order] = splitOnce(written, ',');
  const words = head.trim().split(/\s+/);
  const first = words[0]!;
  if (first === 'center' && words.length === 1 && order === undefined) return { kind: 'center' };
  if (isPosition(first) && words.length === 1 && order === undefined) return { kind: 'point', position: first };
  if ((WAYS as readonly string[]).includes(first) && words[1] === 'from' && words.length === 3) {
    return { kind: 'aligned', way: first as WayWord, name: words[2]!, written };
  }
  if (first === 'at' && words.length === 2) {
    const value = fractionOf(words[1]!);
    if (value !== undefined) return { kind: 'online', at: value, written };
  }
  if (words[1] === 'at' && words.length === 3) {
    const value = fractionOf(words[2]!);
    if (value !== undefined) return { kind: 'online', line: first, at: value, written };
  }
  if ((words[1] === 'start' || words[1] === 'end') && words.length === 2) {
    return { kind: 'online', line: first, at: words[1], written };
  }
  if (!isSide(first)) {
    throw new SourceError(
      `${subject}: "${which}: ${written}" is not a side or a point — write a side (${PART_SIDES.join(', ')}), ` +
        'a point such as bottom-center, a side and how far along it such as left 3/4 down, or center',
      edge.line,
    );
  }
  if (words.length > 1) {
    const fraction = readFractionWords(words.slice(1));
    if (fraction === undefined) {
      throw new SourceError(
        `${subject}: "${which}: ${written}" — after the side comes how far along it, such as ${which}: ${first} ${first === 'left' || first === 'right' ? '3/4 down' : '1/4 across'}`,
        edge.line,
      );
    }
    const runs = first === 'left' || first === 'right' ? ['down', 'up'] : ['across'];
    if (!runs.includes(fraction.along)) {
      throw new SourceError(
        `${subject}: "${which}: ${written}" names no point — ${fraction.along} doesn't run along a ${first} side; ` +
          `it takes ${runs.join(' or ')}`,
        edge.line,
      );
    }
    if (order !== undefined) {
      throw new SourceError(
        `${subject}: "${which}: ${written}" — an end a fraction along a side is already one point, so it has no place among the others to state`,
        edge.line,
      );
    }
    const value = fraction.along === 'up' || fraction.from === 'right' ? 1 - fraction.value : fraction.value;
    return { kind: 'fraction', side: first, value, written: head.trim() };
  }
  if (order === undefined) return { kind: 'side', side: first, implied: false };
  // `top, right of z`: this end's place among the others on the side.
  const ways: OrderWay[] = first === 'top' || first === 'bottom' ? ['left of', 'right of'] : ['above', 'below'];
  const match = /^\s*(left of|right of|above|below)\s+(\S+)\s*$/.exec(order);
  if (match === null || !ways.includes(match[1] as OrderWay)) {
    throw new SourceError(
      `${subject}: "${which}: ${written}" — after the comma comes this end's place among the others on the ${first} side: ` +
        `${ways.map((way) => `${way} <line>`).join(' or ')}`,
      edge.line,
    );
  }
  return { kind: 'side', side: first, implied: false, after: { way: match[1] as OrderWay, name: match[2]! } };
}

function fractionOf(amount: string): number | undefined {
  const ratio = /^(\d+)\/(\d+)$/.exec(amount);
  const value = ratio
    ? Number(ratio[2]) === 0
      ? undefined
      : Number(ratio[1]) / Number(ratio[2])
    : /^\d*\.?\d+$/.test(amount)
      ? Number(amount)
      : undefined;
  return value !== undefined && value >= 0 && value <= 1 ? value : undefined;
}

function readFractionWords(words: string[]): { value: number; along: string; from?: string } | undefined {
  const [amount, along, fromWord, side] = words;
  if (amount === undefined || along === undefined) return undefined;
  const value = fractionOf(amount);
  if (value === undefined) return undefined;
  if (along !== 'down' && along !== 'up' && along !== 'across') return undefined;
  if (fromWord === undefined) return words.length === 2 ? { value, along } : undefined;
  if (along !== 'across' || fromWord !== 'from' || (side !== 'left' && side !== 'right') || words.length !== 4) return undefined;
  return { value, along, from: side };
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, undefined] : [text.slice(0, at), text.slice(at + 1)];
}

function isSide(word: string): word is Side {
  return word === 'top' || word === 'bottom' || word === 'left' || word === 'right';
}

/**
 * The side facing the other box, for an end nothing was said about.
 *
 * Boxes that share a stretch across face each other top to bottom, and boxes
 * that share a stretch up and down face each other side to side. Boxes placed
 * diagonally share neither; the facing side is the one the line between their
 * centers crosses.
 */
function facingSpec(edge: LayoutEdge, which: 'from' | 'to', node: LayoutNode, far: LayoutNode): EndSpec {
  if (holds(node, far) || holds(far, node)) {
    throw new SourceError(
      `edge ${describeEdge(edge)}: ${far.name} is ${holds(node, far) ? 'inside' : 'around'} ${node.name}, so no side of ${node.name} faces it — ` +
        `name the side, such as ${which}: ${holds(node, far) ? 'top' : 'bottom'}`,
      edge.line,
    );
  }
  const own = faceOfNode(node);
  const other = faceOfNode(far);
  const overlapX = own.x < other.x + other.width && other.x < own.x + own.width;
  const overlapY = own.y < other.y + other.height && other.y < own.y + own.height;
  const from = centerOf(own);
  const to = centerOf(other);
  let side: Side;
  if (overlapX && !overlapY) side = to.y >= from.y ? 'bottom' : 'top';
  else if (overlapY && !overlapX) side = to.x >= from.x ? 'right' : 'left';
  else {
    // Diagonal, or one on top of the other: the side the line between the centers crosses.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    side =
      Math.abs(dx) * own.height >= Math.abs(dy) * own.width
        ? dx >= 0
          ? 'right'
          : 'left'
        : dy >= 0
          ? 'bottom'
          : 'top';
  }
  return { kind: 'side', side, implied: true };
}

/** Whether `outer` holds `inner`, at any depth. */
function holds(outer: LayoutNode, inner: LayoutNode): boolean {
  for (let at = inner.parent; at; at = at.parent) if (at === outer) return true;
  return false;
}

// --- ends that need other lines, or the far end -----------------------------------

/**
 * An end on a line, on a point of one, or lined up with another thing: worked
 * out once the lines it needs are drawn.
 */
function placeEnd(end: End, context: Context): void {
  const subject = `edge ${describeEdge(end.edge)}`;
  const spec = end.spec;
  if (spec.kind === 'online') {
    if (end.onLine) {
      // `edge log audit -> req  to: at 1/3`, `to: climb at 1/3` naming a leg
      // of req, or `edge x d -> climb`, ending on the leg itself.
      const name = spec.line ?? end.node.name;
      const owner = context.lines.get(name) ?? context.legs.get(name);
      if (owner !== end.onLine || (spec.line !== undefined && context.legs.has(end.node.name))) {
        throw new SourceError(
          `${subject}: "${end.which}: ${spec.written}" — ${name} is not ${end.node.name}${context.legs.has(end.node.name) ? '' : ' or one of its legs'}, and this end is on ${end.node.name}`,
          end.edge.line,
        );
      }
      const trace = traceNamed(name, context, subject, end.edge.line);
      end.at = alongLength(trace, spec.at);
      standOnLine(end, trace);
      return;
    }
    // `from: req end` on a box: where req ends, which must be on this box.
    const line = spec.line === undefined ? undefined : context.lines.get(spec.line);
    if (line === undefined || typeof spec.at === 'number') {
      throw new SourceError(
        `${subject}: "${end.which}: ${spec.written}" — a point along a line is not on ${end.node.name}; ` +
          `to end on the line, name it in place of the box, such as \`edge ${end.which === 'from' ? `${spec.line ?? 'req'} -> ${end.far.name}` : `${end.far.name} -> ${spec.line ?? 'req'}`}  ${end.which}: at 1/3\``,
        end.edge.line,
      );
    }
    const [lineStart, lineEnd] = context.ends.get(line)!;
    const target = spec.at === 'start' ? lineStart : lineEnd;
    if (target.node !== end.node) {
      throw new SourceError(
        `${subject}: the line ${end.which === 'from' ? 'starts' : 'ends'} at ${end.node.name}, but ${spec.line}'s ${spec.at} is on ${target.node.name}`,
        end.edge.line,
      );
    }
    end.at = target.at ?? centerOf(end.face);
    end.headings = [headingAt(end.face, end.at)];
    return;
  }
  if (spec.kind === 'aligned') {
    // The line straight `way` from the named thing's center, and where it first meets this end's box or line.
    const from = context.layout.nodes.find((node) => node.name === spec.name);
    const fromLine = context.lines.get(spec.name);
    if (from === undefined && fromLine === undefined) {
      throw new SourceError(`${subject}: "${end.which}: ${spec.written}" names ${spec.name}, which does not exist`, end.edge.line);
    }
    const origin = from ? centerOf(faceOfNode(from)) : alongLength(traceRoute(context.routes.get(fromLine!)!), 1 / 2);
    const way = WAY_VECTOR[spec.way];
    if (end.onLine) {
      const hit = rayHit(origin, way, traceRoute(context.routes.get(end.onLine)!));
      if (hit === undefined) {
        throw new SourceError(`${subject}: the line straight ${spec.way} from ${spec.name} never meets ${end.onLine.name} — nothing is bent to reach it`, end.edge.line);
      }
      end.at = hit;
      standOnLine(end, traceRoute(context.routes.get(end.onLine)!));
      return;
    }
    const side = MET_SIDE[spec.way];
    const across = side === 'top' || side === 'bottom';
    const coordinate = across ? origin.x : origin.y;
    const low = across ? end.face.x : end.face.y;
    const high = across ? end.face.x + end.face.width : end.face.y + end.face.height;
    const point = onSide(end.face, side, coordinate);
    const ahead = (point.x - origin.x) * way.x + (point.y - origin.y) * way.y;
    if (coordinate < low - 0.5 || coordinate > high + 0.5 || ahead < -0.5) {
      throw new SourceError(
        `${subject}: the line straight ${spec.way} from ${spec.name}'s center never meets ${end.node.name} — ` +
          `${ahead < -0.5 ? `${end.node.name} is not ${spec.way} from it` : `it passes ${end.node.name}'s ${side} side`}; nothing is bent to reach it`,
        end.edge.line,
      );
    }
    end.at = point;
    end.headings = [SIDE_NORMAL[side]];
  }
}

/** A line ending on another line heads square off it, toward its own far end. */
function standOnLine(end: End, trace: Point[]): void {
  const at = end.at!;
  end.face = { x: at.x, y: at.y, width: 0, height: 0, round: false };
  end.node.x = at.x;
  end.node.y = at.y;
  const along = directionAt(trace, at);
  const toward = centerOf(faceOfNode(end.far));
  // The axis across the line it stands on, or the nearer one where it runs aslant.
  const normal = Math.abs(along.x) >= Math.abs(along.y) ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const sign = (toward.x - at.x) * normal.x + (toward.y - at.y) * normal.y >= 0 ? 1 : -1;
  end.headings = [{ x: normal.x * sign, y: normal.y * sign }];
}

/**
 * A box end with nothing said whose far end is on a line takes the side facing
 * that point, by the same rule as facing a box, landing at its middle.
 */
function faceThePoint(own: End, other: End): void {
  if (own.spec.kind !== 'facing-point') return;
  const point = other.at!;
  const spec = facingSpec(own.edge, own.which, own.node, {
    ...own.far,
    x: point.x,
    y: point.y,
    width: 0,
    height: 0,
    inset: 0,
    parent: undefined,
  } as LayoutNode);
  const side = (spec as { side: Side }).side;
  const face = own.face;
  own.at = onSide(face, side, side === 'top' || side === 'bottom' ? face.x + face.width / 2 : face.y + face.height / 2);
  own.headings = [SIDE_NORMAL[side]];
}

/** A center end aims from the center at where the other end lands, or at its center if that is a center too. */
function aimCenter(own: End, other: End): void {
  if (own.spec.kind !== 'center') return;
  const target = other.spec.kind === 'center' ? centerOf(other.face) : (other.at ?? centerOf(other.face));
  own.at = outlineToward(own.face, target);
  own.headings = [headingAt(own.face, own.at)];
}

/** A named line's trace, or a named leg's. */
function traceNamed(name: string, context: Context, subject: string, line: number): Point[] {
  const edge = context.lines.get(name);
  if (edge) return traceRoute(context.routes.get(edge)!);
  const owner = context.legs.get(name);
  if (owner) return context.routes.get(owner)!.legs.get(name)!;
  throw new SourceError(`${subject}: there is no line or leg named ${name}`, line);
}

/** The point a share of the way along a polyline, bends included, or its start or end. */
export function alongLength(trace: Point[], at: number | 'start' | 'end'): Point {
  if (at === 'start') return trace[0]!;
  if (at === 'end') return trace[trace.length - 1]!;
  let total = 0;
  for (let index = 1; index < trace.length; index += 1) total += distance(trace[index - 1]!, trace[index]!);
  let left = total * at;
  for (let index = 1; index < trace.length; index += 1) {
    const a = trace[index - 1]!;
    const b = trace[index]!;
    const piece = distance(a, b);
    if (piece >= left && piece > 0) return { x: a.x + ((b.x - a.x) * left) / piece, y: a.y + ((b.y - a.y) * left) / piece };
    left -= piece;
  }
  return trace[trace.length - 1]!;
}

/** The direction a polyline runs at the point on it nearest `at`. */
function directionAt(trace: Point[], at: Point): Point {
  let best = { x: 1, y: 0 };
  let nearest = Infinity;
  for (let index = 1; index < trace.length; index += 1) {
    const a = trace[index - 1]!;
    const b = trace[index]!;
    const length = distance(a, b);
    if (length === 0) continue;
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * (b.x - a.x) + (at.y - a.y) * (b.y - a.y)) / (length * length)));
    const off = distance({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, at);
    if (off < nearest) {
      nearest = off;
      best = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    }
  }
  return best;
}

/** Where a ray from `origin` along `way` first meets a polyline, if it does. */
function rayHit(origin: Point, way: Point, trace: Point[]): Point | undefined {
  let best: Point | undefined;
  let nearest = Infinity;
  for (let index = 1; index < trace.length; index += 1) {
    const a = trace[index - 1]!;
    const b = trace[index]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denominator = way.x * ey - way.y * ex;
    if (Math.abs(denominator) < 1e-9) continue;
    const t = ((a.x - origin.x) * ey - (a.y - origin.y) * ex) / denominator;
    const u = ((a.x - origin.x) * way.y - (a.y - origin.y) * way.x) / denominator;
    if (t < 0 || u < -1e-9 || u > 1 + 1e-9) continue;
    if (t < nearest) {
      nearest = t;
      best = { x: origin.x + way.x * t, y: origin.y + way.y * t };
    }
  }
  return best;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// --- points on a box ------------------------------------------------------------

export function centerOf(face: Face): Point {
  return { x: face.x + face.width / 2, y: face.y + face.height / 2 };
}

/** The sides a position sits on: `bottom-right` is on the bottom and the right, `top-center` on the top only. */
function cornerSides(position: Position): [Side | undefined, Side | undefined] {
  const vertical = position.startsWith('top') ? 'top' : position.startsWith('bottom') ? 'bottom' : undefined;
  const horizontal = position.endsWith('left') || position === 'left-center'
    ? 'left'
    : position.endsWith('right') || position === 'right-center'
      ? 'right'
      : undefined;
  return [vertical, horizontal];
}

function positionPoint(face: Face, position: Position): Point {
  const [vertical, horizontal] = cornerSides(position);
  const point = {
    x: horizontal === 'left' ? face.x : horizontal === 'right' ? face.x + face.width : face.x + face.width / 2,
    y: vertical === 'top' ? face.y : vertical === 'bottom' ? face.y + face.height : face.y + face.height / 2,
  };
  // A circle has no corners; its corner is where the diagonal meets it.
  if (face.round && vertical && horizontal) return outlineToward(face, point);
  return point;
}

/** A point a fraction of the way along a side, from its left or top end. */
function fractionPoint(face: Face, side: Side, value: number): Point {
  const along = side === 'top' || side === 'bottom' ? face.x + face.width * value : face.y + face.height * value;
  return onSide(face, side, along);
}

/** The point on a side at `along`, its coordinate along the side; on a circle, where the side's quarter is. */
function onSide(face: Face, side: Side, along: number): Point {
  if (face.round) {
    const radius = face.width / 2;
    const center = centerOf(face);
    const across = side === 'top' || side === 'bottom' ? along - center.x : along - center.y;
    const turn = Math.max(-Math.PI / 4, Math.min(Math.PI / 4, across / radius));
    const angle = { right: turn, bottom: Math.PI / 2 - turn, left: Math.PI - turn, top: -Math.PI / 2 + turn }[side];
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  }
  switch (side) {
    case 'top':
      return { x: along, y: face.y };
    case 'bottom':
      return { x: along, y: face.y + face.height };
    case 'left':
      return { x: face.x, y: along };
    case 'right':
      return { x: face.x + face.width, y: along };
  }
}

/** Where the line from the face's center toward `target` crosses its outline. */
function outlineToward(face: Face, target: Point): Point {
  const center = centerOf(face);
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) return { x: center.x, y: face.y };
  if (face.round) {
    const radius = face.width / 2;
    const length = Math.hypot(dx, dy);
    return { x: center.x + (dx / length) * radius, y: center.y + (dy / length) * radius };
  }
  const scale = Math.min(
    dx === 0 ? Infinity : face.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : face.height / 2 / Math.abs(dy),
  );
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

/** The outward heading of the side a point on the outline is on. */
function headingAt(face: Face, at: Point): Point {
  const distances: [number, Side][] = [
    [Math.abs(at.y - face.y), 'top'],
    [Math.abs(at.y - (face.y + face.height)), 'bottom'],
    [Math.abs(at.x - face.x), 'left'],
    [Math.abs(at.x - (face.x + face.width)), 'right'],
  ];
  if (face.round) {
    const center = centerOf(face);
    const dx = at.x - center.x;
    const dy = at.y - center.y;
    return Math.abs(dx) >= Math.abs(dy) ? SIDE_NORMAL[dx >= 0 ? 'right' : 'left'] : SIDE_NORMAL[dy >= 0 ? 'bottom' : 'top'];
  }
  distances.sort((a, b) => a[0] - b[0]);
  return SIDE_NORMAL[distances[0]![1]];
}

// --- several ends on one side ----------------------------------------------------
// --- several ends on one side ----------------------------------------------------

/**
 * Every end that names a side, or was given the facing one, lands on it spread
 * evenly, ordered by where its far box sits along the side (6.2). An end pinned
 * to a point of that side splits it: the spreading ends before it in that order
 * share the part before the point, the rest the part after.
 */
function spreadSides(ends: End[]): SideEnds[] {
  const shared: SideEnds[] = [];
  const groups = new Map<string, End[]>();
  for (const end of ends) {
    const side = sideOf(end);
    if (side === undefined) continue;
    const key = `${end.node.name}\n${side}`;
    const group = groups.get(key) ?? [];
    group.push(end);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const side = key.split('\n')[1] as Side;
    if (!group.some((end) => end.spec.kind === 'side')) continue;
    const across = side === 'top' || side === 'bottom';
    const face = group[0]!.face;
    const farAt = (end: End): number => {
      const center = centerOf(faceOfNode(end.far));
      return across ? center.x : center.y;
    };
    const along = (point: Point): number => (across ? point.x : point.y);
    // Written order breaks a tie, which is what keeps two copies of one line in step at both ends.
    const ordered = [...group].sort((a, b) => farAt(a) - farAt(b) || a.edge.line - b.edge.line);
    // `to: top, right of z`: an end that states its place moves just past the line it names.
    for (const end of group) {
      if (end.spec.kind !== 'side' || end.spec.after === undefined) continue;
      const { name, way } = end.spec.after;
      const anchor = ordered.find((other) => other !== end && other.edge.name === name);
      if (anchor === undefined) {
        throw new SourceError(
          `edge ${describeEdge(end.edge)}: "${end.which}: ${side}, ${way} ${name}" — no line named ${name} meets ${end.node.name}'s ${side} side`,
          end.edge.line,
        );
      }
      const before = way === 'left of' || way === 'above';
      ordered.splice(ordered.indexOf(end), 1);
      const at = ordered.indexOf(anchor);
      ordered.splice(before ? at : at + 1, 0, end);
    }
    const low = across ? face.x : face.y;
    const high = across ? face.x + face.width : face.y + face.height;
    let from = low;
    let run: End[] = [];
    const place = (to: number): void => {
      run.forEach((end, index) => {
        end.at = onSide(face, side, from + ((to - from) * (index + 1)) / (run.length + 1));
      });
      run = [];
    };
    for (const end of ordered) {
      if (end.spec.kind === 'side') {
        run.push(end);
        continue;
      }
      const pinned = along(end.at!);
      place(pinned);
      from = pinned;
    }
    place(high);
    if (ordered.length > 1) {
      shared.push({
        node: group[0]!.node,
        side,
        ends: ordered.map((end) => ({ at: end.at!, edge: end.edge })).sort((p, q) => along(p.at) - along(q.at)),
      });
    }
  }
  return shared;
}

/** The side an end lands on, for grouping: a side, a fraction along one, or a point in the middle of one. */
function sideOf(end: End): Side | undefined {
  const spec = end.spec;
  if (spec.kind === 'side' || spec.kind === 'fraction') return spec.side;
  if (spec.kind === 'point') {
    const [vertical, horizontal] = cornerSides(spec.position);
    if (vertical && horizontal) return undefined;
    return vertical ?? horizontal;
  }
  return undefined;
}

// --- the shape of one line --------------------------------------------------------

/** A point the line passes, with the way it travels there when that is fixed. */
interface Way {
  at: Point;
  /** The direction of travel at this point: out of a box at the start, along a side at a run. */
  dir?: Point;
  /** What the gaps are measured from: a box at an end, the point itself at a stop. */
  face: Face;
  /** The headings a bare corner may take, at an end; the first stretch or the last picks one. */
  choices?: Point[];
}

/** The part of a line between two neighboring points of its list. */
interface Segment {
  /** A stretch is shaped as a line between two boxes is (6.3); a run goes straight along a side, a region or a leg. */
  kind: 'stretch' | 'run';
  leg?: { name: string; attrs: Attrs };
}

function route(edge: LayoutEdge, start: End, end: End, context: Context): Route {
  const subject = `edge ${describeEdge(edge)}`;
  const ways: Way[] = [
    {
      at: start.at!,
      face: start.face,
      ...(start.headings.length === 1 ? { dir: start.headings[0]! } : {}),
      ...(start.headings.length > 1 ? { choices: start.headings } : {}),
    },
  ];
  const segments: Segment[] = [];
  let pending: { name: string; attrs: Attrs } | undefined;
  const pointLegs = new Map<string, Point>();
  const stops: Route['stops'] = [];
  for (const [index, entry] of (edge.via ?? []).entries()) {
    if (entry.leg && !entry.stop) {
      if (pending) {
        throw new SourceError(`${subject}: leg ${pending.name} and leg ${entry.leg.name} name the same stretch — keep one, or put a stop between them`, edge.line);
      }
      pending = entry.leg;
      continue;
    }
    const stop = entry.stop!;
    const prev = ways[ways.length - 1]!.at;
    const stopWays = expand(stop, edge.viaAt?.[index], prev, context, subject, edge.line);
    segments.push({ kind: 'stretch', ...(pending ? { leg: pending } : {}) });
    pending = undefined;
    ways.push(stopWays[0]!);
    for (const next of stopWays.slice(1)) {
      segments.push({ kind: 'run', ...(entry.leg ? { leg: entry.leg } : {}) });
      ways.push(next);
    }
    if (entry.leg && stopWays.length === 1) pointLegs.set(entry.leg.name, stopWays[0]!.at);
    stops.push({ written: stop.written, points: stopWays.map((way) => way.at) });
  }
  segments.push({ kind: 'stretch', ...(pending ? { leg: pending } : {}) });
  const back = (heading: Point): Point => ({ x: -heading.x, y: -heading.y });
  ways.push({
    at: end.at!,
    face: end.face,
    ...(end.headings.length === 1 ? { dir: back(end.headings[0]!) } : {}),
    ...(end.headings.length > 1 ? { choices: end.headings.map(back) } : {}),
  });

  // Each segment's points, in order, and whether it is drawn curved.
  const drawn: { points: Point[]; curved: boolean; through: Point[]; segment: Segment; from: Way; to: Way }[] = [];
  let arriving: Point | undefined;
  for (const [index, segment] of segments.entries()) {
    const from = ways[index]!;
    const to = ways[index + 1]!;
    const attrs = segment.leg?.attrs ?? {};
    const path = (attrs['path'] ?? edge.look.path) as LayoutEdge['look']['path'];
    if (segment.kind === 'run' || path === 'straight') {
      drawn.push({ points: [from.at, to.at], curved: false, through: [from.at, to.at], segment, from, to });
      arriving = segment.kind === 'run' ? unit(from.at, to.at) : undefined;
      continue;
    }
    const turn = attrs['turn'] !== undefined ? fractionOf(attrs['turn']) ?? edge.look.turn : edge.look.turn;
    const step = attrs['step-out'] !== undefined ? gapPixels(attrs['step-out'], `${subject}: leg ${segment.leg!.name}: step-out:`, edge.line) : edge.look.stepOut;
    const outs = from.dir ? [from.dir] : from.choices ?? [departure(from, to, arriving)];
    const ins = to.dir ? [to.dir] : to.choices ?? [];
    const options: { out: Point; arrive: Point; built: Built }[] = [];
    for (const out of outs) {
      const arrivals = ins.length > 0 ? ins : [arrival(from.at, to.at, out)];
      for (const arrive of arrivals) {
        options.push({ out, arrive, built: squareRoute(from, to, out, back(arrive), turn, step) });
      }
    }
    const bends = (option: (typeof options)[number]): number => option.built.points.length - 2;
    const fewest = Math.min(...options.map(bends));
    const best = options.filter((option) => bends(option) === fewest);
    if (best.length > 1) {
      refuseTie(edge, index === 0 ? start : end, best.map((option) => (index === 0 ? option.out : back(option.arrive))), fewest);
    }
    const chosen = best[0]!;
    // A point with no way of its own is passed in the way the line arrives (6.4).
    from.dir ??= chosen.out;
    to.dir ??= chosen.arrive;
    arriving = chosen.arrive;
    drawn.push({ points: chosen.built.points, curved: path === 'curved', through: chosen.built.through, segment, from, to });
  }

  // The pieces, and each named leg as drawn.
  const pieces: Piece[] = [];
  const legs = new Map<string, Point[]>();
  const points: Point[] = [ways[0]!.at];
  for (const [index, part] of drawn.entries()) {
    const own: Piece[] = part.curved
      ? curve(part.through, part.from.dir, part.to.dir, edge.look.curve, (part.segment.leg?.attrs['curve'] as LayoutEdge['look']['curve'] | undefined))
      : part.points.slice(1).map((to) => ({ to }));
    pieces.push(...own);
    points.push(...(part.curved ? part.through : part.points).slice(1));
    const name = part.segment.leg?.name;
    if (name !== undefined) {
      const trace = tracePieces(part.points[0]!, own);
      const before = legs.get(name);
      // A run named once may be several segments, along a leg's corners.
      legs.set(name, before && drawn[index - 1]?.segment.leg?.name === name ? [...before, ...trace.slice(1)] : trace);
    }
  }
  for (const [name, at] of pointLegs) legs.set(name, [at]);
  return { edge, start: ways[0]!.at, pieces, points: tidyCorners(points), legs, stops };
}

/** The way out of a point with none of its own: along the axis the line was traveling, else the longer way toward the next point. */
function departure(from: Way, to: Way, arriving: Point | undefined): Point {
  if (arriving) return arriving;
  const dx = to.at.x - from.at.x;
  const dy = to.at.y - from.at.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: dx >= 0 ? 1 : -1, y: 0 } : { x: 0, y: dy >= 0 ? 1 : -1 };
}

/** The way into a point with none of its own: along the axis the stretch left on, toward it. */
function arrival(from: Point, to: Point, out: Point): Point {
  if (out.x !== 0) {
    const dx = to.x - from.x;
    if (Math.abs(dx) >= 0.5) return { x: dx > 0 ? 1 : -1, y: 0 };
    return { x: 0, y: to.y >= from.y ? 1 : -1 };
  }
  const dy = to.y - from.y;
  if (Math.abs(dy) >= 0.5) return { x: 0, y: dy > 0 ? 1 : -1 };
  return { x: to.x >= from.x ? 1 : -1, y: 0 };
}

function unit(from: Point, to: Point): Point {
  const length = distance(from, to) || 1;
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

/**
 * The points a stop puts on the line (6.4): one for a point, two or more for a
 * run, nearer end first.
 */
function expand(stop: ViaStop, at: Rect | undefined, prev: Point, context: Context, subject: string, line: number): Way[] {
  const point = (p: Point, dir?: Point): Way => ({ at: p, face: { x: p.x, y: p.y, width: 0, height: 0, round: false }, ...(dir ? { dir } : {}) });
  const run = (a: Point, b: Point): Way[] => {
    // Nearer end first; an exact tie goes in reading order, left or top first.
    const first = distance(prev, a) < distance(prev, b) - 0.5 || (Math.abs(distance(prev, a) - distance(prev, b)) <= 0.5 && (a.x < b.x || (a.x === b.x && a.y <= b.y)));
    const [p, q] = first ? [a, b] : [b, a];
    const dir = unit(p, q);
    return [point(p, dir), point(q, dir)];
  };
  if (stop.kind === 'online') {
    if (stop.along === undefined) return [point(alongLength(traceNamed(stop.line, context, subject, line), stop.at))];
    // `req b top`: the middle of where req passes its own stop `b top`.
    const owner = context.lines.get(stop.line);
    if (owner === undefined) {
      throw new SourceError(
        `${subject}: "via: ${stop.written}" — ${stop.line} is not a line, so "${stop.along}" after it is a second stop, and stops are separated by commas`,
        line,
      );
    }
    const found = context.routes.get(owner)!.stops.filter((one) => one.written === stop.along);
    if (found.length !== 1) {
      throw new SourceError(
        found.length === 0
          ? `${subject}: "via: ${stop.written}" — ${stop.line} never passes ${stop.along}; its via: list doesn't name it`
          : `${subject}: "via: ${stop.written}" — ${stop.line} passes ${stop.along} ${found.length} times, so this could be any of them; name the one meant with a leg, \`leg <name> ${stop.along}\`, and write \`<name> at 1/2\``,
        line,
      );
    }
    return [point(alongLength(found[0]!.points, 1 / 2))];
  }
  if (stop.kind === 'through') {
    const box = at!;
    const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    return stop.axis === 'horizontal'
      ? run({ x: box.x, y: middle.y }, { x: box.x + box.width, y: middle.y })
      : run({ x: middle.x, y: box.y }, { x: middle.x, y: box.y + box.height });
  }
  if (stop.kind === 'alongside') {
    const trace = traceNamed(stop.leg, context, subject, line);
    const level = trace.every((p) => Math.abs(p.y - trace[0]!.y) < 0.5);
    const upright = trace.every((p) => Math.abs(p.x - trace[0]!.x) < 0.5);
    const across = stop.way === 'above' || stop.way === 'below';
    if ((across && upright) || (!across && level)) {
      throw new SourceError(
        `${subject}: "via: ${stop.written}" — ${stop.leg} runs ${upright ? 'up and down' : 'across'}, so it has no ${across ? 'above or below' : 'left or right'}; ` +
          `say ${across ? 'left of or right of' : 'above or below'}`,
        line,
      );
    }
    const gap = stop.gap === undefined ? GAPS['normal']! : gapPixels(stop.gap, `${subject}: via:`, line);
    const shift = { above: { x: 0, y: -gap }, below: { x: 0, y: gap }, 'left of': { x: -gap, y: 0 }, 'right of': { x: gap, y: 0 } }[stop.way];
    const moved = trace.map((p) => ({ x: p.x + shift.x, y: p.y + shift.y }));
    const forward = distance(prev, moved[0]!) <= distance(prev, moved[moved.length - 1]!);
    const ordered = forward ? moved : [...moved].reverse();
    return ordered.map((p, index) => point(p, unit(ordered[Math.max(0, index - 1)]!, ordered[Math.max(1, index)]!)));
  }
  // A place: a side is a run just outside it, a point on a side is passed just
  // outside it going along the side, and anything else is passed through.
  const box = at!;
  const target = stop.target;
  const gap = stop.gap !== undefined
    ? gapPixels(stop.gap, `${subject}: via:`, line)
    : stop.mode === 'on' ? 0 : stop.mode === 'inside' ? GAPS['tight']! : GAPS['normal']!;
  const out = stop.mode === 'inside' ? -gap : stop.mode === 'on' ? 0 : gap;
  const part = target.part;
  if (stop.gap !== undefined && stop.mode === 'on') {
    throw new SourceError(`${subject}: "via: ${stop.written}" — on is exactly on the side, so it takes no gap`, line);
  }
  if (part !== undefined && isSide(part) && target.fraction === undefined) {
    const normal = SIDE_NORMAL[part];
    const across = part === 'top' || part === 'bottom';
    const a = across ? { x: box.x, y: box.y } : { x: box.x, y: box.y };
    const b = across ? { x: box.x + box.width, y: box.y } : { x: box.x, y: box.y + box.height };
    return run({ x: a.x + normal.x * out, y: a.y + normal.y * out }, { x: b.x + normal.x * out, y: b.y + normal.y * out });
  }
  if (part !== undefined && part !== 'text' && part !== 'center') {
    // A point on a side, or a corner: just outside it, on each side it is on.
    const position = isSide(part) ? undefined : (part as Position);
    const [vertical, horizontal] = position ? cornerSides(position) : isSide(part) && (part === 'top' || part === 'bottom') ? [part, undefined] : [undefined, part as Side];
    const shift = {
      x: (horizontal === 'left' ? -1 : horizontal === 'right' ? 1 : 0) * out,
      y: (vertical === 'top' ? -1 : vertical === 'bottom' ? 1 : 0) * out,
    };
    const spot = { x: box.x + shift.x, y: box.y + shift.y };
    // On one side only, the line travels along that side there.
    const along = vertical && !horizontal ? { x: spot.x >= prev.x ? 1 : -1, y: 0 } : horizontal && !vertical ? { x: 0, y: spot.y >= prev.y ? 1 : -1 } : undefined;
    return [point(spot, along)];
  }
  // A box, a region or a point: through its middle.
  return [point({ x: box.x + box.width / 2, y: box.y + box.height / 2 })];
}

function refuseTie(edge: LayoutEdge, which: End, headings: Point[], bends: number): never {
  const position = (which.spec as { position: Position }).position;
  const [vertical, horizontal] = cornerSides(position);
  const ways = [...new Set(headings.map(wordOf))];
  const key = which.which;
  const across = horizontal === 'right' ? '1/1' : '0';
  const down = vertical === 'bottom' ? '1/1' : '0';
  throw new SourceError(
    `edge ${describeEdge(edge)}: ${which.node.name}'s ${position} heads ${ways.join(' or ')} with ${bends === 1 ? 'one bend' : `${bends} bends`} either way, ` +
      `and nothing says which — name it as a point on a side: ${key}: ${vertical} ${across} across, or ${key}: ${horizontal} ${down} down`,
    edge.line,
  );
}

function wordOf(heading: Point): string {
  return heading.x > 0 ? 'right' : heading.x < 0 ? 'left' : heading.y > 0 ? 'down' : 'up';
}

interface Built {
  points: Point[];
  /** The points a curved line passes through, ends included (6.3). */
  through: Point[];
}

/**
 * The square route between two points (design.org 6.3), leaving the first
 * along `out` and arriving at the second against `back`, which points the way
 * a box's side would face. One range, read off the two boxes (or the points
 * themselves, at a stop), decides where the free leg goes; everything else is
 * a step-out.
 */
function squareRoute(start: Way, end: Way, out: Point, back: Point, turn: number, step: number): Built {
  const a = start.at;
  const b = end.at;
  const fromFace = start.face;
  const toFace = end.face;
  const across = out.x !== 0;
  // u runs along the start's heading, v across it.
  const u = (p: Point): number => (across ? p.x : p.y);
  const v = (p: Point): number => (across ? p.y : p.x);
  const make = (uu: number, vv: number): Point => (across ? { x: uu, y: vv } : { x: vv, y: uu });
  const du = across ? out.x : out.y;
  const sa = { x: a.x + out.x * step, y: a.y + out.y * step };
  const sb = { x: b.x + back.x * step, y: b.y + back.y * step };
  const boxSpan = (face: Face, onU: boolean): [number, number] =>
    onU === across ? [face.x, face.x + face.width] : [face.y, face.y + face.height];
  // The gap between the two boxes on an axis, as [near, far] in travel order, or undefined where they overlap.
  const gapOn = (onU: boolean): [number, number] | undefined => {
    const [a0, a1] = boxSpan(fromFace, onU);
    const [b0, b1] = boxSpan(toFace, onU);
    if (a1 <= b0) return [a1, b0];
    if (b1 <= a0) return [a0, b1];
    return undefined;
  };
  const between = (from: number, to: number): number => from + (to - from) * turn;

  const parallel = (back.x !== 0) === across;
  if (parallel) {
    const facing = out.x * back.x + out.y * back.y < 0;
    if (facing && (u(b) - u(a)) * du >= 0) {
      // The range has two ends: the free leg runs between them.
      if (Math.abs(v(a) - v(b)) < 0.5) return { points: [a, b], through: [a, b] };
      const m = between(u(a), u(b));
      const p1 = make(m, v(a));
      const p2 = make(m, v(b));
      return { points: [a, p1, p2, b], through: [a, midpoint(p1, p2), b] };
    }
    if (!facing) {
      // Both sides face the same way: the leg runs a step-out beyond the farther side.
      const far = du > 0 ? Math.max(u(a), u(b)) + step : Math.min(u(a), u(b)) - step;
      const p1 = make(far, v(a));
      const p2 = make(far, v(b));
      return { points: tidyCorners([a, p1, p2, b]), through: [a, midpoint(p1, p2), b] };
    }
    // The range is empty: each end steps out, and the line crosses halfway
    // between the boxes in the other direction, through the gap if there is one.
    const gap = gapOn(false);
    const m = gap ? between(gap[0], gap[1]) : between(v(a), v(b));
    const p1 = make(u(sa), m);
    const p2 = make(u(sb), m);
    return { points: tidyCorners([a, sa, p1, p2, sb, b]), through: [a, sa, midpoint(p1, p2), sb, b] };
  }

  // At right angles: one corner where it sits behind neither end's side.
  const corner = make(u(b), v(a));
  const dv = across ? back.y : back.x;
  const aheadOfStart = (u(corner) - u(a)) * du > 0;
  const aheadOfEnd = (v(corner) - v(b)) * dv > 0;
  if (aheadOfStart && aheadOfEnd) return { points: [a, corner, b], through: [a, b] };
  if (!aheadOfStart && aheadOfEnd) {
    // The far end is behind the start's side: out, across the gap on the end's
    // axis (or round, a step-out off the end where there is none), and in.
    const gap = gapOn(false);
    const m = gap ? between(gap[0], gap[1]) : v(sb);
    const p1 = make(u(sa), m);
    const p2 = make(u(b), m);
    return { points: tidyCorners([a, sa, p1, p2, b]), through: [a, sa, midpoint(p1, p2), b] };
  }
  if (aheadOfStart && !aheadOfEnd) {
    // The start is behind the end's side: along to the gap on the start's axis
    // (or a step-out where there is none), round, and into the end.
    const gap = gapOn(true);
    const m = gap ? between(gap[0], gap[1]) : u(sa);
    const p1 = make(m, v(a));
    const p2 = make(m, v(sb));
    const p3 = make(u(b), v(sb));
    return { points: tidyCorners([a, p1, p2, p3, b]), through: [a, midpoint(p1, p2), sb, b] };
  }
  // Behind both: out, round to a step-out off the end, and in.
  const p1 = make(u(sa), v(sb));
  return { points: tidyCorners([a, sa, p1, sb, b]), through: [a, sa, sb, b] };
}

function midpoint(p: Point, q: Point): Point {
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

/** The points with repeats and points in line with both neighbors dropped. */
export function tidyCorners(points: Point[]): Point[] {
  const kept: Point[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) continue;
    kept.push(point);
  }
  for (let index = kept.length - 2; index >= 1; index -= 1) {
    const [p, q, r] = [kept[index - 1]!, kept[index]!, kept[index + 1]!];
    const inLine = (Math.abs(p.x - q.x) < 0.5 && Math.abs(q.x - r.x) < 0.5) || (Math.abs(p.y - q.y) < 0.5 && Math.abs(q.y - r.y) < 0.5);
    // A leg that folds back on itself is kept: it is drawn, and reported.
    const folds = (q.x - p.x) * (r.x - q.x) + (q.y - p.y) * (r.y - q.y) < 0;
    if (inLine && !folds) kept.splice(index, 1);
  }
  return kept;
}

/** How far a curve's handles reach, as a share of the piece they shape, for each `curve:`. */
const CURVE_REACH: Record<LayoutEdge['look']['curve'], number> = { subtle: 0.22, normal: 0.36, strong: 0.5 };

/**
 * A curve through every point exactly (design.org 6.3). It leaves the first
 * point and arrives at the last in the way the line travels there, and at a
 * point between runs parallel to the line joining that point's neighbors.
 * Nothing is checked or retried.
 */
function curve(points: Point[], first: Point | undefined, last: Point | undefined, look: LayoutEdge['look']['curve'], leg: LayoutEdge['look']['curve'] | undefined): Piece[] {
  if (leg !== undefined && !(leg in CURVE_REACH)) leg = undefined;
  const reach = CURVE_REACH[leg ?? look];
  const tangents = points.map((point, index) => {
    if (index === 0 && first) return first;
    if (index === points.length - 1 && last) return last;
    const before = points[Math.max(0, index - 1)]!;
    const after = points[Math.min(points.length - 1, index + 1)]!;
    return unit(before, after);
  });
  const pieces: Piece[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = distance(a, b);
    const ta = tangents[index - 1]!;
    const tb = tangents[index]!;
    pieces.push({
      c1: { x: a.x + ta.x * length * reach, y: a.y + ta.y * length * reach },
      c2: { x: b.x - tb.x * length * reach, y: b.y - tb.y * length * reach },
      to: b,
    });
  }
  return pieces;
}

/** Pieces from a starting point, as a polyline: a cubic flattened, a straight piece as it is. */
function tracePieces(start: Point, pieces: Piece[]): Point[] {
  const trace: Point[] = [start];
  let from = start;
  for (const piece of pieces) {
    if ('c1' in piece) {
      const { c1, c2, to } = piece;
      for (let step = 1; step <= 16; step += 1) {
        const t = step / 16;
        const u = 1 - t;
        trace.push({
          x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
          y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
        });
      }
    } else {
      trace.push(piece.to);
    }
    from = piece.to;
  }
  return trace;
}

/** The line as drawn, as a polyline: curves flattened, everything else its own points. */
export function traceRoute(route: Route): Point[] {
  return tracePieces(route.start, route.pieces);
}

export function describeEdge(edge: LayoutEdge): string {
  return `${edge.from.name} ${edge.arrow} ${edge.to.name}`;
}
