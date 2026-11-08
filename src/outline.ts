/**
 * The geometry of every outline `shape:` names: where its edge runs, where its
 * middle is, and how big it grows to hold its text.
 *
 * One place knows each shape, and the resolver, the line planner, the checks
 * and the renderer all ask it, so they cannot disagree about where a diamond's
 * edge is.
 *
 * A shape stretches to fill its box. What the box doesn't decide is at most one
 * amount and one direction (a parallelogram's slant and which way it leans),
 * and those are the settings in the shape's bracket. Amounts are fixed
 * distances, not fractions of the box, as the document's fold always was.
 *
 * The rectangle-like outlines (`rectangle`, `document`, `flow-subprocess`) and
 * a round `circle` keep the exact geometry they always had; every other
 * outline is worked with as a polygon, its curves sampled finely enough that a
 * line meeting one lands on the drawn curve to within a fraction of a pixel.
 */

import { UNIT } from './constants.js';
import { SourceError } from './errors.js';

/** A point, relative to whatever the caller says. */
export interface Point {
  x: number;
  y: number;
}

/** How each setting in a shape's bracket is read. */
type SettingKind = 'distance' | 'flag' | readonly string[];

/**
 * The settings each shape takes in its bracket, by name. A shape not listed
 * takes none. The first word of a direction is the default.
 */
export const SHAPE_SETTINGS: Readonly<Record<string, Readonly<Record<string, SettingKind>>>> = {
  document: { fold: 'distance' },
  parallelogram: { slant: 'distance', lean: ['right', 'left'] },
  hexagon: { point: 'distance' },
  trapezoid: { taper: 'distance', narrow: ['bottom', 'top'] },
  triangle: { aim: ['down', 'up', 'left', 'right'] },
  cylinder: { cap: 'distance', lying: 'flag' },
};

/** The settings a shape was given, read: distances in pixels, directions as words, flags as true. */
export interface ShapeLook {
  fold?: number;
  slant?: number;
  lean?: string;
  point?: number;
  taper?: number;
  narrow?: string;
  aim?: string;
  cap?: number;
  lying?: boolean;
}

/** Each amount's default in pixels, the settings' and those the flow- shapes fix. A document's fold is the renderer's `FOLD`. */
const SHAPE_DEFAULTS = {
  slant: 18,
  point: 18,
  taper: 18,
  cap: 9,
  inset: 10,
  wave: 7,
  cut: 14,
  slope: 16,
  curve: 12,
  offPage: 18,
  tail: 16,
};

/**
 * Read a shape's bracket, refusing a setting the shape doesn't take and a
 * value that isn't one. `written` holds the dotted keys as stored, `shape.slant`.
 */
export function readShapeLook(outline: string, written: Record<string, string>, subject: string, line: number): ShapeLook {
  const takes = SHAPE_SETTINGS[outline] ?? {};
  const look: ShapeLook = {};
  for (const [key, value] of Object.entries(written)) {
    const kind = takes[key];
    if (kind === undefined) {
      const names = Object.keys(takes);
      throw new SourceError(
        `${subject}: a ${outline} has no "${key}" setting — ` +
          (names.length === 0 ? `\`shape: ${outline}\` takes no settings` : `it takes ${names.join(', ')}`),
        line,
      );
    }
    if (kind === 'flag') {
      if (value !== 'true') throw new SourceError(`${subject}: "${key}" is a word on its own, written without a value: \`shape: ${outline} (${key})\``, line);
      (look as Record<string, unknown>)[key] = true;
      continue;
    }
    if (kind === 'distance') {
      (look as Record<string, unknown>)[key] = readDistance(value, `${subject} ${key}:`, line);
      continue;
    }
    if (!kind.includes(value)) {
      throw new SourceError(`${subject}: "${key}: ${value}" is not a way a ${outline} can go — use ${kind.join(', ')}`, line);
    }
    (look as Record<string, unknown>)[key] = value;
  }
  return look;
}

