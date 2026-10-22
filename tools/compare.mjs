// Writes the old-beside-new page for `./dev.sh compare`: every example as an
// older release drew it, beside the working tree's render, each source under
// its picture. The shell side renders; this only assembles the page.
//
// node tools/compare.mjs <dir> <ref>
//
// <dir> holds, per example <name>: old/<name>.reladraw and new/<name>.reladraw
// (either may be missing), old/<name>.svg and new/<name>.svg when they
// rendered, and old/<name>.said and new/<name>.said, whatever the CLI printed
// besides the output path (an error, or findings). Writes <dir>/index.html.

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ref] = process.argv.slice(2);
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const lines = (s) => (s === null ? 0 : s.replace(/\n$/, '').split('\n').length);

const names = [...new Set(
  ['old', 'new'].flatMap((side) =>
    existsSync(join(dir, side))
      ? readdirSync(join(dir, side)).filter((f) => f.endsWith('.reladraw')).map((f) => f.slice(0, -9))
      : [])
)].sort();

function side(which, name) {
  const src = read(join(dir, which, `${name}.reladraw`));
  const said = (read(join(dir, which, `${name}.said`)) ?? '').trim();
  const drew = existsSync(join(dir, which, `${name}.svg`));
  const picture = drew
    ? `<img src="${which}/${name}.svg" alt="${which} render of ${name}">`
    : `<p class="fails">${src === null ? 'No such file.' : 'Does not render.'}</p>`;
  const notes = said ? `<pre class="said">${esc(said)}</pre>` : '';
  const source = src === null ? '' : `<pre class="src">${esc(src)}</pre>`;
  return { src, drew, said, html: `<div class="side">${picture}${notes}${source}</div>` };
}

const rows = names.map((name) => {
  const a = side('old', name);
  const b = side('new', name);
  const findings = (b.said.match(/warning\(/g) ?? []).length;
  const status = !b.drew ? 'fails' : findings ? `${findings} finding${findings > 1 ? 's' : ''}` : 'renders';
  return {
    name, status, oldLines: lines(a.src), newLines: lines(b.src), findings, fails: !b.drew,
    html: `<section id="${name}">
<h2>${name} <small>${lines(a.src)} → ${lines(b.src)} lines · ${status}</small></h2>
<div class="pair"><div><h3>${esc(ref)}</h3>${a.html}</div><div><h3>now</h3>${b.html}</div></div>
</section>`,
  };
});

const failing = rows.filter((r) => r.fails).map((r) => r.name);
const index = rows.map((r) =>
  `<tr><td><a href="#${r.name}">${r.name}</a></td><td>${r.oldLines}</td><td>${r.newLines}</td><td>${r.status}</td></tr>`).join('\n');

writeFileSync(join(dir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Old beside new</title>
<style>
  :root { --bg: #fff; --fg: #222; --muted: #666; --rule: #ddd; --code: #f6f6f4; --bad: #a12; }
  body { background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; margin: 0 16px 64px; }
  h1 { font-size: 22px; } h2 { font-size: 18px; margin: 0 0 8px; } h2 small { color: var(--muted); font-weight: normal; }
  h3 { font-size: 13px; color: var(--muted); margin: 0 0 6px; text-transform: uppercase; letter-spacing: .04em; }
  section { border-top: 1px solid var(--rule); padding: 20px 0; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 900px) { .pair { grid-template-columns: 1fr; } }
  img { max-width: 100%; height: auto; display: block; border: 1px solid var(--rule); }
  pre { background: var(--code); padding: 8px 10px; overflow-x: auto; font-size: 12px; line-height: 1.35; }
  pre.said { color: var(--bad); white-space: pre-wrap; }
  .fails { color: var(--bad); font-weight: 600; }
  table { border-collapse: collapse; font-size: 14px; } td, th { padding: 2px 12px 2px 0; text-align: left; }
</style></head><body>
<h1>Every example, ${esc(ref)} beside now</h1>
<p>${rows.length} examples; ${failing.length ? `${failing.length} do not render now: ${failing.join(', ')}` : 'all render now'}. Lines are the source's line count, ${esc(ref)} → now.</p>
<table><tr><th>example</th><th>${esc(ref)}</th><th>now</th><th></th></tr>
${index}
</table>
${rows.map((r) => r.html).join('\n')}
</body></html>
`);
console.log(join(dir, 'index.html'));
