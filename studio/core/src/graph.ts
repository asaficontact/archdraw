// A diagram as a graph an agent (or a diff) can read: nodes with their label, parent and role, edges with their label.
// Read from the parsed source, never from the SVG: the source names everything, the picture names nothing.
//
// `diff` compares two versions of one diagram node by node (names are stable dotted ids) and edge by edge, which is
// what the inbox colors and lists: added, removed, changed (text, style, link), moved (to another container).

import { parse } from "./engine.js"

export type GNode = { id: string; label: string; detail: string; parent: string | null; style: string; shape: string; icon: string; badge: string; url: string; line: number }
export type GEdge = { id: string; from: string; to: string; label: string; arrow: string; style: string; line: number }
export type Graph = { title: string; summary: string; nodes: GNode[]; edges: GEdge[] }

/** Text as a reader sees it: line breaks ( / ) become " · ", [dim] marks dropped. */
export function plain(text: string): { label: string; detail: string } {
  const parts = text.split(/\s+\/\s+/)
  const strip = (s: string) => s.replace(/\[\/?[a-z]+(?:\s[^\]]*)?\]/g, "").replace(/\s+/g, " ").trim()
  const dims = [...text.matchAll(/\[dim\]([\s\S]*?)\[\/dim\]/g)].map(m => strip(m[1]))
  const label = strip(parts[0].replace(/\[dim\][\s\S]*?\[\/dim\]/g, "")) || strip(parts[0])
  const detail = [...parts.slice(1).map(strip), ...dims].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i && v !== label).join(" · ")
  return { label, detail }
}

