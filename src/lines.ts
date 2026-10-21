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
import { EDGE_ORDER_KEYS, PART_SIDES, WAYS, isPosition, type Position, type ViaStop, type Way as WayWord } from './ast.js';
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
  /**
   * Pieces not drawn, as [first, past the last]: a member's way along a
   * collapsed bundle, which the bus draws once (6.6). The line still travels
   * there, so the trace and every finding include them.
   */
  hidden?: [number, number][];
}

/** What an end says, read from `from:` or `to:`. */
type EndSpec =
  | { kind: 'side'; side: Side; implied: boolean; after?: { name: string; way: OrderWay } }
  | { kind: 'point'; position: Position }
  | { kind: 'fraction'; side: Side; value: number; written: string }
  | { kind: 'center' }
  /** `to: left, even with cat1`: on that side, level with cat1's center (or at its place across, on a top or bottom side). */
  | { kind: 'even'; side: Side; written: string }
  /** `to: down from z3`: where the line straight down from z3's center meets this end's box or line. */
  | { kind: 'aligned'; way: WayWord; name: string; written: string; fromStart?: boolean }
  /** `straight down` on the edge, at its start: leaving its own box that way, from its center. */
  | { kind: 'own-way'; way: WayWord }
  /** `to: at 1/3`, `to: climb at 1/3`, `from: req end`: a point on a line or a leg. */
  | { kind: 'online'; line?: string; at: number | 'start' | 'end'; written: string }
  /** Nothing said, and the far end is on a line: the side facing that point, once the line is drawn. */
  | { kind: 'facing-point' }
  /** A bundle's end, which is wherever its path starts or finishes. */
  | { kind: 'free' };

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
  /** One of several copies of a line (6.5): which set, how many steps over, and which way "over" points along this side. */
  copy?: { set: number; k: number; left: Point; leading: boolean };
}

/**
 * How far apart copies of one line run, like lanes on a road (6.5). A fixed
 * step, so adding a copy widens the set by one lane and moves no other lane.
 */
const FAN_STEP = 16;

/** Where every line in the layout goes. */
export function planLines(layout: Layout): Map<LayoutEdge, Route> {
  return planSides(layout).routes;
}

/** The ends sharing one side of one box, in their order along it. */
export interface SideEnds {
  node: LayoutNode;
  side: Side;
  /** Where each end landed, in order along the side, the line it belongs to, and which of the line's ends it is. */
  ends: { at: Point; edge: LayoutEdge; which: 'from' | 'to' }[];
}

/** Every line, and every side two or more ends share, for the findings to measure. */
export function planSides(layout: Layout): { routes: Map<LayoutEdge, Route>; sides: SideEnds[] } {
  const legs = legOwners(layout);
  const lines = new Map(layout.edges.filter((edge) => edge.name !== undefined).map((edge) => [edge.name!, edge]));
  const ends = new Map<LayoutEdge, [End, End]>();
  for (const edge of layout.edges) ends.set(edge, [endOf(edge, 'from'), endOf(edge, 'to')]);
  const copies = copySets(layout.edges, ends);
  // Lines drawn straight from one box to the other: a bundle written `a -> b`,
  // and plain copies whose sides were left to the default. Their ends land
  // where their lanes meet the boxes, so they take no slot on a side.
  const direct = directSets(layout.edges, ends, copies);
  for (const edge of direct.keys()) {
    for (const end of ends.get(edge)!) {
      end.spec = { kind: 'free' };
      end.headings = [];
    }
  }
  const directDrawn = new Map<DirectSet, Map<LayoutEdge, Route>>();

  // Ends spread along a side first, since where an end lands on a shared side
  // depends on the others there.
  const sides = spreadSides([...ends.values()].flat(), layout.nodes);
  const routes = new Map<LayoutEdge, Route>();
  const context: Context = { layout, legs, lines, ends, routes, shapes: new Map(), lanes: new Map() };

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
    if (edge.bundle?.between) {
      // A bundle between two boxes has no path of its own: shown with the
      // guides, it is the line between the two centers, box to box.
      const [a, b] = edge.bundle.between.map(faceOfNode) as [Face, Face];
      const from = outlineToward(a, centerOf(b));
      const to = outlineToward(b, centerOf(a));
      routes.set(edge, { edge, start: from, pieces: [{ to }], points: [from, to], legs: new Map(), stops: [] });
      done.add(edge);
      return;
    }
    const group = direct.get(edge);
    if (group) {
      let drawn = directDrawn.get(group);
      if (!drawn) {
        drawn = directRoutes(group);
        directDrawn.set(group, drawn);
      }
      routes.set(edge, drawn.get(edge)!);
      done.add(edge);
      return;
    }
    const [start, end] = ends.get(edge)!;
    for (const one of [start, end]) placeEnd(one, context);
    for (const [own, other] of [[start, end], [end, start]] as [End, End][]) faceThePoint(own, other);
    for (const [own, other] of [[start, end], [end, start]] as [End, End][]) aimCenter(own, other);
    // A copy takes the first copy's shape, shifted over (6.5); the first is drawn as any line is.
    const set = copies.get(edge);
    const fan = set && set.lines[0] !== edge ? fanned(edge, start, end, set, context) : undefined;
    routes.set(edge, fan ?? route(edge, start, end, context));
    done.add(edge);
  };
  // The first copy of each set comes first, since the others are drawn from it.
  for (const edge of layout.edges) {
    const set = copies.get(edge);
    if (set) draw(set.lines[0]!);
    draw(edge);
  }
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
  /** A line of one stretch, its shape before it was drawn: what its copies are shifted from. */
  shapes: Map<LayoutEdge, Shape>;
  /** Each bundle's members and their lanes, worked out once the bundle is drawn. */
  lanes: Map<LayoutEdge, Map<LayoutEdge, number>>;
}

/** One stretch's shape: the square route, the points a curve passes through, and the way it travels at each end. */
interface Shape {
  square: Point[];
  through: Point[];
  curved: boolean;
  out: Point;
  arrive: Point;
  turned?: Turned;
}

/** A set of copies of one line, in written order; the first sets the direction they all travel in. */
interface CopySet {
  lines: LayoutEdge[];
}

/**
 * Copies are lines with the same two boxes on the same sides, in either
 * direction, with nothing stated about their path (6.5): no waypoints, no
 * landing point, no place among a side's ends. Found by filing each line under
 * its boxes and sides, in one pass.
 */
function copySets(edges: LayoutEdge[], ends: Map<LayoutEdge, [End, End]>): Map<LayoutEdge, CopySet> {
  const filed = new Map<string, CopySet>();
  const plain = (end: End): end is End & { spec: { kind: 'side' } } =>
    end.spec.kind === 'side' && end.spec.after === undefined && !end.onLine && end.edge.onMark?.[end.which] !== 'point';
  const keyOf = (end: End): string => `${end.node.name}\n${(end.spec as { side: Side }).side}`;
  for (const edge of edges) {
    if (edge.via !== undefined || edge.straight !== undefined) continue;
    const [start, end] = ends.get(edge)!;
    if (!plain(start) || !plain(end)) continue;
    const [a, b] = [keyOf(start), keyOf(end)];
    const key = a <= b ? `${a}\n${b}` : `${b}\n${a}`;
    const set = filed.get(key) ?? { lines: [] };
    set.lines.push(edge);
    filed.set(key, set);
  }
  const found = new Map<LayoutEdge, CopySet>();
  for (const set of filed.values()) {
    if (set.lines.length < 2) continue;
    const [first] = ends.get(set.lines[0]!)!;
    set.lines.forEach((edge, k) => {
      found.set(edge, set);
      const [start, end] = ends.get(edge)!;
      // Written the same way round as the first copy, or the other way.
      const along = keyOf(start) === keyOf(first);
      // Copy k is k steps to the left of the way the set travels: leaving a
      // side, left of its outward heading; arriving, left of the inward one.
      const leaving = along ? start : end;
      const arriving = along ? end : start;
      const n1 = SIDE_NORMAL[(leaving.spec as { side: Side }).side];
      const n2 = SIDE_NORMAL[(arriving.spec as { side: Side }).side];
      const line = set.lines[0]!.line;
      leaving.copy = { set: line, k, left: { x: n1.y, y: -n1.x }, leading: true };
      arriving.copy = { set: line, k, left: { x: -n2.y, y: n2.x }, leading: false };
    });
  }
  return found;
}

