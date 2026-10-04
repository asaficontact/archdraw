// The archdraw server: the core's operations over HTTP for the React UI. The same app runs headless on trex (behind
// Tailscale Serve) and inside the Electron shell (on 127.0.0.1 with a per-launch token), so the UI has one API.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Hono, type Context } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { serveStatic } from "@hono/node-server/serve-static"
import type { Conversations } from "../../core/src/agent.js"
import { AppError, checkSlug, DIAGRAM_DIR, type Settings, type Store } from "../../core/src/config.js"
import { bundle, zip } from "../../core/src/export.js"
import { diff, graph } from "../../core/src/graph.js"
import type { Library } from "../../core/src/library.js"
import { type KeyStore, PROVIDERS, providerOfKey } from "../../core/src/models.js"
import type { Spend } from "../../core/src/spend.js"
import type { Syncer } from "../../core/src/sync.js"
import { decide, type Gate, sameOrigin } from "./identity.js"

export type Deps = { store: Store; lib: Library; talks: Conversations; syncer: Syncer; keys: KeyStore; spend: Spend; gate: Gate; ui?: string; serverPort?: () => number; log?: (s: string) => void }

// The page runs only its own bundle (review of archdraw#1, H1): a diagram that slipped markup past the sanitizer still
// cannot run script, load a frame or post a form elsewhere.
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

const SETTABLE: (keyof Settings)[] = ["provider", "chatModel", "triageModel", "syncEveryMinutes", "dayBudgetUsd", "projectDayBudgetUsd", "conversationBudgetUsd", "publish", "ignore", "theme"]

export type AppEnv = { Variables: { who: string } }