/** The graph of a source. Throws the engine's parse error. */
export function graph(source: string): Graph {
  const doc = parse(source)
  const nodes: GNode[] = []
  const edges: GEdge[] = []
  const seen = new Map<string, number>()
  for (const s of doc.statements) {
    if (s.kind === "node") {
      const { label, detail } = plain(s.text || s.name.split(".").pop()!)
      const dot = s.name.lastIndexOf(".")
      const a = s.attrs
      nodes.push({ id: s.name, label, detail, parent: dot > 0 ? s.name.slice(0, dot) : null, style: a.style ?? "", shape: a.shape ?? "", icon: a.icon ?? "", badge: a.badge ?? "", url: a.url ?? "", line: s.line })
    } else if (s.kind === "edge") {
      const label = s.text ? plain(s.text).label : ""
      const base = `${s.from}->${s.to}:${label}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      edges.push({ id: n > 1 ? `${base}#${n}` : base, from: s.from, to: s.to, label, arrow: s.arrow, style: s.attrs.style ?? "", line: s.line })
    }
  }
  const meta = (key: string) => new RegExp(`^\\s*//\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m").exec(source)?.[1] ?? ""
  return { title: meta("title"), summary: meta("summary"), nodes, edges }
}

export type Change =
  | { on: "node"; id: string; kind: "added" | "removed"; label: string }
  | { on: "node"; id: string; kind: "changed" | "moved" | "restyled"; label: string; what: string }
  | { on: "edge"; id: string; kind: "added" | "removed"; from: string; to: string; label: string }
  | { on: "edge"; id: string; kind: "changed"; from: string; to: string; label: string; what: string }

export type Diff = { changes: Change[]; added: number; removed: number; changed: number }

/** Node-by-node, edge-by-edge differences from `a` (before) to `b` (after). A removed container hides its children. */
export function diff(a: Graph, b: Graph): Diff {
  const changes: Change[] = []
  const A = new Map(a.nodes.map(n => [n.id, n]))
  const B = new Map(b.nodes.map(n => [n.id, n]))
  const removedRoots = new Set<string>()
  for (const n of a.nodes) {
    if (B.has(n.id)) continue
    if (n.parent && !B.has(n.parent) && removedRoots.has(n.parent)) {
      removedRoots.add(n.id)
      continue
    }
    removedRoots.add(n.id)
    changes.push({ on: "node", id: n.id, kind: "removed", label: n.label })
  }
  const addedRoots = new Set<string>()
  for (const n of b.nodes) {
    const was = A.get(n.id)
    if (!was) {
      const inNew = n.parent !== null && addedRoots.has(n.parent)
      addedRoots.add(n.id)
      if (!inNew) changes.push({ on: "node", id: n.id, kind: "added", label: n.label })
      continue
    }
    if (was.parent !== n.parent) changes.push({ on: "node", id: n.id, kind: "moved", label: n.label, what: `${was.parent ?? "top level"} → ${n.parent ?? "top level"}` })
    else if (was.label !== n.label || was.detail !== n.detail || was.url !== n.url)
      changes.push({ on: "node", id: n.id, kind: "changed", label: n.label, what: was.label !== n.label ? `"${was.label}" → "${n.label}"` : was.detail !== n.detail ? `"${was.detail}" → "${n.detail}"` : `link ${was.url || "none"} → ${n.url || "none"}` })
    else if (was.style !== n.style || was.shape !== n.shape || was.icon !== n.icon || was.badge !== n.badge)
      changes.push({ on: "node", id: n.id, kind: "restyled", label: n.label, what: `style ${was.style || "none"} → ${n.style || "none"}` })
  }
  // edges: exact matches first, then same ends with a new label count as changed
  const restA = a.edges.filter(e => !b.edges.some(f => f.id === e.id))
  const restB = b.edges.filter(e => !a.edges.some(f => f.id === e.id))
  for (const e of restB) {
    const i = restA.findIndex(f => f.from === e.from && f.to === e.to)
    if (i >= 0) {
      const was = restA.splice(i, 1)[0]
      changes.push({ on: "edge", id: e.id, kind: "changed", from: e.from, to: e.to, label: e.label, what: `"${was.label}" → "${e.label}"` })
    } else changes.push({ on: "edge", id: e.id, kind: "added", from: e.from, to: e.to, label: e.label })
  }
  for (const e of restA) {
    if (removedRoots.has(e.from) || removedRoots.has(e.to)) continue // gone with its node
    changes.push({ on: "edge", id: e.id, kind: "removed", from: e.from, to: e.to, label: e.label })
  }
  const count = (k: string) => changes.filter(c => c.kind === k).length
  return { changes, added: count("added"), removed: count("removed"), changed: changes.length - count("added") - count("removed") }
}

/** A short text outline of a diagram for an agent: the node tree with roles, then every edge as A → B: label. */
export function outline(g: Graph): string {
  const kids = new Map<string | null, GNode[]>()
  for (const n of g.nodes) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n])
  const lines: string[] = []
  if (g.title) lines.push(`# ${g.title}`)
  if (g.summary) lines.push(g.summary)
  lines.push("", "Parts:")
  const walk = (parent: string | null, depth: number) => {
    for (const n of kids.get(parent) ?? []) {
      if (n.shape === "none") continue // notes are listed below
      const role = [n.style, n.badge === "database" ? "store" : "", n.icon].filter(Boolean).join(", ")
      lines.push(`${"  ".repeat(depth)}- ${n.id}: ${n.label}${n.detail ? ` (${n.detail})` : ""}${role ? ` [${role}]` : ""}${n.url ? ` → ${n.url}` : ""}`)
      walk(n.id, depth + 1)
    }
  }
  walk(null, 0)
  const notes = g.nodes.filter(n => n.shape === "none")
  if (notes.length) lines.push("", "Notes:", ...notes.map(n => `- ${n.label}${n.detail ? " " + n.detail : ""}`))
  lines.push("", "Connections:", ...g.edges.map(e => `- ${e.from} → ${e.to}${e.label ? `: ${e.label}` : ""}${e.style ? ` [${e.style}]` : ""}`))
  return lines.join("\n")
}