/**
 * A copy drawn as the first copy's shape shifted k steps to its left (6.5).
 * Each end keeps its own slot on its side, and every stretch between keeps the
 * fixed step; on a square line the two never conflict, since a leg touching a
 * side takes its place from the slot and the rest from the step. A straight
 * shape has no stretch between, so the copy runs from slot to slot.
 */
function fanned(edge: LayoutEdge, start: End, end: End, set: CopySet, context: Context): Route | undefined {
  const shape = context.shapes.get(set.lines[0]!);
  if (shape === undefined) return undefined;
  const k = set.lines.indexOf(edge);
  // Worked out in the way the set travels, then turned round for a copy written the other way.
  const along = start.copy!.leading;
  const [a, b] = along ? [start.at!, end.at!] : [end.at!, start.at!];
  const moved = shiftShape(shape, a, b, k * FAN_STEP);
  if (moved === undefined) return undefined;
  let { square, through, turned } = moved;
  let out = shape.out;
  let arrive = shape.arrive;
  if (!along) {
    square = [...square].reverse();
    through = [...through].reverse();
    [out, arrive] = [{ x: -arrive.x, y: -arrive.y }, { x: -out.x, y: -out.y }];
    if (turned) turned = { at: turned.at, dir: { x: -turned.dir.x, y: -turned.dir.y } };
  }
  const pieces: Piece[] = shape.curved
    ? curve(through, out, arrive, edge.look.curve, undefined, edge.look.stepOut, turned)
    : square.slice(1).map((to) => ({ to }));
  return { edge, start: square[0]!, pieces, points: shape.curved ? tracePieces(square[0]!, pieces) : tidyCorners(square), legs: new Map(), stops: [] };
}

/**
 * A square shape moved to new ends, each leg between shifted `by` to the left
 * of the way it travels; the points a curve passes through move with the legs
 * they lie on, at the same share of the way along. Undefined for a shape that
 * isn't made of legs at right angles, which is drawn as it is.
 */
function shiftShape(shape: Shape, a: Point, b: Point, by: number): { square: Point[]; through: Point[]; turned?: Turned } | undefined {
  const base = tidyCorners(shape.square);
  const count = base.length - 1;
  if (count < 1) return undefined;
  if (count === 1) return { square: [a, b], through: [a, b] };
  const level: boolean[] = [];
  for (let index = 0; index < count; index += 1) {
    const p = base[index]!;
    const q = base[index + 1]!;
    const flat = Math.abs(p.y - q.y) < 0.5;
    const upright = Math.abs(p.x - q.x) < 0.5;
    if (flat === upright) return undefined;
    level.push(flat);
    if (index > 0 && level[index - 1] === flat) return undefined;
  }
  // Each leg's coordinate across it: the first and last from the ends' slots.
  const across = base.slice(0, count).map((p, index) => {
    const q = base[index + 1]!;
    if (index === 0) return level[0] ? a.y : a.x;
    if (index === count - 1) return level[index] ? b.y : b.x;
    const way = level[index] ? Math.sign(q.x - p.x) : Math.sign(q.y - p.y);
    return level[index] ? p.y - way * by : p.x + way * by;
  });
  const corners = across.slice(0, -1).map((value, index) =>
    level[index] ? { x: across[index + 1]!, y: value } : { x: value, y: across[index + 1]! },
  );
  const square = [a, ...corners, b];
  const move = (point: Point): Point => {
    for (let index = 0; index < count; index += 1) {
      const p = base[index]!;
      const q = base[index + 1]!;
      const length = distance(p, q);
      const t = length === 0 ? 0 : distance(p, point) / length;
      const off = Math.abs((q.x - p.x) * (point.y - p.y) - (q.y - p.y) * (point.x - p.x)) / (length || 1);
      if (off > 0.5 || t > 1 + 1e-6 || distance(q, point) > length + 0.5) continue;
      const p2 = square[index]!;
      const q2 = square[index + 1]!;
      return { x: p2.x + (q2.x - p2.x) * t, y: p2.y + (q2.y - p2.y) * t };
    }
    return point;
  };
  const through = shape.through.map(move);
  return { square, through, ...(shape.turned ? { turned: { at: move(shape.turned.at), dir: shape.turned.dir } } : {}) };
}

// --- lines straight between two boxes ---------------------------------------------

/** Lines sharing the direct way between two boxes, in order across it. */
interface DirectSet {
  a: LayoutNode;
  b: LayoutNode;
  members: LayoutEdge[];
  arrangement: 'parallel' | 'collapsed' | 'fan';
  gap: number;
}

/**
 * Each line drawn straight between its two boxes, and the set it shares that
 * way with (design.org 6.5, 6.6). A bundle written `a -> b` holds the lines
 * that name it in `via:`; plain straight copies whose sides were both left to
 * the default are an unnamed parallel set, at a bundle's default gap.
 */
