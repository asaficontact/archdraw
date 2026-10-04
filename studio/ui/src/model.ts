// Pure pieces of the studio: the API, card layout on the canvas, and camera math. No DOM here, so they are tested
// in node (model.test.ts).

export type Source = { kind: "github"; repo: string; url: string; branch: string } | { kind: "folder"; path: string }
export type Project = { slug: string; title: string; files: number; updated: number; pending: boolean; archived: boolean; source: Source; settings: Partial<Settings>; checkedThrough: string | null }
export type FileStatus = "same" | "added" | "changed"
export type FileMeta = { name: string; title: string; summary: string; updated: number; bytes: number; version: string; status: FileStatus }
export type FileDoc = { project: string; name: string; source: string; version: string; doc: string | null; title?: string; summary?: string }
export type Settings = {
  provider: string
  chatModel: string
  triageModel: string
  syncEveryMinutes: number
  dayBudgetUsd: number
  projectDayBudgetUsd: number
  conversationBudgetUsd: number
  publish: "pull-request" | "direct"
  ignore: string[]
  theme: "system" | "light" | "dark"
}
export type ProviderInfo = { name: string; env: string; chat: string; triage: string; prefix: string; keyUrl: string }
export type SettingsView = { settings: Settings; keys: Record<string, boolean>; keysEditable: boolean; providers: Record<string, ProviderInfo>; onboarded: boolean; spentToday: { total: number; projects: Record<string, number> } }
export type Change =
  | { on: "node"; id: string; kind: "added" | "removed" | "changed" | "moved" | "restyled"; label: string; what?: string }
  | { on: "edge"; id: string; kind: "added" | "removed" | "changed"; from: string; to: string; label: string; what?: string }
export type DiagramDiff = { name: string; before: string | null; after: string | null; beforeDoc: string | null; afterDoc: string | null; diff: { changes: Change[]; added: number; removed: number; changed: number } }
export type Pending = { head: string; base: string; behind: number; files: { name: string; status: "added" | "changed" | "removed" }[]; pr?: { number: number; url: string; state: string } | null }
export type SyncResult = { project: string; outcome: string; checkedThrough?: string; commits?: number; why?: string; files?: string[]; headline?: string; reason?: string; at?: number }
export type InboxItem = { project: string; title: string; pending: Pending | null; commits?: { subject: string; at: number }[]; headline?: string; checkedThrough: string | null; last: SyncResult | null }
export type TrashItem = { name: string; deletedAt: number; commit: string }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`api/${path}`, { headers: { "content-type": "application/json" }, ...init })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, (body as { detail?: string }).detail ?? `${r.status}`)
  return body as T
}

const post = <T>(path: string, json: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(json) })

export const api = {
  projects: () => call<Project[]>("projects"),
  connect: (b: { repo?: string; folder?: string; title?: string }) => post<Project>("projects", b),
  updateProject: (p: string, b: { title?: string; archived?: boolean; settings?: Partial<Settings> }) => call<Project>(`projects/${p}`, { method: "PATCH", body: JSON.stringify(b) }),
  disconnect: (p: string) => call(`projects/${p}`, { method: "DELETE" }),
  refresh: (p: string) => post(`projects/${p}/refresh`),
  files: (p: string) => call<FileMeta[]>(`projects/${p}/files`),
  read: (p: string, f: string, at: "head" | "base" = "head") => call<FileDoc>(`projects/${p}/files/${f}${at === "base" ? "?at=base" : ""}`),
  save: (p: string, f: string, source: string, base: string | null, doc?: string | null) =>
    call<{ version: string; commit: string | null }>(`projects/${p}/files/${f}`, { method: "PUT", body: JSON.stringify({ source, base, doc }) }),
  rename: (p: string, f: string, to: string) => post(`projects/${p}/files/${f}/rename`, { to }),
  duplicate: (p: string, f: string, to: string) => post(`projects/${p}/files/${f}/duplicate`, { to }),
  archive: (p: string, f: string) => post(`projects/${p}/files/${f}/archive`),
  unarchive: (p: string, f: string) => post(`projects/${p}/archive/${f}/restore`),
  remove: (p: string, f: string) => call(`projects/${p}/files/${f}`, { method: "DELETE" }),
  archived: (p: string) => call<string[]>(`projects/${p}/archive`),
  trash: (p: string) => call<TrashItem[]>(`projects/${p}/trash`),
  restore: (p: string, f: string) => post(`projects/${p}/trash/${f}/restore`),
  diff: (p: string, f: string) => call<DiagramDiff>(`projects/${p}/files/${f}/diff`),
  pending: (p: string) => call<Pending | null>(`projects/${p}/pending`),
  approve: (p: string) => post<{ published: string }>(`projects/${p}/approve`),
  discard: (p: string) => post(`projects/${p}/discard`),
  pullRequest: (p: string) => post<{ number: number; url: string }>(`projects/${p}/pull-request`),
  sync: (p: string) => post<SyncResult>(`projects/${p}/sync`),
  inbox: () => call<InboxItem[]>("inbox"),
  settings: () => call<SettingsView>("settings"),
  saveSettings: (s: Partial<Settings> & { onboarded?: boolean }) => call<{ settings: Settings; onboarded: boolean }>("settings", { method: "PUT", body: JSON.stringify(s) }),
  setKey: (key: string, provider?: string) => call<{ provider: string }>("keys", { method: "PUT", body: JSON.stringify({ key, provider }) }),
  exportUrl: (p: string, only?: string, at: "head" | "base" = "head") => `api/projects/${p}/export?at=${at}${only ? `&only=${only}` : ""}`,
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

/** The leading `// title:` and `// summary:` comments, as the server reads them. */
export function meta(source: string): { title?: string; summary?: string } {
  const out: { title?: string; summary?: string } = {}
  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (!line.startsWith("//")) break
    const m = /^\/\/\s*(title|summary)\s*:\s*(.+?)\s*$/.exec(line)
    if (m && !(m[1] in out)) out[m[1] as "title" | "summary"] = m[2]
  }
  return out
}

