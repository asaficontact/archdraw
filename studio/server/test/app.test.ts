import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { Conversations } from "../../core/src/agent.js"
import { Store } from "../../core/src/config.js"
import { Library } from "../../core/src/library.js"
import { MemoryKeys } from "../../core/src/models.js"
import { Spend } from "../../core/src/spend.js"
import { Syncer } from "../../core/src/sync.js"
import { createApp } from "../src/app.js"

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env })
const SYSTEM = '// title: Shop\n// summary: Orders.\n\nnode web "Web"\nnode api "API" right of web\nedge web -> api "calls" from: right to: left\n'
const TOKEN = "t0k3n"

function world() {
  const root = mkdtempSync(join(tmpdir(), "archdraw-app-"))
  const seed = join(root, "seed")
  mkdirSync(join(seed, ".archdraw"), { recursive: true })
  sh(seed, "init", "-q", "-b", "main")
  writeFileSync(join(seed, ".archdraw", "system.archdraw"), SYSTEM)
  sh(seed, "add", "-A")
  sh(seed, "commit", "-q", "-m", "seed")
  const origin = join(root, "origin.git")
  sh(root, "clone", "-q", "--bare", seed, origin)
  const store = new Store(join(root, "home"))
  store.update(c => {
    c.settings.provider = "faux"
    c.settings.chatModel = "faux-1"
    c.settings.publish = "direct"
  })
  const lib = new Library(store, null, "test")
  const keys = new MemoryKeys()
  keys.set("faux", "k")
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const spend = new Spend(store)
  const talks = new Conversations({ store, lib, keys, models, spend })
  const syncer = new Syncer({ store, lib, keys, models, spend })
  const app = createApp({ store, lib, talks, syncer, keys, spend, gate: { mode: "token", token: TOKEN } })
  const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers: Record<string, string> = { host: "127.0.0.1:9999", cookie: `archdraw=${TOKEN}`, ...(init.headers as Record<string, string>) }
    if (init.json !== undefined) headers["content-type"] = "application/json"
    return app.request(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
  }
  return { origin, root, call, faux, app }
}

describe("the gate", () => {
  it("refuses a request without the session, from another host, or a cross-origin write; sends the CSP", async () => {
    const w = world()
    expect((await w.app.request("/api/projects", { headers: { host: "127.0.0.1:9" } })).status).toBe(403)
    expect((await w.app.request("/api/projects", { headers: { host: "evil.example", cookie: `archdraw=${TOKEN}` } })).status).toBe(403)
    const ok = await w.call("/api/projects")
    expect(ok.status).toBe(200)
    expect(ok.headers.get("content-security-policy")).toContain("script-src 'self'")
    const cross = await w.call("/api/settings", { method: "PUT", json: { theme: "dark" }, headers: { origin: "https://evil.example" } })
    expect(cross.status).toBe(403)
    // the token in the URL sets the cookie (how the desktop window opens)
    const first = await w.app.request(`/?token=${TOKEN}`, { headers: { host: "127.0.0.1:9" } })
    expect(first.headers.get("set-cookie")).toContain(`archdraw=${TOKEN}`)
  })
})

describe("the API", () => {
  it("connects a repo, edits, renames, diffs, publishes from the inbox and exports", async () => {
    const w = world()
    const p = await (await w.call("/api/projects", { method: "POST", json: { repo: w.origin, slug: "shop" } })).json()
    expect(p.slug).toBe("shop")
    const files = await (await w.call("/api/projects/shop/files")).json()
    expect(files.map((f: { name: string }) => f.name)).toEqual(["system"])
    const doc = await (await w.call("/api/projects/shop/files/system")).json()
    const edited = SYSTEM + 'node db "DB" right of api\nedge api -> db "SQL" from: right to: left\n'
    const saved = await w.call("/api/projects/shop/files/system", { method: "PUT", json: { source: edited, base: doc.version } })
    expect(saved.status).toBe(200)
    const bad = await w.call("/api/projects/shop/files/system", { method: "PUT", json: { source: 'node a "A" below nowhere\n', base: (await saved.json()).version } })
    expect(bad.status).toBe(422)
    const d = await (await w.call("/api/projects/shop/files/system/diff")).json()
    expect(d.diff.changes.map((c: { kind: string; id: string }) => `${c.kind} ${c.id}`)).toEqual(expect.arrayContaining(["added db", "added api->db:SQL"]))
    const inbox = await (await w.call("/api/inbox")).json()
    expect(inbox[0]).toMatchObject({ project: "shop", pending: { files: [{ name: "system", status: "changed" }] } })
    expect((await w.call("/api/projects/shop/approve", { method: "POST" })).status).toBe(200)
    expect(sh(w.origin, "show", "main:.archdraw/system.archdraw")).toBe(edited)
    expect((await (await w.call("/api/inbox")).json())[0].pending).toBeNull()

    expect((await w.call("/api/projects/shop/files/system/rename", { method: "POST", json: { to: "overview" } })).status).toBe(200)
    expect((await w.call("/api/projects/shop/files/overview/duplicate", { method: "POST", json: { to: "copy" } })).status).toBe(200)
    expect((await w.call("/api/projects/shop/files/copy", { method: "DELETE" })).status).toBe(200)
    expect((await (await w.call("/api/projects/shop/trash")).json()).map((t: { name: string }) => t.name)).toEqual(["copy"])

    const z = await w.call("/api/projects/shop/export?at=head")
    expect(z.headers.get("content-type")).toBe("application/zip")
    const names = Object.keys(unzipSync(new Uint8Array(await z.arrayBuffer())))
    expect(names.some(n => n.endsWith("/ARCHITECTURE.md"))).toBe(true)
    expect(names.some(n => n.endsWith("/diagrams/overview/overview.md"))).toBe(true)
  })

  it("saves settings, hides keys, and talks to the agent over the long poll", async () => {
    const w = world()
    await w.call("/api/projects", { method: "POST", json: { repo: w.origin, slug: "shop" } })
    const s = await (await w.call("/api/settings", { method: "PUT", json: { syncEveryMinutes: 30, projectDayBudgetUsd: 2 } })).json()
    expect(s.settings).toMatchObject({ syncEveryMinutes: 30, projectDayBudgetUsd: 2 })
    expect((await w.call("/api/settings", { method: "PUT", json: { dayBudgetUsd: -1 } })).status).toBe(400)
    const got = await (await w.call("/api/settings")).json()
    expect(got.keys.openai).toBe(false)
    expect(JSON.stringify(got)).not.toContain('"k"')
    w.faux.setResponses([fauxAssistantMessage([fauxText("It is a shop.")])])
    const talk = await (await w.call("/api/agent/conversations", { method: "POST", json: { project: "shop" } })).json()
    await w.call(`/api/agent/conversations/${talk.id}/messages`, { method: "POST", json: { text: "what is this?", file: "system" } })
    let items: { type: string; text?: string }[] = []
    for (let i = 0; i < 20 && !items.some(e => e.type === "settled"); i++) items = (await (await w.call(`/api/agent/conversations/${talk.id}?after=-1&wait=1`)).json()).items
    expect(items.find(e => e.type === "assistant")?.text).toBe("It is a shop.")
  })
})
