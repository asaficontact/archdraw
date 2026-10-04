// The archdraw agent: one conversation = one pi Agent (pi-agent-core) with archdraw's read-only tools, streaming to the
// page. Every event is kept in order and saved, so any device that opens the conversation replays all of it.
//
// The events the page reads (the same names the piray bridge used): user, ready, assistant_start, delta, assistant,
// tool, fixing, proposal, cost, settled, error, closed.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { Agent } from "@earendil-works/pi-agent-core"
import type { Model, Models } from "@earendil-works/pi-ai"
import { AppError, type Store } from "./config.js"
import type { Library } from "./library.js"
import { type KeyStore, pickModel } from "./models.js"
import type { Spend } from "./spend.js"
import { makeTools, type Proposal } from "./tools.js"
import { demoAgent } from "./sample.js"

export type AgentEvent = { n: number; at: number; type: string; [k: string]: unknown }

/** The prompts and skills shipped with the app: core/assets in development, next to the bundle once built. */
export function assetsDir(): string {
  if (process.env.ARCHDRAW_ASSETS) return process.env.ARCHDRAW_ASSETS
  const here = dirname(fileURLToPath(import.meta.url))
  for (const c of [join(here, "..", "assets"), join(here, "assets")]) if (existsSync(join(c, "prompts"))) return c
  return join(here, "assets")
}

let skillCache: Record<string, string> | null = null
export function skills(): Record<string, string> {
  if (skillCache) return skillCache
  const root = join(assetsDir(), "skills")
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n)
      if (n.endsWith(".md")) out[relative(root, f)] = readFileSync(f, "utf8")
      else if (!n.includes(".")) walk(f)
    }
  }
  if (existsSync(root)) walk(root)
  skillCache = out
  return out
}

export function systemPrompt(): string {
  const base = readFileSync(join(assetsDir(), "prompts", "agent.md"), "utf8")
  const index = Object.entries(skills())
    .filter(([p]) => p.endsWith("SKILL.md"))
    .map(([p, body]) => `- ${p}: ${/^description:\s*(.+)$/m.exec(body)?.[1] ?? "a skill"}`)
  return `${base}\n\n## Your skills (read with read_skill)\n${index.join("\n")}\n`
}

export type ConversationDeps = {
  store: Store
  lib: Library
  keys: KeyStore
  models: Models
  spend: Spend
  save: (c: Conversation) => void
}

export class Conversation {
  readonly id: string
  events: AgentEvent[] = []
  cost = 0
  started = Date.now() / 1000
  last = Date.now() / 1000
  state: "ready" | "working" | "closed" = "ready"
  title = ""
  model = ""
  private agent: Agent | null = null
  private waiters: (() => void)[] = []
  private live = new Map<string, string>() // message id → text so far
  private demo: ReturnType<typeof demoAgent> | null = null // the sample's scripted agent

  constructor(
    readonly project: string,
    private deps: ConversationDeps | null,
    id?: string,
  ) {
    this.id = id ?? Math.random().toString(16).slice(2, 14)
  }

  summary() {
    return { id: this.id, project: this.project, title: this.title, state: this.state, cost: Math.round(this.cost * 10000) / 10000, started: this.started, last: this.last, events: this.events.length, model: this.model }
  }

  emit(e: Record<string, unknown>) {
    this.events.push({ n: this.events.length, at: Date.now() / 1000, ...e } as AgentEvent)
    const w = this.waiters
    this.waiters = []
    w.forEach(f => f())
  }

  /** Events after `after`, waiting up to `timeout` ms for one: a long poll that any device can resume. */
  async wait(after: number, timeout: number): Promise<AgentEvent[]> {
    if (this.events.length <= after + 1 && timeout > 0) {
      await new Promise<void>(res => {
        const t = setTimeout(res, timeout)
        this.waiters.push(() => {
          clearTimeout(t)
          res()
        })
      })
    }
    return this.events.slice(after + 1)
  }

  private build(): Agent {
    const d = this.deps!
    const p = d.lib.get(this.project)
    const s = d.store.settingsFor(this.project)
    if (p.sample) this.demo = demoAgent()
    const key = this.demo ? "demo" : d.keys.get(s.provider)
    if (!key) throw new AppError(412, `add your ${s.provider} key in Settings to talk to the agent`)
    const models = this.demo ? this.demo.models : d.models
    const model: Model<any> = this.demo ? this.demo.model : pickModel(d.models, s.provider, s.chatModel, "chat")
    this.model = this.demo ? "demo (scripted, no AI)" : `${model.provider}/${model.id}`
    const root = p.source.kind === "github" ? d.lib.clonePath(this.project) : p.source.path
    const tools = makeTools({
      root,
      rev: p.source.kind === "github" ? `origin/${p.source.branch}` : null,
      ignore: s.ignore,
      diagrams: async () => (await d.lib.files(this.project)).map(f => ({ name: f.name, title: f.title, summary: f.summary })),
      readDiagram: async name => {
        const doc = await d.lib.read(this.project, name)
        return { source: doc.source, doc: doc.doc }
      },
      skills: skills(),
      onProposal: (pr: Proposal) => this.emit({ type: "proposal", kind: "archdraw", name: pr.name, source: pr.source, doc: pr.doc, error: null }),
    })
    const agent = new Agent({
      initialState: { systemPrompt: systemPrompt(), model, tools, thinkingLevel: "medium" },
      streamFn: models.streamSimple.bind(models),
      getApiKey: async () => (this.demo ? "demo" : d.keys.get(s.provider)),
      sessionId: `archdraw-${this.id}`,
      toolExecution: "sequential",
    })
    agent.subscribe(e => this.onEvent(e))
    this.emit({ type: "ready", model: this.model })
    return agent
  }

