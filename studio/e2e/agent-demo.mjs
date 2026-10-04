// Records the archdraw agent end to end, for choosing between the two ways of holding it (?v=dock, ?v=sheet), and
// fails when a step does not happen, so it is also the UI check for the agent.
//
//   PLAYWRIGHT_CORE=<path to playwright-core> PLAYWRIGHT_BROWSERS_PATH=<browsers> \
//     node studio/e2e/agent-demo.mjs --base http://127.0.0.1:8091 --out <dir> [--variant dock|sheet] [--device desktop|phone]
//
// It talks to the real agent (a few cents a run) and accepts what it proposes, so point it at a studio whose library
// is a scratch copy (ARCHDRAW_LIBRARY), never at the brain.

import { createRequire } from "node:module"
import { mkdirSync, renameSync } from "node:fs"
import path from "node:path"

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core")

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : dflt
}
const base = arg("base", "http://127.0.0.1:8091")
const out = arg("out", "agent-demo")
const variants = arg("variant") ? [arg("variant")] : ["dock", "sheet"]
const devices = arg("device") ? [arg("device")] : ["desktop", "phone"]
const ASK = "Add a retry for failed hero images: a Convex cron with backoff that re-dispatches the illustration. Propose the updated file."

const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
}

const pause = ms => new Promise(r => setTimeout(r, ms))

async function run(variant, device) {
  const dir = path.join(out, `${variant}-${device}`)
  mkdirSync(dir, { recursive: true })
  const browser = await chromium.launch()
  const vp = DEVICES[device].viewport
  const ctx = await browser.newContext({ ...DEVICES[device], recordVideo: { dir, size: vp } })
  const page = await ctx.newPage()
  page.on("dialog", d => d.accept())
  const steps = []
  const step = async (name, fn) => {
    const t0 = Date.now()
    await fn()
    steps.push(`${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
  }
  try {
    await step("open the system diagram", async () => {
      await page.goto(`${base}/?v=${variant}#/ohara/system`)
      await page.waitForSelector("[data-card=system]")
      await pause(1500)
    })
    if (device === "desktop") {
      await step("⌘K jumps by name", async () => {
        await page.keyboard.press("Control+k")
        await page.waitForSelector("[data-testid=palette-input]:focus")
        await page.keyboard.type("data mod", { delay: 90 })
        await pause(700)
        await page.keyboard.press("Enter")
        await page.waitForURL(/#\/ohara\/data-model/)
        await pause(1600)
        await page.keyboard.press("Control+k")
        await page.waitForSelector("[data-testid=palette-input]:focus")
        await page.keyboard.type("system", { delay: 90 })
        await pause(500)
        await page.keyboard.press("Enter")
        await page.waitForURL(/#\/ohara\/system$/)
        await pause(1400)
      })
      await step("⌘K asks the agent", async () => {
        await page.keyboard.press("Control+k")
        await page.waitForSelector("[data-testid=palette-input]:focus")
        await page.keyboard.type(ASK, { delay: 25 })
        await pause(600)
        await page.keyboard.press("Enter")
        await page.waitForSelector("[data-testid=chat]")
      })
    } else {
      await step("Ask opens the agent", async () => {
        await page.tap("[data-testid=open-chat]")
        await page.waitForSelector("[data-testid=chat-input]")
        await page.fill("[data-testid=chat-input]", ASK)
        await pause(600)
        await page.tap("[data-testid=chat-send]")
      })
    }
    await step("the agent answers with a checked proposal", async () => {
      await page.waitForSelector("[data-testid=proposal] [data-testid=accept]:not([disabled])", { timeout: 180_000 })
      await page.waitForSelector("[data-testid=chat-send]", { timeout: 60_000 }) // settled: Send is back
      await pause(1800)
    })
    const tap = sel => (device === "phone" ? page.tap(sel) : page.click(sel))
    if (variant === "dock" && device === "desktop") {
      await step("the diff", async () => {
        await page.click("[data-testid=proposal] >> text=Diff")
        await page.waitForSelector("[data-testid=diff]")
        await pause(2200)
        await page.click("[data-testid=proposal] >> text=Hide diff")
      })
    }
    await step("the proposal on the canvas", async () => {
      await tap("[data-testid=stage]")
      await page.waitForSelector(variant === "dock" ? "[data-card$='~proposed']" : "[data-testid=bar-accept]")
      await pause(2600)
    })
    await step("Accept saves it", async () => {
      await tap(variant === "dock" ? "[data-testid=ghost-accept]" : "[data-testid=bar-accept]")
      await page.waitForSelector("text=/Accepted/")
      await pause(2200)
    })
    console.log(`${variant}-${device}: ok\n  ${steps.join("\n  ")}`)
  } catch (e) {
    await page.screenshot({ path: path.join(dir, "failed.png") })
    console.log(`${variant}-${device}: FAILED after ${steps.length} steps: ${e.message.split("\n")[0]}\n  ${steps.join("\n  ")}`)
    process.exitCode = 1
  } finally {
    const video = page.video()
    await ctx.close()
    await browser.close()
    if (video) renameSync(await video.path(), path.join(out, `${variant}-${device}.webm`))
  }
}

for (const v of variants) for (const d of devices) await run(v, d)