function readDistance(written: string, subject: string, line: number): number {
  if (/^\d*\.?\d+$/.test(written)) return Number(written) * UNIT;
  const pixels = /^(\d*\.?\d+)px$/.exec(written);
  if (pixels) return Number(pixels[1]);
  throw new SourceError(`${subject} "${written}" is not a distance — write a number in the file's unit, or pixels such as 12px`, line);
}

/** How far inside each side a subprocess's bars stand. */
export const SUBPROCESS_INSET = SHAPE_DEFAULTS.inset;

/** The outlines handled as a plain rectangle by everything but the renderer. */
const BOXY = new Set(['rectangle', 'document', 'flow-subprocess']);

/** Whether an outline is a rectangle as far as placement and lines go. */
export function isBoxy(outline: string): boolean {
  return BOXY.has(outline);
}

/** Whether an outline is drawn round in a square box, so the exact circle code applies. */
export function isRound(outline: string, width: number, height: number): boolean {
  return outline === 'circle' && Math.abs(width - height) < 0.5;
}

// --- curves, sampled ------------------------------------------------------------

const CURVE_STEPS = 24;

/** Points along an elliptical arc about (cx, cy), from angle a0 to a1, both ends included. */
function arcPoints(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= CURVE_STEPS; i++) {
    const a = a0 + ((a1 - a0) * i) / CURVE_STEPS;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

/** Points along a quadratic curve, the start left out. */
function quadPoints(p0: Point, c: Point, p1: Point): Point[] {
  const out: Point[] = [];
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y });
  }
  return out;
}

/** A wave across a box from (x0, y) to (x1, y), up then down, as the standard's document draws its bottom. */
function wavePoints(x0: number, x1: number, y: number, depth: number): Point[] {
  const mid = (x0 + x1) / 2;
  const q = (x1 - x0) / 4;
  return [...quadPoints({ x: x0, y }, { x: x0 + q, y: y - 2 * depth }, { x: mid, y }), ...quadPoints({ x: mid, y }, { x: mid + q, y: y + 2 * depth }, { x: x1, y })];
}

// --- each shape ------------------------------------------------------------------

/** One outline at one size: the polygon it is worked with, and the SVG it is drawn as. Points are relative to the box's top-left. */
export interface Shape {
  /** The outline as a closed polygon, for meeting lines and testing what is inside. */
  polygon: Point[];
  /** The path data, relative, drawn translated to the box. */
  path: string;
  /** Lines drawn inside the outline: a cylinder's near rim, a subprocess's bars. */
  detail: string[];
}

function polyShape(points: Point[]): Shape {
  return { polygon: points, path: polygonPath(points), detail: [] };
}

