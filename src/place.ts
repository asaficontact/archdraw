/**
 * Where every box goes, and how big each container is.
 *
 * Nothing here is solved and nothing is pushed. A placement gives a box an
 * exact distance from its target, each axis of each box comes from exactly one
 * statement, and a box is worked out from things already worked out, in
 * whatever order its targets allow. A container is the outline of its children
 * plus its padding. Two boxes the file puts on one spot are drawn there, and
 * the findings report it.
 *
 * Every quantity is worked out on demand and remembered: a box's start on an
 * axis, its size, and a container's frame. A box asked for while it is still
 * being worked out is a circle in the file, reported with the placements that
 * make it.
 *
 * Coordinates are per frame. The top level's frame is the page. A container's
 * children are placed in its own frame, whose origin is wherever its anchor
 * landed, and the container's box is found around them; a child's place on the
 * page is its container's plus its offset in that frame.
 */
import type { Axis, Direction, OffsetPlacement, Part, Placement, PlacementTarget, PointExpr, PointStmt, RegionStmt, Side } from './ast.js';
import { describePlacement, describePoint, fractionAxis, nameTarget, PART_SIDES } from './ast.js';
import { DECK_STEP, GAPS, HEADER_GAP, UNIT } from './constants.js';
import { SourceError } from './errors.js';
import { joinedToText, type LayoutNode } from './model.js';
import { type Dimension, SIZE_KEYS, type SizeExpr, type SpanSide, storedSize } from './size.js';

/** A stretch of one axis. */
interface Extent {
  start: number;
  size: number;
}

/** Where a container's title sits: against which side, and how. */
export interface TitlePlace {
  /** `inside`, `on` or `outside` a side, or `center` for the middle of the box. */
  how: 'inside' | 'on' | 'outside' | 'center';
  side: 'top' | 'bottom' | 'left' | 'right' | 'center';
  /** Along the side: the start (left or top), the middle, or the end. */
  along: 'start' | 'center' | 'end';
}

/** What `layout:` said, read and checked. */
export interface Layout {
  kind: 'column' | 'row';
  /** Between facing sides of neighbors, in pixels. Absent when `centers` is given. */
  gap?: number;
  /** Between neighbors' centers, in pixels. */
  centers?: number;
  widths: 'natural' | 'match' | 'fill';
  /** `align-children:`: the children's starts, middles or ends even with each other. */
  align: 'start' | 'center' | 'end';
}

/** What the tree pass settled about each node before anything is placed. */
export interface NodeFacts {
  /** The size the node's own contents give it: a leaf's text and padding, a picture. Zero for a container. */
  natural: { width: number; height: number };
  /** The text's ink box from the node's top-left, as a leaf is sized. */
  textBox: { x: number; y: number; width: number; height: number };
  /** Whether the node has any text. An empty text takes no room. */
  hasText: boolean;
  padding: number;
  /** One line of the node's text, and one character, for sizes in `lines` and `chars`. */
  lineHeight: number;
  charWidth: number;
  title: TitlePlace;
  layout?: Layout;
  circle: boolean;
  /** Where `gather-children:` puts the children in the box's spare room, on each axis. */
  gather: Record<Axis, 'start' | 'center' | 'end'>;
}

const BOTH_AXES: Axis[] = ['x', 'y'];

/** Whether an axis is across or down, in a writer's words. */
const AXIS_SAID: Record<Axis, string> = { x: 'across', y: 'up and down' };

/** Which way a direction moves on each axis: past the far side, before the near one, or not at all. */
function component(direction: Direction, axis: Axis): 'after' | 'before' | undefined {
  if (axis === 'x') {
    if (direction.includes('right')) return 'after';
    if (direction.includes('left')) return 'before';
    return undefined;
  }
  if (direction.startsWith('below')) return 'after';
  if (direction.startsWith('above')) return 'before';
  return undefined;
}

/** One statement about one axis of a box. */
type Statement =
  | { kind: 'after' | 'before'; placement: Placement; edge: () => number }
  | { kind: 'align'; placement: Placement; side: 'start' | 'center' | 'end'; at: () => Extent };

/**
 * A gap as written: a gap word, a number in the file's unit, or a number of
 * pixels with `px`. A distance is never negative; the words for an overlap are
 * `inside` and `on`.
 */
export function gapPixels(written: string, subject: string, line: number): number {
  const word = GAPS[written];
  if (word !== undefined) return word;
  if (/^\d*\.?\d+$/.test(written)) return Number(written) * UNIT;
  const pixels = /^(\d*\.?\d+)px$/.exec(written);
  if (pixels) return Number(pixels[1]);
  if (written.startsWith('-')) {
    throw new SourceError(
      `${subject}: a distance is never negative, so ${written} is not one — to overlap, place it inside or on the other`,
      line,
    );
  }
  throw new SourceError(
    `${subject}: "${written}" is not a distance — write one of ${Object.keys(GAPS).join(', ')}, ` +
      'a number in the file\'s unit, or a number of pixels such as 12px',
    line,
  );
}

export class Placer {
  private readonly starts = new Map<string, number>();
  private readonly sizes = new Map<string, number>();
  private readonly frames = new Map<string, FrameAxis>();
  private readonly outlines = new Map<string, FrameAxis>();
  private readonly working = new Set<string>();
  /** What is being worked out, innermost last, for reporting a circle. */
  private readonly trail: Array<{ node: LayoutNode; axis: Axis; placement?: Placement; size?: string }> = [];
  /** A node's size on its own, from what it states or holds, within its limits. */
  private readonly owns = new Map<string, number>();
  /** A layout's child's position and size on each axis, worked out for the whole layout at once. */
  private readonly laid = new Map<string, { start: number; size?: number }>();
  /** The band a laid-out container's children are aligned in, across its layout. */
  private readonly bands = new Map<string, number>();
  /** Where a node joined to its container's text starts, measured from the text's start. */
  private readonly unitStarts = new Map<string, number>();
  /** The stretch a container's text and what is joined to it cover, measured from the text's start. */
  private readonly units = new Map<string, Extent>();

  /** Named points and regions being worked out, innermost last, to refuse one defined through itself. */
  private readonly expanding: string[] = [];

  constructor(
    private readonly roots: LayoutNode[],
    private readonly byName: Map<string, LayoutNode>,
    private readonly facts: Map<LayoutNode, NodeFacts>,
    /** Named points and regions (design.org 4.5), worked out wherever they are used. */
    private readonly named: Map<string, PointStmt | RegionStmt> = new Map(),
  ) {}

