// The first run end to end: a new user on an empty app takes the tour on the sample, doing each step for real, and
// finishes; then the same thing on a phone; and an existing user is offered the tour once, never pushed into it.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MemoryKeys } from "../core/src/models.js"
import { start } from "../server/src/main.js"

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core") as typeof import("playwright-core")
const here = dirname(fileURLToPath(import.meta.url))
const videoDir = process.argv.includes("--video") ? process.argv[process.argv.indexOf("--video") + 1] : null
const shotDir = process.argv.includes("--shot") ? process.argv[process.argv.indexOf("--shot") + 1] : null
const steps: string[] = []
let failShot: ((file: string) => Promise<unknown>) | null = null
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    steps.push(`ok   ${name}`)
  } catch (e) {
    const file = join(tmpdir(), `archdraw-tour-fail-${Date.now()}.png`)
    await failShot?.(file).catch(() => undefined)
    steps.push(`FAIL ${name}: ${String((e as Error).message).split("\n")[0]} (screenshot ${file})`)
    throw e
  }
}

async function server(config?: object) {
  const home = mkdtempSync(join(tmpdir(), "archdraw-tour-"))
  if (config) writeFileSync(join(home, "config.json"), JSON.stringify(config))
  return start({ home, port: 0, gate: { mode: "local" }, keys: new MemoryKeys(), ui: resolve(here, "../ui/dist"), sync: false, log: () => undefined })
}

