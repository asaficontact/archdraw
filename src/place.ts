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
import type { Axis, Direction, OffsetPlacement, Part, Placement, PlacementTarget, Side } from './ast.js';
import { describePlacement, nameTarget, PART_SIDES } from './ast.js';
import { DECK_STEP, GAPS, HEADER_GAP, UNIT } from './constants.js';
import { SourceError } from './errors.js';
import type { LayoutNode } from './model.js';
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

  constructor(
    private readonly roots: LayoutNode[],
    private readonly byName: Map<string, LayoutNode>,
    private readonly facts: Map<LayoutNode, NodeFacts>,
  ) {}

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
    const kind = memo === this.starts ? 'start' : memo === this.owns ? 'own' : 'size';
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
    if (parent && this.facts.get(parent)!.layout) return this.inLayout(node, axis).start;
    if (node.placements.length === 0) {
      // The anchor of its frame. A container's title, when something is
      // placed against it, is the anchor instead; `checkAnchors` has made sure
      // there is exactly one.
      return 0;
    }
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
        return statement.kind === 'after' ? statement.edge() : statement.edge() - this.size(node, axis);
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
      return at.start + at.size / 2 - this.size(node, axis) / 2;
    });
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
            const gap = this.gapOf(node, placement);
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
  private gapOf(node: LayoutNode, placement: OffsetPlacement): number {
    if (placement.gap !== undefined) return gapPixels(placement.gap, `"${node.name}"`, placement.line);
    const parent = node.parent;
    const own = parent !== undefined && placement.targets.some((target) => target.name === parent.name);
    if (own && placement.targets.some((target) => target.part === 'text')) {
      // One unit, so `badge:` draws as its long form `1 right of hub text`
      // does. An empty text takes no room, and that includes the gap beside it.
      return this.facts.get(parent)!.hasText ? UNIT : 0;
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

  /** One target's extent on one axis, in the frame `node` is placed in. */
  private extentOf(node: LayoutNode, target: PlacementTarget, axis: Axis, placement: Placement): Extent {
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
    } else if (named === parent && target.part === 'text' && parent.children.some((child) => !this.framed(child) && this.onTitle(child))) {
      // The title anchors the frame, so it is at the origin, known without the box.
      const facts = this.facts.get(parent)!;
      whole = { start: 0, size: 0 };
      text = { start: 0, size: facts.hasText ? (axis === 'x' ? facts.textBox.width : facts.textBox.height) : 0 };
    } else if (named === parent) {
      const frame = this.frame(parent, axis);
      whole = { start: frame.boxStart, size: frame.boxSize };
      if (target.part === 'text') text = { start: frame.titleStart, size: frame.titleSize };
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
      if (!text || (!this.facts.get(named)!.hasText && named !== parent)) {
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
      return { start: start + frame.titleStart - frame.boxStart, size: frame.titleSize };
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

  /** A child placed against its container's text, which makes the text its frame's anchor. */
  private onTitle(node: LayoutNode): boolean {
    const parent = node.parent;
    if (!parent) return false;
    return node.placements.some((placement) =>
      placement.targets.some((target) => target.name === parent.name && target.part === 'text'),
    );
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
    if (parent && this.stretches(parent, axis)) {
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
    const title = facts.title;
    const titleSize = facts.hasText ? (axis === 'x' ? facts.textBox.width : facts.textBox.height) : 0;
    const content = node.children.filter((child) => !this.framed(child));
    const anchoredOnTitle = content.some((child) => this.onTitle(child));

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
    // aligned in, so a title wider than they are is centered over the band and
    // `align:` decides where in it they sit.
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
    let titleStart: number;
    if (anchoredOnTitle || empty) {
      titleStart = 0;
      if (empty && !anchoredOnTitle && facts.hasText) {
        low = 0;
        high = titleSize;
      }
    } else if (title.how === 'center' || title.side === 'center') {
      titleStart = (low + high) / 2 - titleSize / 2;
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

    const inBox = facts.hasText && title.how !== 'outside';
    let boxLow = low;
    let boxHigh = high;
    if (inBox && !empty) {
      boxLow = Math.min(boxLow, titleStart);
      boxHigh = Math.max(boxHigh, titleStart + titleSize);
    }
    boxLow -= facts.padding;
    boxHigh += facts.padding;

    // On the border: the box's edge on that side runs through the title's middle.
    if (title.how === 'on' && facts.hasText && axis !== across) {
      const middle = titleStart + titleSize / 2;
      if (title.side === 'top' || title.side === 'left') boxLow = middle;
      else boxHigh = middle;
    }

    // Outside the border: placed off the finished box, so it never sizes it.
    if (title.how === 'outside' && facts.hasText && !anchoredOnTitle) {
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
    if (inBox && (title.how === 'center' || title.side === 'center' || (axis === across && title.along === 'center'))) {
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
    return { boxStart: boxLow, boxSize: natural, natural, titleStart, titleSize };
  }

  /**
   * A container's box at the size it ends up, when something states one: its
   * outline grown or shrunk evenly about its middle, so what it holds stays
   * centered, and its title moved with the side it keeps to. A title something
   * is placed against is part of what it holds, and stays.
   */
  private fit(node: LayoutNode, axis: Axis): FrameAxis {
    const outline = this.outline(node, axis);
    const extra = this.size(node, axis) - outline.boxSize;
    if (extra === 0) return outline;
    const title = this.facts.get(node)!.title;
    const across: Axis = title.side === 'top' || title.side === 'bottom' ? 'x' : 'y';
    const anchored = node.children.some((child) => !this.framed(child) && this.onTitle(child));
    let shift = 0;
    if (!anchored && title.how !== 'center' && title.side !== 'center') {
      const toward = axis === across ? title.along : title.side === 'top' || title.side === 'left' ? 'start' : 'end';
      shift = toward === 'start' ? -extra / 2 : toward === 'end' ? extra / 2 : 0;
    }
    return {
      ...outline,
      boxStart: outline.boxStart - extra / 2,
      boxSize: outline.boxSize + extra,
      titleStart: outline.titleStart + shift,
    };
  }

  /** The padded-in block of a circle on the other axis, which its diameter depends on as well. */
  private innerOther(node: LayoutNode, axis: Axis): number {
    const facts = this.facts.get(node)!;
    const key = `inner\n${node.name}\n${axis}`;
    return this.guard(key, node, axis, undefined, () => {
      const content = node.children.filter((child) => !this.framed(child));
      let low = Infinity;
      let high = -Infinity;
      for (const child of content) {
        low = Math.min(low, this.start(child, axis));
        high = Math.max(high, this.start(child, axis) + this.size(child, axis));
      }
      const titleSize = facts.hasText ? (axis === 'x' ? facts.textBox.width : facts.textBox.height) : 0;
      const along = facts.title.side === 'top' || facts.title.side === 'bottom' ? 'x' : 'y';
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
    const children = parent.children;
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
      // The band is the room the children are aligned in: as wide as the
      // widest of them, or the title along the top or bottom if that is wider.
      let widest = Math.max(...children.map((child) => natural(child, axis)));
      const facts = this.facts.get(parent)!;
      const titleAlong = facts.title.side === 'top' || facts.title.side === 'bottom';
      const band =
        axis === 'x' && titleAlong && facts.hasText && facts.title.how !== 'outside' && facts.title.how !== 'center'
          ? Math.max(widest, facts.textBox.width)
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
  private checkAnchors(members: LayoutNode[], parent: LayoutNode | undefined): void {
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
    for (const member of members) this.checkAnchors(member.children, member);
  }

  // --- finishing -----------------------------------------------------------

  /** The text box, how far the node reaches past its own box, and the flags the renderer reads. */
  private finish(node: LayoutNode): void {
    const facts = this.facts.get(node)!;
    if (node.children.length === 0) {
      const box = facts.textBox;
      node.textBox = {
        x: box.x + (node.width - facts.natural.width) / 2,
        y: box.y + (node.height - facts.natural.height) / 2,
        width: box.width,
        height: box.height,
      };
      return;
    }
    const x = this.frame(node, 'x');
    const y = this.frame(node, 'y');
    node.textBox = facts.hasText
      ? { x: x.titleStart - x.boxStart, y: y.titleStart - y.boxStart, width: x.titleSize, height: y.titleSize }
      : { x: 0, y: 0, width: 0, height: 0 };
    node.banded = true;
    node.inset = node.deckTexts.length * DECK_STEP;
    const x2 = this.reachOf(node, 'x');
    const y2 = this.reachOf(node, 'y');
    node.reach = { left: x2.low, top: y2.low, right: x2.high, bottom: y2.high };
  }

  /**
   * How far a node reaches past its own box on one axis: its title outside the
   * border, and its children, with whatever they reach in turn. A container's
   * outline holds what its children reach, so it is worked out as soon as a
   * container asks, not after everything is placed.
   */
  private reachOf(node: LayoutNode, axis: Axis): { low: number; high: number } {
    if (node.children.length === 0) return { low: 0, high: 0 };
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
  titleStart: number;
  titleSize: number;
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
