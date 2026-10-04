// archdraw end to end: the real server and UI in Chromium, against a sandbox "GitHub" repo (a local bare repo) and a
// scripted model (pi-ai's faux provider), so every feature is exercised without the network or a key. Each check is a
// thing Tawab does; a failure names the step.
//
//   PLAYWRIGHT_CORE=<playwright-core> PLAYWRIGHT_BROWSERS_PATH=<browsers> npx tsx e2e/app.e2e.ts [--headed] [--video <dir>]

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai"
import { MemoryKeys } from "../core/src/models.js"
import { start } from "../server/src/main.js"

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core") as typeof import("playwright-core")
const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const videoDir = args.includes("--video") ? args[args.indexOf("--video") + 1] : null
const shotDir = args.includes("--shot") ? args[args.indexOf("--shot") + 1] : null

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env })

const SYSTEM = `// title: Bean There, the whole system
// summary: How an order goes from the app to the barista.

style ours  fill: theme-primary-subtle  border: theme-primary
style store  fill: theme-fill  border: theme-border  badge: database

node app "Customer app"  style: ours
node api "Order API" right of app  style: ours
node db "Orders" right of api  style: store
edge app -> api "HTTPS" from: right to: left
edge api -> db "SQL" from: right to: left
`
const PAYMENTS = `// title: Payments
// summary: Card payments and receipts.

node api "Order API"
node psp "Payment provider" right of api
edge api -> psp "charge" from: right to: left
`
const WITH_QUEUE = SYSTEM + `node queue "Barista queue" below api  style: ours\nedge api -> queue "enqueue" from: bottom to: top\n`

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "archdraw-e2e-"))
  const seed = join(root, "seed")
  mkdirSync(join(seed, ".archdraw"), { recursive: true })
  mkdirSync(join(seed, "src"))
  sh(seed, "init", "-q", "-b", "main")
  writeFileSync(join(seed, ".archdraw", "system.archdraw"), SYSTEM)
  writeFileSync(join(seed, ".archdraw", "payments.archdraw"), PAYMENTS)
  writeFileSync(join(seed, "src", "orders.ts"), "export const queue = 'barista'\n")
  sh(seed, "add", "-A")
  sh(seed, "commit", "-q", "-m", "seed")
  const origin = join(root, "origin.git")
  sh(root, "clone", "-q", "--bare", seed, origin)
  return { root, origin }
}

const steps: string[] = []
let shoot: ((file: string) => Promise<unknown>) | null = null
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    const r = await fn()
    steps.push(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
    return r
  } catch (e) {
    const file = join(process.env.E2E_OUT ?? tmpdir(), `archdraw-e2e-failed.png`)
    await shoot?.(file).catch(() => undefined)
    steps.push(`FAIL ${name}: ${String((e as Error).message).split("\n")[0]} (screenshot ${file})`)
    throw e
  }
}

