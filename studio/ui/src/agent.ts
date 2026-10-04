// The archdraw agent, the pure half: its API, the event log folded into a transcript, a line diff for proposals,
// and the ⌘K palette's matching. No DOM here, so it is tested in node (agent.test.ts).

import { ApiError } from "./model"

export type AgentEvent = { n: number; at: number; type: string; [k: string]: unknown }
export type Summary = { id: string; project: string; title: string; state: string; cost: number; started: number; last: number; events: number }
export type Status = { spent_today: number; day_budget: number; conversation_budget: number; conversations: Summary[] }
export type Proposal = { kind: "archdraw" | "markdown"; name: string; source: string; error: string | null; n: number; doc?: string | null }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`api/agent${path}`, { headers: { "content-type": "application/json" }, ...init })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, (body as { detail?: string }).detail ?? `${r.status}`)
  return body as T
}

export const agentApi = {
  status: () => call<Status>(""),
  open: (project: string) => call<Summary>("/conversations", { method: "POST", body: JSON.stringify({ project }) }),
  events: (id: string, after: number, wait: number, signal?: AbortSignal) =>
    call<Summary & { items: AgentEvent[] }>(`/conversations/${id}?after=${after}&wait=${wait}`, { signal }),
  say: (id: string, text: string, file?: string, source?: string) =>
    call<Summary>(`/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text, file, source }) }),
  interrupt: (id: string) => call(`/conversations/${id}/interrupt`, { method: "POST" }),
  close: (id: string) => call(`/conversations/${id}/close`, { method: "POST" }),
}

// ---- the transcript -------------------------------------------------------------------------------------------

export type Turn =
  | { kind: "user"; n: number; text: string }
  | { kind: "agent"; n: number; id: string; text: string; done: boolean }
  | { kind: "tool"; n: number; name: string; args: string }
  | { kind: "fixing"; n: number; errors: string[] }
  | { kind: "proposal"; n: number; p: Proposal }
  | { kind: "note"; n: number; text: string; tone: "error" | "muted" }

export type Transcript = { turns: Turn[]; busy: boolean; ready: boolean; ended: boolean; cost: number; model?: string }

/** Fold the event log into what the panel shows. Deltas build a message until its completed text replaces them. */
export function transcript(events: AgentEvent[]): Transcript {
  const turns: Turn[] = []
  const live = new Map<string, Extract<Turn, { kind: "agent" }>>()
  const t: Transcript = { turns, busy: false, ready: false, ended: false, cost: 0 }
  for (const e of events) {
    const s = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : "")
    switch (e.type) {
      case "user":
        turns.push({ kind: "user", n: e.n, text: s("text") })
        t.busy = true
        break
      case "ready":
        t.ready = true
        t.model = s("model") || undefined
        break
      case "assistant_start": {
        const turn = { kind: "agent" as const, n: e.n, id: s("id"), text: "", done: false }
        live.set(turn.id, turn)
        turns.push(turn)
        break
      }
      case "delta": {
        const turn = live.get(s("id"))
        if (turn) turn.text += s("text")
        break
      }
      case "assistant": {
        const turn = live.get(s("id"))
        if (turn) Object.assign(turn, { text: s("text"), done: true })
        else turns.push({ kind: "agent", n: e.n, id: s("id"), text: s("text"), done: true })
        break
      }
      case "tool":
        turns.push({ kind: "tool", n: e.n, name: s("name"), args: s("args") })
        break
      case "fixing":
        turns.push({ kind: "fixing", n: e.n, errors: (e.errors as string[]) ?? [] })
        break
      case "proposal":
        turns.push({ kind: "proposal", n: e.n, p: { kind: e.kind as Proposal["kind"], name: s("name"), source: s("source"), error: (e.error as string) ?? null, n: e.n, doc: (e.doc as string) ?? null } })
        break
      case "settled":
        t.busy = false
        break
      case "cost":
        t.cost = Number(e.usd) || 0
        break
      case "error":
        turns.push({ kind: "note", n: e.n, text: s("text"), tone: "error" })
        break
      case "closed":
      case "ended":
        if (!t.ended) turns.push({ kind: "note", n: e.n, text: e.type === "closed" ? `Conversation ended (${s("why")}).` : "The agent stopped.", tone: "muted" })
        t.ended = true
        t.busy = false
        break
    }
  }
  // an empty bubble from a turn that only called tools says nothing (the server sends no completion for it, so it
  // stays open; only the newest turn may still be filling in)
  t.turns = turns.filter((x, i) => !(x.kind === "agent" && !x.text.trim() && (x.done || i < turns.length - 1)))
  return t
}

/** A finished message with its fenced files cut out: the proposal cards show those. */
export function prose(text: string): string {
  return text
    .replace(/```(archdraw|markdown)\s+file=[a-z0-9-]+\s*\n[\s\S]*?\n```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// ---- diff -----------------------------------------------------------------------------------------------------

export type DiffLine = { op: " " | "+" | "-"; text: string }

/** A line diff (LCS). Diagram files are a few hundred lines at most, so the quadratic table is fine. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.replace(/\n$/, "").split("\n")
  const y = b.replace(/\n$/, "").split("\n")
  if (a === "") return y.map(text => ({ op: "+", text }))
  const m = x.length
  const n = y.length
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      out.push({ op: " ", text: x[i] })
      i++
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: x[i++] })
    else out.push({ op: "+", text: y[j++] })
  }
  while (i < m) out.push({ op: "-", text: x[i++] })
  while (j < n) out.push({ op: "+", text: y[j++] })
  return out
}

export const diffCount = (d: DiffLine[]) => ({ added: d.filter(l => l.op === "+").length, removed: d.filter(l => l.op === "-").length })

/** The changed lines with `context` unchanged lines around each run; long unchanged stretches collapse to null. */
export function hunks(d: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = d.map(() => false)
  d.forEach((l, i) => {
    if (l.op !== " ") for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true
  })
  const out: (DiffLine | null)[] = []
  d.forEach((l, i) => {
    if (keep[i]) out.push(l)
    else if (out.length && out[out.length - 1] !== null) out.push(null)
  })
  if (out[out.length - 1] === null) out.pop()
  return out
}

// ---- the palette ----------------------------------------------------------------------------------------------

export type Target = { kind: "project" | "file"; project: string; file?: string; title: string; hint: string }

/** A subsequence match scored by how early and how tightly the letters land; -1 when they do not all land. */
export function score(query: string, text: string): number {
  const q = query.toLowerCase().trim()
  const t = text.toLowerCase()
  if (!q) return 0
  const at = t.indexOf(q)
  if (at >= 0) return 1000 - at - (t.length - q.length) * 0.1 + (at === 0 || /\W/.test(t[at - 1]) ? 50 : 0)
  let s = 0
  let last = -1
  for (const ch of q) {
    if (ch === " ") continue
    const i = t.indexOf(ch, last + 1)
    if (i < 0) return -1
    s += i === last + 1 ? 10 : 1
    last = i
  }
  return s
}

/** The best matches first; on a tie, the project you are in wins (every project has a `system`). */
export function rank(query: string, targets: Target[], limit = 8, here?: string): Target[] {
  const near = (t: Target) => (t.project === here ? 3 : 0)
  if (!query.trim()) return [...targets].sort((a, b) => near(b) - near(a)).slice(0, limit)
  return targets
    .map(t => ({ t, s: Math.max(score(query, t.title), score(query, t.file ?? t.project) - 5, score(query, t.hint) - 20) }))
    .filter(x => x.s >= 0)
    .map(x => ({ ...x, s: x.s + near(x.t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.t)
}

/** Does this read as a request to the agent rather than a name to jump to? */
export const looksLikeAsk = (q: string) => q.trim().split(/\s+/).length >= 3 || /[?]$/.test(q.trim())