  private onEvent(e: any) {
    if (e.type === "message_start" && e.message.role === "assistant") {
      const mid = `m${this.events.length}`
      this.live.set("current", mid)
      this.live.set(mid, "")
      this.emit({ type: "assistant_start", id: mid })
    } else if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      const mid = this.live.get("current")
      if (mid) {
        this.live.set(mid, (this.live.get(mid) ?? "") + e.assistantMessageEvent.delta)
        this.emit({ type: "delta", id: mid, text: e.assistantMessageEvent.delta })
      }
    } else if (e.type === "message_end" && e.message.role === "assistant") {
      const mid = this.live.get("current") ?? `m${this.events.length}`
      const text = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
      if (text.trim()) this.emit({ type: "assistant", id: mid, text })
      if (e.message.errorMessage) this.emit({ type: "error", text: String(e.message.errorMessage).slice(0, 400) })
      const usd = Number(e.message.usage?.cost?.total) || 0
      if (usd > 0) {
        this.cost += usd
        this.deps!.spend.add(this.project, usd)
        this.emit({ type: "cost", usd: Math.round(this.cost * 10000) / 10000 })
        this.overBudget()
      }
    } else if (e.type === "tool_execution_start") {
      this.emit({ type: "tool", name: e.toolName, args: JSON.stringify(e.args ?? {}).slice(0, 200) })
    } else if (e.type === "tool_execution_end" && e.toolName === "propose_diagram" && e.isError) {
      const msg = (e.result?.content ?? []).map((c: any) => c.text).join(" ")
      this.emit({ type: "fixing", errors: [msg.slice(0, 300)] })
    } else if (e.type === "agent_end") {
      this.state = this.state === "closed" ? "closed" : "ready"
      this.emit({ type: "settled" })
      this.deps!.save(this)
    }
  }

  private overBudget(): boolean {
    const s = this.deps!.store.settingsFor(this.project)
    const why = this.cost >= s.conversationBudgetUsd ? `this conversation reached its $${s.conversationBudgetUsd.toFixed(2)} budget` : this.deps!.spend.refusal(this.project)
    if (!why) return false
    this.emit({ type: "error", text: why })
    this.agent?.abort()
    this.close("budget")
    return true
  }

  /** The user's message; `context` (the open diagram) rides with it, unseen in the transcript. */
  say(text: string, context = ""): void {
    if (this.state === "closed") throw new AppError(409, "this conversation has ended; start a new one")
    const why = this.deps!.spend.refusal(this.project)
    if (why) throw new AppError(429, why)
    this.last = Date.now() / 1000
    if (!this.title) this.title = text.slice(0, 80)
    if (!this.agent) this.agent = this.build()
    this.emit({ type: "user", text })
    const message = context ? `${context}\n\n---\n\n${text}` : text
    this.demo?.script(text)
    if (this.agent.state.isStreaming) {
      this.agent.followUp({ role: "user", content: message, timestamp: Date.now() } as any)
      return
    }
    this.state = "working"
    this.agent.prompt(message).catch(err => {
      this.emit({ type: "error", text: String(err?.message ?? err).slice(0, 400) })
      this.state = this.state === "closed" ? "closed" : "ready"
      this.emit({ type: "settled" })
    })
  }

  interrupt(): void {
    this.agent?.abort()
  }

  close(why = "closed"): void {
    if (this.state === "closed") return
    this.state = "closed"
    this.agent?.abort()
    this.emit({ type: "closed", why })
    this.deps?.save(this)
  }

  toJSON() {
    return { id: this.id, project: this.project, title: this.title, cost: this.cost, started: this.started, last: this.last, model: this.model, events: this.events }
  }
}

/** Every conversation by id; saved under `<home>/conversations`, reloaded read-only after a restart. */
export class Conversations {
  readonly byId = new Map<string, Conversation>()
  private dir: string

  constructor(private deps: Omit<ConversationDeps, "save">) {
    this.dir = join(deps.store.home, "conversations")
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    for (const f of readdirSync(this.dir).filter(f => f.endsWith(".json"))) {
      try {
        const d = JSON.parse(readFileSync(join(this.dir, f), "utf8"))
        const c = new Conversation(d.project, null, d.id)
        Object.assign(c, { events: d.events, cost: d.cost, started: d.started, last: d.last, title: d.title, model: d.model ?? "", state: "closed" })
        this.byId.set(c.id, c)
      } catch {
        /* a broken file is skipped */
      }
    }
  }

  save = (c: Conversation) => {
    const tmp = join(this.dir, `.${c.id}.tmp`)
    writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 })
    renameSync(tmp, join(this.dir, `${c.id}.json`))
  }

  open(project: string): Conversation {
    this.deps.lib.get(project)
    const why = this.deps.spend.refusal(project)
    if (why) throw new AppError(429, why)
    const c = new Conversation(project, { ...this.deps, save: this.save })
    this.byId.set(c.id, c)
    this.save(c)
    return c
  }

  get(id: string): Conversation {
    const c = this.byId.get(id)
    if (!c) throw new AppError(404, "no such conversation")
    return c
  }

  list(): ReturnType<Conversation["summary"]>[] {
    return [...this.byId.values()].map(c => c.summary()).sort((a, b) => b.last - a.last)
  }

  /** Close conversations idle for `idleMs` (their history stays). */
  sweep(idleMs = 20 * 60_000): void {
    const now = Date.now() / 1000
    for (const c of this.byId.values()) if (c.state !== "closed" && now - c.last > idleMs / 1000) c.close("idle")
  }

  closeAll(): void {
    for (const c of this.byId.values()) c.close("the app closed")
  }
}
