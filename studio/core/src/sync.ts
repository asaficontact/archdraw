// Keeping a project's diagrams current. Each tick, for every connected GitHub project whose sync is on:
//
//   1. fetch; when the branch has not moved since the last check, stop (no model call, no cost);
//   2. triage: one cheap model call reads the new commits (subjects, files touched) and the diagrams' outlines and
//      answers whether the architecture changed;
//   3. only then draft: an agent run with the read-only tools updates the diagrams (and their explanations), and every
//      proposal goes onto the project's one waiting update (`archdraw/update`), re-drafted as more commits land;
//   4. record "checked through <commit>", so an empty inbox can be trusted.
//
// Another device may already have drafted the same commits: the update's commit carries `Archdraw-Base: <sha>`, and a
// device that sees its base already covered does nothing.

import { Agent } from "@earendil-works/pi-agent-core"
import { AppError, type Store } from "./config.js"
import { systemPrompt, skills } from "./agent.js"
import { git } from "./git.js"
import { graph, outline } from "./graph.js"
import type { Library } from "./library.js"
import { type KeyStore, type ModelSet, pickModel } from "./models.js"
import type { Spend } from "./spend.js"
import { makeTools, type Proposal } from "./tools.js"

export type SyncResult =
  | { project: string; outcome: "unchanged"; checkedThrough: string }
  | { project: string; outcome: "no-architecture-change"; checkedThrough: string; commits: number; why: string }
  | { project: string; outcome: "drafted"; checkedThrough: string; commits: number; why: string; files: string[]; headline: string }
  | { project: string; outcome: "skipped"; reason: string }
  | { project: string; outcome: "failed"; reason: string; checkedThrough: string }

export type SyncDeps = { store: Store; lib: Library; keys: KeyStore; models: ModelSet; spend: Spend; log?: (line: string) => void }

type Commit = { sha: string; subject: string; files: string[] }

async function commitsBetween(dir: string, from: string | undefined, to: string): Promise<Commit[]> {
  const range = from ? [`${from}..${to}`] : ["-30", to]
  const r = await git(dir, ["log", "--first-parent", "--name-only", "--format=@%H%x09%s", ...range], { ok: [128] })
  const out: Commit[] = []
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("@")) {
      const [sha, subject] = line.slice(1).split("\t")
      out.push({ sha, subject, files: [] })
    } else if (line.trim() && out.length) out[out.length - 1].files.push(line.trim())
  }
  return out
}

/** The pending update already covers `base` (another device drafted it, or we did on a previous tick). */
async function covered(dir: string, head: string | null, base: string): Promise<boolean> {
  if (!head) return false
  const r = await git(dir, ["log", "-20", "--format=%(trailers:key=Archdraw-Base,valueonly)", head], { ok: [128] })
  return r.stdout.split("\n").some(l => l.trim() === base)
}

const TRIAGE = `You decide whether a range of commits changed a software project's architecture: its parts (services, apps,
stores, queues, jobs, external APIs), how they connect, or where they run. Refactors inside one part, tests, docs,
styling, dependency bumps and copy changes do not count. Answer with JSON only:
{"changed": true|false, "why": "<one sentence>", "touches": ["<diagram names likely affected>"]}`

export class Syncer {
  private running = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  last: Record<string, SyncResult & { at: number }> = {}

  constructor(private d: SyncDeps) {}

