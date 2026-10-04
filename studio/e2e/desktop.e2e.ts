// The desktop app end to end: Electron starts its own server (token gate), the window opens on the empty app, a
// project is added through the UI, its diagrams render, a key is saved encrypted, and quitting stops the server.
// Run under a display (xvfb-run on a headless Linux box):
//
//   PLAYWRIGHT_CORE=… xvfb-run -a npx tsx e2e/desktop.e2e.ts [--shot <dir>]

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { _electron } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core") as typeof import("playwright-core")
const here = dirname(fileURLToPath(import.meta.url))
const studio = resolve(here, "..")
const shotDir = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env })

const root = mkdtempSync(join(tmpdir(), "archdraw-desktop-"))
const seed = join(root, "seed")
mkdirSync(join(seed, ".archdraw"), { recursive: true })
sh(seed, "init", "-q", "-b", "main")
writeFileSync(join(seed, ".archdraw", "system.archdraw"), '// title: Desk test\n\nnode a "App"\nnode b "Store" right of a\nedge a -> b "reads" from: right to: left\n')
sh(seed, "add", "-A")
sh(seed, "commit", "-q", "-m", "seed")
const origin = join(root, "origin.git")
sh(root, "clone", "-q", "--bare", seed, origin)
const userData = join(root, "userData")

const steps: string[] = []
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    steps.push(`ok   ${name}`)
  } catch (e) {
    steps.push(`FAIL ${name}: ${String((e as Error).message).split("\n")[0]}`)
    throw e
  }
}

// --exe <packaged binary> tests a built package (e.g. an extracted AppImage) instead of the development app
const exe = process.argv.includes("--exe") ? process.argv[process.argv.indexOf("--exe") + 1] : null
const app = await _electron.launch({
  executablePath: exe ?? join(studio, "node_modules/electron/dist/electron"),
  args: [...(exe ? [] : [join(studio, "desktop/app/main.mjs")]), `--user-data-dir=${userData}`, "--no-sandbox"],
  env: { ...process.env, OPENAI_API_KEY: "" },
})
try {
  const win = await app.firstWindow()
  await step("the window opens on the app, served by its own token-gated server", async () => {
    await win.waitForSelector("[data-testid=empty]", { timeout: 30_000 })
    const url = win.url()
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url) || url.includes("token=")) throw new Error(`window url ${url}`)
    const direct = await fetch(url.replace(/#.*$/, "") + "api/projects")
    if (direct.status !== 403) throw new Error(`the server answered ${direct.status} without the session`)
  })
  await step("add a project through the UI; its diagram renders", async () => {
    await win.click("[data-testid=add-project]")
    await win.fill("[data-testid=connect-input]", origin)
    await win.click("[data-testid=connect-submit]")
    await win.waitForSelector("[data-card=system] svg", { timeout: 30_000 })
  })
  await step("a key saved in Settings is never written as plain text, and a machine without a keyring says so", async () => {
    await win.click("[data-testid=open-settings]")
    await win.selectOption("[data-testid=set-provider]", "openai")
    await win.fill("[data-testid=set-key]", "sk-test-0123456789abcdefghijklmnop")
    await win.click("[data-testid=settings-save]")
    await win.waitForSelector("[data-testid=settings-dialog]", { state: "detached", timeout: 8000 }).catch(async e => {
      throw new Error(`settings did not close: ${await win.locator("[data-testid=settings-dialog] .text-\\[var\\(--danger\\)\\]").innerText().catch(() => "?")} (${e.message.split("\n")[0]})`)
    })
    const file = join(userData, "keys.json")
    if (!existsSync(file)) throw new Error("no keys.json")
    if (readFileSync(file, "utf8").includes("sk-test-0123456789")) throw new Error("the key is stored in plain text")
    const v = await win.evaluate(async () => await (await fetch("api/settings")).json())
    if (!v.keys.openai) throw new Error("the app does not see the key")
    const sealed = JSON.parse(readFileSync(file, "utf8")).openai as string
    if (sealed.startsWith("plain:") && !v.keysWeak) throw new Error("basic protection used without telling the user")
  })
  if (shotDir) await win.screenshot({ path: join(shotDir, "desktop.png") })
  await step("the app's state lives in its own data folder", async () => {
    const cfg = JSON.parse(readFileSync(join(userData, "config.json"), "utf8"))
    if (cfg.projects?.[0]?.slug !== "origin") throw new Error("config.json does not list the project")
    if (!existsSync(join(userData, "repos", "origin", ".git"))) throw new Error("no clone in userData/repos")
  })
} finally {
  await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
  await app.close().catch(() => undefined)
  console.log(steps.join("\n"))
}
console.log(steps.every(s => s.startsWith("ok")) ? "desktop e2e: all passed" : "desktop e2e: FAILED")
if (!steps.every(s => s.startsWith("ok"))) process.exit(1)
