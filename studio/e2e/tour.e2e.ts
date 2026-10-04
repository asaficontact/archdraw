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
  page.on("dialog", d => void d.accept())
  const errors: string[] = []
  page.on("pageerror", e => errors.push(String(e)))
  const at = async (n: number) => page.waitForSelector(`[data-testid=tour-card][data-step="${n}"]`, { timeout: 15_000 })
  await step("1 · the start screen: open your code, or just try the sample", async () => {
    await page.goto(s1.url)
    await page.waitForSelector("[data-testid=start-input]")
    await page.waitForTimeout(600)
    await page.click("[data-testid=start-sample]")
    await at(2)
    await page.waitForSelector("[data-card=overview] svg")
  })
  await step("2 · fly into a card, then drill down through a link", async () => {
    await page.waitForTimeout(900)
    await page.dblclick("[data-card=overview] header")
    await page.waitForTimeout(900)
    await page.click('[data-card=overview] a[href="#/bean-there/payments"]')
    await at(3)
  })
  await step("3 · the diagram is just text: an edit redraws it", async () => {
    await page.waitForTimeout(600)
    await page.click("[data-testid=toggle-source]")
    await page.click("[data-testid=source]")
    await page.keyboard.press("Control+End")
    await page.keyboard.type("\n// my first edit\n", { delay: 30 })
    await at(4)
    await page.click("[data-testid=toggle-source]")
  })
  await step("4 · ask for a change; the scripted, labelled proposal is accepted", async () => {
    await page.waitForTimeout(500)
    await page.click("[data-testid=file-overview]")
    await page.click("[data-testid=open-chat]")
    await page.fill("[data-testid=chat-input]", "Add a loyalty program")
    await page.waitForTimeout(400)
    await page.click("[data-testid=chat-send]")
    await page.waitForSelector("[data-testid=proposal] [data-testid=accept]:not([disabled])", { timeout: 20_000 })
    if (!(await page.textContent("[data-testid=chat-log]"))?.includes("no AI used")) throw new Error("the demo reply is not labelled")
    await page.waitForTimeout(1200)
    await page.click("[data-testid=stage]")
    await page.waitForSelector("[data-card$='~proposed']")
    await page.waitForTimeout(1500)
    await page.click("[data-testid=ghost-accept]")
    await at(5)
  })
  await step("5 · the inbox: the colored diff, approved", async () => {
    await page.click("[data-testid=nav-inbox]")
    await page.waitForSelector("[data-testid=diff-overview] .ad-dm-added", { timeout: 15_000 })
    await page.waitForTimeout(1800)
    await page.click("[data-testid=inbox-approve]")
    await page.click("[data-testid=confirm-submit]")
    await at(6)
  })
  await step("6 · export for a coding agent, then the finish card", async () => {
    await page.click("[data-testid=project-bean-there]")
    await page.waitForSelector("[data-testid=open-export]")
    await page.click("[data-testid=open-export]")
    await page.waitForSelector("[data-testid=export-files]:has-text('ARCHITECTURE.md')")
    await page.waitForTimeout(1200)
    await page.keyboard.press("Escape")
    await page.waitForSelector("[data-testid=tour-finish]", { timeout: 10_000 })
    await page.waitForTimeout(800)
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