export function createApp(d: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url)
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string; remotePort?: number; localPort?: number } } } | undefined
    const sock = env?.incoming?.socket
    const peer = { address: (sock?.remoteAddress ?? "").replace(/^::ffff:/, ""), port: sock?.remotePort ?? 0, serverPort: sock?.localPort ?? d.serverPort?.() ?? 0 }
    const verdict = await decide(d.gate, url.pathname, { get: (n: string) => c.req.header(n) }, peer, getCookie(c, "archdraw"), url.searchParams.get("token"))
    if (!verdict.ok) {
      d.log?.(`refused ${c.req.method} ${url.pathname}: ${verdict.reason}`)
      return c.json({ detail: `refused: ${verdict.reason}` }, 403)
    }
    if (d.gate.mode === "token" && url.searchParams.get("token") === d.gate.token) {
      setCookie(c, "archdraw", d.gate.token, { httpOnly: true, sameSite: "Strict", path: "/" })
      if (c.req.method === "GET" && !url.pathname.startsWith("/api/")) return c.redirect(url.pathname + url.hash, 302)
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !sameOrigin({ get: (n: string) => c.req.header(n) })) return c.json({ detail: "refused: cross-origin write" }, 403)
    c.set("who", verdict.who)
    await next()
    c.header("Content-Security-Policy", CSP)
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Referrer-Policy", "no-referrer")
  })

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ detail: err.message }, err.status as 400)
    d.log?.(`error ${c.req.method} ${c.req.path}: ${err.stack ?? err}`)
    return c.json({ detail: `the server failed: ${String(err.message ?? err).slice(0, 300)}` }, 500)
  })

  const body = async <T>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T
    } catch {
      throw new AppError(400, "the request body is not JSON")
    }
  }
  const slugOf = (c: Context) => checkSlug(c.req.param("p")!, "project")
  const nameOf = (c: Context) => checkSlug(c.req.param("name")!, "diagram name")

  // -- health, settings, keys --------------------------------------------------------------------------------------

  app.get("/api/health", c => c.json({ ok: true, projects: d.store.read().projects.length, mode: d.gate.mode }))

  app.get("/api/settings", c => {
    const cfg = d.store.read()
    const keys = Object.fromEntries(Object.keys(PROVIDERS).map(p => [p, d.keys.has(p)]))
    return c.json({ settings: cfg.settings, keys, keysEditable: !!d.keys.set, providers: PROVIDERS, onboarded: cfg.onboarded ?? false, spentToday: d.spend.day() })
  })

  app.put("/api/settings", async c => {
    const patch = await body<Partial<Settings> & { onboarded?: boolean }>(c)
    const next = d.store.update(cfg => {
      for (const k of SETTABLE) if (k in patch) (cfg.settings as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k]
      if (typeof patch.onboarded === "boolean") cfg.onboarded = patch.onboarded
      const s = cfg.settings
      for (const k of ["syncEveryMinutes", "dayBudgetUsd", "projectDayBudgetUsd", "conversationBudgetUsd"] as const) if (!(Number(s[k]) >= 0)) throw new AppError(400, `${k} must be a number ≥ 0`)
      if (!["pull-request", "direct"].includes(s.publish)) throw new AppError(400, "publish is pull-request or direct")
    })
    return c.json({ settings: next.settings, onboarded: next.onboarded ?? false })
  })

  app.put("/api/keys", async c => {
    const { provider, key } = await body<{ provider?: string; key: string }>(c)
    if (!d.keys.set) throw new AppError(409, "keys on this machine are read from its secrets file, not set here")
    const p = provider || providerOfKey(key)
    if (!p || !(p in PROVIDERS)) throw new AppError(400, "which provider is this key for?")
    if (!key || key.trim().length < 20) throw new AppError(400, "that does not look like a whole key")
    d.keys.set(p, key.trim())
    d.store.update(cfg => {
      cfg.settings.provider = p
    })
    return c.json({ provider: p, ok: true })
  })

  // -- projects ----------------------------------------------------------------------------------------------------

  app.get("/api/projects", async c => {
    const out = []
    for (const p of d.store.read().projects) {
      let files = 0
      let updated = p.addedAt / 1000
      let pending = false
      try {
        const rows = await d.lib.files(p.slug)
        files = rows.length
        updated = Math.max(updated, ...rows.map(r => r.updated))
        pending = !!(await d.lib.revisions(p.slug)).head // a local lookup; the inbox asks GitHub about the PR
      } catch {
        /* a broken clone shows as empty */
      }
      out.push({ slug: p.slug, title: p.title, files, updated, pending, archived: !!p.archived, source: p.source, settings: p.settings ?? {}, checkedThrough: p.checkedThrough ?? null })
    }
    return c.json(out)
  })

  app.post("/api/projects", async c => {
    const b = await body<{ repo?: string; folder?: string; title?: string; slug?: string }>(c)
    const p = b.repo ? await d.lib.addRepo(b.repo, { title: b.title, slug: b.slug }) : b.folder ? d.lib.addFolder(b.folder, { title: b.title, slug: b.slug }) : null
    if (!p) throw new AppError(400, "give a GitHub repo (owner/name or URL) or a local folder")
    return c.json(p)
  })

  app.patch("/api/projects/:p", async c => {
    const b = await body<{ title?: string; archived?: boolean; settings?: Record<string, unknown> }>(c)
    return c.json(d.lib.setProject(slugOf(c), b as never))
  })

  app.delete("/api/projects/:p", async c => {
    await d.lib.disconnect(slugOf(c))
    return c.json({ ok: true })
  })

  app.post("/api/projects/:p/refresh", async c => {
    await d.lib.refresh(slugOf(c))
    return c.json({ ok: true })
  })

  // -- diagrams ----------------------------------------------------------------------------------------------------

  app.get("/api/projects/:p/files", async c => c.json(await d.lib.files(slugOf(c))))

  app.get("/api/projects/:p/files/:name", async c => c.json(await d.lib.read(slugOf(c), nameOf(c), c.req.query("at") === "base" ? "base" : "head")))

  app.put("/api/projects/:p/files/:name", async c => {
    const b = await body<{ source: string; base: string | null; doc?: string | null }>(c)
    if (typeof b.source !== "string") throw new AppError(400, "source is required")
    return c.json(await d.lib.save(slugOf(c), nameOf(c), b.source, b.base ?? null, { doc: b.doc, message: undefined }))
  })

  app.post("/api/projects/:p/files/:name/rename", async c => {
    const { to } = await body<{ to: string }>(c)
    await d.lib.rename(slugOf(c), nameOf(c), to)
    return c.json({ ok: true, name: to })
  })
  app.post("/api/projects/:p/files/:name/duplicate", async c => {
    const { to } = await body<{ to: string }>(c)
    await d.lib.duplicate(slugOf(c), nameOf(c), to)
    return c.json({ ok: true, name: to })
  })
  app.post("/api/projects/:p/files/:name/archive", async c => {
    await d.lib.archive(slugOf(c), nameOf(c))
    return c.json({ ok: true })
  })
  app.post("/api/projects/:p/archive/:name/restore", async c => {
    await d.lib.archive(slugOf(c), nameOf(c), true)
    return c.json({ ok: true })
  })
  app.delete("/api/projects/:p/files/:name", async c => {
    await d.lib.remove(slugOf(c), nameOf(c))
    return c.json({ ok: true })
  })
  app.get("/api/projects/:p/archive", async c => c.json(await d.lib.archived(slugOf(c))))
  app.get("/api/projects/:p/trash", async c => c.json(await d.lib.trash(slugOf(c))))
  app.post("/api/projects/:p/trash/:name/restore", async c => {
    await d.lib.restore(slugOf(c), nameOf(c))
    return c.json({ ok: true })
  })

  /** One diagram before (published) and after (waiting), with the node/edge changes the inbox colors. */
  app.get("/api/projects/:p/files/:name/diff", async c => {
    const slug = slugOf(c)
    const name = nameOf(c)
    const after = await d.lib.read(slug, name).catch(() => null)
    const before = await d.lib.read(slug, name, "base").catch(() => null)
    if (!after && !before) throw new AppError(404, `no diagram ${name}`)
    const g = (s: string | undefined) => (s ? graph(s) : { title: "", summary: "", nodes: [], edges: [] })
    return c.json({ name, before: before?.source ?? null, after: after?.source ?? null, beforeDoc: before?.doc ?? null, afterDoc: after?.doc ?? null, diff: diff(g(before?.source), g(after?.source)) })
  })

  // -- the waiting update, the inbox, sync -------------------------------------------------------------------------

  app.get("/api/projects/:p/pending", async c => c.json(await d.lib.pending(slugOf(c))))
  app.post("/api/projects/:p/approve", async c => c.json(await d.lib.approve(slugOf(c))))
  app.post("/api/projects/:p/discard", async c => {
    await d.lib.discard(slugOf(c))
    return c.json({ ok: true })
  })
  app.post("/api/projects/:p/pull-request", async c => c.json(await d.lib.openPullRequest(slugOf(c))))
  app.post("/api/projects/:p/sync", async c => c.json(await d.syncer.sync(slugOf(c))))

  /** Every project's waiting update with its headline, newest first, and when each was last checked. */
  app.get("/api/inbox", async c => {
    const items = []
    for (const p of d.store.read().projects.filter(p => !p.archived && p.source.kind === "github")) {
      const pending = await d.lib.pending(p.slug).catch(() => null)
      const last = d.syncer.last[p.slug] ?? null
      if (!pending) {
        items.push({ project: p.slug, title: p.title, pending: null, checkedThrough: p.checkedThrough ?? null, last })
        continue
      }
      const { git } = await import("../../core/src/git.js")
      const log = await git(d.lib.clonePath(p.slug), ["log", "--format=%s%x09%ct%x09%(trailers:key=Archdraw-Base,valueonly)", `${pending.base}..${pending.head}`], { ok: [128] })
      const commits = log.stdout.split("\n").filter(Boolean).map(l => {
        const [subject, at] = l.split("\t")
        return { subject, at: Number(at) }
      })
      items.push({ project: p.slug, title: p.title, pending, commits, headline: commits[0]?.subject.replace(/^archdraw:\s*/, "") ?? "Changes waiting", checkedThrough: p.checkedThrough ?? null, last })
    }
    items.sort((a, b) => Number(!!b.pending) - Number(!!a.pending))
    return c.json(items)
  })

  // -- export ------------------------------------------------------------------------------------------------------

  app.get("/api/projects/:p/export", async c => {
    const only = c.req.query("only") ? checkSlug(c.req.query("only")!, "diagram name") : undefined
    const b = await bundle(d.lib, slugOf(c), { only, at: c.req.query("at") === "head" ? "head" : "base" })
    if (c.req.query("format") === "json") return c.json(b)
    return new Response(Buffer.from(zip(b)), {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${b.root}${only ? "-" + only : ""}.zip"` },
    })
  })

  // -- the agent ---------------------------------------------------------------------------------------------------

  app.get("/api/agent", c => {
    const s = d.store.read().settings
    return c.json({ spent_today: Math.round(d.spend.day().total * 10000) / 10000, day_budget: s.dayBudgetUsd, conversation_budget: s.conversationBudgetUsd, conversations: d.talks.list().slice(0, 30) })
  })

  app.post("/api/agent/conversations", async c => {
    const { project } = await body<{ project: string }>(c)
    return c.json(d.talks.open(checkSlug(project, "project")).summary())
  })

  app.get("/api/agent/conversations/:id", async c => {
    const t = d.talks.get(c.req.param("id"))
    const after = Number(c.req.query("after") ?? -1)
    const wait = Math.min(Math.max(Number(c.req.query("wait") ?? 0), 0), 25)
    const items = await t.wait(after, wait * 1000)
    return c.json({ ...t.summary(), items })
  })

  app.post("/api/agent/conversations/:id/messages", async c => {
    const t = d.talks.get(c.req.param("id"))
    const b = await body<{ text: string; file?: string; source?: string }>(c)
    if (!b.text?.trim() || b.text.length > 20_000) throw new AppError(400, "a message is 1 to 20,000 characters")
    t.say(b.text.trim(), await context(d, t.project, b.file, b.source))
    return c.json(t.summary())
  })

  app.post("/api/agent/conversations/:id/interrupt", c => {
    d.talks.get(c.req.param("id")).interrupt()
    return c.json({ ok: true })
  })
  app.post("/api/agent/conversations/:id/close", c => {
    d.talks.get(c.req.param("id")).close("closed by you")
    return c.json({ ok: true })
  })

  app.all("/api/*", c => c.json({ detail: `no route ${c.req.path}` }, 404))

  // -- the page ------------------------------------------------------------------------------------------------------

  if (d.ui) {
    const ui = d.ui
    app.use(
      "/assets/*",
      serveStatic({
        root: ui,
        onFound: (_p, c) => {
          c.header("Cache-Control", "public, max-age=31536000, immutable")
        },
      }),
    )
    app.use("*", serveStatic({ root: ui, onFound: (_p, c) => c.header("Cache-Control", "no-cache") }))
    app.get("*", c => {
      c.header("Cache-Control", "no-cache")
      return c.html(readFileSync(join(ui, "index.html"), "utf8"))
    })
  }
  return app
}

/** What rides with a message: the project, its diagrams, and the one the user is looking at (as the editor holds it). */
async function context(d: Deps, project: string, file?: string, source?: string): Promise<string> {
  const rows = await d.lib.files(project)
  const lines = [`[archdraw] Project \`${project}\`; its diagrams live in \`${DIAGRAM_DIR}/\`.`]
  if (rows.length) lines.push("Diagrams: " + rows.map(r => `${r.name} (${r.title})`).join("; ") + ".")
  if (file) {
    checkSlug(file, "diagram name")
    const src = source ?? (await d.lib.read(project, file)).source
    lines.push(`The user is looking at \`${file}\`; its source as it stands in the editor:`, "```archdraw", src.trimEnd(), "```")
  }
  return lines.join("\n")
}
