// Times the compiled library on diagrams of rising difficulty and stops at the
// first one that takes longer than its limit. Run it through `./dev.sh stress`.
//
// Each level is the same 45 boxes in a grid, with more and more lines between
// pairs of them chosen by a fixed seed, so a level is the same diagram on every
// run and every machine. The pairs are scattered, so the lines cross a great
// deal: far more tangled than a diagram anyone would write, which is the point.
// Routing lines is where the time goes, and it is the part that has grown
// worse than linearly before (a diagram of 48 lines took over half an hour in
// 0.14.0).
//
// A level over its limit ends the run there, so a slow build is reported in
// seconds rather than after minutes of the larger levels. The limits are about
// twice what each level took when they were set, on the machine that set them:
// room for a slower machine, not for a slower build.

import { compile } from '../dist/index.js';

const LEVELS = [
  { lines: 5, limit: 1 },
  { lines: 10, limit: 2 },
  { lines: 20, limit: 4 },
  { lines: 30, limit: 7 },
  { lines: 48, limit: 14 },
];
const QUICK = 3;

const full = process.argv[2] === 'full';

function diagram(lines) {
  const boxes = 45;
  const columns = 9;
  let seed = 1;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [];
  for (let i = 0; i < boxes; i += 1) {
    const place = i % columns > 0 ? `right of n${i - 1}  (gap: wide)` : i > 0 ? `below n${i - columns}  (gap: wide)` : '';
    out.push(`node n${i} "Service ${i}"  ${place}`);
  }
  const seen = new Set();
  while (seen.size < lines) {
    const a = Math.floor(next() * boxes);
    const b = Math.floor(next() * boxes);
    if (a === b || seen.has(`${a}-${b}`)) continue;
    seen.add(`${a}-${b}`);
    out.push(`edge n${a} -> n${b}  "flow ${seen.size}"`);
  }
  return out.join('\n');
}

let level = 0;
for (const { lines, limit } of full ? LEVELS : LEVELS.slice(0, QUICK)) {
  level += 1;
  const source = diagram(lines);
  const began = performance.now();
  compile(source);
  const took = (performance.now() - began) / 1000;
  const over = took > limit;
  console.log(`level ${level}  ${String(lines).padStart(2)} lines  ${took.toFixed(2)}s  (limit ${limit}s)${over ? '  TOO SLOW' : ''}`);
  if (over) {
    console.log(`stopped at level ${level}: routing has become slower than it was`);
    process.exit(1);
  }
}
if (!full) console.log(`levels 1-${QUICK} in time; \`./dev.sh stress full\` runs all ${LEVELS.length}`);