const browser = await chromium.launch()
try {
  // -- a new user, desktop ---------------------------------------------------------------------------------------
  const s1 = await server()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } } : {}) })
  const page = await ctx.newPage()
  failShot = file => page.screenshot({ path: file })
  page.on("dialog", d => void d.accept())
  const errors: string[] = []
  page.on("pageerror", e => errors.push(String(e)))
  const at = async (n: number) => {
    await page.waitForSelector(`[data-testid=tour-card][data-step="${n}"]`, { timeout: 15_000 })
    if (shotDir) await page.waitForTimeout(700).then(() => page.screenshot({ path: join(shotDir, `step-${n}.png`) }))
  }
  await step("1 · the start screen: open your code, or just try the sample", async () => {
    await page.goto(s1.url)
    await page.waitForSelector("[data-testid=start-input]")
    await page.waitForTimeout(600)
    await page.click("[data-testid=start-sample]")
    await at(2)
    await page.waitForSelector("[data-card=overview] svg")
  })
  await step("2 · fly into the ringed card, then drill down through its Payments link", async () => {
    await page.waitForTimeout(900)
    if (!(await page.textContent("[data-testid=tour-card]"))?.includes("ringed card")) throw new Error("step 2 should point at the ringed card, not a name the card does not show")
    await page.dblclick("[data-card=overview] header")
    await page.waitForTimeout(900)
    await page.click('[data-card=overview] a[href="#/bean-there/payments"]')
    await at(3)
  })
  // the ring sits on the control the step asks for, and that control is on screen: nobody hunts for it (Tawab, 10-04)
  const ringOn = async (selector: string) => {
    await page.waitForFunction(
      sel => {
        const ring = document.querySelector("[data-testid=tour-ring]") as HTMLElement | null
        const el = document.querySelector(sel)
        if (!ring || !el || ring.style.display === "none") return false
        const a = ring.getBoundingClientRect()
        const b = el.getBoundingClientRect()
        return b.width > 0 && Math.abs(a.left + 6 - b.left) < 3 && Math.abs(a.top + 6 - b.top) < 3
      },
      selector,
      { timeout: 10_000 },
    )
  }
  await step("3 · the step opens Payments' text itself; an edit redraws the card; Save completes it", async () => {
    await page.waitForSelector("[data-testid=editor] [data-testid=source]")
    await ringOn("[data-testid=source]")
    if (!(await page.textContent("[data-testid=tour-card]"))?.includes("Receipts")) throw new Error("step 3 should name a word that is in the text")
    const ta = page.locator("[data-testid=source]")
    const before = await ta.inputValue()
    await ta.fill(before.replace('"Receipts"', '"Email receipts"'))
    await page.waitForFunction(() => document.querySelector("[data-card=payments]")?.textContent?.includes("Email receipts"))
    await ringOn("[data-testid=save]")
    await page.click("[data-testid=save]")
    await at(4)
  })
  await step("4 · the step opens the chat with the request typed; Send, then Accept the scripted, labelled proposal", async () => {
    await page.waitForFunction(() => (document.querySelector("[data-testid=chat-input]") as HTMLTextAreaElement | null)?.value === "Add a loyalty program")
    if (await page.locator("[data-testid=editor]").count()) throw new Error("the source panel should close for the chat")
    await ringOn("[data-testid=chat-send]")
    await page.click("[data-testid=chat-send]")
    await page.waitForSelector("[data-testid=proposal] [data-testid=accept]:not([disabled])", { timeout: 20_000 })
    if (!(await page.textContent("[data-testid=chat-log]"))?.includes("no AI used")) throw new Error("the demo reply is not labelled")
    await ringOn("[data-testid=proposal] [data-testid=accept]")
    await page.click("[data-testid=proposal] [data-testid=accept]")
    await at(5)
  })
  await step("5 · the step opens the Inbox on the update; a click shows the colored diff; Approve", async () => {
    await page.waitForSelector("[data-testid=inbox-approve]", { timeout: 15_000 })
    await ringOn("[data-testid=inbox-approve]")
    await page.click("[data-testid=diff-toggle-overview]")
    await page.waitForSelector("[data-testid=diff-overview] .ad-dm-added", { timeout: 15_000 })
    await page.click("[data-testid=inbox-approve]")
    await page.click("[data-testid=confirm-submit]")
    await at(6)
  })
  await step("6 · the step returns to the canvas with Export ringed; export, then the finish card", async () => {
    await ringOn("[data-testid=open-export]")
    await page.click("[data-testid=open-export]")
    await page.waitForSelector("[data-testid=export-files]:has-text('ARCHITECTURE.md')")
    await page.keyboard.press("Escape")
    await page.waitForSelector("[data-testid=tour-finish]", { timeout: 10_000 })
    await page.click("[data-testid=tour-keep]")
    await page.waitForSelector("[data-testid=tour-finish]", { state: "detached" })
    const o = await page.evaluate(async () => (await (await fetch("api/settings")).json()).onboarding)
    if (o.status !== "done") throw new Error(`tour state ${JSON.stringify(o)}`)
  })
  if (errors.length) throw new Error(errors.join(" | "))
  await ctx.close()
  await s1.close()

  // -- a new user on a phone ---------------------------------------------------------------------------------------
  const s2 = await server()
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await step("phone · the tour runs as a bottom sheet; text-only steps say Got it", async () => {
    await phone.goto(s2.url)
    await phone.tap("[data-testid=start-sample]")
    await phone.waitForSelector(".ad-tour-sheet[data-step='2']")
    await phone.evaluate(() => window.dispatchEvent(new CustomEvent("archdraw:ev", { detail: "drilled" })))
    await phone.waitForSelector(".ad-tour-sheet[data-step='3']", { timeout: 5000 })
    await phone.tap(".ad-tour-sheet button:has-text('Got it')")
    await phone.waitForSelector(".ad-tour-sheet[data-step='4']")
  })
  await phone.close()
  await s2.close()

  // -- an existing user is offered the tour once ---------------------------------------------------------------------
  const s3 = await server({ version: 1, projects: [], settings: {}, onboarding: { status: "new", step: 0 } })
  const p3 = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await step("existing user · a chip offers the tour once; ✕ removes it for good", async () => {
    await p3.goto(s3.url)
    await p3.click("[data-testid=start-sample]").catch(() => undefined) // makes the app non-empty without starting a tour on the next load
    await p3.evaluate(async () => fetch("api/onboarding", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "new", step: 0, chipDismissed: false }) }))
    await p3.goto(s3.url + "/?again=1")
    await p3.waitForSelector("[data-testid=tour-chip]")
    if (await p3.$("[data-testid=tour-card]")) throw new Error("the tour started by itself")
    await p3.click("[data-testid=tour-chip] button[aria-label=Dismiss]")
    await p3.goto(s3.url + "/?again=2")
    await p3.waitForSelector("[data-testid=nav-inbox]")
    await p3.waitForTimeout(800)
    if (await p3.$("[data-testid=tour-chip]")) throw new Error("the chip came back after ✕")
  })
  await p3.close()
  await s3.close()
} finally {
  await browser.close()
  console.log(steps.join("\n"))
}
console.log(steps.every(s => s.startsWith("ok")) ? "tour e2e: all passed" : "tour e2e: FAILED")
if (!steps.every(s => s.startsWith("ok"))) process.exit(1)
