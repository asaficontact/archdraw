import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { Conversations, systemPrompt } from "../src/agent.js"
import { Store } from "../src/config.js"
import { Library } from "../src/library.js"
import { MemoryKeys } from "../src/models.js"
import { Spend } from "../src/spend.js"
import { Jail, makeTools } from "../src/tools.js"

const SYSTEM = '// title: Shop\n\nnode web "Web"\nnode api "API" right of web\nedge web -> api "calls" from: right to: left\n'
const GOOD = SYSTEM + 'node db "DB" right of api\nedge api -> db "SQL" from: right to: left\n'

function setup(responses: ReturnType<typeof fauxAssistantMessage>[], budget = 1) {
  const root = mkdtempSync(join(tmpdir(), "archdraw-agent-"))
  const dir = join(root, "proj")
  mkdirSync(join(dir, ".archdraw"), { recursive: true })
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, ".archdraw", "system.archdraw"), SYSTEM)
  writeFileSync(join(dir, "src", "db.ts"), "export const pool = connect(process.env.DATABASE_URL)\n")
  writeFileSync(join(dir, ".env"), "SECRET=1\n")
  const store = new Store(join(root, "home"))
  store.update(c => {
    c.settings.provider = "faux"
    c.settings.chatModel = "faux-1"
    c.settings.conversationBudgetUsd = budget
  })
  const lib = new Library(store, null)
  lib.addFolder(dir, { slug: "proj" })
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(responses)
  const keys = new MemoryKeys()
  keys.set("faux", "test-key")
  const deps = { store, lib, keys, models, spend: new Spend(store) }
  return { talks: new Conversations(deps), dir, deps }
}

async function settle(c: { events: { type: string }[] }, kind = "settled", ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (c.events.some(e => e.type === kind)) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`no ${kind}: ${c.events.map(e => e.type).join(",")}`)
}