// ---- layout ---------------------------------------------------------------------------------------------------

export type Size = { w: number; h: number }
export type Rect = { x: number; y: number; w: number; h: number }

export const CARD_PAD = 28 // inside a card, around the diagram
export const CARD_HEAD = 76 // the title and summary above it
export const GAP = 140 // between cards

/** The row width whose layout comes closest to 16:10 (the shape of a screen): each column count is tried, and
 *  the widths of its first row are the candidate. Never narrower than the widest card. */
export function rowWidthFor(sizes: Size[]): number {
  if (!sizes.length) return 1
  const widths = sizes.map(s => Math.max(s.w, 320) + CARD_PAD * 2)
  let best = { score: Infinity, width: Math.max(...widths) }
  for (let cols = 1; cols <= sizes.length; cols++) {
    const width = Math.max(...widths, widths.slice(0, cols).reduce((a, w) => a + w + GAP, -GAP))
    const b = bounds(layout(sizes, width + 1))
    const score = Math.abs(Math.log(b.w / b.h / 1.6))
    if (score < best.score) best = { score, width: width + 1 }
  }
  return best.width
}

/** Cards in rows, left to right, wrapping when a row passes `rowWidth`. Each card is the diagram plus its frame. */
export function layout(sizes: Size[], rowWidth = rowWidthFor(sizes)): Rect[] {
  const out: Rect[] = []
  let x = 0
  let y = 0
  let rowH = 0
  for (const s of sizes) {
    const w = Math.max(s.w, 320) + CARD_PAD * 2
    const h = s.h + CARD_PAD * 2 + CARD_HEAD
    if (x > 0 && x + w > rowWidth) {
      x = 0
      y += rowH + GAP
      rowH = 0
    }
    out.push({ x, y, w, h })
    x += w + GAP
    rowH = Math.max(rowH, h)
  }
  return out
}

/** The size an SVG asks for, from its width/height or else its viewBox. */
export function svgSize(svg: string): Size {
  const num = (name: string) => {
    const m = new RegExp(`<svg[^>]*\\s${name}="([\\d.]+)`).exec(svg)
    return m ? Number(m[1]) : NaN
  }
  let w = num("width")
  let h = num("height")
  if (!(w > 0 && h > 0)) {
    const vb = /<svg[^>]*viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/.exec(svg)
    w = vb ? Number(vb[1]) : 400
    h = vb ? Number(vb[2]) : 240
  }
  return { w, h }
}

// ---- camera ---------------------------------------------------------------------------------------------------

export type Camera = { x: number; y: number; k: number } // screen = world * k + (x, y)

export const MIN_K = 0.05
export const MAX_K = 4

export const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k))

/** Zoom by `factor` keeping the world point under screen point (sx, sy) where it is. */
export function zoomAt(c: Camera, factor: number, sx: number, sy: number): Camera {
  const k = clampK(c.k * factor)
  const f = k / c.k
  return { k, x: sx - (sx - c.x) * f, y: sy - (sy - c.y) * f }
}

/** The camera that fits `r` inside a viewport of `vw`×`vh` with `margin` pixels around it, never above `maxK`. */
export function fit(r: Rect, vw: number, vh: number, margin = 48, maxK = 1.5): Camera {
  const k = clampK(Math.min((vw - margin * 2) / r.w, (vh - margin * 2) / r.h, maxK))
  return { k, x: (vw - r.w * k) / 2 - r.x * k, y: (vh - r.h * k) / 2 - r.y * k }
}

export function bounds(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 1, h: 1 }
  const x = Math.min(...rects.map(r => r.x))
  const y = Math.min(...rects.map(r => r.y))
  const r = Math.max(...rects.map(r => r.x + r.w))
  const b = Math.max(...rects.map(r => r.y + r.h))
  return { x, y, w: r - x, h: b - y }
}

export function lerp(a: Camera, b: Camera, t: number): Camera {
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 // ease in-out
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, k: a.k + (b.k - a.k) * e }
}

// ---- route ----------------------------------------------------------------------------------------------------

/** `#/<project>/<file>` ⇄ { project, file }; `#/inbox` and `#/inbox/<project>` are the inbox. */
export function parseHash(hash: string): { project?: string; file?: string; inbox?: boolean } {
  const [p, f] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent)
  if (p === "inbox") return { inbox: true, project: f && SLUG.test(f) ? f : undefined }
  if (!p || !SLUG.test(p)) return { project: undefined, file: undefined }
  return { project: p, file: f && SLUG.test(f) ? f : undefined }
}

export const hashFor = (project?: string, file?: string) => (project ? `#/${project}${file ? `/${file}` : ""}` : "#/")
export const inboxHash = (project?: string) => `#/inbox${project ? `/${project}` : ""}`