function polygonPath(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r2(p.x)} ${r2(p.y)}`).join(' ') + ' Z';
}

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * An outline at a size. Rectangle-like outlines and the round circle are
 * included so a caller can always ask, but the renderer draws those itself.
 */
export function shapeOf(outline: string, look: ShapeLook, w: number, h: number): Shape {
  switch (outline) {
    case 'circle': {
      const points = arcPoints(w / 2, h / 2, w / 2, h / 2, Math.PI, 3 * Math.PI).slice(0, -1);
      return { polygon: points, path: `M0 ${r2(h / 2)} A${r2(w / 2)} ${r2(h / 2)} 0 1 0 ${r2(w)} ${r2(h / 2)} A${r2(w / 2)} ${r2(h / 2)} 0 1 0 0 ${r2(h / 2)} Z`, detail: [] };
    }
    case 'diamond':
      return polyShape([{ x: w / 2, y: 0 }, { x: w, y: h / 2 }, { x: w / 2, y: h }, { x: 0, y: h / 2 }]);
    case 'pill': {
      const rad = Math.min(w, h) / 2;
      if (w >= h) {
        const points = [...arcPoints(w - rad, rad, rad, rad, -Math.PI / 2, Math.PI / 2), ...arcPoints(rad, rad, rad, rad, Math.PI / 2, (3 * Math.PI) / 2)];
        return { polygon: points, path: `M${r2(rad)} 0 H${r2(w - rad)} A${r2(rad)} ${r2(rad)} 0 0 1 ${r2(w - rad)} ${r2(h)} H${r2(rad)} A${r2(rad)} ${r2(rad)} 0 0 1 ${r2(rad)} 0 Z`, detail: [] };
      }
      const points = [...arcPoints(rad, h - rad, rad, rad, 0, Math.PI), ...arcPoints(rad, rad, rad, rad, Math.PI, 2 * Math.PI)];
      return { polygon: points, path: `M0 ${r2(rad)} A${r2(rad)} ${r2(rad)} 0 0 1 ${r2(w)} ${r2(rad)} V${r2(h - rad)} A${r2(rad)} ${r2(rad)} 0 0 1 0 ${r2(h - rad)} Z`, detail: [] };
    }
    case 'parallelogram': {
      const s = Math.min(look.slant ?? SHAPE_DEFAULTS.slant, w / 2);
      return look.lean === 'left'
        ? polyShape([{ x: 0, y: 0 }, { x: w - s, y: 0 }, { x: w, y: h }, { x: s, y: h }])
        : polyShape([{ x: s, y: 0 }, { x: w, y: 0 }, { x: w - s, y: h }, { x: 0, y: h }]);
    }
    case 'hexagon': {
      const p = Math.min(look.point ?? SHAPE_DEFAULTS.point, w / 2);
      return polyShape([{ x: p, y: 0 }, { x: w - p, y: 0 }, { x: w, y: h / 2 }, { x: w - p, y: h }, { x: p, y: h }, { x: 0, y: h / 2 }]);
    }
    case 'trapezoid': {
      const t = Math.min(look.taper ?? SHAPE_DEFAULTS.taper, w / 2);
      return look.narrow === 'top'
        ? polyShape([{ x: t, y: 0 }, { x: w - t, y: 0 }, { x: w, y: h }, { x: 0, y: h }])
        : polyShape([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w - t, y: h }, { x: t, y: h }]);
    }
    case 'triangle':
      switch (look.aim ?? 'down') {
        case 'up':
          return polyShape([{ x: w / 2, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
        case 'left':
          return polyShape([{ x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h / 2 }]);
        case 'right':
          return polyShape([{ x: 0, y: 0 }, { x: w, y: h / 2 }, { x: 0, y: h }]);
        default:
          return polyShape([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w / 2, y: h }]);
      }
    case 'cylinder': {
      if (look.lying) {
        const c = Math.min(look.cap ?? SHAPE_DEFAULTS.cap, w / 4);
        const points = [...arcPoints(w - c, h / 2, c, h / 2, -Math.PI / 2, Math.PI / 2), ...arcPoints(c, h / 2, c, h / 2, Math.PI / 2, (3 * Math.PI) / 2)];
        return {
          polygon: points,
          path: `M${r2(c)} 0 H${r2(w - c)} A${r2(c)} ${r2(h / 2)} 0 0 1 ${r2(w - c)} ${r2(h)} H${r2(c)} A${r2(c)} ${r2(h / 2)} 0 0 1 ${r2(c)} 0 Z`,
          detail: [`M${r2(w - c)} 0 A${r2(c)} ${r2(h / 2)} 0 0 0 ${r2(w - c)} ${r2(h)}`],
        };
      }
      const c = Math.min(look.cap ?? SHAPE_DEFAULTS.cap, h / 4);
      const points = [...arcPoints(w / 2, c, w / 2, c, Math.PI, 2 * Math.PI), ...arcPoints(w / 2, h - c, w / 2, c, 0, Math.PI)];
      return {
        polygon: points,
        path: `M0 ${r2(c)} A${r2(w / 2)} ${r2(c)} 0 0 1 ${r2(w)} ${r2(c)} V${r2(h - c)} A${r2(w / 2)} ${r2(c)} 0 0 1 0 ${r2(h - c)} Z`,
        detail: [`M0 ${r2(c)} A${r2(w / 2)} ${r2(c)} 0 0 0 ${r2(w)} ${r2(c)}`],
      };
    }
    case 'flow-document': {
      const a = SHAPE_DEFAULTS.wave;
      const points = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h - a }, ...wavePoints(w, 0, h - a, -a)];
      return polyShape(points);
    }
    case 'flow-off-page': {
      const p = Math.min(SHAPE_DEFAULTS.offPage, h / 2);
      return polyShape([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h - p }, { x: w / 2, y: h }, { x: 0, y: h - p }]);
    }
    case 'flow-delay': {
      const rad = Math.min(h / 2, w);
      const points = [{ x: 0, y: 0 }, ...arcPoints(w - rad, h / 2, rad, h / 2, -Math.PI / 2, Math.PI / 2), { x: 0, y: h }];
      return { polygon: points, path: `M0 0 H${r2(w - rad)} A${r2(rad)} ${r2(h / 2)} 0 0 1 ${r2(w - rad)} ${r2(h)} H0 Z`, detail: [] };
    }
    case 'flow-manual-input': {
      const s = Math.min(SHAPE_DEFAULTS.slope, h / 2);
      return polyShape([{ x: 0, y: s }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
    }
    case 'flow-stored-data': {
      const k = Math.min(SHAPE_DEFAULTS.curve, w / 4);
      const points = [{ x: k, y: 0 }, { x: w, y: 0 }, ...quadPoints({ x: w, y: 0 }, { x: w - 2 * k, y: h / 2 }, { x: w, y: h }), { x: k, y: h }, ...quadPoints({ x: k, y: h }, { x: -k, y: h / 2 }, { x: k, y: 0 })];
      return {
        polygon: points.slice(0, -1),
        path: `M${r2(k)} 0 H${r2(w)} Q${r2(w - 2 * k)} ${r2(h / 2)} ${r2(w)} ${r2(h)} H${r2(k)} Q${r2(-k)} ${r2(h / 2)} ${r2(k)} 0 Z`,
        detail: [],
      };
    }
    case 'flow-loop-start': {
      const c = Math.min(SHAPE_DEFAULTS.cut, w / 3, h / 2);
      return polyShape([{ x: c, y: 0 }, { x: w - c, y: 0 }, { x: w, y: c }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: c }]);
    }
    case 'flow-loop-end': {
      const c = Math.min(SHAPE_DEFAULTS.cut, w / 3, h / 2);
      return polyShape([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h - c }, { x: w - c, y: h }, { x: c, y: h }, { x: 0, y: h - c }]);
    }
    case 'flow-card': {
      const c = Math.min(SHAPE_DEFAULTS.cut, w / 3, h / 2);
      return polyShape([{ x: c, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: c }]);
    }
    case 'flow-display': {
      const p = Math.min(h * 0.35, w / 4);
      const k = Math.min(h * 0.45, w / 4);
      const points = [{ x: p, y: 0 }, { x: w - k, y: 0 }, ...quadPoints({ x: w - k, y: 0 }, { x: w, y: 0 }, { x: w, y: h / 2 }), ...quadPoints({ x: w, y: h / 2 }, { x: w, y: h }, { x: w - k, y: h }), { x: p, y: h }, { x: 0, y: h / 2 }];
      return {
        polygon: points,
        path: `M${r2(p)} 0 H${r2(w - k)} Q${r2(w)} 0 ${r2(w)} ${r2(h / 2)} Q${r2(w)} ${r2(h)} ${r2(w - k)} ${r2(h)} H${r2(p)} L0 ${r2(h / 2)} Z`,
        detail: [],
      };
    }
    case 'flow-tape': {
      const d = Math.min(h, w - SHAPE_DEFAULTS.tail);
      const rad = d / 2;
      const points = arcPoints(rad, h / 2, rad, rad, Math.PI, 3 * Math.PI).slice(0, -1);
      return {
        polygon: points,
        path: `M0 ${r2(h / 2)} A${r2(rad)} ${r2(rad)} 0 1 0 ${r2(d)} ${r2(h / 2)} A${r2(rad)} ${r2(rad)} 0 1 0 0 ${r2(h / 2)} Z`,
        detail: [`M${r2(rad)} ${r2(h / 2 + rad)} H${r2(w)}`],
      };
    }
    case 'flow-punched-tape': {
      const a = SHAPE_DEFAULTS.wave;
      const points = [...[{ x: 0, y: a }, ...wavePoints(0, w, a, a)], ...[{ x: w, y: h - a }, ...wavePoints(w, 0, h - a, -a)]];
      return polyShape(points);
    }
    case 'flow-collate': {
      // Two triangles meeting at a point. Worked with as the bowtie's outline,
      // which passes through its own middle.
      return {
        polygon: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w / 2, y: h / 2 }, { x: w, y: h }, { x: 0, y: h }, { x: w / 2, y: h / 2 }],
        path: `M0 0 H${r2(w)} L0 ${r2(h)} H${r2(w)} Z`,
        detail: [],
      };
    }
    default:
      return polyShape([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
  }
}

/**
 * A path written relative to a box's top-left, moved to (x, y). Only the
 * absolute commands `shapeOf` writes are handled: M, L, H, V, Q, T, A and Z.
 */
export function placePath(d: string, x: number, y: number): string {
  return d.replace(/([MLHVQTAZ])([^MLHVQTAZ]*)/g, (_all, command: string, rest: string) => {
    const n = rest.trim().length === 0 ? [] : rest.trim().split(/[\s,]+/).map(Number);
    const moved = n.map((value, i) => {
      switch (command) {
        case 'H':
          return value + x;
        case 'V':
          return value + y;
        case 'A':
          // rx ry rotation large-arc sweep x y: only the end point moves.
          return i % 7 === 5 ? value + x : i % 7 === 6 ? value + y : value;
        default:
          return i % 2 === 0 ? value + x : value + y;
      }
    });
    return `${command}${moved.map(r2).join(' ')}${command === 'Z' ? '' : ' '}`;
  }).trim();
}

// --- the middle, and size for text ------------------------------------------------

/**
 * The shape's own middle, where its text sits and its lines aim: the center of
 * its area. On a symmetric shape that is the middle of its box; a triangle's is
 * a third of the way from its base.
 */
export function middleOf(outline: string, look: ShapeLook, w: number, h: number): Point {
  if (isBoxy(outline) || outline === 'circle' || outline === 'flow-collate') return { x: w / 2, y: h / 2 };
  if (outline === 'flow-tape') return { x: Math.min(h, w - SHAPE_DEFAULTS.tail) / 2, y: h / 2 };
  return areaCentroid(shapeOf(outline, look, w, h).polygon);
}

function areaCentroid(points: Point[]): Point {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-9) return points[0] ?? { x: 0, y: 0 };
  return { x: cx / (3 * area), y: cy / (3 * area) };
}

/** Whether a point is inside a polygon, by crossings. */
export function insideOutline(points: Point[], p: Point): boolean {
  let within = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) within = !within;
  }
  return within;
}

/** Whether a point is more than `distance` from every edge of a polygon. */
export function clearOf(points: Point[], p: Point, distance: number): boolean {
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const length = ex * ex + ey * ey;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / length));
    if (Math.hypot(p.x - (a.x + ex * t), p.y - (a.y + ey * t)) <= distance) return false;
  }
  return true;
}

/** Whether a rectangle centered on the shape's middle fits inside its outline, checked round its edge. */
function holdsBlock(outline: string, look: ShapeLook, w: number, h: number, tw: number, th: number): boolean {
  const polygon = shapeOf(outline, look, w, h).polygon;
  const m = middleOf(outline, look, w, h);
  const x0 = m.x - tw / 2;
  const y0 = m.y - th / 2;
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    for (const p of [{ x: x0 + tw * f, y: y0 }, { x: x0 + tw * f, y: y0 + th }, { x: x0, y: y0 + th * f }, { x: x0 + tw, y: y0 + th * f }]) {
      // A hair in, so a corner the outline passes exactly through counts as inside.
      const toward = { x: p.x + (m.x - p.x) * 1e-6, y: p.y + (m.y - p.y) * 1e-6 };
      if (!insideOutline(polygon, toward)) return false;
    }
  }
  return true;
}

/**
 * The size an outline takes to hold a block `tw` by `th` (the text with its
 * padding) at its middle: a first guess that is exact for most shapes, then
 * grown a step at a time until the block fits. A rectangle-like outline and
 * the round circle are sized by the resolver, as they always were.
 */
export function sizeFor(outline: string, look: ShapeLook, tw: number, th: number): { width: number; height: number } {
  const guess = guessSize(outline, look, tw, th);
  if (outline === 'flow-collate') return guess;
  let { width, height } = guess;
  for (let step = 0; step < 200 && !holdsBlock(outline, look, width, height, tw, th); step++) {
    width *= 1.02;
    height *= 1.02;
  }
  return { width, height };
}

function guessSize(outline: string, look: ShapeLook, tw: number, th: number): { width: number; height: number } {
  switch (outline) {
    case 'circle':
      // A circle given two sizes is an ellipse; one sized for its text is round.
      return { width: Math.hypot(tw, th), height: Math.hypot(tw, th) };
    case 'diamond':
      return { width: tw * 2, height: th * 2 };
    case 'pill':
      return { width: tw + th, height: th };
    case 'parallelogram':
      return { width: tw + (look.slant ?? SHAPE_DEFAULTS.slant), height: th };
    case 'hexagon':
      return { width: tw + 2 * (look.point ?? SHAPE_DEFAULTS.point), height: th };
    case 'trapezoid':
      return { width: tw + 2 * (look.taper ?? SHAPE_DEFAULTS.taper), height: th };
    case 'triangle':
      return look.aim === 'left' || look.aim === 'right' ? { width: tw * 2, height: th * 2.4 } : { width: tw * 2.4, height: th * 2 };
    case 'cylinder': {
      const c = look.cap ?? SHAPE_DEFAULTS.cap;
      return look.lying ? { width: tw + 4 * c, height: th } : { width: tw, height: th + 4 * c };
    }
    case 'flow-document':
      return { width: tw, height: th + 3 * SHAPE_DEFAULTS.wave };
    case 'flow-off-page':
      return { width: tw, height: th + SHAPE_DEFAULTS.offPage };
    case 'flow-delay':
      return { width: tw + th / 2, height: th };
    case 'flow-manual-input':
      return { width: tw, height: th + SHAPE_DEFAULTS.slope };
    case 'flow-stored-data':
      return { width: tw + 2 * SHAPE_DEFAULTS.curve, height: th };
    case 'flow-loop-start':
    case 'flow-loop-end':
      return { width: tw + SHAPE_DEFAULTS.cut, height: th + SHAPE_DEFAULTS.cut / 2 };
    case 'flow-card':
      return { width: tw + SHAPE_DEFAULTS.cut / 2, height: th + SHAPE_DEFAULTS.cut / 2 };
    case 'flow-display':
      return { width: tw + th * 0.8, height: th };
    case 'flow-tape': {
      const d = Math.hypot(tw, th);
      return { width: d + SHAPE_DEFAULTS.tail, height: d };
    }
    case 'flow-punched-tape':
      return { width: tw, height: th + 4 * SHAPE_DEFAULTS.wave };
    case 'flow-collate':
      return { width: tw, height: Math.max(th * 1.6, th + 20) };
    default:
      return { width: tw, height: th };
  }
}

// --- sides and corners ---------------------------------------------------------------

/**
 * Where the ray from `from` heading `way` first leaves a polygon, measured as
 * the distance along the ray, or undefined if it never crosses it.
 */
export function rayExit(points: Point[], from: Point, way: Point): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const t = rayHitsSegment(from, way, a, b);
    if (t !== undefined && t > 1e-9 && (best === undefined || t > best)) best = t;
  }
  return best;
}

/** Every distance along the line through `from` heading `way`, either direction, at which it crosses a polygon. */
export function lineCrossings(points: Point[], from: Point, way: Point): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const t = rayHitsSegment(from, way, points[i]!, points[(i + 1) % points.length]!, true);
    if (t !== undefined) out.push(t);
  }
  return out;
}

function rayHitsSegment(from: Point, way: Point, a: Point, b: Point, both = false): number | undefined {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const denom = way.x * ey - way.y * ex;
  if (Math.abs(denom) < 1e-12) return undefined;
  const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / denom;
  const s = ((a.x - from.x) * way.y - (a.y - from.y) * way.x) / denom;
  if (s < -1e-9 || s > 1 + 1e-9) return undefined;
  if (!both && t < 0) return undefined;
  return t;
}

/** Where the line from a polygon's middle toward `target` crosses its outline: the farthest crossing, so a concave outline is met at its rim. */
export function towardOutline(points: Point[], middle: Point, target: Point): Point {
  const dx = target.x - middle.x;
  const dy = target.y - middle.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return middle;
  const way = { x: dx / length, y: dy / length };
  const t = rayExit(points, middle, way) ?? 0;
  return { x: middle.x + way.x * t, y: middle.y + way.y * t };
}

/**
 * The stretch of the outline that is one side: from where the line from the
 * middle to one corner of the box meets it, round to where the line to the
 * next corner does. Returned in reading order, left to right along a top or
 * bottom side and top to bottom along a left or right one.
 */
export function sideStretch(points: Point[], middle: Point, box: { x: number; y: number; width: number; height: number }, side: 'top' | 'bottom' | 'left' | 'right'): Point[] {
  const tl = { x: box.x, y: box.y };
  const tr = { x: box.x + box.width, y: box.y };
  const bl = { x: box.x, y: box.y + box.height };
  const br = { x: box.x + box.width, y: box.y + box.height };
  const [c0, c1] = { top: [tl, tr], right: [tr, br], bottom: [bl, br], left: [tl, bl] }[side] as [Point, Point];
  const a0 = Math.atan2(c0.y - middle.y, c0.x - middle.x);
  const a1 = Math.atan2(c1.y - middle.y, c1.x - middle.x);
  // The angular wedge between the two corner rays that holds the side.
  const span = (to: number): number => {
    let d = to - a0;
    while (d < 0) d += 2 * Math.PI;
    while (d >= 2 * Math.PI) d -= 2 * Math.PI;
    return d;
  };
  let width = span(a1);
  let clockwise = true;
  const facing = { top: -Math.PI / 2, right: 0, bottom: Math.PI / 2, left: Math.PI }[side];
  if (span(facing) > width) {
    clockwise = false;
    width = 2 * Math.PI - width;
  }
  const out: Point[] = [];
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    const angle = a0 + (clockwise ? 1 : -1) * (width * i) / steps;
    const p = towardOutline(points, middle, { x: middle.x + Math.cos(angle), y: middle.y + Math.sin(angle) });
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) out.push(p);
  }
  return out;
}

/** The point a fraction of the way along a polyline, by length. */
export function alongPolyline(points: Point[], fraction: number): Point {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  let left = Math.max(0, Math.min(1, fraction)) * total;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= length || i === points.length - 1) {
      const f = length < 1e-9 ? 0 : Math.min(1, left / length);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    left -= length;
  }
  return points[0] ?? { x: 0, y: 0 };
}

/** Which side of the box a point on the outline is on, by the corner rays from the middle. */
export function sideOfPoint(middle: Point, box: { x: number; y: number; width: number; height: number }, at: Point): 'top' | 'bottom' | 'left' | 'right' {
  const angle = Math.atan2(at.y - middle.y, at.x - middle.x);
  const corner = (x: number, y: number): number => Math.atan2(y - middle.y, x - middle.x);
  const tr = corner(box.x + box.width, box.y);
  const br = corner(box.x + box.width, box.y + box.height);
  const bl = corner(box.x, box.y + box.height);
  const tl = corner(box.x, box.y);
  if (angle >= tr && angle <= br) return 'right';
  if (angle >= br && angle <= bl) return 'bottom';
  if (angle <= tr && angle >= tl) return 'top';
  return 'left';
}