  /** Start the background tick (every minute; each project syncs on its own cadence). */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick().catch(e => this.d.log?.(`sync tick failed: ${e}`)), 60_000)
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Sync every project that is due. */
  async tick(now = Date.now()): Promise<SyncResult[]> {
    const out: SyncResult[] = []
    for (const p of this.d.store.read().projects) {
      if (p.archived || p.source.kind !== "github") continue
      const every = this.d.store.settingsFor(p.slug).syncEveryMinutes
      if (!every) continue
      const last = this.last[p.slug]?.at ?? 0
      // spread devices out: a little jitter per project so two machines rarely tick together
      const jitter = (hash(p.slug) % 300) * 1000
      if (now - last < every * 60_000 + jitter) continue
      out.push(await this.sync(p.slug).catch(e => ({ project: p.slug, outcome: "skipped" as const, reason: String(e.message ?? e) })))
    }
    return out
  }

  /** Sync one project; `manual` is "Sync now", which also retries a draft that failed for this commit. */
  async sync(slug: string, manual = false): Promise<SyncResult> {
    if (this.running.has(slug)) return { project: slug, outcome: "skipped", reason: "already syncing" }
    this.running.add(slug)
    try {
      const r = await this.run(slug, manual)
      this.last[slug] = { ...r, at: Date.now() }
      this.d.log?.(`sync ${slug}: ${r.outcome}`)
      return r
    } finally {
      this.running.delete(slug)
    }
  }

  private async run(slug: string, manual = false): Promise<SyncResult> {
    const { store, lib, spend } = this.d
    const p = lib.get(slug)
    if (p.source.kind !== "github") return { project: slug, outcome: "skipped", reason: "not a git project" }
    await lib.refresh(slug)
    const dir = lib.clonePath(slug)
    const { base, head } = await lib.revisions(slug)
    if (!base) return { project: slug, outcome: "skipped", reason: "the branch is empty" }
    const through = store.project(slug)?.checkedThrough
    if (through === base) return { project: slug, outcome: "unchanged", checkedThrough: base }
    // a draft for this very commit failed (no push rights, no key…): the hourly check waits for new commits or
    // "Sync now" instead of spending the budget again every hour (review of #2 F2)
    const failure = store.project(slug)?.syncFailure
    if (failure && failure.base === base && !manual) return { project: slug, outcome: "skipped", reason: `waiting: ${failure.message}` }
    if (await covered(dir, head, base)) {
      this.mark(slug, base)
      return { project: slug, outcome: "unchanged", checkedThrough: base }
    }
    const commits = (await commitsBetween(dir, through, base)).filter(c => !c.files.every(f => f.startsWith(".archdraw/")))
    if (commits.length === 0) {
      this.mark(slug, base)
      return { project: slug, outcome: "unchanged", checkedThrough: base }
    }
    const refusal = spend.refusal(slug)
    if (refusal) return { project: slug, outcome: "skipped", reason: refusal }

    const files = await lib.files(slug)
    // the versions the draft starts from: an edit saved while the agent works wins over the draft (review of #2 F4)
    const versions = new Map(files.map(f => [f.name, f.version]))
    const outlines: string[] = []
    for (const f of files) {
      try {
        outlines.push(`## ${f.name}\n${outline(graph((await lib.read(slug, f.name)).source))}`)
      } catch {
        outlines.push(`## ${f.name}\n(unreadable)`)
      }
    }
    const verdict = files.length === 0 ? { changed: false, why: "the project has no diagrams yet; draft the first ones from the project page", touches: [] as string[] } : await this.triage(slug, commits, outlines)
    if (!verdict.changed) {
      this.mark(slug, base)
      return { project: slug, outcome: "no-architecture-change", checkedThrough: base, commits: commits.length, why: verdict.why }
    }
    const range = through ? `${through.slice(0, 12)}..${base.slice(0, 12)}` : base.slice(0, 12)
    const written: string[] = []
    const kept: string[] = []
    try {
      const proposals = await this.draft(slug, commits, range, verdict)
      for (const pr of proposals) {
        try {
          await lib.save(slug, pr.name, pr.source, versions.get(pr.name) ?? null, {
            doc: pr.doc,
            message: `archdraw: ${verdict.why.slice(0, 60)}\n\n${commits.length} commit(s) ${range}: ${verdict.why}\n\nArchdraw-Base: ${base}`,
          })
          written.push(pr.name)
        } catch (e) {
          if (e instanceof AppError && e.status === 409 && /changed since|already exists|removed since/.test(e.message)) kept.push(pr.name)
          else throw e
        }
      }
    } catch (e) {
      const message = String((e as Error).message ?? e).slice(0, 300)
      store.update(c => {
        const x = c.projects.find(q => q.slug === slug)
        if (x) x.syncFailure = { base, at: Date.now(), message }
      })
      return { project: slug, outcome: "failed", reason: message, checkedThrough: through ?? "" }
    }
    this.mark(slug, base)
    const note = kept.length ? ` (kept your edits to ${kept.join(", ")})` : ""
    if (written.length === 0) return { project: slug, outcome: "no-architecture-change", checkedThrough: base, commits: commits.length, why: `${verdict.why} (the draft changed no diagram)${note}` }
    return { project: slug, outcome: "drafted", checkedThrough: base, commits: commits.length, why: verdict.why + note, files: written, headline: verdict.why }
  }

  private mark(slug: string, sha: string) {
    this.d.store.update(c => {
      const p = c.projects.find(x => x.slug === slug)
      if (p) delete p.syncFailure
      if (p) p.checkedThrough = sha
    })
  }

  private async triage(slug: string, commits: Commit[], outlines: string[]): Promise<{ changed: boolean; why: string; touches: string[] }> {
    const { store, keys, models, spend } = this.d
    const s = store.settingsFor(slug)
    const key = keys.get(s.provider)
    if (!key) throw new AppError(412, `no ${s.provider} key: add it in Settings`)
    const model = pickModel(models, s.provider, s.triageModel, "triage")
    const listing = commits
      .slice(0, 60)
      .map(c => `- ${c.sha.slice(0, 8)} ${c.subject}\n  ${c.files.slice(0, 15).join(", ")}${c.files.length > 15 ? ` (+${c.files.length - 15})` : ""}`)
      .join("\n")
    const msg = await models.completeSimple(model, {
      systemPrompt: TRIAGE,
      messages: [{ role: "user", content: `# The diagrams now\n\n${outlines.join("\n\n").slice(0, 12_000)}\n\n# New commits (${commits.length})\n\n${listing}`, timestamp: Date.now() }],
    } as any, { apiKey: key } as any)
    spend.add(slug, Number((msg as any).usage?.cost?.total) || 0)
    const text = ((msg as any).content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
    try {
      const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
      return { changed: !!j.changed, why: String(j.why ?? "").slice(0, 300) || "the architecture changed", touches: Array.isArray(j.touches) ? j.touches.map(String) : [] }
    } catch {
      return { changed: false, why: `the triage answer was not readable: ${text.slice(0, 120)}`, touches: [] }
    }
  }

  private async draft(slug: string, commits: Commit[], range: string, verdict: { why: string; touches: string[] }): Promise<Proposal[]> {
    const { store, lib, keys, models, spend } = this.d
    const s = store.settingsFor(slug)
    const p = lib.get(slug)
    const model = pickModel(models, s.provider, s.chatModel, "chat")
    const proposals = new Map<string, Proposal>()
    const tools = makeTools({
      root: lib.clonePath(slug),
      folder: p.source.kind === "folder",
      rev: p.source.kind === "github" ? `origin/${p.source.branch}` : null,
      ignore: s.ignore,
      diagrams: async () => (await lib.files(slug)).map(f => ({ name: f.name, title: f.title, summary: f.summary })),
      readDiagram: async name => {
        const d = await lib.read(slug, name)
        return { source: d.source, doc: d.doc }
      },
      skills: skills(),
      onProposal: pr => proposals.set(pr.name, pr),
    })
    const agent = new Agent({
      initialState: { systemPrompt: systemPrompt({ slug: p.slug, title: p.title }), model, tools, thinkingLevel: "medium" },
      streamFn: models.streamSimple.bind(models),
      getApiKey: async () => keys.get(s.provider),
      toolExecution: "sequential",
    })
    let cost = 0
    agent.subscribe(e => {
      if (e.type === "message_end" && (e.message as any).role === "assistant") {
        const usd = Number((e.message as any).usage?.cost?.total) || 0
        cost += usd
        spend.add(slug, usd)
        if (cost > s.conversationBudgetUsd * 2 || spend.refusal(slug)) agent.abort()
      }
    })
    const listing = commits.map(c => `- ${c.sha.slice(0, 8)} ${c.subject} (${c.files.slice(0, 8).join(", ")})`).join("\n")
    await agent.prompt(
      `Background job, no user is watching: keep the architecture diagrams of project \`${slug}\` current (links between its diagrams are url: "#/${slug}/<file>").\n\n` +
        `Commits ${range} changed the architecture: ${verdict.why}\nDiagrams likely affected: ${verdict.touches.join(", ") || "(unknown)"}\n\n${listing}\n\n` +
        `Read the changes (git_diff with this range, the files), read the affected diagrams, and propose each diagram that must change ` +
        `with propose_diagram (complete file, the fewest changed lines, never reordered) and an updated explanation. Do not ask questions; ` +
        `when unsure, leave a part out and say so in the explanation's open questions. Finish with one sentence on what changed.`,
    )
    return [...proposals.values()]
  }
}

function hash(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