async function main() {
  const { root, origin } = sandbox()
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const keys = new MemoryKeys()
  keys.set("faux", "e2e")
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, projects: [], settings: { provider: "faux", chatModel: "faux-1", triageModel: "faux-1" }, onboarded: true }))
  const server = await start({ home, port: 0, gate: { mode: "local" }, keys, models, ui: resolve(here, "../ui/dist"), sync: false, by: "archdraw-e2e", log: () => undefined })
  const browser = await chromium.launch({ headless: !args.includes("--headed") })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } } : {}) })
  const page = await ctx.newPage()
  shoot = file => page.screenshot({ path: file })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(String(e)))
  page.on("dialog", d => void d.accept())
  try {
    await step("an empty app invites a first project", async () => {
      await page.goto(server.url)
      await page.waitForSelector("[data-testid=empty]")
    })
    await step("add a GitHub-style project; its diagrams appear on the canvas", async () => {
      await page.click("[data-testid=add-project]")
      await page.fill("[data-testid=connect-input]", origin)
      await page.click("[data-testid=connect-submit]")
      await page.waitForSelector("[data-card=system]", { timeout: 30_000 })
      await page.waitForSelector("[data-card=payments]")
    })
    await step("⌘K jumps to a diagram by name", async () => {
      await page.keyboard.press("Control+k")
      await page.waitForSelector("[data-testid=palette-input]:focus")
      await page.keyboard.type("paym")
      await page.keyboard.press("Enter")
      await page.waitForURL(/#\/origin\/payments$/)
    })
    await step("edit the source: the card redraws, Save makes a waiting change and the banner says so", async () => {
      await page.click("[data-testid=file-system]")
      await page.click("[data-testid=toggle-source]")
      const ta = page.locator("[data-testid=source]")
      await ta.click()
      await page.keyboard.press("Control+End")
      await page.keyboard.type('\nnode cache "Menu cache" below db  style: store\n')
      await page.waitForFunction(() => document.querySelector("[data-card=system]")?.textContent?.includes("Menu cache"))
      await page.keyboard.press("Control+s")
      await page.waitForSelector("[data-testid=toast]:has-text('waiting for review')")
      await page.click("[data-testid=toggle-source]")
      await page.waitForSelector("[data-testid=waiting-banner]")
      // a second diagram in the same update, so the inbox has more than one to show
      await page.click("[data-testid=file-payments]")
      await page.click("[data-testid=toggle-source]")
      await page.locator("[data-testid=source]").click()
      await page.keyboard.press("Control+End")
      await page.keyboard.type('\nnode bank "Bank" below psp\n')
      await page.keyboard.press("Control+s")
      await page.waitForSelector("[data-testid=toast]:has-text('waiting for review')")
      await page.click("[data-testid=toggle-source]")
    })
    await step("the inbox lists the changed diagrams compactly, Approve on top; a click opens one's colored diff; Approve publishes", async () => {
      await page.click("[data-testid=waiting-banner]")
      await page.waitForSelector("[data-testid=diff-row-payments]", { timeout: 15_000 })
      if (await page.locator("[data-testid=diff-system]").count()) throw new Error("with two diagrams changed, no diff should be open at first")
      const approve = await page.locator("[data-testid=inbox-approve]").boundingBox()
      const firstRow = await page.locator("[data-testid=diff-row-system]").boundingBox()
      if (!approve || !firstRow || approve.y > firstRow.y) throw new Error("Approve should sit above the list of diagrams")
      if (shotDir) await page.screenshot({ path: join(shotDir, "inbox-collapsed.png") })
      // on a narrow phone the action bar wraps instead of clipping "Approve all 2" (review of the compact inbox)
      const wide = page.viewportSize()!
      await page.setViewportSize({ width: 360, height: 740 })
      await page.reload()
      await page.waitForSelector("[data-testid=diff-row-payments]", { timeout: 15_000 })
      const box = await page.locator("[data-testid=inbox-approve]").boundingBox()
      if (!box || box.height > 34) throw new Error(`Approve wraps or clips at 360px (height ${box?.height})`)
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("the inbox scrolls sideways at 360px")
      if (shotDir) await page.screenshot({ path: join(shotDir, "inbox-phone.png") })
      await page.setViewportSize(wide)
      await page.reload()
      await page.waitForSelector("[data-testid=diff-row-payments]", { timeout: 15_000 })
      await page.click("[data-testid=diff-toggle-system]")
      await page.waitForSelector("[data-testid=diff-system] .ad-dm-added", { timeout: 15_000 })
      if (shotDir) await page.screenshot({ path: join(shotDir, "inbox-open.png") })
      await page.click("[data-testid=side-before]")
      await page.click("[data-testid=side-after]")
      await page.click("[data-testid=inbox-approve]")
      await page.click("[data-testid=confirm-submit]")
      await page.waitForSelector("text=All caught up")
      if (!sh(origin, "show", "main:.archdraw/system.archdraw").includes("Menu cache")) throw new Error("main does not have the approved change")
    })
    await step("diagram menu: rename, duplicate, delete, then restore from the trash", async () => {
      await page.click("[data-testid=project-origin]")
      await page.waitForSelector("[data-card=payments]")
      await page.hover("[data-testid=file-payments]")
      await page.click("[data-testid=file-menu-payments]")
      await page.click("[role=menuitem]:has-text('Rename')")
      await page.fill("[data-testid=name-input]", "billing")
      await page.click("[data-testid=name-submit]")
      await page.waitForSelector("[data-testid=file-billing]")
      await page.click("[data-testid=file-menu-billing]")
      await page.click("[role=menuitem]:has-text('Duplicate')")
      await page.click("[data-testid=name-submit]")
      await page.waitForSelector("[data-testid=file-billing-copy]")
      await page.click("[data-testid=file-menu-billing-copy]")
      await page.click("[role=menuitem]:has-text('Delete')")
      await page.click("[data-testid=confirm-submit]")
      await page.waitForSelector("[data-testid=file-billing-copy]", { state: "detached" })
      await page.click("[data-testid=open-trash]")
      await page.click("[data-testid=trash-dialog] button:has-text('Restore')")
      await page.keyboard.press("Escape")
      await page.waitForSelector("[data-testid=file-billing-copy]")
    })
    await step("export: the bundle lists ARCHITECTURE.md and downloads as a zip", async () => {
      await page.click("[data-testid=open-export]")
      await page.waitForSelector("[data-testid=export-files]:has-text('ARCHITECTURE.md')")
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-testid=export-zip]")])
      if (!dl.suggestedFilename().endsWith(".zip")) throw new Error(`download is ${dl.suggestedFilename()}`)
      await page.keyboard.press("Escape")
    })
    await step("settings: the sync cadence and a budget are saved", async () => {
      await page.click("[data-testid=open-settings]")
      await page.fill("[data-testid=set-sync]", "30")
      await page.fill("[data-testid=set-project-sync]", "15")
      await page.click("[data-testid=settings-save]")
      await page.waitForSelector("[data-testid=settings-dialog]", { state: "detached" })
      const s = await page.evaluate(async () => (await (await fetch("api/settings")).json()).settings.syncEveryMinutes)
      const own = await page.evaluate(async () => (await (await fetch("api/projects")).json())[0].settings.syncEveryMinutes)
      if (s !== 30 || own !== 15) throw new Error(`settings are ${s} / ${own}`)
    })
    await step("the agent proposes a diagram; it shows beside the original, Accept makes it a waiting change", async () => {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read_diagram", { name: "system" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("propose_diagram", { name: "system", source: WITH_QUEUE, explanation: "## Purpose\n\nOrders and the barista queue." })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("- Added the barista queue (src/orders.ts).")]),
      ])
      await page.click("[data-testid=file-system]")
      await page.click("[data-testid=open-chat]")
      await page.fill("[data-testid=chat-input]", "Add the barista queue")
      await page.click("[data-testid=chat-send]")
      await page.waitForSelector("[data-testid=proposal] [data-testid=accept]:not([disabled])", { timeout: 20_000 })
      await page.click("[data-testid=stage]")
      await page.waitForSelector("[data-card$='~proposed']")
      await page.click("[data-testid=ghost-accept]")
      await page.waitForSelector("[data-testid=toast]:has-text('Accepted')")
      await page.waitForSelector("[data-testid=waiting-banner]")
      if (!sh(origin, "show", "archdraw/update:.archdraw/system.md").includes("barista queue")) throw new Error("the explanation was not saved with the diagram")
    })
    await step("on a phone the menu opens and the inbox reads", async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${server.url}/?phone=1#/inbox`)
      await page.waitForSelector("[data-testid=inbox-origin]")
      await page.click("button[aria-label=Menu]")
      await page.waitForSelector("[data-testid=nav-inbox]")
    })
    if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`)
  } finally {
    await ctx.close()
    await browser.close()
    await server.close()
    console.log(steps.join("\n"))
  }
}

main().then(
  () => console.log("e2e: all passed"),
  e => {
    console.log(`e2e: FAILED — ${String(e.message ?? e).split("\n")[0]}`)
    process.exit(1)
  },
)
