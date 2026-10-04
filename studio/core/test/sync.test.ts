import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { Store } from "../src/config.js"
import { Library } from "../src/library.js"
import { MemoryKeys } from "../src/models.js"
import { Spend } from "../src/spend.js"
import { Syncer } from "../src/sync.js"

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env })
const SYSTEM = '// title: Shop\n\nnode web "Web"\nnode api "API" right of web\nedge web -> api "calls" from: right to: left\n'
const WITH_QUEUE = SYSTEM + 'node queue "Jobs queue" right of api\nedge api -> queue "enqueue" from: right to: left\n'

function world() {
  const root = mkdtempSync(join(tmpdir(), "archdraw-sync-"))
  const seed = join(root, "seed")
  mkdirSync(join(seed, ".archdraw"), { recursive: true })
  mkdirSync(join(seed, "src"))
  sh(seed, "init", "-q", "-b", "main")
  writeFileSync(join(seed, ".archdraw", "system.archdraw"), SYSTEM)
  writeFileSync(join(seed, "src", "api.ts"), "export const api = 1\n")
  sh(seed, "add", "-A")
  sh(seed, "commit", "-q", "-m", "seed")
  const origin = join(root, "origin.git")
  sh(root, "clone", "-q", "--bare", seed, origin)
  sh(seed, "remote", "add", "o", origin)
  const push = (file: string, body: string, msg: string) => {
    writeFileSync(join(seed, file), body)
    sh(seed, "add", "-A")
    sh(seed, "commit", "-q", "-m", msg)
    sh(seed, "push", "-q", "o", "main")
  }
  const store = new Store(join(root, "home"))
  store.update(c => {
    c.settings.provider = "faux"
    c.settings.chatModel = "faux-1"
    c.settings.triageModel = "faux-1"
  })
  const lib = new Library(store, null, "test")
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const keys = new MemoryKeys()
  keys.set("faux", "k")
  const syncer = new Syncer({ store, lib, keys, models, spend: new Spend(store) })
  return { origin, push, lib, faux, syncer, store }
}

describe("the sync", () => {
  it("does nothing when main has not moved, triages new commits, and drafts only an architecture change", async () => {
    const w = world()
    await w.lib.addRepo(w.origin, { slug: "shop" })
    expect(await w.syncer.sync("shop")).toMatchObject({ outcome: "unchanged" }) // connecting starts tracking at the head

    w.push("README.md", "# shop\n", "docs: readme")
    w.faux.setResponses([fauxAssistantMessage([fauxText('{"changed": false, "why": "only docs", "touches": []}')])])
    expect(await w.syncer.sync("shop")).toMatchObject({ outcome: "no-architecture-change", commits: 1 })

    w.push("src/queue.ts", "export const queue = new Queue('jobs')\n", "feat: jobs queue")
    w.faux.setResponses([
      fauxAssistantMessage([fauxText('{"changed": true, "why": "a jobs queue was added", "touches": ["system"]}')]),
      fauxAssistantMessage([fauxToolCall("read_diagram", { name: "system" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("propose_diagram", { name: "system", source: WITH_QUEUE, explanation: "## Purpose\n\nThe shop." })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Added the jobs queue.")]),
    ])
    const r = await w.syncer.sync("shop")
    expect(r).toMatchObject({ outcome: "drafted", files: ["system"], headline: "a jobs queue was added" })
    expect(sh(w.origin, "show", "main:.archdraw/system.archdraw")).toBe(SYSTEM) // main is untouched until approval
    expect(sh(w.origin, "show", "archdraw/update:.archdraw/system.archdraw")).toBe(WITH_QUEUE)
    expect(sh(w.origin, "log", "-1", "--format=%B", "archdraw/update")).toMatch(/Archdraw-Base: [0-9a-f]{40}/)
    expect((await w.lib.pending("shop"))!.files).toEqual([{ name: "system", status: "changed" }])

    // nothing new: no model call (an empty response queue would fail if one were made)
    w.faux.setResponses([])
    expect(await w.syncer.sync("shop")).toMatchObject({ outcome: "unchanged" })
  })

  it("a second device sees the update already covers main and does not draft again", async () => {
    const w = world()
    await w.lib.addRepo(w.origin, { slug: "shop" })
    w.push("src/queue.ts", "export const queue = 1\n", "feat: queue")
    w.faux.setResponses([
      fauxAssistantMessage([fauxText('{"changed": true, "why": "queue", "touches": ["system"]}')]),
      fauxAssistantMessage([fauxToolCall("propose_diagram", { name: "system", source: WITH_QUEUE })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ])
    await w.syncer.sync("shop")
    // device B: its own home, connected before the queue commit, so it has the same commits to check
    const storeB = new Store(join(w.store.home, "..", "home-b"))
    storeB.update(c => {
      c.settings = { ...w.store.read().settings }
    })
    const libB = new Library(storeB, null, "test")
    await libB.addRepo(w.origin, { slug: "shop" })
    storeB.update(c => {
      c.projects[0].checkedThrough = undefined
    })
    w.faux.setResponses([])
    const b = new Syncer({ store: storeB, lib: libB, keys: (w.syncer as any).d.keys, models: (w.syncer as any).d.models, spend: new Spend(storeB) })
    expect(await b.sync("shop")).toMatchObject({ outcome: "unchanged" })
  })

  it("a draft that cannot be pushed is recorded once; the hourly check waits instead of spending again", async () => {
    const w = world()
    await w.lib.addRepo(w.origin, { slug: "shop" })
    w.push("src/queue.ts", "export const queue = 1\n", "feat: queue")
    writeFileSync(join(w.origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'Permission denied' >&2\nexit 1\n", { mode: 0o755 })
    w.faux.setResponses([
      fauxAssistantMessage([fauxText('{"changed": true, "why": "queue", "touches": ["system"]}')]),
      fauxAssistantMessage([fauxToolCall("propose_diagram", { name: "system", source: WITH_QUEUE })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ])
    const r = await w.syncer.sync("shop")
    expect(r).toMatchObject({ outcome: "failed" })
    expect((r as { reason: string }).reason).toMatch(/refused the push|cannot push/)
    w.faux.setResponses([]) // a second automatic tick must not call the model at all
    expect(await w.syncer.sync("shop")).toMatchObject({ outcome: "skipped", reason: expect.stringMatching(/^waiting:/) })
  })
})