function directSets(edges: LayoutEdge[], ends: Map<LayoutEdge, [End, End]>, copies: Map<LayoutEdge, CopySet>): Map<LayoutEdge, DirectSet> {
  const found = new Map<LayoutEdge, DirectSet>();
  const bundles = new Map(edges.filter((edge) => edge.bundle?.between).map((edge) => [edge.name!, edge]));
  const named = new Map<LayoutEdge, DirectSet>();
  for (const edge of edges) {
    if (edge.bundle) continue;
    const entries = edge.via ?? [];
    const stop = entries.map((entry) => entry.stop).find((one) => one?.kind === 'bundle' && bundles.has(one.bundle)) as Extract<ViaStop, { kind: 'bundle' }> | undefined;
    if (!stop) continue;
    const bundle = bundles.get(stop.bundle)!;
    const [a, b] = bundle.bundle!.between!;
    const subject = `edge ${describeEdge(edge)}`;
    if (!((edge.from === a && edge.to === b) || (edge.from === b && edge.to === a))) {
      throw new SourceError(
        `${subject}: "via: ${stop.written}" — ${stop.bundle} runs directly between ${a.name} and ${b.name}, so only a line between those two can take it`,
        edge.line,
      );
    }
    if (entries.length > 1) {
      throw new SourceError(`${subject}: ${stop.bundle} runs directly between ${a.name} and ${b.name}, so the line passes nothing else — leave the other stops off`, edge.line);
    }
    for (const which of ['from', 'to'] as const) {
      if (edge.attrs[which] !== undefined) {
        throw new SourceError(
          `${subject}: "${which}: ${edge.attrs[which]}" — ${stop.bundle} says where its lines land, each where its lane meets the box; leave ${which}: off, or take the line out of the bundle`,
          edge.line,
        );
      }
    }
    if (edge.attrs['line.path'] !== undefined) {
      throw new SourceError(
        `${subject}: "path: ${edge.attrs['line.path']}" — ${stop.bundle}'s layout: says the shape of its lines; leave path: off, or take the line out of the bundle`,
        edge.line,
      );
    }
    if (stop.order !== undefined) {
      throw new SourceError(
        `${subject}: "via: ${stop.written}" — ${stop.bundle} runs between two boxes, and its lines take their order from the bundle's order: or the order they are written in`,
        edge.line,
      );
    }
    const set = named.get(bundle) ?? { a, b, members: [], arrangement: bundle.bundle!.arrangement, gap: bundle.bundle!.gap };
    set.members.push(edge);
    named.set(bundle, set);
  }
  for (const [bundle, set] of named) {
    const order = bundle.bundle!.order;
    if (order) {
      const subject = `bundle ${bundle.name}`;
      for (const name of order) {
        if (!set.members.some((edge) => edge.name === name)) {
          throw new SourceError(`${subject}: order: lists ${name}, which is not a line through it — add \`via: ${bundle.name}\` to ${name}, or take it off the list`, bundle.line);
        }
      }
      for (const edge of set.members) {
        if (edge.name === undefined || !order.includes(edge.name)) {
          throw new SourceError(`edge ${describeEdge(edge)}: passes through ${bundle.name}, whose order: lists every line through it and leaves this one out`, edge.line);
        }
      }
      set.members.sort((p, q) => order.indexOf(p.name!) - order.indexOf(q.name!));
    }
    for (const edge of set.members) found.set(edge, set);
  }
  // Plain copies: straight, and neither end's side written.
  const seen = new Set<CopySet>();
  for (const set of copies.values()) {
    if (seen.has(set)) continue;
    seen.add(set);
    const plain = set.lines.every((edge) => edge.look.path === 'straight' && ends.get(edge)!.every((end) => end.spec.kind === 'side' && end.spec.implied));
    if (!plain) continue;
    const first = set.lines[0]!;
    const group: DirectSet = { a: first.from, b: first.to, members: set.lines, arrangement: 'parallel', gap: GAPS['tight']! };
    for (const edge of set.lines) found.set(edge, group);
  }
  return found;
}

/**
 * The members of one direct set, drawn (6.6). Lanes run parallel to the line
 * between the two centers, a gap apart, the first written uppermost (or
 * leftmost, on an upright way), and each end lands where its lane meets the
 * box. Where a box is too small across to take the lanes at their gap, they
 * draw together at that box: parallel lines stay straight, closer together;
 * fanned ones keep the gap at the middle and bow out to it, the middle line
 * straight. Collapsed, they share the one line.
 */
function directRoutes(set: DirectSet): Map<LayoutEdge, Route> {
  const fa = faceOfNode(set.a);
  const fb = faceOfNode(set.b);
  const ca = centerOf(fa);
  const cb = centerOf(fb);
  const d = unit(ca, cb);
  // Across the way, pointing up, or left where the way is level across.
  let p = { x: -d.y, y: d.x };
  if (p.y > 1e-9 || (Math.abs(p.y) <= 1e-9 && p.x > 0)) p = { x: -p.x, y: -p.y };
  const n = set.members.length;
  const gap = set.arrangement === 'collapsed' ? 0 : set.gap;
  const lane = (k: number): number => ((n - 1) / 2 - k) * gap;
  const widest = lane(0);
  // How far across a lane may sit at a box: within its width across the way,
  // kept a little off the corners.
  const room = (face: Face): number => {
    const half = face.round ? face.width / 2 : (Math.abs(p.x) * face.width + Math.abs(p.y) * face.height) / 2;
    return Math.max(0, half - Math.min(8, half * 0.3));
  };
  const squeeze = (face: Face): number => (widest <= 0 ? 1 : Math.min(1, room(face) / widest));
  const sa = squeeze(fa);
  const sb = squeeze(fb);
  const fanned = set.arrangement === 'fan';
  // Parallel lines keep one spacing all the way, the tighter box's.
  const parallelScale = Math.min(sa, sb);
  const across = (point: Point): number => (point.x - ca.x) * p.x + (point.y - ca.y) * p.y;
  const routes = new Map<LayoutEdge, Route>();
  set.members.forEach((edge, k) => {
    const ea = lane(k) * (fanned ? sa : parallelScale);
    const eb = lane(k) * (fanned ? sb : parallelScale);
    const s = leaving(fa, { x: ca.x + p.x * ea, y: ca.y + p.y * ea }, d);
    const e = leaving(fb, { x: cb.x + p.x * eb, y: cb.y + p.y * eb }, { x: -d.x, y: -d.y });
    let start = s;
    let pieces: Piece[] = [{ to: e }];
    const want = lane(k);
    const shortfall = want - (across(s) + across(e)) / 2;
    if (fanned && Math.abs(shortfall) > 0.5) {
      // One curve, through the lane at its middle and level with the way there.
      const length = (e.x - s.x) * d.x + (e.y - s.y) * d.y;
      const h = (8 * want - 4 * (across(s) + across(e))) / 6;
      const c1 = { x: s.x + (d.x * length) / 3 + p.x * h, y: s.y + (d.y * length) / 3 + p.y * h };
      const c2 = { x: e.x - (d.x * length) / 3 + p.x * h, y: e.y - (d.y * length) / 3 + p.y * h };
      pieces = [{ c1, c2, to: e }];
    }
    if (edge.from !== set.a) {
      // Written the other way round: the same lane, travelled back.
      const only = pieces[0]!;
      pieces = 'c1' in only ? [{ c1: only.c2, c2: only.c1, to: s }] : [{ to: s }];
      start = e;
    }
    routes.set(edge, { edge, start, pieces, points: 'c1' in pieces[0]! ? tracePieces(start, pieces) : [start, pieces[0]!.to], legs: new Map(), stops: [] });
  });
  return routes;
}

