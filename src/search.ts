/**
 * Finding a line's way through the open space between boxes.
 *
 * Every box is a wall. A line may turn only where two tracks cross, and the
 * tracks are few: a line a little way out from each side of each wall, one
 * down the middle of each gap between walls, and the lines through the two
 * ends. That is the whole of the open space a right-angled line ever needs,
 * reduced to a grid of a few hundred points for a diagram of ordinary size.
 *
 * The line leaves its start heading straight out and arrives at its end heading
 * straight in, with a straight stretch at each end at least `stub` long, so an
 * arrowhead always lands on a straight piece. Between those two stretches it
 * takes the cheapest way through the grid, where cost is length plus a charge
 * for every turn. On a right-angled grid many ways tie on length — a staircase
 * is exactly as long as one bend — and the turn charge breaks those ties toward
 * the fewest bends, which is the line a person would draw. What still ties
 * after that goes over the top rather than under, and round the right rather
 * than the left.
 *
 * A way through a box is not a losing option here. It is not a way at all.
 */

export interface SearchPoint {
  x: number;
  y: number;
}

/** A box the line may not enter, as its extent. Touching its border is allowed. */
export interface SearchWall {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** One end of the line: a point on a box's side, and the unit direction out of it. */
export interface SearchEnd {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface SearchOptions {
  /** How far the line runs straight out of each end before it may turn. */
  stub: number;
  /** How far outside a wall a track runs beside it, where there is room. */
  clear: number;
  /** What a turn costs, in the same units as length. */
  turn: number;
  /**
   * Walls the stretches at the two ends may pass through: the line's own boxes,
   * which it has to cross the margin of to leave, and any box holding an end.
   */
  ownStart: SearchWall[];
  ownEnd: SearchWall[];
  /**
   * Lines already placed. A line may cross one but not run along it within
   * `lane` of it; tracks are added a lane either side of each, so a later line
   * sharing a stretch takes the next lane out.
   */
  taken: SearchPoint[][];
  lane: number;
}

export interface SearchResult {
  points: SearchPoint[];
  cost: number;
}

/**
 * The cheapest right-angled line from `start` to `end` that enters no wall, or
 * undefined when there is none.
 */
export function searchRoute(
  start: SearchEnd,
  end: SearchEnd,
  walls: SearchWall[],
  options: SearchOptions,
): SearchResult | undefined {
  const { clear, turn } = options;
  // The stretches at the ends are fixed. Each crosses its own box's margin and
  // runs `stub` further, or, where another box is closer than that, stops in
  // the middle of the gap between the two margins: a node placed a `tight` gap
  // away still leaves room to get out.
  const others = (own: SearchWall[]): SearchWall[] => walls.filter((wall) => !own.includes(wall));
  const reach = (from: SearchEnd, own: SearchWall[]): SearchPoint | undefined => {
    const exit = Math.max(0, ...own.map((wall) => depth(from, wall)));
    const wanted = Math.max(options.stub, exit + 1);
    const hit = Math.min(Infinity, ...others(own).map((wall) => distanceTo(from, wall, wanted)));
    const length = hit >= wanted ? wanted : (exit + hit) / 2;
    if (length <= exit) return undefined;
    return { x: snap(from.x + from.dx * length), y: snap(from.y + from.dy * length) };
  };
  const out = reach(start, options.ownStart);
  const back = reach(end, options.ownEnd);
  if (!out || !back) return undefined;
  if (inside(out, walls) || inside(back, walls)) return undefined;

  const xs = tracks(walls, 'x', clear, [out.x, back.x], options.taken, options.lane);
  const ys = tracks(walls, 'y', clear, [out.y, back.y], options.taken, options.lane);
  const ix = new Map(xs.map((x, index) => [x, index]));
  const iy = new Map(ys.map((y, index) => [y, index]));
  const width = xs.length;
  const height = ys.length;
  const open = (i: number, j: number): boolean => !inside({ x: xs[i]!, y: ys[j]! }, walls);

  // Four headings: 0 right, 1 down, 2 left, 3 up.
  const STEP = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const;
  const heading = (dx: number, dy: number): number => (dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3);

  const first = heading(start.dx, start.dy);
  // The last stretch travels into the end, against the way its side faces.
  const last = heading(-end.dx, -end.dy);
  const si = ix.get(out.x)!;
  const sj = iy.get(out.y)!;
  const ti = ix.get(back.x)!;
  const tj = iy.get(back.y)!;

  // Cost is compared first on length and turns, then on a tie-break that
  // prefers a stretch higher up the page, or further right, so that of two
  // ways round that are exactly as long the line goes over the top.
  const size = width * height * 4;
  const cost = new Float64Array(size).fill(Infinity);
  const tie = new Float64Array(size).fill(Infinity);
  const from = new Int32Array(size).fill(-1);
  const state = (i: number, j: number, h: number): number => (j * width + i) * 4 + h;

  const heap = new MinHeap();
  const begin = state(si, sj, first);
  cost[begin] = 0;
  tie[begin] = 0;
  heap.push(begin, 0, 0);

  let goal = -1;
  while (heap.size > 0) {
    const [current, c, t] = heap.pop();
    if (c > cost[current]! || (c === cost[current]! && t > tie[current]!)) continue;
    const h = current % 4;
    const cell = (current - h) / 4;
    const i = cell % width;
    const j = (cell - i) / width;
    if (i === ti && j === tj && h === last) {
      goal = current;
      break;
    }
    for (let next = 0; next < 4; next += 1) {
      // A line never doubles straight back on itself.
      if ((next + 2) % 4 === h) continue;
      if (next !== h) {
        // Turning on the spot costs a turn and moves nowhere.
        relax(current, state(i, j, next), c + turn, t);
        continue;
      }
      const ni = i + STEP[next]![0];
      const nj = j + STEP[next]![1];
      if (ni < 0 || nj < 0 || ni >= width || nj >= height || !open(ni, nj)) continue;
      const a = { x: xs[i]!, y: ys[j]! };
      const b = { x: xs[ni]!, y: ys[nj]! };
      if (blocked(a, b, walls) || alongTaken(a, b, options.taken, options.lane)) continue;
      // Running closer to a wall than `clear` counts double: the line may pass
      // a narrow gap, but where there is room it keeps its distance.
      const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + crowding(a, b, walls, clear);
      // Higher up for a stretch across, further right for one down: a smaller
      // tie-break is preferred, so the across level counts as it is and the
      // down level counts negated.
      const lean = next % 2 === 0 ? a.y * length : -a.x * length;
      relax(current, state(ni, nj, next), c + length, t + lean);
    }
  }
  if (goal < 0) return undefined;

  function relax(previous: number, next: number, c: number, t: number): void {
    if (c < cost[next]! - 1e-9 || (Math.abs(c - cost[next]!) <= 1e-9 && t < tie[next]!)) {
      cost[next] = c;
      tie[next] = t;
      from[next] = previous;
      heap.push(next, c, t);
    }
  }

  const path: SearchPoint[] = [];
  for (let at = goal; at >= 0; at = from[at]!) {
    const cell = (at - (at % 4)) / 4;
    const i = cell % width;
    const j = (cell - i) / width;
    const point = { x: xs[i]!, y: ys[j]! };
    const previous = path[path.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) path.push(point);
  }
  path.reverse();
  return { points: straightRuns([start, ...path, end]), cost: cost[goal]! };
}

/**
 * The tracks on one axis: beside each wall at `clear` where that is open,
 * down the middle of every gap between walls, through the ends, and a lane
 * either side of each line already placed.
 */
function tracks(
  walls: SearchWall[],
  axis: 'x' | 'y',
  clear: number,
  ends: number[],
  taken: SearchPoint[][],
  lane: number,
): number[] {
  const lo = (wall: SearchWall): number => (axis === 'x' ? wall.minX : wall.minY);
  const hi = (wall: SearchWall): number => (axis === 'x' ? wall.maxX : wall.maxY);
  // The other axis, to tell a real gap — two walls facing each other across
  // it — from two edges that merely happen to lie near each other on this one.
  const olo = (wall: SearchWall): number => (axis === 'x' ? wall.minY : wall.minX);
  const ohi = (wall: SearchWall): number => (axis === 'x' ? wall.maxY : wall.maxX);
  const found = new Set<number>(ends);
  for (const wall of walls) {
    found.add(lo(wall) - clear);
    found.add(hi(wall) + clear);
  }
  for (const a of walls) {
    for (const b of walls) {
      if (hi(a) < lo(b) && olo(a) < ohi(b) && olo(b) < ohi(a)) found.add((hi(a) + lo(b)) / 2);
    }
  }
  for (const line of taken) {
    for (let index = 0; index + 1 < line.length; index += 1) {
      const [a, b] = [line[index]!, line[index + 1]!];
      // A stretch across sits at a level on y; one down, at a level on x.
      const across = Math.abs(a.y - b.y) < 0.5;
      if ((axis === 'y') !== across) continue;
      // A lane either side of a placed line. One that runs close beside a box
      // is paid for as crowding, like any other track.
      const level = axis === 'y' ? a.y : a.x;
      found.add(level - lane);
      found.add(level + lane);
    }
  }
  return [...new Set([...found].map(snap))].sort((p, q) => p - q);
}

/** Coordinates to a hundredth, so a track and the end it runs through compare equal. */
function snap(value: number): number {
  return Math.round(value * 100) / 100;
}

/** How far along its heading an end runs before it leaves a wall it starts inside; 0 if it is outside. */
function depth(from: SearchEnd, wall: SearchWall): number {
  if (!(from.x >= wall.minX && from.x <= wall.maxX && from.y >= wall.minY && from.y <= wall.maxY)) return 0;
  if (from.dx > 0) return wall.maxX - from.x;
  if (from.dx < 0) return from.x - wall.minX;
  if (from.dy > 0) return wall.maxY - from.y;
  return from.y - wall.minY;
}

/**
 * How far along its heading an end runs before it meets a wall it is outside
 * of, looking no further than `limit`; Infinity if it meets none.
 */
function distanceTo(from: SearchEnd, wall: SearchWall, limit: number): number {
  const tip = { x: from.x + from.dx * limit, y: from.y + from.dy * limit };
  if (!blocked(from, tip, [wall])) return Infinity;
  if (from.dx > 0) return wall.minX - from.x;
  if (from.dx < 0) return from.x - wall.maxX;
  if (from.dy > 0) return wall.minY - from.y;
  return from.y - wall.maxY;
}

/** Whether a point lies strictly inside any wall. */
function inside(point: SearchPoint, walls: SearchWall[]): boolean {
  return walls.some(
    (wall) => point.x > wall.minX && point.x < wall.maxX && point.y > wall.minY && point.y < wall.maxY,
  );
}

/** Whether a level or upright stretch passes through the inside of any wall. */
function blocked(a: SearchPoint, b: SearchPoint, walls: SearchWall[]): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return walls.some((wall) => {
    if (minY === maxY) return minY > wall.minY && minY < wall.maxY && maxX > wall.minX && minX < wall.maxX;
    return minX > wall.minX && minX < wall.maxX && maxY > wall.minY && minY < wall.maxY;
  });
}

/**
 * How much of a stretch runs within `clear` of a wall's side, alongside it:
 * the longest such run against any one wall.
 */
function crowding(a: SearchPoint, b: SearchPoint, walls: SearchWall[], clear: number): number {
  const across = Math.abs(a.y - b.y) < 0.5;
  const level = across ? a.y : a.x;
  const from = across ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
  const to = across ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  let worst = 0;
  for (const wall of walls) {
    const [lo, hi] = across ? [wall.minY, wall.maxY] : [wall.minX, wall.maxX];
    const [alo, ahi] = across ? [wall.minX, wall.maxX] : [wall.minY, wall.maxY];
    const near = (level > lo - clear + 0.01 && level <= lo) || (level >= hi && level < hi + clear - 0.01);
    if (!near) continue;
    worst = Math.max(worst, Math.min(to, ahi) - Math.max(from, alo));
  }
  return worst;
}

/** Whether a stretch runs along a placed line, closer than a lane, for any distance. */
function alongTaken(a: SearchPoint, b: SearchPoint, taken: SearchPoint[][], lane: number): boolean {
  const across = Math.abs(a.y - b.y) < 0.5;
  const level = across ? a.y : a.x;
  const lo = across ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
  const hi = across ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  for (const line of taken) {
    for (let index = 0; index + 1 < line.length; index += 1) {
      const [p, q] = [line[index]!, line[index + 1]!];
      const pAcross = Math.abs(p.y - q.y) < 0.5;
      if (pAcross !== across) continue;
      const other = across ? p.y : p.x;
      if (Math.abs(other - level) >= lane - 0.5) continue;
      const pLo = across ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
      const pHi = across ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
      if (Math.min(hi, pHi) - Math.max(lo, pLo) > 0.5) return true;
    }
  }
  return false;
}

/** The points with every one dropped that sits on a straight run between its neighbors. */
function straightRuns(points: SearchPoint[]): SearchPoint[] {
  const kept: SearchPoint[] = [];
  for (const point of points) {
    const previous = kept[kept.length - 1];
    if (previous && Math.abs(previous.x - point.x) < 0.01 && Math.abs(previous.y - point.y) < 0.01) continue;
    kept.push(point);
    while (kept.length >= 3) {
      const [a, b, c] = kept.slice(-3) as [SearchPoint, SearchPoint, SearchPoint];
      const level = Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01;
      const upright = Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01;
      if (!level && !upright) break;
      kept.splice(kept.length - 2, 1);
    }
  }
  return kept;
}

/** A binary heap of states, cheapest first, ties broken by the second cost. */
class MinHeap {
  private items: [number, number, number][] = [];

  get size(): number {
    return this.items.length;
  }

  push(state: number, cost: number, tie: number): void {
    const items = this.items;
    items.push([state, cost, tie]);
    let at = items.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!before(items[at]!, items[parent]!)) break;
      [items[at], items[parent]] = [items[parent]!, items[at]!];
      at = parent;
    }
  }

  pop(): [number, number, number] {
    const items = this.items;
    const top = items[0]!;
    const tail = items.pop()!;
    if (items.length > 0) {
      items[0] = tail;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let best = at;
        if (left < items.length && before(items[left]!, items[best]!)) best = left;
        if (right < items.length && before(items[right]!, items[best]!)) best = right;
        if (best === at) break;
        [items[at], items[best]] = [items[best]!, items[at]!];
        at = best;
      }
    }
    return top;
  }
}

function before(p: [number, number, number], q: [number, number, number]): boolean {
  return p[1] < q[1] - 1e-9 || (Math.abs(p[1] - q[1]) <= 1e-9 && p[2] < q[2]);
}
