// The colored diff of a diagram: the engine's layout gives every node's box in the SVG's own coordinates (its viewBox
// is the layout's space), so highlights are drawn as rectangles inside the SVG itself, under the diagram's marks.
// Added nodes are green, changed amber, moved blue; in the "before" picture, removed nodes are red. A badge (+, ~, −)
// carries the meaning too, so color is never the only signal.

import { parse, resolve, THEMES, compile } from "@engine"
import type { Change } from "./model"
import { sanitize } from "./render"

export type Mark = "added" | "changed" | "moved" | "removed"

type Box = { x: number; y: number; w: number; h: number }

function boxes(source: string): Map<string, Box> {
  const out = new Map<string, Box>()
  try {
    const r = resolve(parse(source)) as unknown as { nodes: Iterable<{ name: string; x: number; y: number; width: number; height: number }> | Map<string, { name: string; x: number; y: number; width: number; height: number }> }
    const list = r.nodes instanceof Map ? [...r.nodes.values()] : [...(r.nodes as Iterable<{ name: string; x: number; y: number; width: number; height: number }>)]
    for (const n of list) out.set(n.name, { x: n.x, y: n.y, w: n.width, h: n.height })
  } catch {
    /* a source the engine refuses has no boxes */
  }
  return out
}

/** Which mark each node gets in the after-picture and in the before-picture. */
export function marks(changes: Change[]): { after: Map<string, Mark>; before: Map<string, Mark> } {
  const after = new Map<string, Mark>()
  const before = new Map<string, Mark>()
  for (const c of changes) {
    if (c.on !== "node") continue
    if (c.kind === "added") after.set(c.id, "added")
    else if (c.kind === "removed") before.set(c.id, "removed")
    else if (c.kind === "moved") after.set(c.id, "moved")
    else if (c.kind === "changed") after.set(c.id, "changed")
  }
  // an edge change marks both its ends as touched, unless they are already marked
  for (const c of changes) {
    if (c.on !== "edge") continue
    const side = c.kind === "removed" ? before : after
    for (const id of [c.from, c.to]) if (!side.has(id)) side.set(id, c.kind === "removed" ? "removed" : "changed")
  }
  return { after, before }
}

const BADGE: Record<Mark, string> = { added: "+", changed: "~", moved: "↦", removed: "−" }

/** The diagram's SVG with its marked nodes highlighted (sanitized like every diagram). */
export function highlighted(source: string, dark: boolean, which: Map<string, Mark>, focus?: string): string {
  const svg = compile(source, { theme: dark ? THEMES.dark : THEMES.light })
  const b = boxes(source)
  const pad = 6
  const rects: string[] = []
  for (const [id, mark] of which) {
    const box = b.get(id)
    if (!box) continue
    const on = focus === id ? " ad-dm-focus" : ""
    rects.push(
      `<rect class="ad-dm ad-dm-${mark}${on}" x="${box.x - pad}" y="${box.y - pad}" width="${box.w + pad * 2}" height="${box.h + pad * 2}" rx="12" ry="12"/>`,
      `<circle class="ad-dm-badge ad-dm-${mark}" cx="${box.x + box.w + pad}" cy="${box.y - pad}" r="11"/>`,
      `<text class="ad-dm-badge-t" x="${box.x + box.w + pad}" y="${box.y - pad + 4.5}" text-anchor="middle">${BADGE[mark]}</text>`,
    )
  }
  if (!rects.length) return sanitize(svg)
  // the layer goes right after the diagram's background (the first rect after its defs), so the background does not
  // cover the tint and the diagram's own boxes and lines still draw over it
  const open = svg.indexOf(">", svg.indexOf("<svg")) + 1
  const defsEnd = svg.indexOf("</defs>")
  const from = defsEnd >= 0 ? defsEnd + 7 : open
  const bg = svg.indexOf("<rect", from)
  const at = bg >= 0 ? svg.indexOf(">", bg) + 1 : from
  return sanitize(svg.slice(0, at) + `<g class="ad-dm-layer">${rects.join("")}</g>` + svg.slice(at))
}
