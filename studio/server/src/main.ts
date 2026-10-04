// Start archdraw: the store, the library, the agent, the hourly sync and the HTTP server. The headless server on trex
// runs this file; the Electron shell calls `start()` in its own process with token mode and its keychain.

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { Conversations } from "../../core/src/agent.js"
import { appHome, Store } from "../../core/src/config.js"
import { GhForge } from "../../core/src/gh.js"
import { Library } from "../../core/src/library.js"
import { EnvKeys, type KeyStore, type ModelSet, models } from "../../core/src/models.js"
import { Spend } from "../../core/src/spend.js"
import { Syncer } from "../../core/src/sync.js"
import { createApp } from "./app.js"
import type { Gate } from "./identity.js"

export type StartOptions = {
  home?: string
  host?: string
  port?: number // 0 = any free port
  gate?: Gate
  keys?: KeyStore
  models?: ModelSet // tests and the onboarding demo inject a scripted model set
  ui?: string | null
  sync?: boolean
  by?: string // the commit author name for diagram changes
  log?: (s: string) => void
}

function defaultUi(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const c of [process.env.ARCHDRAW_UI, join(here, "ui"), resolve(here, "../../ui/dist")]) if (c && existsSync(join(c, "index.html"))) return c
  return null
}

export async function start(o: StartOptions = {}): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const log = o.log ?? ((s: string) => console.log(`${new Date().toISOString()} ${s}`))
  const store = new Store(o.home ?? appHome())
  const keys = o.keys ?? new EnvKeys(process.env.ARCHDRAW_SECRETS ?? join(homedir(), "work", "secrets", "providers.env"))
  const lib = new Library(store, new GhForge(), o.by ?? process.env.ARCHDRAW_AUTHOR ?? "archdraw")
  const spend = new Spend(store)
  const m = o.models ?? models()
  const talks = new Conversations({ store, lib, keys, models: m, spend })
  const syncer = new Syncer({ store, lib, keys, models: m, spend, log })
  let port = o.port ?? 8088
  const app = createApp({ store, lib, talks, syncer, keys, spend, gate: o.gate ?? { mode: "local" }, ui: o.ui === null ? undefined : (o.ui ?? defaultUi() ?? undefined), serverPort: () => port, log })
  const server = await new Promise<ReturnType<typeof serve>>(res => {
    const s = serve({ fetch: app.fetch, hostname: o.host ?? "127.0.0.1", port }, info => {
      port = info.port
      res(s)
    })
  })
  const sweep = setInterval(() => talks.sweep(), 60_000)
  if (o.sync !== false) syncer.start()
  const url = `http://${o.host ?? "127.0.0.1"}:${port}`
  log(`archdraw on ${url} (${o.gate?.mode ?? "local"} gate, home ${store.home})`)
  return {
    port,
    url,
    close: async () => {
      clearInterval(sweep)
      syncer.stop()
      talks.closeAll()
      await new Promise<void>(res => server.close(() => res()))
    },
  }
}

/** Run from the command line: the trex deployment (tailnet gate) or development. */
async function main() {
  const mode = (process.env.ARCHDRAW_GATE ?? "tailnet") as Gate["mode"]
  const gate: Gate = mode === "token" ? { mode, token: process.env.ARCHDRAW_TOKEN || randomBytes(24).toString("hex") } : mode === "local" ? { mode } : { mode: "tailnet", allowLocal: process.env.ARCHDRAW_ALLOW_LOCAL === "1" }
  const s = await start({ host: process.env.ARCHDRAW_HOST ?? "127.0.0.1", port: Number(process.env.ARCHDRAW_PORT ?? 8088), gate, sync: process.env.ARCHDRAW_SYNC !== "0", by: process.env.ARCHDRAW_AUTHOR })
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void s.close().then(() => process.exit(0)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main()