describe("the agent", () => {
  it("reads the code, has a refused proposal fixed, and hands the user a checked proposal", async () => {
    const { talks } = setup([
      fauxAssistantMessage([fauxToolCall("grep", { pattern: "DATABASE_URL" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("propose_diagram", { name: "system", source: 'node a "A" right of nowhere\n' })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("propose_diagram", { name: "system", source: GOOD, explanation: "## Purpose\n\nWhere data lives." })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("- Added the DB (src/db.ts reads DATABASE_URL).")]),
    ])
    const c = talks.open("proj")
    c.say("add the database", "[studio] project proj")
    await settle(c)
    const kinds = c.events.map(e => e.type)
    expect(kinds).toEqual(expect.arrayContaining(["user", "ready", "tool", "fixing", "proposal", "assistant", "settled"]))
    expect(kinds.indexOf("fixing")).toBeLessThan(kinds.indexOf("proposal"))
    const prop = c.events.find(e => e.type === "proposal") as any
    expect(prop.name).toBe("system")
    expect(prop.doc).toContain("Where data lives")
    const grep = c.events.find(e => e.type === "tool") as any
    expect(grep.name).toBe("grep")
  })

  it("knows its project, so it links diagrams without asking for the slug", () => {
    const prompt = systemPrompt({ slug: "banna-dashboard", title: "banna_dashboard" })
    expect(prompt).toContain('url: "#/banna-dashboard/<file>"')
    expect(prompt).toContain("Asked to draw, and the code answers the open points: draw.")
  })

  it("keeps *.env files and secrets/ folders out of read, grep and git_diff (re-review of #2 R1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "archdraw-r1-"))
    const sh = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    sh("init", "-q", "-b", "main")
    writeFileSync(join(root, "app.ts"), "export const ok = 1\n")
    sh("add", "-A")
    sh("commit", "-q", "-m", "one")
    const first = sh("rev-parse", "HEAD").trim()
    mkdirSync(join(root, "config", "secrets"), { recursive: true })
    writeFileSync(join(root, "providers.env"), "OPENAI_API_KEY=sk-hunter2\n")
    writeFileSync(join(root, "app.env.local"), "STRIPE_KEY=sk-hunter2\n")
    writeFileSync(join(root, ".envrc"), "export TOKEN=hunter2\n")
    writeFileSync(join(root, "config", "secrets", "prod.yml"), "password: hunter2\n")
    writeFileSync(join(root, "app.ts"), "export const ok = 2 // hunter2 is not a secret here\n")
    sh("add", "-A")
    sh("commit", "-q", "-m", "two")
    const tools = makeTools({ root, rev: "HEAD", ignore: [], diagrams: async () => [], readDiagram: async () => ({ source: "", doc: null }), skills: {}, onProposal: () => undefined })
    const run = async (name: string, args: object) => {
      const t = tools.find(x => x.name === name)!
      try {
        const r = await t.execute("1", args as never)
        return (r.content as { text: string }[]).map(c => c.text).join("")
      } catch (e) {
        return `refused: ${(e as Error).message}`
      }
    }
    expect(await run("read", { path: "providers.env" })).toMatch(/^refused/)
    expect(await run("read", { path: "config/secrets/prod.yml" })).toMatch(/^refused/)
    expect(await run("read", { path: "app.env.local" })).toMatch(/^refused/)
    expect(await run("read", { path: ".envrc" })).toMatch(/^refused/)
    const found = await run("grep", { pattern: "hunter2" })
    expect(found).toContain("app.ts")
    expect(found).not.toContain("providers.env")
    expect(found).not.toContain("app.env.local")
    expect(found).not.toContain(".envrc")
    expect(found).not.toContain("prod.yml")
    const diff = await run("git_diff", { range: `${first}..HEAD` })
    expect(diff).toContain("app.ts")
    expect(diff).not.toContain("sk-hunter2")
    expect(diff).not.toContain("password")
  })

  it("confines a connected folder to the folder root, but not the app's own clones (third review of #2)", () => {
    const top = mkdtempSync(join(tmpdir(), "archdraw-top-"))
    const clone = mkdtempSync(join(tmpdir(), "archdraw-clone-"))
    const ctx = { root: clone, rev: null, ignore: [], diagrams: async () => [], readDiagram: async () => ({ source: "", doc: null }), skills: {}, onProposal: () => undefined }
    const was = process.env.ARCHDRAW_FOLDER_ROOT
    process.env.ARCHDRAW_FOLDER_ROOT = top
    try {
      expect(() => makeTools(ctx)).not.toThrow()
      expect(() => makeTools({ ...ctx, folder: true })).toThrow(/outside/)
    } finally {
      if (was === undefined) delete process.env.ARCHDRAW_FOLDER_ROOT
      else process.env.ARCHDRAW_FOLDER_ROOT = was
    }
  })

  it("never connects the folder that holds this machine's keys", () => {
    const home = mkdtempSync(join(tmpdir(), "archdraw-sec-"))
    mkdirSync(join(home, "secrets"))
    writeFileSync(join(home, "secrets", "providers.env"), "X=1\n")
    process.env.ARCHDRAW_SECRETS = join(home, "secrets", "providers.env")
    try {
      const lib = new Library(new Store(join(home, "app")), null)
      expect(() => lib.addFolder(join(home, "secrets"))).toThrow(/secrets/)
    } finally {
      delete process.env.ARCHDRAW_SECRETS
    }
  })

  it("never reads secrets or leaves the project", () => {
    const { dir } = setup([])
    const jail = new Jail(dir)
    expect(() => jail.path(".env")).toThrow(/not readable/)
    expect(() => jail.path("../../etc/passwd")).toThrow(/outside/)
    expect(() => jail.path(".git/config")).toThrow()
    expect(jail.path("src/db.ts")).toMatch(/src\/db\.ts$/)
  })

  it("refuses without a key, and keeps conversations across a restart", async () => {
    const { talks, deps } = setup([fauxAssistantMessage([fauxText("hi")])])
    const c = talks.open("proj")
    c.say("hello")
    await settle(c)
    const again = new Conversations(deps)
    expect(again.get(c.id).events.map(e => e.type)).toEqual(c.events.map(e => e.type))
    expect(again.get(c.id).state).toBe("closed")
    const keyless = { ...deps, keys: new MemoryKeys() }
    const k = new Conversations(keyless).open("proj")
    expect(() => k.say("hello")).toThrow(/add your faux key/)
  })
})