  /**
   * Where each named point and region is on the page. A point names one spot,
   * so one that works out to a stretch (a side, a whole box) is refused.
   */
  placeNamed(): Map<string, { x: number; y: number; width: number; height: number }> {
    const placed = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const [name, stmt] of this.named) {
      const page = { name: `${stmt.kind} ${name}`, parent: undefined, children: [], placements: [], line: stmt.line } as unknown as LayoutNode;
      const at = { name } as PlacementTarget;
      const x = this.extentOf(page, at, 'x', { kind: 'on', targets: [at], line: stmt.line });
      const y = this.extentOf(page, at, 'y', { kind: 'on', targets: [at], line: stmt.line });
      if (stmt.kind === 'point' && (x.size > 0.01 || y.size > 0.01)) {
        throw new SourceError(
          `point "${name}" is "${nameTarget(stmt.point)}", which is a stretch rather than one point — ` +
            'name a point, such as a corner or a side\'s -center, or a fraction along a side',
          stmt.line,
        );
      }
      placed.set(name, { x: x.start, y: y.start, width: x.size, height: y.size });
    }
    return placed;
  }

  /**
   * Where a target is on the page once everything is placed: a box, a side (a
   * stretch on one axis), a point, a named point or region. For a line's
   * `via:` stops (design.org 6.4).
   */
  locate(target: PlacementTarget, subject: string, line: number): { x: number; y: number; width: number; height: number } {
    const page = { name: subject, parent: undefined, children: [], placements: [], line } as unknown as LayoutNode;
    const placement: Placement = { kind: 'on', targets: [target], line };
    const x = this.extentOf(page, target, 'x', placement);
    const y = this.extentOf(page, target, 'y', placement);
    return { x: x.start, y: y.start, width: x.size, height: y.size };
  }

  /** Work out everything, and write it onto the nodes. */
  run(): void {
    this.checkAnchors(this.roots, undefined);
    for (const node of this.byName.values()) {
      for (const axis of BOTH_AXES) {
        this.size(node, axis);
        this.page(node, axis);
      }
    }
    for (const node of this.byName.values()) {
      node.x = this.page(node, 'x');
      node.y = this.page(node, 'y');
      node.width = this.size(node, 'x');
      node.height = this.size(node, 'y');
    }
    for (const node of this.byName.values()) this.finish(node);
  }

  // --- the quantities ------------------------------------------------------

  /** Where a node starts on the page. */
  page(node: LayoutNode, axis: Axis): number {
    const parent = node.parent;
    if (!parent) return this.start(node, axis);
    return this.page(parent, axis) + this.start(node, axis) - this.frame(parent, axis).boxStart;
  }

  /** Where a node starts in its container's frame, or on the page for the top level. */
  start(node: LayoutNode, axis: Axis): number {
    return this.remember(this.starts, node, axis, () => this.workOutStart(node, axis));
  }

  size(node: LayoutNode, axis: Axis): number {
    return this.remember(this.sizes, node, axis, () => this.workOutSize(node, axis));
  }

  /** A container's box and title in its own frame, at the size it ends up. */
  private frame(node: LayoutNode, axis: Axis): FrameAxis {
    const key = `${node.name}\n${axis}`;
    const known = this.frames.get(key);
    if (known) return known;
    const worked = this.guard(`frame\n${key}`, node, axis, undefined, () => this.fit(node, axis));
    this.frames.set(key, worked);
    return worked;
  }

  /** A container's outline around what it holds, before anything states its size. */
  private outline(node: LayoutNode, axis: Axis): FrameAxis {
    const key = `${node.name}\n${axis}`;
    const known = this.outlines.get(key);
    if (known) return known;
    const worked = this.guard(`outline\n${key}`, node, axis, undefined, () => this.workOutFrame(node, axis));
    this.outlines.set(key, worked);
    return worked;
  }

  private remember(memo: Map<string, number>, node: LayoutNode, axis: Axis, work: () => number): number {
    const key = `${node.name}\n${axis}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const kind = memo === this.starts ? 'start' : memo === this.owns ? 'own' : memo === this.unitStarts ? 'unit' : 'size';
    const worked = this.guard(`${kind}\n${key}`, node, axis, undefined, work);
    memo.set(key, worked);
    return worked;
  }

  /**
   * Work something out, refusing a circle. The trail holds what was being
   * worked out on the way here, and the placements that asked for each.
   */
  private guard<T>(
    key: string,
    node: LayoutNode,
    axis: Axis,
    placement: Placement | undefined,
    work: () => T,
    size?: string,
  ): T {
    if (this.working.has(key)) throw this.circle(node);
    this.working.add(key);
    this.trail.push({ node, axis, ...(placement ? { placement } : {}), ...(size ? { size } : {}) });
    try {
      return work();
    } finally {
      this.working.delete(key);
      this.trail.pop();
    }
  }

  private circle(node: LayoutNode): SourceError {
    const from = this.trail.findIndex((step) => step.node === node);
    const loop = this.trail.slice(from === -1 ? 0 : from).filter((step) => step.placement || step.size);
    const said = [
      ...new Set(
        loop.map((step) =>
          step.placement ? `"${step.node.name} ${describePlacement(step.placement)}"` : `"${step.node.name} ${step.size}"`,
        ),
      ),
    ];
    const last = loop[loop.length - 1];
    if (loop.some((step) => step.size)) {
      return new SourceError(
        said.length === 1
          ? `"${node.name}" is sized from itself: ${said[0]} — measure it from something worked out without it`
          : `these depend on each other in a circle: ${said.join(', ')} — one of them has to be stated without the others`,
        last?.placement?.line ?? last?.node.line ?? node.line,
      );
    }
    if (said.length < 2) {
      return new SourceError(
        `"${node.name}" is placed against something that depends on where "${node.name}" goes` +
          (said.length === 1 ? ` (${said[0]})` : '') +
          ' — place it against something worked out without it',
        last?.placement?.line ?? node.line,
      );
    }
    return new SourceError(
      `these placements depend on each other in a circle: ${said.join(', ')} — ` +
        'one of them has to be placed against something else',
      last?.placement?.line ?? node.line,
    );
  }

  // --- a box's start -------------------------------------------------------

  private workOutStart(node: LayoutNode, axis: Axis): number {
    const parent = node.parent;
    // A heading goes where its container's title would.
    if (parent && parent.heading === node) return this.frame(parent, axis).titleStart;
    // Joined to the text: wherever the text goes, the same distance from it.
    if (parent && joinedToText(node)) return this.frame(parent, axis).textStart + this.unitStart(node, axis);
    if (parent && this.facts.get(parent)!.layout) return this.inLayout(node, axis).start;
    if (node.placements.length === 0) {
      // The anchor of its frame. A container's title, when something is
      // placed against it, is the anchor instead; `checkAnchors` has made sure
      // there is exactly one.
      return 0;
    }
    return this.placed(node, axis);
  }

  /** Where a node joined to its container's text starts, from the text's start. */
  private unitStart(node: LayoutNode, axis: Axis): number {
    return this.remember(this.unitStarts, node, axis, () => this.placed(node, axis));
  }

  /** A box's start from its own placements. */
  private placed(node: LayoutNode, axis: Axis): number {
    const statements = this.statements(node, axis);
    if (statements.length === 0) return this.lone(node, axis);
    if (statements.length === 1) {
      const [only] = statements;
      return this.apply(node, axis, only!);
    }
    const [first, second] = statements as [Statement, Statement];
    if (first.kind !== 'align' && second.kind !== 'align' && first.kind !== second.kind) {
      // Opposite placements: centered between the two at its own size. Each
      // target stays where its own statement put it.
      const after = first.kind === 'after' ? first : second;
      const before = first.kind === 'after' ? second : first;
      const low = this.edgeOf(node, axis, after);
      const high = this.edgeOf(node, axis, before);
      return (low + high) / 2 - this.size(node, axis) / 2;
    }
    // Two pinned edges position the box and size it; `pins` checked them.
    const pins = this.pins(node, axis);
    if (pins) return pins.start;
    throw this.overStated(node, axis, statements);
  }

  private edgeOf(node: LayoutNode, axis: Axis, statement: Statement): number {
    return this.guard(`edge\n${node.name}\n${axis}\n${statement.placement.line}`, node, axis, statement.placement, () =>
      statement.kind === 'align' ? 0 : statement.edge(),
    );
  }

  /** A box's start from one statement. */
  private apply(node: LayoutNode, axis: Axis, statement: Statement): number {
    return this.guard(`apply\n${node.name}\n${axis}`, node, axis, statement.placement, () => {
      if (statement.kind !== 'align') {
        // Measured from a part of this box (`center 12 right of a center`), or from its facing side.
        const own = this.ownPart(node, statement.placement, axis);
        return statement.kind === 'after' ? statement.edge() - own.start : statement.edge() - own.start - own.size;
      }
      const at = statement.at();
      if (statement.side === 'start') return at.start;
      if (statement.side === 'end') return at.start + at.size - this.size(node, axis);
      return at.start + at.size / 2 - this.size(node, axis) / 2;
    });
  }

  /**
   * Nothing states this axis. A lone direction on the other axis centers the
   * box on its target here, since walking right from something keeps you on
   * its center line. Two of them leave it open which target to center on, and
   * that is refused rather than decided.
   */
  private lone(node: LayoutNode, axis: Axis): number {
    const offsets = node.placements.filter(
      (placement): placement is OffsetPlacement =>
        placement.kind === 'offset' && component(placement.direction, axis) === undefined,
    );
    if (offsets.length !== 1) {
      const said = node.placements.map((placement) => `"${describePlacement(placement)}"`).join(' and ');
      throw new SourceError(
        `"${node.name}" says where it goes ${AXIS_SAID[axis === 'x' ? 'y' : 'x']} (${said}) but not ` +
          `${AXIS_SAID[axis]} — add a placement that says ${axis === 'x' ? 'how far across, such as left even with' : 'how high, such as even with'} one of them`,
        node.line,
      );
    }
    const [offset] = offsets;
    return this.guard(`lone\n${node.name}\n${axis}`, node, axis, offset, () => {
      const at = this.region(node, offset!, axis);
      const own = this.ownPart(node, offset!, axis);
      return at.start + at.size / 2 - own.start - own.size / 2;
    });
  }

  /**
   * The stretch of this box a placement measures from, from the box's start:
   * the part it names, or the whole box.
   */
  private ownPart(node: LayoutNode, placement: Placement, axis: Axis): Extent {
    const whole = { start: 0, size: this.size(node, axis) };
    if (placement.kind !== 'offset' || placement.own === undefined) return whole;
    if (placement.own === 'text') {
      if (!this.hasTitle(node)) {
        throw new SourceError(`"${node.name}" measures "${describePlacement(placement)}" from its text, and it has none`, placement.line);
      }
      return this.textOf(node, axis, 0);
    }
    return narrow(whole, placement.own, axis, this.facts.get(node)!.circle, this.size(node, 'x'));
  }

  private overStated(node: LayoutNode, axis: Axis, statements: Statement[]): SourceError {
    const said = [...new Set(statements.map((statement) => statement.placement))]
      .map((placement) => `"${describePlacement(placement)}"`)
      .join(' and ');
    return new SourceError(
      `"${node.name}" says where it goes ${AXIS_SAID[axis]} more than once: ${said}. Each axis is stated ` +
        'once — keep one, or pin two opposite edges with even with to give it a size',
      statements[statements.length - 1]!.placement.line,
    );
  }

  /** Every statement a node's placements make about one axis. */
  private statements(node: LayoutNode, axis: Axis): Statement[] {
    const found: Statement[] = [];
    for (const placement of node.placements) {
      if (placement.kind === 'offset') {
        const way = component(placement.direction, axis);
        if (way === undefined) continue;
        found.push({
          kind: way,
          placement,
          edge: () => {
            const at = this.region(node, placement, axis);
            const gap = this.gapOf(node, placement, axis);
            return way === 'after' ? at.start + at.size + gap : at.start - gap;
          },
        });
      } else if (placement.kind === 'align') {
        if (placement.axis !== axis) continue;
        found.push({
          kind: 'align',
          placement,
          side: sideAlong(placement.side),
          at: () => this.region(node, placement, axis),
        });
      } else {
        found.push({ kind: 'align', placement, side: 'center', at: () => this.region(node, placement, axis) });
      }
    }
    return found;
  }

  /**
   * Two alignments pinning opposite edges: `top even with a  bottom even with
   * c` positions the box and sizes it, and counts as one statement.
   */
  private pins(node: LayoutNode, axis: Axis): { start: number; size: number } | undefined {
    const parent = node.parent;
    if (parent && this.facts.get(parent)!.layout) return undefined;
    const statements = this.statements(node, axis);
    if (statements.length !== 2) return undefined;
    const [first, second] = statements as [Statement, Statement];
    if (first.kind !== 'align' || second.kind !== 'align') return undefined;
    const sides = new Set([first.side, second.side]);
    if (!sides.has('start') || !sides.has('end')) return undefined;
    const low = first.side === 'start' ? first : second;
    const high = first.side === 'start' ? second : first;
    const from = this.guard(`pin\n${node.name}\n${axis}\nlow`, node, axis, low.placement, () => low.at());
    const to = this.guard(`pin\n${node.name}\n${axis}\nhigh`, node, axis, high.placement, () => high.at());
    const start = from.start;
    const end = to.start + to.size;
    if (end < start) {
      throw new SourceError(
        `"${node.name}" pins its ${axis === 'x' ? 'left' : 'top'} edge past its ${axis === 'x' ? 'right' : 'bottom'} ` +
          `edge ("${describePlacement(low.placement)}" and "${describePlacement(high.placement)}"), which leaves it no size`,
        high.placement.line,
      );
    }
    return { start, size: end - start };
  }

  /** The gap a placement leaves, in pixels. */
  private gapOf(node: LayoutNode, placement: OffsetPlacement, axis: Axis): number {
    const each = placement.gaps?.[axis];
    if (each !== undefined) return gapPixels(each, `"${node.name}"`, placement.line);
    if (placement.gap !== undefined) return gapPixels(placement.gap, `"${node.name}"`, placement.line);
    const parent = node.parent;
    const own = parent !== undefined && placement.targets.some((target) => target.name === parent.name);
    if (own && placement.targets.some((target) => target.part === 'text')) {
      // One unit, as beside any text of one's own. An empty text takes no
      // room, and that includes the gap beside it.
      return parent.heading !== undefined || this.facts.get(parent)!.hasText ? UNIT : 0;
    }
    if (placement.written === 'inside') return own ? this.facts.get(parent)!.padding : GAPS['tight']!;
    return GAPS['normal']!;
  }

  // --- targets -------------------------------------------------------------

  /** The extent on one axis of what a placement names: one target, or the region bounding several. */
  private region(node: LayoutNode, placement: Placement, axis: Axis): Extent {
    let start = Infinity;
    let end = -Infinity;
    for (const target of placement.targets) {
      const at = this.extentOf(node, target, axis, placement);
      start = Math.min(start, at.start);
      end = Math.max(end, at.start + at.size);
    }
    return { start, size: end - start };
  }

  /**
   * One target's extent on one axis, in the frame `node` is placed in: a
   * point written out, a named point or region, a fraction of the way across
   * a box, or a box and its part.
   */
  private extentOf(node: LayoutNode, target: PlacementTarget, axis: Axis, placement: Placement): Extent {
    if (target.point) return this.pointExtent(node, target.point, axis, placement);
    const defined = this.byName.has(target.name) ? undefined : this.named.get(target.name);
    if (defined) {
      const whole = this.namedExtent(node, defined, axis, placement);
      if (target.part === 'text') {
        throw new SourceError(`"${node.name}" is placed against "${nameTarget(target)}", and a ${defined.kind} has no text`, placement.line);
      }
      return this.alongFraction(whole, target, axis, () => narrow(whole, target.part, axis, false, 0));
    }
    if (target.fraction) {
      const whole = this.extentOf(node, { name: target.name }, axis, placement);
      return this.alongFraction(whole, target, axis, () =>
        target.part === undefined ? whole : this.extentOf(node, { name: target.name, part: target.part }, axis, placement),
      );
    }
    return this.nodeExtent(node, target, axis, placement);
  }

  /**
   * A fraction of the way across `whole` on its own axis (`3/4 down`, `1/3
   * across from right`). On the other axis it is the side it runs along, or
   * the whole box when it was written first.
   */
  private alongFraction(whole: Extent, target: PlacementTarget, axis: Axis, otherwise: () => Extent): Extent {
    const fraction = target.fraction;
    if (!fraction || fractionAxis(fraction) !== axis) return otherwise();
    const fromEnd = fraction.along === 'up' || fraction.from === 'right';
    const at = fromEnd ? whole.start + whole.size * (1 - fraction.value) : whole.start + whole.size * fraction.value;
    return { start: at, size: 0 };
  }

  /** A named point or region, worked out in the frame `node` is placed in, with a region's padding. */
  private namedExtent(node: LayoutNode, stmt: PointStmt | RegionStmt, axis: Axis, placement: Placement): Extent {
    if (this.expanding.includes(stmt.name)) {
      const loop = [...this.expanding.slice(this.expanding.indexOf(stmt.name)), stmt.name];
      throw new SourceError(
        loop.length === 2
          ? `${stmt.kind} "${stmt.name}" is worked out from itself — name things worked out without it`
          : `these are worked out from each other in a circle: ${loop.join(' → ')} — one of them has to name something else`,
        stmt.line,
      );
    }
    this.expanding.push(stmt.name);
    try {
      if (stmt.kind === 'point') return this.extentOf(node, stmt.point, axis, placement);
      let extent: Extent;
      const [first, second] = stmt.corners;
      if (second === undefined) {
        extent = this.betweenOf(node, first.point as Extract<PointExpr, { kind: 'between' }>, axis, placement, stmt.name);
      } else {
        const a = this.extentOf(node, first, axis, placement);
        const b = this.extentOf(node, second, axis, placement);
        const start = Math.min(a.start, b.start);
        extent = { start, size: Math.max(a.start + a.size, b.start + b.size) - start };
      }
      const padding = stmt.attrs['padding'];
      if (padding === undefined) return extent;
      const by = gapPixels(padding, `region "${stmt.name}" padding:`, stmt.line);
      return { start: extent.start - by, size: extent.size + by * 2 };
    } finally {
      this.expanding.pop();
    }
  }

  /** A point written out, on one axis. */
  private pointExtent(node: LayoutNode, point: PointExpr, axis: Axis, placement: Placement): Extent {
    if (point.kind === 'between') return this.betweenOf(node, point, axis, placement);
    if (point.kind === 'from') return this.crossingOf(node, point, axis, placement);
    const from = point.from;
    const namedPoint = !this.byName.has(from.name) && this.named.get(from.name)?.kind === 'point';
    if (from.part === undefined && from.point === undefined && from.fraction === undefined && !namedPoint) {
      throw new SourceError(
        `"${describePoint(point)}" moves a point, and "${from.name}" is a whole ${this.named.has(from.name) ? 'region' : 'box'} — ` +
          `say which point, such as \`${point.distance} ${point.direction}${/left|right/.test(point.direction) ? ' of' : ''} ${from.name} ${point.direction.startsWith('above') ? 'top' : point.direction.startsWith('below') ? 'bottom' : point.direction}\``,
        placement.line,
      );
    }
    const at = this.extentOf(node, from, axis, placement);
    const way = component(point.direction, axis);
    if (way === undefined) return at;
    const by = gapPixels(point.distance, `"${describePoint(point)}"`, placement.line);
    return { start: at.start + (way === 'after' ? by : -by), size: at.size };
  }

  /**
   * `between a and b`: the space between two things. On an axis where they are
   * apart it is the gap, from `a`'s facing side to `b`'s; where they overlap,
   * the stretch they share. As a point it is the middle of that, or `at` the
   * fraction of the gap from `a`. As a region (`region` given) it is the whole
   * of it, and `(span: both)` stretches it over both boxes where they overlap
   * (design.org 4.2).
   */
  private betweenOf(
    node: LayoutNode,
    point: Extract<PointExpr, { kind: 'between' }>,
    axis: Axis,
    placement: Placement,
    region?: string,
  ): Extent {
    const pair = (on: Axis) => [this.extentOf(node, point.a, on, placement), this.extentOf(node, point.b, on, placement)] as const;
    const apart = (on: Axis) => {
      const [a, b] = pair(on);
      return a.start + a.size <= b.start + 0.01 || b.start + b.size <= a.start + 0.01;
    };
    const other: Axis = axis === 'x' ? 'y' : 'x';
    const written = describePoint(point);
    if (region !== undefined && point.span && apart('x') && apart('y')) {
      const [ax, bx] = pair('x');
      const [ay, by] = pair('y');
      const aLeft = ax.start < bx.start;
      const aAbove = ay.start < by.start;
      const a = nameTarget(point.a);
      const b = nameTarget(point.b);
      throw new SourceError(
        `region "${region}": ${a} and ${b} are apart both ways, so there are two gaps to stretch — write the one meant by its corners: ` +
          `\`region ${region}  ${point.a.name} ${aAbove ? 'top' : 'bottom'}-${aLeft ? 'right' : 'left'} to ${point.b.name} ${aAbove ? 'bottom' : 'top'}-${aLeft ? 'left' : 'right'}\` (the gap across) or ` +
          `\`region ${region}  ${point.a.name} ${aAbove ? 'bottom' : 'top'}-${aLeft ? 'left' : 'right'} to ${point.b.name} ${aAbove ? 'top' : 'bottom'}-${aLeft ? 'right' : 'left'}\` (the gap up and down)`,
        placement.line,
      );
    }
    const [a, b] = pair(axis);
    if (apart(axis)) {
      const aFirst = a.start + a.size <= b.start + 0.01;
      const from = aFirst ? a.start + a.size : a.start;
      const to = aFirst ? b.start : b.start + b.size;
      if (region !== undefined) return { start: Math.min(from, to), size: Math.abs(to - from) };
      return { start: from + (to - from) * (point.at ?? 0.5), size: 0 };
    }
    if (region === undefined && point.at !== undefined && !apart(other)) {
      throw new SourceError(
        `"${written}": ${nameTarget(point.a)} and ${nameTarget(point.b)} overlap, so there is no gap to go ${point.atWritten} of the way across`,
        placement.line,
      );
    }
    const start = Math.max(a.start, b.start);
    const end = Math.min(a.start + a.size, b.start + b.size);
    if (region !== undefined && point.span) {
      const outer = Math.min(a.start, b.start);
      return { start: outer, size: Math.max(a.start + a.size, b.start + b.size) - outer };
    }
    if (region !== undefined) return { start, size: end - start };
    return { start: (start + end) / 2, size: 0 };
  }

  /**
   * `down from a and left from b`: where a line straight down from `a` meets
   * one straight left from `b`. The words also say which way the point lies
   * from each, and that is checked (design.org 4.3).
   */
  private crossingOf(node: LayoutNode, point: Extract<PointExpr, { kind: 'from' }>, axis: Axis, placement: Placement): Extent {
    const upright = point.lines.find((line) => line.way === 'up' || line.way === 'down')!;
    const level = point.lines.find((line) => line.way === 'left' || line.way === 'right')!;
    const written = describePoint(point);
    /** Where a line from this thing runs, on the axis it holds still. */
    const runs = (line: typeof upright, on: Axis) => {
      const at = this.extentOf(node, line.target, on, placement);
      if (line.target.part !== undefined && at.size > 0.01) {
        const sides = on === 'x' ? 'left or right, or a corner' : 'top or bottom, or a corner';
        throw new SourceError(
          `"${written}": ${nameTarget(line.target)} is a whole side, with no one place for a line ${line.way} from it to start — name ${sides}`,
          placement.line,
        );
      }
      return at.start + at.size / 2;
    };
    const x = runs(upright, 'x');
    const y = runs(level, 'y');
    // Each line starts at its thing and goes the way it says; the meeting has to be on both.
    const fromUpright = (() => {
      const at = this.extentOf(node, upright.target, 'y', placement);
      return at.start + at.size / 2;
    })();
    const fromLevel = (() => {
      const at = this.extentOf(node, level.target, 'x', placement);
      return at.start + at.size / 2;
    })();
    const wrong =
      (upright.way === 'down' && y <= fromUpright) || (upright.way === 'up' && y >= fromUpright)
        ? `${upright.way} from ${nameTarget(upright.target)}`
        : (level.way === 'right' && x <= fromLevel) || (level.way === 'left' && x >= fromLevel)
          ? `${level.way} from ${nameTarget(level.target)}`
          : undefined;
    if (wrong !== undefined) {
      throw new SourceError(
        `"${written}": the two lines never meet — the point where they would cross isn't ${wrong}. ` +
          'The words say which way the point lies from each, so one of them is the wrong way round',
        placement.line,
      );
    }
    return { start: axis === 'x' ? x : y, size: 0 };
  }

  /** A box, or a part of one, on one axis, in the frame `node` is placed in. */
  private nodeExtent(node: LayoutNode, target: PlacementTarget, axis: Axis, placement: Placement): Extent {
    const named = this.byName.get(target.name);
    if (!named) {
      throw new SourceError(`"${node.name}" is placed against "${target.name}", which does not exist`, placement.line);
    }
    if (named === node || isWithin(named, node)) {
      throw new SourceError(
        `"${node.name}" is placed against ${named === node ? 'itself' : `"${named.name}", which is inside it`}`,
        placement.line,
      );
    }
    const parent = node.parent;
    let whole: Extent;
    let text: Extent | undefined;
    if (!parent) {
      // The top level is placed on the page, so anything anywhere can be named.
      whole = { start: this.page(named, axis), size: this.size(named, axis) };
      if (target.part === 'text') text = this.textOf(named, axis, whole.start);
    } else if (joinedToText(node)) {
      // Joined to the text: measured from the text's start, so the unit has
      // one shape wherever the text's position words put it. The tree pass
      // allowed nothing else to be named.
      if (named === parent) {
        whole = { start: 0, size: 0 };
        text = { start: 0, size: this.textSize(parent, axis) };
      } else {
        whole = { start: this.unitStart(named, axis), size: this.size(named, axis) };
        if (target.part === 'text') text = this.textOf(named, axis, whole.start);
      }
    } else if (named === parent && target.part === 'text' && this.anchoredOnTitle(parent)) {
      // The title anchors the frame: the text is at the origin, known without the box.
      whole = { start: 0, size: 0 };
      text = { start: 0, size: this.textSize(parent, axis) };
    } else if (named.parent === parent && joinedToText(named) && this.anchoredOnTitle(parent)) {
      // Joined to the text, which is at the origin.
      whole = { start: this.unitStart(named, axis), size: this.size(named, axis) };
      if (target.part === 'text') text = this.textOf(named, axis, whole.start);
    } else if (named === parent.heading) {
      // The heading is the title: at the origin when something is placed
      // against it, and otherwise wherever the title goes.
      whole = this.anchoredOnTitle(parent)
        ? { start: 0, size: this.size(named, axis) }
        : { start: this.start(named, axis), size: this.size(named, axis) };
      if (target.part === 'text') text = this.textOf(named, axis, whole.start);
    } else if (named === parent) {
      const frame = this.frame(parent, axis);
      whole = { start: frame.boxStart, size: frame.boxSize };
      if (target.part === 'text') text = { start: frame.textStart, size: frame.textSize };
    } else if (named.parent === parent) {
      if (this.framed(named) && !this.framed(node)) {
        throw new SourceError(
          `"${node.name}" is placed against "${named.name}", which is placed against "${parent.name}" itself. ` +
            `Nothing may be placed against a thing placed against its container's side or corner — place ` +
            `"${node.name}" against another child`,
          placement.line,
        );
      }
      whole = { start: this.start(named, axis), size: this.size(named, axis) };
      if (target.part === 'text') text = this.textOf(named, axis, whole.start);
    } else {
      throw new SourceError(
        `"${node.name}" is placed against "${target.name}", which is not one of its siblings or its parent`,
        placement.line,
      );
    }
    if (target.part === 'text') {
      if (!text || (!this.hasTitle(named) && named !== parent)) {
        throw new SourceError(
          `"${node.name}" is placed against "${nameTarget(target)}", and "${named.name}" has no text`,
          placement.line,
        );
      }
      return text;
    }
    return narrow(whole, target.part, axis, this.facts.get(named)!.circle, this.size(named, 'x'));
  }

  /** A node's text on one axis, given where the node starts. */
  private textOf(node: LayoutNode, axis: Axis, start: number): Extent {
    const facts = this.facts.get(node)!;
    if (node.children.length > 0) {
      const frame = this.frame(node, axis);
      return { start: start + frame.textStart - frame.boxStart, size: frame.textSize };
    }
    const box = facts.textBox;
    const natural = axis === 'x' ? facts.natural.width : facts.natural.height;
    const grown = this.size(node, axis) - natural;
    return {
      start: start + (axis === 'x' ? box.x : box.y) + grown / 2,
      size: axis === 'x' ? box.width : box.height,
    };
  }

  /** A child placed against its own container's box, which it does not grow. */
  framed(node: LayoutNode): boolean {
    const parent = node.parent;
    if (!parent || this.facts.get(parent)!.layout) return false;
    return node.placements.some((placement) =>
      placement.targets.some((target) => target.name === parent.name && target.part !== 'text'),
    );
  }

  /**
   * A child placed against its container's text, or against its heading,
   * which makes the title its frame's anchor.
   */
  private onTitle(node: LayoutNode): boolean {
    const parent = node.parent;
    if (!parent) return false;
    return node.placements.some((placement) =>
      placement.targets.some((target) => {
        if (target.name === parent.name && target.part === 'text') return true;
        if (parent.heading !== undefined && target.name === parent.heading.name) return true;
        const named = this.byName.get(target.name);
        return named !== undefined && named.parent === parent && joinedToText(named);
      }),
    );
  }

  /** The stretch a container's text and what is joined to it cover, measured from the text's start. */
  private unit(node: LayoutNode, axis: Axis): Extent {
    const key = `${node.name}\n${axis}`;
    const known = this.units.get(key);
    if (known) return known;
    const worked = this.guard(`unit\n${key}`, node, axis, undefined, () => {
      const hasText = this.facts.get(node)!.hasText;
      let low = hasText ? 0 : Infinity;
      let high = hasText ? this.textSize(node, axis) : -Infinity;
      for (const child of node.children) {
        if (!joinedToText(child)) continue;
        const start = this.unitStart(child, axis);
        const reach = this.reachOf(child, axis);
        low = Math.min(low, start - reach.low);
        high = Math.max(high, start + this.size(child, axis) + reach.high);
      }
      return low > high ? { start: 0, size: 0 } : { start: low, size: high - low };
    });
    this.units.set(key, worked);
    return worked;
  }

  /** Whether anything is joined to a container's text. */
  private hasUnit(node: LayoutNode): boolean {
    return node.children.some((child) => joinedToText(child));
  }

  /** How big a container's own text is on one axis, without what is joined to it. */
  private textSize(node: LayoutNode, axis: Axis): number {
    const facts = this.facts.get(node)!;
    return facts.hasText ? (axis === 'x' ? facts.textBox.width : facts.textBox.height) : 0;
  }

  /** Whether a container's title anchors its frame, because a child is placed against it. */
  private anchoredOnTitle(node: LayoutNode): boolean {
    return this.contentOf(node).some((child) => this.onTitle(child));
  }

  /**
   * The children a container's box is the outline of, besides its title: not
   * its heading, not what is joined to its text, and not those placed against
   * the box.
   */
  private contentOf(node: LayoutNode): LayoutNode[] {
    return node.children.filter((child) => child !== node.heading && !joinedToText(child) && !this.framed(child));
  }

  /** Whether a node has a title: its text, what is joined to it, or a heading. */
  private hasTitle(node: LayoutNode): boolean {
    return node.heading !== undefined || this.facts.get(node)!.hasText || this.hasUnit(node);
  }

  /** How big a container's title is on one axis: its heading, or its text with what is joined to it. */
  private titleSize(node: LayoutNode, axis: Axis): number {
    if (node.heading) return this.size(node.heading, axis);
    if (this.hasUnit(node)) return this.unit(node, axis).size;
    return this.textSize(node, axis);
  }

  /**
   * Where a container's title sits. A heading, or a text with something joined
   * to it, over nothing else is centered, as a leaf's text is, unless its
   * bracket says where.
   */
  private titleOf(node: LayoutNode): TitlePlace {
    const stated = node.textAttrs['place'] !== undefined;
    if ((node.heading || this.hasUnit(node)) && !stated && this.contentOf(node).length === 0) {
      return { how: 'center', side: 'center', along: 'center' };
    }
    return this.facts.get(node)!.title;
  }

  // --- sizes ---------------------------------------------------------------

  /**
   * A node's size: from two pinned edges, from its layout's stretching, or from
   * what it states or holds. Each axis's size is stated once, so a size key
   * beside pins or a stretching layout is refused.
   */
  private workOutSize(node: LayoutNode, axis: Axis): number {
    const pinned = this.pins(node, axis);
    if (pinned) {
      const keys = sizeKeysOn(node, axis);
      if (keys.length > 0) {
        const pins = this.statements(node, axis).map((statement) => `"${describePlacement(statement.placement)}"`);
        throw new SourceError(
          `"${node.name}" is pinned on both sides (${pins.join(' and ')}), which gives it its ${DIMENSION[axis]}, ` +
            `and also states ${keys.join(' ')} — keep one`,
          node.line,
        );
      }
      return pinned.size;
    }
    const parent = node.parent;
    if (parent && parent.heading !== node && !joinedToText(node) && this.stretches(parent, axis)) {
      const laid = this.inLayout(node, axis);
      if (laid.size !== undefined) return laid.size;
    }
    return this.ownSize(node, axis);
  }

  /** Whether a laid-out container sets its children's size on this axis. */
  private stretches(parent: LayoutNode, axis: Axis): boolean {
    const layout = this.facts.get(parent)!.layout;
    return layout !== undefined && axis === 'x' && layout.widths !== 'natural';
  }

  /** A node's size from what it states, or else what it holds, within its limits. */
  private ownSize(node: LayoutNode, axis: Axis): number {
    return this.remember(this.owns, node, axis, () => {
      const dimension = DIMENSION[axis];
      const stated = node.appearance[dimension];
      const value = stated === undefined ? this.naturalSize(node, axis) : this.measure(node, dimension, stated);
      const least = node.appearance[`min-${dimension}`];
      const most = node.appearance[`max-${dimension}`];
      const low = least === undefined ? 0 : this.measure(node, `min-${dimension}`, least);
      const high = most === undefined ? Infinity : this.measure(node, `max-${dimension}`, most);
      if (low > high) {
        throw new SourceError(
          `"${node.name}" has min-${dimension}: ${least} larger than its max-${dimension}: ${most}, which leaves no ${dimension} it may be`,
          node.line,
        );
      }
      return Math.min(Math.max(value, low), high);
    });
  }

  /** What a node's own contents make it, before anything stretches it. */
  private naturalSize(node: LayoutNode, axis: Axis): number {
    const facts = this.facts.get(node)!;
    if (node.children.length === 0) return axis === 'x' ? facts.natural.width : facts.natural.height;
    return this.outline(node, axis).natural;
  }

  /** Work out one size key's value, in pixels. */
  private measure(node: LayoutNode, key: string, written: string): number {
    const dimension = SIZE_KEYS[key]!;
    const axis: Axis = dimension === 'width' ? 'x' : 'y';
    const size = storedSize(written, key, `"${node.name}"`, node.line);
    return this.guard(`measure\n${node.name}\n${key}`, node, axis, undefined, () => this.evaluate(node, key, size), `${key}: ${written}`);
  }

  private evaluate(node: LayoutNode, key: string, size: SizeExpr): number {
    const dimension = SIZE_KEYS[key]!;
    const facts = this.facts.get(node)!;
    switch (size.kind) {
      case 'number':
        if (size.unit === 'px') return size.value;
        if (size.unit === 'unit') return size.value * UNIT;
        // Room for this much text: the lines or characters, and the padding round them.
        return size.value * (size.unit === 'lines' ? facts.lineHeight : facts.charWidth) + facts.padding * 2;
      case 'own':
        if (size.dimension === dimension) {
          throw new SourceError(`"${node.name}" ${key}: ${size.dimension} measures itself — measure it from something else`, node.line);
        }
        return this.size(node, size.dimension === 'width' ? 'x' : 'y');
      case 'measure': {
        const named = this.sized(node, key, size.name);
        const measured = size.dimension ?? dimension;
        return this.size(named, measured === 'width' ? 'x' : 'y');
      }
      case 'span':
        return this.span(node, key, size);
      case 'scale':
        return size.by * this.evaluate(node, key, size.of);
      case 'sum':
        return size.terms.reduce((total, term) => total + this.evaluate(node, key, term), 0);
      case 'pick': {
        const first = this.evaluate(node, key, size.first);
        const second = this.evaluate(node, key, size.second);
        return size.which === 'larger' ? Math.max(first, second) : Math.min(first, second);
      }
    }
  }

  /** The box a size names. */
  private sized(node: LayoutNode, key: string, name: string): LayoutNode {
    const named = this.byName.get(name);
    if (named) return named;
    const dot = name.lastIndexOf('.');
    const last = name.slice(dot + 1);
    if (dot !== -1 && (last === 'width' || last === 'height')) {
      throw new SourceError(
        `"${node.name}" ${key}: ${name} — a dot names a child, so write the measurement after a space: ${name.slice(0, dot)} ${last}`,
        node.line,
      );
    }
    throw new SourceError(`"${node.name}" ${key}: measures "${name}", which does not exist`, node.line);
  }

  /**
   * `a top to c bottom`: the distance between two edges. Both are found in the
   * frame of the innermost container holding them both, so a span between two
   * children never waits on their container's box.
   */
  private span(node: LayoutNode, key: string, size: Extract<SizeExpr, { kind: 'span' }>): number {
    const axisOf = (side: SpanSide): Axis | undefined =>
      side === 'top' || side === 'bottom' ? 'y' : side === 'left' || side === 'right' ? 'x' : undefined;
    const fromAxis = axisOf(size.from.side);
    const toAxis = axisOf(size.to.side);
    if (fromAxis && toAxis && fromAxis !== toAxis) {
      throw new SourceError(
        `"${node.name}" ${key}: ${size.from.name} ${size.from.side} to ${size.to.name} ${size.to.side} — a span runs between ` +
          'two edges on one axis, such as top to bottom or left to right',
        node.line,
      );
    }
    const axis = fromAxis ?? toAxis ?? (SIZE_KEYS[key] === 'width' ? 'x' : 'y');
    const from = this.sized(node, key, size.from.name);
    const to = this.sized(node, key, size.to.name);
    const common = commonFrame(from, to);
    const edge = (named: LayoutNode, side: SpanSide): number => {
      const start = this.within(named, common, axis);
      const length = named === common ? this.frame(named, axis).boxSize : this.size(named, axis);
      return start + (side === 'center' ? length / 2 : side === 'bottom' || side === 'right' ? length : 0);
    };
    const length = edge(to, size.to.side) - edge(from, size.from.side);
    if (length < 0) {
      throw new SourceError(
        `"${node.name}" ${key}: ${size.from.name} ${size.from.side} to ${size.to.name} ${size.to.side} runs backward — ` +
          `${size.to.name} ${size.to.side} comes before ${size.from.name} ${size.from.side}, so name them the other way round`,
        node.line,
      );
    }
    return length;
  }

  /** Where a node starts in the frame of `frame`, one of its containers, or on the page when that is undefined. */
  private within(node: LayoutNode, frame: LayoutNode | undefined, axis: Axis): number {
    if (node === frame) return this.frame(node, axis).boxStart;
    const parent = node.parent;
    if (parent === frame) return this.start(node, axis);
    return this.within(parent!, frame, axis) - this.frame(parent!, axis).boxStart + this.start(node, axis);
  }

  // --- containers ----------------------------------------------------------

  /**
   * A container on one axis: its box in its own frame, and where its title
   * sits. The box is the outline of what it holds, plus padding: the children
   * not placed against the box itself, and the title when it sits inside the
   * border or on it.
   */
  private workOutFrame(node: LayoutNode, axis: Axis): FrameAxis {
    const facts = this.facts.get(node)!;
    const title = this.titleOf(node);
    const hasTitle = this.hasTitle(node);
    const titleSize = this.titleSize(node, axis);
    const content = this.contentOf(node);
    const anchoredOnTitle = this.anchoredOnTitle(node);

    let low = Infinity;
    let high = -Infinity;
    for (const child of content) {
      const start = this.start(child, axis);
      const reach = this.reachOf(child, axis);
      low = Math.min(low, start - reach.low);
      high = Math.max(high, start + this.size(child, axis) + reach.high);
    }
    const empty = low > high;
    if (empty) {
      low = 0;
      high = 0;
    }
    // A laid-out container's content spans the whole band its children are
    // lined up in.
    if (!empty && facts.layout) {
      this.inLayout(content[0]!, axis);
      const band = this.bands.get(`${node.name}\n${axis}`);
      if (band !== undefined) {
        low = Math.min(low, 0);
        high = Math.max(high, band);
      }
    }

    // Where the title sits in the frame. When something is placed against it,
    // it is the frame's anchor and sits at the origin; otherwise it is placed
    // against the children by its side.
    const across = title.side === 'top' || title.side === 'bottom' ? 'x' : 'y';
    const gapToTitle = axis === 'x' ? HEADER_GAP : HEADER_GAP;
    // With something joined to the text, the title is the whole unit, and the
    // text sits inside it; a frame the title anchors has the text at its origin.
    const unit = this.hasUnit(node) ? this.unit(node, axis) : undefined;
    let titleStart: number;
    if (anchoredOnTitle || empty) {
      titleStart = unit ? unit.start : 0;
      if (empty && !anchoredOnTitle && hasTitle) {
        low = titleStart;
        high = titleStart + titleSize;
      }
    } else if (title.how === 'center' || title.side === 'center') {
      titleStart = (low + high) / 2 - titleSize / 2;
    } else if (axis === across && titleSize > high - low && title.how !== 'outside') {
      // A title longer than the children leaves the box room beside them, and
      // gather-children: says where in it they sit; the title spans it.
      const where = facts.gather[axis];
      titleStart = where === 'start' ? low : where === 'end' ? high - titleSize : (low + high) / 2 - titleSize / 2;
    } else if (axis === across) {
      titleStart =
        title.along === 'start' ? low : title.along === 'end' ? high - titleSize : (low + high) / 2 - titleSize / 2;
    } else if (title.how === 'on') {
      // The border runs through the title's middle, and the contents clear the
      // half of it that is inside.
      const clear = Math.max(facts.padding, titleSize / 2 + gapToTitle);
      titleStart =
        title.side === 'top' || title.side === 'left' ? low - clear - titleSize / 2 : high + clear - titleSize / 2;
    } else if (title.how === 'inside') {
      titleStart = title.side === 'top' || title.side === 'left' ? low - gapToTitle - titleSize : high + gapToTitle;
    } else {
      titleStart = 0;
    }
    // A title placed against the box's own children on this axis goes there,
    // and is content like a child: no row or column is kept for it.
    const placedTitle = hasTitle ? this.titlePlaced(node, axis) : undefined;
    if (placedTitle !== undefined) titleStart = placedTitle;

    const inBox = hasTitle && title.how !== 'outside';
    let boxLow = low;
    let boxHigh = high;
    if (inBox && !empty) {
      boxLow = Math.min(boxLow, titleStart);
      boxHigh = Math.max(boxHigh, titleStart + titleSize);
    }
    boxLow -= facts.padding;
    boxHigh += facts.padding;

    // On the border: the box's edge on that side runs through the title's middle.
    if (title.how === 'on' && hasTitle && axis !== across) {
      const middle = titleStart + titleSize / 2;
      if (title.side === 'top' || title.side === 'left') boxLow = middle;
      else boxHigh = middle;
    }

    // Outside the border: placed off the finished box, so it never sizes it.
    if (title.how === 'outside' && hasTitle && !anchoredOnTitle && placedTitle === undefined) {
      if (axis === across) {
        titleStart =
          title.along === 'start'
            ? boxLow
            : title.along === 'end'
              ? boxHigh - titleSize
              : (boxLow + boxHigh) / 2 - titleSize / 2;
      } else {
        titleStart = title.side === 'top' || title.side === 'left' ? boxLow - HEADER_GAP - titleSize : boxHigh + HEADER_GAP;
      }
    }

    // Grown evenly, so a centered title sits in the middle of its box, and a
    // centered title along a side sits in the middle of that side.
    if (
      inBox &&
      placedTitle === undefined &&
      (title.how === 'center' || title.side === 'center' || (axis === across && title.along === 'center'))
    ) {
      const middle = titleStart + titleSize / 2;
      const half = Math.max(middle - boxLow, boxHigh - middle);
      boxLow = middle - half;
      boxHigh = middle + half;
    }

    let natural = boxHigh - boxLow;
    if (facts.circle) {
      // The circle round the padded-in block, so whatever fits in the
      // rectangle fits in the circle, clear of it at the corners.
      const other = axis === 'x' ? 'y' : 'x';
      const otherInner = this.innerOther(node, other);
      const side = Math.hypot(natural - facts.padding * 2, otherInner) + facts.padding * 2;
      boxLow -= (side - natural) / 2;
      boxHigh = boxLow + side;
      natural = side;
    }
    if (node.deckTexts.length > 0) {
      const inset = node.deckTexts.length * DECK_STEP;
      boxLow -= inset;
      natural += inset;
    }
    return {
      boxStart: boxLow,
      boxSize: natural,
      natural,
      titleStart,
      titleSize,
      textStart: unit ? titleStart - unit.start : titleStart,
      textSize: unit ? this.textSize(node, axis) : titleSize,
    };
  }

  /**
   * A container's box at the size it ends up, when something states one: its
   * outline grown or shrunk so what it holds sits where gather-children: says,
   * the middle unless it says, and its title moved with the side it keeps to. A title something
   * is placed against is part of what it holds, and stays.
   */
  private fit(node: LayoutNode, axis: Axis): FrameAxis {
    const outline = this.outline(node, axis);
    const extra = this.size(node, axis) - outline.boxSize;
    if (extra === 0) return outline;
    const title = this.titleOf(node);
    const across: Axis = title.side === 'top' || title.side === 'bottom' ? 'x' : 'y';
    const anchored = this.anchoredOnTitle(node);
    // The children sit in the room where gather-children: says, the middle
    // unless it says; the box grows away from them.
    const share = { start: 0, center: 0.5, end: 1 };
    const grow = extra * share[this.facts.get(node)!.gather[axis]];
    let shift = 0;
    if (!anchored && title.how !== 'center' && title.side !== 'center' && !this.titleStates(node, axis)) {
      const toward = axis === across ? title.along : title.side === 'top' || title.side === 'left' ? 'start' : 'end';
      shift = extra * share[toward] - grow;
    }
    return {
      ...outline,
      boxStart: outline.boxStart - grow,
      boxSize: outline.boxSize + extra,
      titleStart: outline.titleStart + shift,
      textStart: outline.textStart + shift,
    };
  }

  /** The title's placements that state one axis. */
  private titleStatementsOn(node: LayoutNode, axis: Axis): Placement[] {
    return (node.titlePlacements ?? []).filter((placement) =>
      placement.kind === 'offset'
        ? component(placement.direction, axis) !== undefined
        : placement.kind === 'align'
          ? placement.axis === axis
          : true,
    );
  }

  /** Whether the title's bracket places it on this axis with a placement. */
  private titleStates(node: LayoutNode, axis: Axis): boolean {
    return this.titleStatementsOn(node, axis).length > 0;
  }

  /**
   * Where a title placed against the box's own children starts on one axis,
   * in the box's frame, or undefined when no placement states the axis and
   * its side words place it (design.org 7.2). Each axis is stated once.
   */
  private titlePlaced(node: LayoutNode, axis: Axis): number | undefined {
    const placements = this.titleStatementsOn(node, axis);
    if (placements.length === 0) return undefined;
    const subject = `"${node.name}"'s title`;
    const said = placements.map((placement) => `"${describePlacement(placement)}"`).join(' and ');
    const line = placements[0]!.line;
    if (placements.length > 1) {
      throw new SourceError(
        `${subject} says where it goes ${AXIS_SAID[axis]} more than once: ${said}. Each axis is stated once — keep one`,
        line,
      );
    }
    // The side words state the axis across their side, and align: the axis
    // along it; a placement may take whichever of the two they leave unsaid.
    const place = node.textAttrs['place'];
    const side = place?.split(' ')[1];
    const across: Axis = side === 'left' || side === 'right' ? 'x' : 'y';
    const words =
      place === 'center'
        ? ['x', 'y']
        : [...(place !== undefined ? [across] : []), ...(node.textAttrs['align'] !== undefined ? [across === 'x' ? 'y' : 'x'] : [])];
    if (words.includes(axis)) {
      const written = [place, node.textAttrs['align'] !== undefined ? `align: ${node.textAttrs['align']}` : undefined]
        .filter((one) => one !== undefined)
        .join(', ');
      throw new SourceError(
        `${subject} says where it goes ${AXIS_SAID[axis]} twice: "${written}" and ${said}. Each axis is stated once — keep one`,
        line,
      );
    }
    const [placement] = placements as [Placement];
    // A child placed against the title anchors the frame on the title, which
    // a title placed against a child would move: a loop.
    const onTitle = this.contentOf(node).find((child) => this.onTitle(child));
    if (onTitle) {
      const against = onTitle.placements.find((one) =>
        one.targets.some((target) => target.name === node.name && target.part === 'text'),
      ) ?? onTitle.placements[0]!;
      throw new SourceError(
        `these placements depend on each other in a circle: "${node.name}"'s title "${describePlacement(placement)}", ` +
          `"${onTitle.name} ${describePlacement(against)}" — one of them has to be placed against something else`,
        placement.line,
      );
    }
    return this.guard(`title\n${node.name}\n${axis}`, node, axis, placement, () => {
      let start = Infinity;
      let end = -Infinity;
      for (const target of placement.targets) {
        const child = node.children.find((one) => one.name === target.name);
        if (!child) {
          throw new SourceError(
            `${subject} is placed against "${target.name}", which is not one of "${node.name}"'s own children — ` +
              'a title is placed against the box it names, by its sides, or against its children',
            placement.line,
          );
        }
        const whole = { start: this.start(child, axis), size: this.size(child, axis) };
        const at =
          target.part === 'text'
            ? this.textOf(child, axis, whole.start)
            : narrow(whole, target.part, axis, this.facts.get(child)!.circle, this.size(child, 'x'));
        start = Math.min(start, at.start);
        end = Math.max(end, at.start + at.size);
      }
      const size = this.titleSize(node, axis);
      if (placement.kind === 'offset') {
        const gap =
          placement.gap !== undefined ? gapPixels(placement.gap, subject, placement.line) : GAPS['normal']!;
        return component(placement.direction, axis) === 'after' ? end + gap : start - gap - size;
      }
      const along = placement.kind === 'align' ? sideAlong(placement.side) : 'center';
      if (along === 'start') return start;
      if (along === 'end') return end - size;
      return (start + end) / 2 - size / 2;
    });
  }

  /** The padded-in block of a circle on the other axis, which its diameter depends on as well. */
  private innerOther(node: LayoutNode, axis: Axis): number {
    const key = `inner\n${node.name}\n${axis}`;
    return this.guard(key, node, axis, undefined, () => {
      const content = this.contentOf(node);
      let low = Infinity;
      let high = -Infinity;
      for (const child of content) {
        low = Math.min(low, this.start(child, axis));
        high = Math.max(high, this.start(child, axis) + this.size(child, axis));
      }
      const titleSize = this.titleSize(node, axis);
      const title = this.titleOf(node);
      const along = title.side === 'top' || title.side === 'bottom' ? 'x' : 'y';
      if (low > high) return titleSize;
      return axis === along ? Math.max(high - low, titleSize) : high - low + (titleSize > 0 ? titleSize + HEADER_GAP : 0);
    });
  }

  /**
   * A child of a laid-out container: placed by the layout, in written order,
   * and never by itself.
   */
  private inLayout(node: LayoutNode, axis: Axis): { start: number; size?: number } {
    const parent = node.parent!;
    const key = `${node.name}\n${axis}`;
    const known = this.laid.get(key);
    if (known) return known;
    const layout = this.facts.get(parent)!.layout!;
    const main: Axis = layout.kind === 'column' ? 'y' : 'x';
    const children = parent.children.filter((child) => child !== parent.heading && !joinedToText(child));
    const natural = (child: LayoutNode, on: Axis) => this.ownSize(child, on);
    if (axis !== main && this.stretches(parent, axis)) {
      for (const child of children) {
        const keys = sizeKeysOn(child, axis);
        if (keys.length > 0) {
          throw new SourceError(
            `"${child.name}" states ${keys.join(' ')}, but "${parent.name}" has layout: ${layout.kind} ` +
              `(widths: ${layout.widths}), which sets every child's width — drop one`,
            child.line,
          );
        }
      }
    }
    if (axis === main) {
      let cursor = 0;
      children.forEach((child, index) => {
        const size = natural(child, axis);
        if (layout.centers !== undefined) {
          this.laid.set(`${child.name}\n${axis}`, { start: index * layout.centers - size / 2 });
        } else {
          this.laid.set(`${child.name}\n${axis}`, { start: cursor });
          cursor += size + layout.gap!;
        }
      });
    } else {
      // The band is the room the children are lined up in: as wide as the
      // widest of them. With widths: fill it is the title along the top or
      // bottom if that is wider, so they stretch under it; otherwise a wider
      // title leaves spare room, which gather-children: says where they sit in.
      let widest = Math.max(...children.map((child) => natural(child, axis)));
      const title = this.titleOf(parent);
      const titleAlong = title.side === 'top' || title.side === 'bottom';
      const band =
        layout.widths === 'fill' &&
        axis === 'x' && titleAlong && this.hasTitle(parent) && title.how !== 'outside' && title.how !== 'center'
          ? Math.max(widest, this.titleSize(parent, 'x'))
          : widest;
      if (layout.widths === 'fill') widest = band;
      this.bands.set(`${parent.name}\n${axis}`, band);
      const stretch = axis === 'x' && layout.widths !== 'natural';
      for (const child of children) {
        const size = stretch ? widest : natural(child, axis);
        const start = layout.align === 'start' ? 0 : layout.align === 'end' ? band - size : (band - size) / 2;
        this.laid.set(`${child.name}\n${axis}`, stretch ? { start, size } : { start });
      }
    }
    return this.laid.get(key)!;
  }

  // --- anchors -------------------------------------------------------------

  /**
   * Exactly one box in each frame says nothing about where it goes, and every
   * other is placed against it, directly or through others. In a container a
   * title something is placed against anchors the frame instead.
   */
  private checkAnchors(all: LayoutNode[], parent: LayoutNode | undefined): void {
    // A heading goes where the title would, and anchors nothing; the tree
    // pass refused any placement on it. What is joined to the text goes with
    // the title, placed against the text.
    const members = all.filter((member) => member !== parent?.heading && !(parent && joinedToText(member)));
    if (parent && this.facts.get(parent)!.layout) {
      for (const child of members) {
        const [placement] = child.placements;
        if (placement) {
          throw new SourceError(
            `"${child.name}" places itself ("${describePlacement(placement)}"), but "${parent.name}" has a layout:, ` +
              'which places every child — drop the placement, or the layout: to place each child by hand',
            placement.line,
          );
        }
      }
    } else if (members.length > 0) {
      const content = members.filter((member) => !this.framed(member));
      const unplaced = content.filter((member) => member.placements.length === 0);
      const onTitle = content.find((member) => this.onTitle(member));
      if (!parent && unplaced.length === 0) {
        throw new SourceError('every node is placed relative to another, so nothing anchors the diagram', 1);
      }
      if (unplaced.length > 1) {
        const names = unplaced.map((node) => `"${node.name}"`).join(', ');
        throw new SourceError(
          parent
            ? `"${parent.name}" has ${unplaced.length} children that say nothing about where they go (${names}). ` +
                'One is the anchor and the rest are placed against it — or give the container a layout: such as ' +
                'layout: column to place them in order'
            : `exactly one node may say nothing about where it goes, but ${unplaced.length} do: ${names}`,
          unplaced[1]!.line,
        );
      }
      if (parent && unplaced.length === 1 && onTitle) {
        throw new SourceError(
          `"${parent.name}" has two anchors: "${unplaced[0]!.name}" says nothing about where it goes, and ` +
            `"${onTitle.name}" is placed against "${parent.name} text" — place "${unplaced[0]!.name}" against one of them`,
          unplaced[0]!.line,
        );
      }
    }
    for (const member of all) this.checkAnchors(member.children, member);
  }

  // --- finishing -----------------------------------------------------------

  /** The text box, how far the node reaches past its own box, and the flags the renderer reads. */
  private finish(node: LayoutNode): void {
    const facts = this.facts.get(node)!;
    if (node.children.length === 0) {
      node.textBox = this.leafText(node);
      const x = this.reachOf(node, 'x');
      const y = this.reachOf(node, 'y');
      node.reach = { left: x.low, top: y.low, right: x.high, bottom: y.high };
      return;
    }
    const x = this.frame(node, 'x');
    const y = this.frame(node, 'y');
    node.textBox = facts.hasText
      ? { x: x.textStart - x.boxStart, y: y.textStart - y.boxStart, width: x.textSize, height: y.textSize }
      : { x: 0, y: 0, width: 0, height: 0 };
    node.banded = true;
    node.inset = node.deckTexts.length * DECK_STEP;
    const x2 = this.reachOf(node, 'x');
    const y2 = this.reachOf(node, 'y');
    node.reach = { left: x2.low, top: y2.low, right: x2.high, bottom: y2.high };
  }

  /**
   * Where a leaf's text sits, from the leaf's top-left. Centered unless its
   * bracket says a side, and then where a container's title would be: inside,
   * on or outside that side, at the start, middle or end along it. A picture
   * and a circle keep their text where their shape puts it.
   */
  private leafText(node: LayoutNode): { x: number; y: number; width: number; height: number } {
    const facts = this.facts.get(node)!;
    const box = facts.textBox;
    const width = this.size(node, 'x');
    const height = this.size(node, 'y');
    const title = facts.title;
    const centered = {
      x: box.x + (width - facts.natural.width) / 2,
      y: box.y + (height - facts.natural.height) / 2,
      width: box.width,
      height: box.height,
    };
    if (node.textAttrs['place'] === undefined || title.how === 'center' || facts.circle || node.body.kind === 'icon') {
      return centered;
    }
    const sideAxis: Axis = title.side === 'top' || title.side === 'bottom' ? 'y' : 'x';
    const low = title.side === 'top' || title.side === 'left';
    const at = (axis: Axis): number => {
      const room = axis === 'x' ? width : height;
      const text = axis === 'x' ? box.width : box.height;
      if (axis !== sideAxis) {
        // Outside, an end of the text is even with the box's edge; otherwise it clears the padding.
        const inset = title.how === 'outside' ? 0 : facts.padding;
        return title.along === 'start' ? inset : title.along === 'end' ? room - inset - text : (room - text) / 2;
      }
      if (title.how === 'inside') return low ? facts.padding : room - facts.padding - text;
      if (title.how === 'on') return low ? -text / 2 : room - text / 2;
      return low ? -HEADER_GAP - text : room + HEADER_GAP;
    };
    return { x: at('x'), y: at('y'), width: box.width, height: box.height };
  }

  /**
   * How far a node reaches past its own box on one axis: its title outside the
   * border, and its children, with whatever they reach in turn. A container's
   * outline holds what its children reach, so it is worked out as soon as a
   * container asks, not after everything is placed.
   */
  private reachOf(node: LayoutNode, axis: Axis): { low: number; high: number } {
    if (node.children.length === 0) {
      // Only a text placed on or outside the border reaches past it; one that
      // spills from a box too small for it is drawn spilling and reported.
      const how = this.facts.get(node)!.title.how;
      if (node.textAttrs['place'] === undefined || how === 'inside' || how === 'center') return { low: 0, high: 0 };
      const text = this.leafText(node);
      const start = axis === 'x' ? text.x : text.y;
      const size = axis === 'x' ? text.width : text.height;
      return { low: Math.max(0, -start), high: Math.max(0, start + size - this.size(node, axis)) };
    }
    const frame = this.frame(node, axis);
    const end = frame.boxStart + frame.boxSize;
    let low = 0;
    let high = 0;
    if (this.facts.get(node)!.hasText) {
      low = Math.max(low, frame.boxStart - frame.titleStart);
      high = Math.max(high, frame.titleStart + frame.titleSize - end);
    }
    for (const child of node.children) {
      const start = this.start(child, axis);
      const reach = this.reachOf(child, axis);
      low = Math.max(low, frame.boxStart - (start - reach.low));
      high = Math.max(high, start + this.size(child, axis) + reach.high - end);
    }
    return { low, high };
  }
}