/** Where a ray from a point inside a face, heading `way`, leaves its outline. */
function leaving(face: Face, from: Point, way: Point): Point {
  if (face.round) {
    const c = centerOf(face);
    const r = face.width / 2;
    const fx = from.x - c.x;
    const fy = from.y - c.y;
    const b = fx * way.x + fy * way.y;
    const t = -b + Math.sqrt(Math.max(0, b * b - (fx * fx + fy * fy - r * r)));
    return { x: from.x + way.x * t, y: from.y + way.y * t };
  }
  const tx = way.x > 1e-9 ? (face.x + face.width - from.x) / way.x : way.x < -1e-9 ? (face.x - from.x) / way.x : Infinity;
  const ty = way.y > 1e-9 ? (face.y + face.height - from.y) / way.y : way.y < -1e-9 ? (face.y - from.y) / way.y : Infinity;
  const t = Math.max(0, Math.min(tx, ty));
  return { x: from.x + way.x * t, y: from.y + way.y * t };
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
    if (stop?.kind === 'bundle') found.push(context.lines.get(stop.bundle)!);
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
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
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
  if (edge.bundle) return { edge, which, node, face, far, spec: { kind: 'free' }, headings: [] };
  // `straight right` leaves from the middle of the side facing right unless
  // `from:` names a spot on that side, which it then leaves from (design.org 6.2).
  const startWritten = edge.straight !== undefined ? edge.attrs['from'] : undefined;
  if (edge.straight !== undefined && which === 'to' && written !== undefined) {
    throw new SourceError(
      `${subject}: "straight ${edge.straight}" says where the line ends, so "to: ${written}" says it twice — keep one`,
      edge.line,
    );
  }
  let spec: EndSpec;
  if (edge.straight !== undefined) {
    spec = which === 'from'
      ? straightStart(edge, edge.straight, subject)
      : {
          kind: 'aligned',
          way: edge.straight,
          name: edge.from.name,
          written: `straight ${edge.straight}`,
          ...(startWritten !== undefined ? { fromStart: true } : {}),
        };
  } else if (onLine) {
    spec = written === undefined ? { kind: 'online', at: 1 / 2, written: 'its middle' } : readEnd(written, edge, which);
    if (spec.kind !== 'online' && spec.kind !== 'aligned') {
      throw new SourceError(
        `${subject}: "${which}: ${written}" names a part of a box, and ${node.name} is a line — say how far along it, such as ${which}: at 1/3`,
        edge.line,
      );
    }
  } else if (edge.onMark?.[which] === 'point' && written !== undefined) {
    throw new SourceError(
      `${subject}: "${which}: ${written}" — ${node.name} is a point, which has no sides or parts, so the line ${which === 'from' ? 'starts' : 'ends'} exactly on it; leave out ${which}:`,
      edge.line,
    );
  } else {
    const farOnLine = edge.onLine?.[which === 'from' ? 'to' : 'from'] !== undefined;
    spec = written !== undefined
      ? readEnd(written, edge, which)
      : farOnLine
        ? { kind: 'facing-point' }
        : facingSpec(edge, which, node, far);
  }
  const end: End = { edge, which, node, face, far, spec, ...(onLine ? { onLine } : {}), headings: [] };
  if (spec.kind === 'side' || spec.kind === 'fraction' || spec.kind === 'even') end.headings = [SIDE_NORMAL[spec.side]];
  if (spec.kind === 'fraction') end.at = fractionPoint(face, spec.side, spec.value);
  if (spec.kind === 'even') {
    // Level with the thing's center on a left or right side, at its place
    // across on a top or bottom one. A miss is refused, never bent (6.2).
    const target = edge.evenAt![which]!;
    const across = spec.side === 'top' || spec.side === 'bottom';
    const coordinate = across ? target.x + target.width / 2 : target.y + target.height / 2;
    const low = across ? face.x : face.y;
    const high = across ? face.x + face.width : face.y + face.height;
    if (coordinate < low - 0.5 || coordinate > high + 0.5) {
      const thing = spec.written.replace(/^[^,]*,\s*even with\s+/, '');
      const where = across ? (coordinate < low ? 'left of' : 'right of') : coordinate < low ? 'above' : 'below';
      throw new SourceError(
        `${subject}: "${which}: ${spec.written}" misses ${node.name}'s ${spec.side} side — ${thing} is ${where} it, ` +
          `so no point of that side is even with ${thing}; nothing is bent to reach it`,
        edge.line,
      );
    }
    end.at = onSide(face, spec.side, coordinate);
  }
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

/**
 * The start of a `straight` line. Bare, the middle of the side facing its
 * way; a `from:` may name another spot on that side, and naming any other
 * side is refused, since the line could not leave it that way.
 */
function straightStart(edge: LayoutEdge, way: WayWord, subject: string): EndSpec {
  const written = edge.attrs['from'];
  const facing = MET_SIDE[opposite(way)];
  if (written === undefined) return { kind: 'own-way', way };
  const spec = readEnd(written, edge, 'from');
  if (spec.kind === 'side' && spec.side === facing && spec.after === undefined) return { kind: 'own-way', way };
  const sides =
    spec.kind === 'fraction' || spec.kind === 'even'
      ? [spec.side]
      : spec.kind === 'point'
        ? cornerSides(spec.position).filter((side): side is Side => side !== undefined)
        : [];
  if (!sides.includes(facing)) {
    throw new SourceError(
      `${subject}: "straight ${way}" leaves from ${edge.from.name}'s ${facing} side, and "from: ${written}" is not on it — ` +
        `name a spot on the ${facing} side, such as from: ${facing} 1/4 ${facing === 'left' || facing === 'right' ? 'down' : 'across'}, or drop one`,
      edge.line,
    );
  }
  return spec;
}

function opposite(way: WayWord): WayWord {
  return ({ up: 'down', down: 'up', left: 'right', right: 'left' } as const)[way];
}

/**
 * `top`, `left 3/4 down`, `bottom 1/4 across from right`, `top, right of z`,
 * `left, even with cat1`, `bottom-center`, `center`, `down from z3`, `at 1/3`, `climb at 1/3`,
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
  // `left, even with cat1`: the parser read the targets, and the resolver located them.
  if (/^\s*even with /.test(order)) return { kind: 'even', side: first, written };
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
    const from = context.layout.nodes.find((node) => node.name === spec.name) ?? context.layout.marks.find((mark) => mark.name === spec.name);
    const fromLine = context.lines.get(spec.name);
    if (from === undefined && fromLine === undefined) {
      throw new SourceError(`${subject}: "${end.which}: ${spec.written}" names ${spec.name}, which does not exist`, end.edge.line);
    }
    const start = spec.fromStart ? context.ends.get(end.edge)![0].at : undefined;
    const origin = start
      ?? (from ? centerOf('body' in from ? faceOfNode(from) : { ...from, round: false }) : alongLength(traceRoute(context.routes.get(fromLine!)!), 1 / 2));
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
        `${subject}: the line straight ${spec.way} from ${spec.fromStart ? 'its start' : `${spec.name}'s center`} never meets ${end.node.name} — ` +
          `${ahead < -0.5 ? `${end.node.name} is not ${spec.way} from it` : end.edge.onMark?.[end.which] === 'point' ? `it passes beside ${end.node.name}` : `it passes ${end.node.name}'s ${side} side`}; nothing is bent to reach it`,
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
function spreadSides(ends: End[], nodes: LayoutNode[]): SideEnds[] {
  const shared: SideEnds[] = [];
  const listsUsed = new Set<string>();
  const groups = new Map<string, End[]>();
  for (const end of ends) {
    // At a named point every end lands on the point itself, heading out of
    // the side that faces its far end; nothing spreads, and nothing crowds.
    if (end.edge.onMark?.[end.which] === 'point' && end.spec.kind === 'side') {
      end.at = centerOf(end.face);
      continue;
    }
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
    // Written order breaks a tie. Copies of one line take adjacent slots, each
    // a step further to the left of the way the set travels (6.5), which keeps
    // them in step at both ends.
    const axis = across ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const lane = (end: End): number => (end.copy ? end.copy.k * (end.copy.left.x * axis.x + end.copy.left.y * axis.y) : 0);
    const ordered = [...group].sort(
      (a, b) => farAt(a) - farAt(b) || (a.copy?.set ?? a.edge.line) - (b.copy?.set ?? b.edge.line) || lane(a) - lane(b) || a.edge.line - b.edge.line,
    );
    // `right-edge-order: ae, ad, ac` on the box: every line spreading on that side, in reading order.
    const listKey = `${side}-edge-order`;
    const list = group[0]!.node.attrs[listKey];
    if (list !== undefined) {
      listsUsed.add(`${group[0]!.node.name}\n${listKey}`);
      const names = list.split(', ');
      const subject = `node "${group[0]!.node.name}"`;
      const spreading = ordered.filter((end) => end.spec.kind === 'side');
      const stated = spreading.find((end) => end.spec.kind === 'side' && end.spec.after !== undefined);
      if (stated !== undefined) {
        throw new SourceError(
          `edge ${describeEdge(stated.edge)}: states its own place on ${stated.node.name}'s ${side} side, and ${listKey}: already orders that side — keep one`,
          stated.edge.line,
        );
      }
      const pinned = ordered.find((end) => end.spec.kind !== 'side');
      if (pinned !== undefined) {
        throw new SourceError(
          `edge ${describeEdge(pinned.edge)}: is pinned to a spot on ${pinned.node.name}'s ${side} side, and ${listKey}: orders lines that spread along it — take it off the side or drop the list`,
          pinned.edge.line,
        );
      }
      if (new Set(names).size !== names.length) throw new SourceError(`${subject}: ${listKey}: lists a line twice — each line has one place`, group[0]!.node.line);
      const listed = names.map((name) => {
        const end = spreading.find((other) => other.edge.name === name);
        if (end === undefined) {
          throw new SourceError(`${subject}: ${listKey}: lists ${name}, and no line named ${name} meets ${group[0]!.node.name}'s ${side} side`, group[0]!.node.line);
        }
        return end;
      });
      const left = spreading.find((end) => !listed.includes(end));
      if (left !== undefined) {
        throw new SourceError(
          `edge ${describeEdge(left.edge)}: meets ${left.node.name}'s ${side} side, whose ${listKey}: lists every line there and leaves this one out` +
            (left.edge.name === undefined ? ' — name it, as in edge ab a -> b, and add it to the list' : ''),
          left.edge.line,
        );
      }
      ordered.splice(0, ordered.length, ...listed);
    }
    // `to: top, right of z`: an end that states its place sits just past the line it names,
    // and takes along whatever is placed against it, so a chain (`ac below ad`, `ad below ae`)
    // holds whichever order it is written in.
    const before = new Map<End, End[]>();
    const after = new Map<End, End[]>();
    const attached = new Set<End>();
    for (const end of ordered) {
      if (end.spec.kind !== 'side' || end.spec.after === undefined) continue;
      const { name, way } = end.spec.after;
      const anchor = ordered.find((other) => other !== end && other.edge.name === name);
      if (anchor === undefined) {
        throw new SourceError(
          `edge ${describeEdge(end.edge)}: "${end.which}: ${side}, ${way} ${name}" — no line named ${name} meets ${end.node.name}'s ${side} side`,
          end.edge.line,
        );
      }
      const into = way === 'left of' || way === 'above' ? before : after;
      into.set(anchor, [...(into.get(anchor) ?? []), end]);
      attached.add(end);
    }
    const chained: End[] = [];
    const emit = (end: End): void => {
      (before.get(end) ?? []).forEach(emit);
      chained.push(end);
      (after.get(end) ?? []).forEach(emit);
    };
    ordered.filter((end) => !attached.has(end)).forEach(emit);
    const looped = ordered.find((end) => !chained.includes(end));
    if (looped !== undefined && looped.spec.kind === 'side' && looped.spec.after !== undefined) {
      const { name, way } = looped.spec.after;
      throw new SourceError(
        `edge ${describeEdge(looped.edge)}: "${looped.which}: ${side}, ${way} ${name}" — the lines on ${looped.node.name}'s ${side} side are placed against each other in a loop, so none of them has a place to start from`,
        looped.edge.line,
      );
    }
    ordered.splice(0, ordered.length, ...chained);
    // Pinned ends keep their slots in that order but take them in the order
    // they sit along the side, so the side is split from one end to the other
    // even where their far boxes tie (`to: left, even with cat1` from one box).
    const slots = ordered.flatMap((end, index) => (end.spec.kind === 'side' ? [] : [index]));
    const pins = slots.map((index) => ordered[index]!).sort((a, b) => along(a.at!) - along(b.at!));
    slots.forEach((index, k) => (ordered[index] = pins[k]!));
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
        ends: ordered.map((end) => ({ at: end.at!, edge: end.edge, which: end.which })).sort((p, q) => along(p.at) - along(q.at)),
      });
    }
  }
  for (const node of nodes) {
    for (const key of EDGE_ORDER_KEYS) {
      if (node.attrs[key] === undefined || listsUsed.has(`${node.name}\n${key}`)) continue;
      throw new SourceError(`node "${node.name}": ${key}: lists ${node.attrs[key]}, and no line spreads along ${node.name}'s ${key.split('-')[0]} side`, node.line);
    }
  }
  return shared;
}

/** The side an end lands on, for grouping: a side, a fraction along one, or a point in the middle of one. */
function sideOf(end: End): Side | undefined {
  const spec = end.spec;
  if (spec.kind === 'side' || spec.kind === 'fraction' || spec.kind === 'even') return spec.side;
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
  /** Along a collapsed bundle: the bus draws this stretch once, so the member doesn't. */
  hidden?: boolean;
}

function route(edge: LayoutEdge, start: End, end: End, context: Context): Route {
  const subject = edge.bundle ? `bundle ${edge.name}` : `edge ${describeEdge(edge)}`;
  // A straight line from a box back to itself has nowhere to go but along
  // its own border; a loop needs a path that bends round something.
  const bends = edge.look.path !== 'straight' || (edge.via ?? []).some((entry) => entry.leg?.attrs['path'] !== undefined && entry.leg.attrs['path'] !== 'straight');
  if (!edge.bundle && edge.from === edge.to && !edge.onLine?.from && !edge.onLine?.to && !bends) {
    throw new SourceError(
      `${subject} goes from ${edge.from.name} back to itself, and a straight line can't loop — ` +
        `write it as a loop round a side, such as from: left  to: right  via: ${edge.from.name} top  line: (path: square)`,
      edge.line,
    );
  }
  // A bundle has no ends: its path is its stops alone (6.6).
  const ways: Way[] = edge.bundle
    ? []
    : [
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
  const entries = edge.via ?? [];
  for (const [index, entry] of entries.entries()) {
    if (entry.leg && !entry.stop) {
      if (pending) {
        throw new SourceError(`${subject}: leg ${pending.name} and leg ${entry.leg.name} name the same stretch — keep one, or put a stop between them`, edge.line);
      }
      if (ways.length === 0) {
        throw new SourceError(`${subject}: leg ${entry.leg.name} comes before the first stop, and a bundle starts there — name a stretch between two stops`, edge.line);
      }
      pending = entry.leg;
      continue;
    }
    const stop = entry.stop!;
    const prev = ways.length > 0 ? ways[ways.length - 1]!.at : firstPrev(edge, index);
    const stopWays = stop.kind === 'bundle'
      ? alongBundle(edge, stop, prev, context, subject)
      : expand(stop, edge.viaAt?.[index], prev, context, subject, edge.line);
    // A bundle's first stop is where it starts, so nothing leads into it.
    if (ways.length > 0) segments.push({ kind: 'stretch', ...(pending ? { leg: pending } : {}) });
    pending = undefined;
    ways.push(stopWays[0]!);
    const hidden = stop.kind === 'bundle' && context.lines.get(stop.bundle)!.bundle!.arrangement === 'collapsed';
    for (const next of stopWays.slice(1)) {
      segments.push({ kind: 'run', ...(entry.leg ? { leg: entry.leg } : {}), ...(hidden ? { hidden } : {}) });
      ways.push(next);
    }
    if (entry.leg && stopWays.length === 1) pointLegs.set(entry.leg.name, stopWays[0]!.at);
    stops.push({ written: stop.written, points: stopWays.map((way) => way.at) });
  }
  const back = (heading: Point): Point => ({ x: -heading.x, y: -heading.y });
  if (edge.bundle) {
    if (pending) throw new SourceError(`${subject}: leg ${pending.name} comes after the last stop, and a bundle ends there — name a stretch between two stops`, edge.line);
    if (ways.length < 2) {
      throw new SourceError(`${subject}: a bundle's path runs from one place to another, and via: names one point — add a stop, or pass a side or a region, such as \`via: through slot horizontal\``, edge.line);
    }
  } else {
    segments.push({ kind: 'stretch', ...(pending ? { leg: pending } : {}) });
    ways.push({
      at: end.at!,
      face: end.face,
      ...(end.headings.length === 1 ? { dir: back(end.headings[0]!) } : {}),
      ...(end.headings.length > 1 ? { choices: end.headings.map(back) } : {}),
    });
  }

  // A curved line passes a stop with no way of its own, such as a corner,
  // heading from the place before it toward the place after it (6.4), so a
  // set of stops that mirror each other draws a curve that does too.
  const smooth = ways.map((way, index) =>
    index > 0 && index < ways.length - 1 && !way.dir && !way.choices ? unit(ways[index - 1]!.at, ways[index + 1]!.at) : undefined,
  );

  // Each segment's points, in order, and whether it is drawn curved.
  const drawn: { points: Point[]; curved: boolean; through: Point[]; turned?: Turned; segment: Segment; from: Way; to: Way; step: number }[] = [];
  let arriving: Point | undefined;
  // For each stretch the line's own turn: shapes, why it placed nothing there, or undefined where it did.
  const unturned: (string | undefined)[] = [];
  for (const [index, segment] of segments.entries()) {
    const from = ways[index]!;
    const to = ways[index + 1]!;
    const attrs = segment.leg?.attrs ?? {};
    const path = (attrs['path'] ?? edge.look.path) as LayoutEdge['look']['path'];
    if (segment.kind === 'run' || path === 'straight') {
      drawn.push({ points: [from.at, to.at], curved: false, through: [from.at, to.at], segment, from, to, step: 0 });
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
        options.push({ out, arrive, built: squareRoute(from, to, out, back(arrive), turn ?? 1 / 2, step) });
      }
    }
    const bends = (option: (typeof options)[number]): number => option.built.points.length - 2;
    const fewest = Math.min(...options.map(bends));
    const best = options.filter((option) => bends(option) === fewest);
    if (best.length > 1) {
      refuseTie(edge, index === 0 ? start : end, best.map((option) => (index === 0 ? option.out : back(option.arrive))), fewest);
    }
    const chosen = best[0]!;
    // A point with no way of its own is passed in the way the line arrives,
    // along an axis, which is what a square line needs (6.4).
    from.dir ??= chosen.out;
    to.dir ??= chosen.arrive;
    arriving = chosen.arrive;
    // Only a stated turn is passed through; without one a curve is one free sweep.
    const turned = turn !== undefined ? chosen.built.turned : undefined;
    if (attrs['turn'] !== undefined && !chosen.built.turned) {
      throw new SourceError(`${subject}: leg ${segment.leg!.name}: \`turn: ${attrs['turn']}\` places nothing — ${chosen.built.unturned ?? 'it has no leg between its stops'}. Remove it, or say where the line goes with \`via:\``, edge.line);
    }
    if (attrs['turn'] === undefined) unturned.push(chosen.built.turned ? undefined : chosen.built.unturned ?? '');
    drawn.push({ points: chosen.built.points, curved: path === 'curved', through: chosen.built.through, ...(turned ? { turned } : {}), segment, from, to, step });
    if (segments.length === 1) {
      context.shapes.set(edge, { square: chosen.built.points, through: chosen.built.through, curved: path === 'curved', out: chosen.out, arrive: chosen.arrive, ...(turned ? { turned } : {}) });
    }
  }

  // A turn: written on the line itself must place a leg somewhere; from a style or a default it lands where it can.
  if (edge.look.turnWritten !== undefined && unturned.length > 0 && unturned.every((why) => why !== undefined)) {
    const why = unturned.length === 1 && unturned[0] ? unturned[0] : 'no stretch of it has a leg between its stops';
    throw new SourceError(`${subject}: \`turn: ${edge.look.turnWritten}\` places nothing — ${why}. Remove it, or say where the line goes with \`via:\``, edge.line);
  }

  // The pieces, and each named leg as drawn.
  const pieces: Piece[] = [];
  const legs = new Map<string, Point[]>();
  const points: Point[] = [ways[0]!.at];
  const hidden: [number, number][] = [];
  for (const [index, part] of drawn.entries()) {
    const own: Piece[] = part.curved
      ? curve(part.through, smooth[index] ?? part.from.dir, smooth[index + 1] ?? part.to.dir, edge.look.curve, (part.segment.leg?.attrs['curve'] as LayoutEdge['look']['curve'] | undefined), part.step, part.turned)
      : part.points.slice(1).map((to) => ({ to }));
    if (part.segment.hidden) {
      const last = hidden[hidden.length - 1];
      if (last && last[1] === pieces.length) last[1] += own.length;
      else hidden.push([pieces.length, pieces.length + own.length]);
    }
    pieces.push(...own);
    points.push(...(part.curved ? tracePieces(part.from.at, own) : part.points).slice(1));
    const name = part.segment.leg?.name;
    if (name !== undefined) {
      const trace = tracePieces(part.points[0]!, own);
      const before = legs.get(name);
      // A run named once may be several segments, along a leg's corners.
      legs.set(name, before && drawn[index - 1]?.segment.leg?.name === name ? [...before, ...trace.slice(1)] : trace);
    }
  }
  for (const [name, at] of pointLegs) legs.set(name, [at]);
  return { edge, start: ways[0]!.at, pieces, points: tidyCorners(points), legs, stops, ...(hidden.length > 0 ? { hidden } : {}) };
}

/**
 * What a bundle's first stop is measured from, having nothing before it: the
 * far side of it from the next stop, so a run there is taken away from where
 * the bundle goes next. With no next stop, the stop itself, which leaves a run
 * in reading order, left or top first.
 */
function firstPrev(edge: LayoutEdge, index: number): Point {
  const center = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const own = edge.viaAt?.[index];
  const here = own ? center(own) : { x: 0, y: 0 };
  const next = edge.viaAt?.slice(index + 1).find((rect) => rect !== undefined);
  if (next === undefined) return here;
  const there = center(next);
  return { x: 2 * here.x - there.x, y: 2 * here.y - there.y };
}

/**
 * The lines through each bundle and the lane each runs in: its distance to the
 * left of the bundle's own way of travel (6.6). Members are spread evenly about
 * the path a gap apart, in one order read across the bundle where it starts —
 * top to bottom on a level start, left to right on an upright one — and held
 * round every turn. A collapsed bundle runs them all on the path itself.
 */
function lanesOf(bundle: LayoutEdge, context: Context): Map<LayoutEdge, number> {
  const cached = context.lanes.get(bundle);
  if (cached) return cached;
  const subject = `bundle ${bundle.name}`;
  const members = context.layout.edges.filter((edge) => (edge.via ?? []).some((entry) => entry.stop?.kind === 'bundle' && entry.stop.bundle === bundle.name));
  const placed = (edge: LayoutEdge) => (edge.via ?? []).map((entry) => entry.stop).find((stop) => stop?.kind === 'bundle' && stop.bundle === bundle.name) as Extract<ViaStop, { kind: 'bundle' }>;
  const named = new Map(members.filter((edge) => edge.name !== undefined).map((edge) => [edge.name!, edge]));
  const info = bundle.bundle!;
  let ordered: LayoutEdge[];
  if (info.order) {
    // The bundle's list is its whole membership (design.org 6.6).
    for (const name of info.order) {
      if (!named.has(name)) {
        throw new SourceError(
          context.lines.has(name)
            ? `${subject}: order: lists ${name}, which doesn't pass through it — add \`via: ${bundle.name}\` to ${name}, or take it off the list`
            : `${subject}: order: lists ${name}, which is not a line; order: names lines through the bundle`,
          bundle.line,
        );
      }
    }
    if (new Set(info.order).size !== info.order.length) {
      throw new SourceError(`${subject}: order: lists a line twice — each line has one place`, bundle.line);
    }
    for (const member of members) {
      if (member.name === undefined || !info.order.includes(member.name)) {
        throw new SourceError(
          `edge ${describeEdge(member)}: passes through ${bundle.name}, whose order: lists every line through it and leaves this one out` +
            (member.name === undefined ? ' — name the line, such as `edge x a -> b`, and add it to the list' : ` — add ${member.name} to the list`),
          member.line,
        );
      }
    }
    ordered = info.order.map((name) => named.get(name)!);
  } else {
    ordered = [...members];
  }
  // `via: trunk (after: z)`: one line placing itself, as the terms of order: say.
  for (const member of members) {
    const stop = placed(member);
    if (!stop.order) continue;
    const { way, name } = stop.order;
    const anchor = named.get(name);
    if (anchor === undefined || anchor === member) {
      throw new SourceError(
        `edge ${describeEdge(member)}: "via: ${stop.written}" — ${anchor === member ? 'a line has no place relative to itself' : `${name} is not a line through ${bundle.name}`}`,
        member.line,
      );
    }
    if (info.arrangement === 'collapsed') {
      throw new SourceError(`edge ${describeEdge(member)}: "via: ${stop.written}" — ${bundle.name} is collapsed, so its lines share one path and have no order across`, member.line);
    }
    if (info.order) {
      const holds = way === 'after' ? ordered.indexOf(member) > ordered.indexOf(anchor) : ordered.indexOf(member) < ordered.indexOf(anchor);
      if (!holds) {
        throw new SourceError(
          `edge ${describeEdge(member)}: "via: ${stop.written}" puts it ${way} ${name}, and ${bundle.name}'s order: (${info.order.join(', ')}) puts it ${way === 'after' ? 'before' : 'after'} — keep one`,
          member.line,
        );
      }
      continue;
    }
    ordered.splice(ordered.indexOf(member), 1);
    const at = ordered.indexOf(anchor);
    ordered.splice(way === 'after' ? at + 1 : at, 0, member);
  }
  const lanes = new Map<LayoutEdge, number>();
  const trace = traceRoute(context.routes.get(bundle)!);
  const first = unit(trace[0]!, trace[1]!);
  // Reading order across the start: down for a level start, rightward for an upright one.
  const reading = Math.abs(first.x) >= Math.abs(first.y) ? { x: 0, y: 1 } : { x: 1, y: 0 };
  const left = { x: first.y, y: -first.x };
  const sign = reading.x * left.x + reading.y * left.y;
  const gap = info.arrangement === 'collapsed' ? 0 : info.gap;
  ordered.forEach((member, index) => lanes.set(member, (index - (ordered.length - 1) / 2) * gap * sign));
  context.lanes.set(bundle, lanes);
  return lanes;
}

/**
 * A member's way along a bundle: the whole path, shifted into its lane, entered
 * at the end nearer where the line comes from (6.6).
 */
function alongBundle(edge: LayoutEdge, stop: Extract<ViaStop, { kind: 'bundle' }>, prev: Point, context: Context, subject: string): Way[] {
  const bundle = context.lines.get(stop.bundle)!;
  if (edge.via!.filter((entry) => entry.stop?.kind === 'bundle' && entry.stop.bundle === stop.bundle).length > 1) {
    throw new SourceError(`${subject}: passes through ${stop.bundle} twice, and a line has one lane in a bundle — use a second bundle`, edge.line);
  }
  const lane = lanesOf(bundle, context).get(edge)!;
  const path = tidyCorners(traceRoute(context.routes.get(bundle)!));
  const shifted = offsetLine(path, lane);
  const forward = distance(prev, shifted[0]!) <= distance(prev, shifted[shifted.length - 1]!);
  const ordered = forward ? shifted : [...shifted].reverse();
  return ordered.map((p, index) => {
    const dir = unit(ordered[Math.max(0, index - 1)]!, ordered[Math.max(1, index)]!);
    return { at: p, face: { x: p.x, y: p.y, width: 0, height: 0, round: false }, dir };
  });
}

/**
 * A polyline moved `by` to the left of the way it travels, each corner where
 * its two moved neighbors meet, so the moved line keeps its distance round
 * every turn.
 */
function offsetLine(points: Point[], by: number): Point[] {
  if (by === 0) return points;
  const normals = points.slice(1).map((point, index) => {
    const along = unit(points[index]!, point);
    return { x: along.y * by, y: -along.x * by };
  });
  return points.map((point, index) => {
    const before = normals[index - 1];
    const after = normals[index];
    if (!before) return { x: point.x + after!.x, y: point.y + after!.y };
    if (!after) return { x: point.x + before.x, y: point.y + before.y };
    // Where the two moved legs meet: the miter, as long as the turn needs.
    const sum = { x: before.x + after.x, y: before.y + after.y };
    const length = Math.hypot(sum.x, sum.y);
    if (length < 1e-9) return { x: point.x + after.x, y: point.y + after.y };
    const scale = (by * by * 2) / (length * length);
    return { x: point.x + sum.x * scale, y: point.y + sum.y * scale };
  });
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
  // A bundle is followed by `alongBundle`, never expanded here.
  if (stop.kind === 'bundle') throw new Error(`bundle stop ${stop.written} reached expand`);
  // A place: a side is a run just outside it, a point on a side is passed just
  // outside it going along the side, and anything else is passed through.
  // "Just outside" and "just inside" are a tight gap: a line passing a box
  // needs less room than two boxes need from each other.
  const box = at!;
  const target = stop.target;
  const gap = stop.gap !== undefined
    ? gapPixels(stop.gap, `${subject}: via:`, line)
    : stop.mode === 'on' ? 0 : GAPS['tight']!;
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
  /** The middle of the free leg, where `turn:` placed one. */
  turned?: Turned;
  /** Where `turn:` placed nothing, why, for the refusal. */
  unturned?: string;
}

/** Where a stated turn puts a curved line: through the middle of the free leg, heading along it. */
interface Turned {
  at: Point;
  dir: Point;
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
  // The free leg from p1 to p2, placed by `between`, as a curve passes it.
  const turnedOn = (p1: Point, p2: Point): { turned?: Turned } =>
    distance(p1, p2) < 0.5 ? {} : { turned: { at: midpoint(p1, p2), dir: unit(p1, p2) } };

  const parallel = (back.x !== 0) === across;
  if (parallel) {
    const facing = out.x * back.x + out.y * back.y < 0;
    if (facing && (u(b) - u(a)) * du >= 0) {
      // The range has two ends: the free leg runs between them.
      if (Math.abs(v(a) - v(b)) < 0.5) return { points: [a, b], through: [a, b], unturned: 'its ends are level, so it runs straight across' };
      const m = between(u(a), u(b));
      const p1 = make(m, v(a));
      const p2 = make(m, v(b));
      return { points: [a, p1, p2, b], through: [a, midpoint(p1, p2), b], ...turnedOn(p1, p2) };
    }
    if (!facing) {
      // Both sides face the same way: the leg runs a step-out beyond the farther side.
      const far = du > 0 ? Math.max(u(a), u(b)) + step : Math.min(u(a), u(b)) - step;
      const p1 = make(far, v(a));
      const p2 = make(far, v(b));
      return {
        points: tidyCorners([a, p1, p2, b]),
        through: [a, midpoint(p1, p2), b],
        unturned: 'both its ends face the same way, so its middle leg runs a step-out beyond the farther one, not between them',
      };
    }
    // The range is empty: each end steps out, and the line crosses halfway
    // between the boxes in the other direction, through the gap if there is one.
    const gap = gapOn(false);
    const m = gap ? between(gap[0], gap[1]) : between(v(a), v(b));
    const p1 = make(u(sa), m);
    const p2 = make(u(sb), m);
    return { points: tidyCorners([a, sa, p1, p2, sb, b]), through: [a, sa, midpoint(p1, p2), sb, b], ...turnedOn(p1, p2) };
  }

  // At right angles: one corner where it sits behind neither end's side.
  const corner = make(u(b), v(a));
  const dv = across ? back.y : back.x;
  const aheadOfStart = (u(corner) - u(a)) * du > 0;
  const aheadOfEnd = (v(corner) - v(b)) * dv > 0;
  const once = 'it turns once, at right angles, and that corner has only one place';
  if (aheadOfStart && aheadOfEnd) return { points: [a, corner, b], through: [a, b], unturned: once };
  // A waypoint in line with the other end: the corner is the waypoint itself,
  // so the line turns there rather than going round it.
  const point = (face: Face) => face.width === 0 && face.height === 0;
  const inLine = 'it runs straight, in line with the waypoint';
  if (aheadOfStart && point(toFace) && Math.abs(v(corner) - v(b)) < 0.5) return { points: [a, b], through: [a, b], unturned: inLine };
  if (aheadOfEnd && point(fromFace) && Math.abs(u(corner) - u(a)) < 0.5) return { points: [a, b], through: [a, b], unturned: inLine };
  const round = 'it goes round the end a step-out off it, with no gap between the two to cross';
  if (!aheadOfStart && aheadOfEnd) {
    // The far end is behind the start's side: out, across the gap on the end's
    // axis (or round, a step-out off the end where there is none), and in.
    const gap = gapOn(false);
    const m = gap ? between(gap[0], gap[1]) : v(sb);
    const p1 = make(u(sa), m);
    const p2 = make(u(b), m);
    return { points: tidyCorners([a, sa, p1, p2, b]), through: [a, sa, midpoint(p1, p2), b], ...(gap ? turnedOn(p1, p2) : { unturned: round }) };
  }
  if (aheadOfStart && !aheadOfEnd) {
    // The start is behind the end's side: along to the gap on the start's axis
    // (or a step-out where there is none), round, and into the end.
    const gap = gapOn(true);
    const m = gap ? between(gap[0], gap[1]) : u(sa);
    const p1 = make(m, v(a));
    const p2 = make(m, v(sb));
    const p3 = make(u(b), v(sb));
    return { points: tidyCorners([a, p1, p2, p3, b]), through: [a, midpoint(p1, p2), sb, b], ...(gap ? turnedOn(p1, p2) : { unturned: round }) };
  }
  // Behind both: out, round to a step-out off the end, and in.
  const p1 = make(u(sa), v(sb));
  return { points: tidyCorners([a, sa, p1, sb, b]), through: [a, sa, sb, b], unturned: 'it goes round behind both ends, a step-out off each' };
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
 * One sweep from a stretch's first point to its last (design.org 6.3),
 * leaving and arriving in the way the line travels there. The square route's
 * corners are not passed through: a curve forced through points a step-out
 * apart bends sharply between them. An end that heads away from the other end
 * reaches at least a step-out, so a line that turns back loops wide enough to
 * read as a turn. A stated turn is stated, so it splits the sweep in two,
 * passing the middle of the free leg heading along it. Nothing is checked or
 * retried.
 */
function curve(points: Point[], first: Point | undefined, last: Point | undefined, look: LayoutEdge['look']['curve'], leg: LayoutEdge['look']['curve'] | undefined, step: number, turned?: Turned): Piece[] {
  if (leg !== undefined && !(leg in CURVE_REACH)) leg = undefined;
  const reach = CURVE_REACH[leg ?? look];
  const a = points[0]!;
  const b = points[points.length - 1]!;
  if (turned) return [...sweep(a, turned.at, first, turned.dir, reach, step), ...sweep(turned.at, b, turned.dir, last, reach, step)];
  return sweep(a, b, first, last, reach, step);
}

/** One cubic from a to b, leaving along `first` and arriving along `last`. */
function sweep(a: Point, b: Point, first: Point | undefined, last: Point | undefined, reach: number, step: number): Piece[] {
  const length = distance(a, b);
  const chord = unit(a, b);
  const ta = first ?? chord;
  const tb = last ?? chord;
  // How far each handle reaches: a share of the chord, more as the end turns away from it.
  const handle = (t: Point): number => {
    const ahead = t.x * chord.x + t.y * chord.y;
    return Math.max(length * reach, step * Math.max(0, 1 - ahead));
  };
  const ha = handle(ta);
  const hb = handle(tb);
  return [
    {
      c1: { x: a.x + ta.x * ha, y: a.y + ta.y * ha },
      c2: { x: b.x - tb.x * hb, y: b.y - tb.y * hb },
      to: b,
    },
  ];
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

/** A line's pieces with those along a collapsed bundle left out, as the runs either side of each. */
export function visibleRuns(route: Route): { start: Point; pieces: Route['pieces'] }[] {
  const runs: { start: Point; pieces: Route['pieces'] }[] = [];
  let run: { start: Point; pieces: Route['pieces'] } = { start: route.start, pieces: [] };
  route.pieces.forEach((piece, index) => {
    const hidden = route.hidden?.some(([first, past]) => index >= first && index < past) ?? false;
    if (hidden) {
      if (run.pieces.length > 0) runs.push(run);
      run = { start: piece.to, pieces: [] };
    } else {
      run.pieces.push(piece);
    }
  });
  if (run.pieces.length > 0) runs.push(run);
  return runs;
}

/** The line as drawn, as polylines: its trace with any stretch along a collapsed bundle left out. */
export function traceVisible(route: Route): Point[][] {
  return visibleRuns(route).map((run) => tracePieces(run.start, run.pieces));
}

/**
 * Where two drawn lines cross, with the way each runs there. Lines that only
 * touch or run together don't cross, and nor do two lines nearer than `clear`
 * to an end of either: that is two lines meeting at a box, not passing each
 * other. The renderer jumps these and the `edge-crossings` finding counts
 * them, so the two agree.
 */
export function crossingPoints(a: Point[], b: Point[], clear: number): { at: Point; along: Point; other: Point }[] {
  const found: { at: Point; along: Point; other: Point }[] = [];
  const ends = [a[0]!, a[a.length - 1]!, b[0]!, b[b.length - 1]!];
  for (let i = 1; i < a.length; i += 1) {
    const p = a[i - 1]!;
    const q = a[i]!;
    for (let j = 1; j < b.length; j += 1) {
      const r = b[j - 1]!;
      const s = b[j]!;
      const at = intersect(p, q, r, s);
      if (!at || ends.some((end) => distance(end, at) < clear)) continue;
      if (found.some((one) => distance(one.at, at) < 1)) continue;
      found.push({ at, along: unit(p, q), other: unit(r, s) });
    }
  }
  return found;
}

/** Where two segments cross, if they do. Segments that only touch or run together do not. */
function intersect(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 1e-9) return undefined;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denominator;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denominator;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return undefined;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

export function describeEdge(edge: LayoutEdge): string {
  if (edge.bundle) return `bundle ${edge.name}`;
  return `${edge.from.name} ${edge.arrow} ${edge.to.name}`;
}
