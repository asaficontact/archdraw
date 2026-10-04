// Build archdraw: the headless server (dist/, for trex) and the desktop app (desktop/app/, for electron-builder).
//
//   node scripts/build.mjs            both
//   node scripts/build.mjs server     dist/server.mjs + dist/ui + dist/assets
//   node scripts/build.mjs desktop    desktop/app/{main.mjs,preload.cjs,package.json}
//
// The UI is built by its own package (ui/: `npx vite build`); this copies ui/dist next to each bundle.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const what = process.argv[2] ?? "all"
// bundled ESM still needs `require` for the few CommonJS dependencies
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }

if (what === "all" || what === "server") {
  const out = join(root, "dist")
  rmSync(out, { recursive: true, force: true })
  await build({ entryPoints: { server: join(root, "server/src/main.ts") }, outdir: out, bundle: true, platform: "node", format: "esm", target: "node22", splitting: true, outExtension: { ".js": ".mjs" }, sourcemap: true, banner, logLevel: "warning" })
  cpSync(join(root, "ui/dist"), join(out, "ui"), { recursive: true })
  cpSync(join(root, "core/assets"), join(out, "assets"), { recursive: true })
  console.log("built dist/server.mjs")
}

if (what === "all" || what === "desktop") {
  const out = join(root, "desktop/app")
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  await build({ entryPoints: { main: join(root, "desktop/src/main.ts") }, outdir: out, bundle: true, platform: "node", format: "esm", target: "node22", splitting: true, outExtension: { ".js": ".mjs" }, external: ["electron"], banner, logLevel: "warning" })
  await build({ entryPoints: [join(root, "desktop/src/preload.ts")], outfile: join(out, "preload.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "warning" })
  writeFileSync(join(out, "package.json"), JSON.stringify({ name: "archdraw", productName: "archdraw", version: pkg.version, description: pkg.description, main: "main.mjs", type: "module", author: { name: "Safiware", email: "archdraw@users.noreply.github.com" }, homepage: "https://github.com/asaficontact/archdraw", desktopName: "archdraw.desktop", license: "UNLICENSED" }, null, 1))
  console.log("built desktop/app")
}