interface FrameAxis {
  /** Where the box starts, in the container's own frame. */
  boxStart: number;
  boxSize: number;
  /** The box's size from its contents, which is its size unless something states another. */
  natural: number;
  /** The title: the text, a heading, or the text with what is joined to it. */
  titleStart: number;
  titleSize: number;
  /** The text alone, which is the title unless something is joined to it. */
  textStart: number;
  textSize: number;
}

function sideAlong(side: Side): 'start' | 'center' | 'end' {
  if (side === 'top' || side === 'left') return 'start';
  if (side === 'bottom' || side === 'right') return 'end';
  return 'center';
}

/** The width or height a size key on an axis states. */
const DIMENSION: Record<Axis, Dimension> = { x: 'width', y: 'height' };

/** The size keys a node states on one axis, as written, for quoting back. */
function sizeKeysOn(node: LayoutNode, axis: Axis): string[] {
  const dimension = DIMENSION[axis];
  return [dimension, `min-${dimension}`, `max-${dimension}`]
    .filter((key) => node.appearance[key] !== undefined)
    .map((key) => `${key}: ${node.appearance[key]}`);
}

/**
 * The container whose frame holds both ends of a span: one of them when it
 * holds the other, else the innermost container of both, or the page.
 */
function commonFrame(a: LayoutNode, b: LayoutNode): LayoutNode | undefined {
  if (a === b) return a.parent;
  if (isWithin(b, a)) return a;
  if (isWithin(a, b)) return b;
  for (let at = a.parent; at; at = at.parent) if (isWithin(b, at)) return at;
  return undefined;
}

function isWithin(node: LayoutNode, ancestor: LayoutNode): boolean {
  for (let at = node.parent; at; at = at.parent) if (at === ancestor) return true;
  return false;
}

/**
 * Narrow an extent to the part a placement named. A side leaves the axis it
 * doesn't name alone (`right` is the whole right edge); a point is a point on
 * both. On a circle a corner is the point on it halfway between its sides.
 */
function narrow(whole: Extent, part: Part | undefined, axis: Axis, circle: boolean, diameter: number): Extent {
  if (part === undefined || part === 'text') return whole;
  const words = part.split('-');
  const isSide = (PART_SIDES as readonly string[]).includes(part);
  const [near, far] = axis === 'x' ? ['left', 'right'] : ['top', 'bottom'];
  const named = words.includes(near!) ? 0 : words.includes(far!) ? whole.size : undefined;
  if (named === undefined && isSide) return whole;
  let at = whole.start + (named ?? whole.size / 2);
  const across = words.includes('left') || words.includes('right');
  const down = words.includes('top') || words.includes('bottom');
  if (circle && across && down) {
    const pull = (diameter / 2) * (1 - Math.SQRT1_2);
    at += named === 0 ? pull : -pull;
  }
  return { start: at, size: 0 };
}
