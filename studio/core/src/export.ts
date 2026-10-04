// The export bundle: what to hand any coding agent so it understands the architecture with confidence.
//
//   <project>-<sha>/
//     ARCHITECTURE.md        the entry point: the project's own overview (.archdraw/README.md) and an index
//     architecture.json      every diagram as a graph, for machines
//     manifest.json          what was exported, from which commit, when
//     diagrams/<name>/
//       <name>.md            the diagram's explanation (.archdraw/<name>.md) plus its parts and connections as text
//       <name>.archdraw      the source of truth
//       <name>.svg           the picture, for people
//       <name>.graph.json    this diagram's graph
//
// Agents read text far better than pictures, so every claim the picture makes is also written out as tables and
// "A → B: label" lines. What only a person or the agent can write (purpose, flows, invariants) comes from the
// explanation file; when there is none, a visible TODO says so instead of inventing it.

import { zipSync, strToU8 } from "fflate"
import { DIAGRAM_DIR } from "./config.js"
import { svg } from "./engine.js"
import { type Graph, graph } from "./graph.js"
import type { Library } from "./library.js"

export type Bundle = { root: string; files: Record<string, string> }

export async function bundle(lib: Library, slug: string, opts: { only?: string; at?: "head" | "base"; now?: Date } = {}): Promise<Bundle> {
  const project = lib.get(slug)
  const at = opts.at ?? "base"
  const revs = await lib.revisions(slug)
  const sha = at === "base" ? revs.base : (revs.head ?? revs.base)
  const short = sha ? sha.slice(0, 7) : "local"
  const root = `${slug}-${short}`
  const all = (await lib.files(slug)).filter(f => (at === "base" ? f.status !== "added" : true))
  const names = opts.only ? all.filter(f => f.name === opts.only).map(f => f.name) : all.map(f => f.name)
  if (opts.only && names.length === 0) throw new Error(`no diagram ${opts.only}`)
  const files: Record<string, string> = {}
  const graphs: Record<string, Graph> = {}
  const index: string[] = []
  for (const name of names) {
    const doc = await lib.read(slug, name, at)
    const g = graph(doc.source)
    graphs[name] = g
    const dir = `diagrams/${name}`
    files[`${dir}/${name}.archdraw`] = doc.source
    files[`${dir}/${name}.svg`] = safeSvg(doc.source)
    files[`${dir}/${name}.graph.json`] = JSON.stringify(g, null, 1) + "\n"
    files[`${dir}/${name}.md`] = diagramMd(name, g, doc.doc, { project: project.title, sha })
    index.push(`- [${g.title || name}](${dir}/${name}.md): ${g.summary || "(no summary yet)"}`)
  }
  const overview = await readOverview(lib, slug, at)
  const generated = (opts.now ?? new Date()).toISOString()
  files["ARCHITECTURE.md"] = architectureMd(project.title, overview, index, { sha, generated, repo: project.source.kind === "github" ? project.source.repo : project.source.path })
  files["architecture.json"] = JSON.stringify({ project: project.title, commit: sha || null, diagrams: graphs }, null, 1) + "\n"
  files["manifest.json"] = JSON.stringify({ exporter: "archdraw 0.2", project: slug, commit: sha || null, generated, files: Object.keys(files).sort() }, null, 1) + "\n"
  return { root, files }
}

/** The bundle as one .zip (everything under the bundle's root folder). */
export function zip(b: Bundle): Uint8Array {
  const tree: Record<string, Uint8Array> = {}
  for (const [path, text] of Object.entries(b.files)) tree[`${b.root}/${path}`] = strToU8(text)
  return zipSync(tree, { level: 6 })
}

async function readOverview(lib: Library, slug: string, at: "head" | "base"): Promise<string | null> {
  const p = lib.get(slug)
  if (p.source.kind === "folder") {
    const { existsSync, readFileSync } = await import("node:fs")
    const f = `${p.source.path}/${DIAGRAM_DIR}/README.md`
    return existsSync(f) ? readFileSync(f, "utf8") : null
  }
  const { show } = await import("./git.js")
  const revs = await lib.revisions(slug)
  const rev = at === "base" ? revs.base : (revs.head ?? revs.base)
  return rev ? show(lib.clonePath(slug), rev, `${DIAGRAM_DIR}/README.md`) : null
}

function safeSvg(source: string): string {
  try {
    return svg(source)
  } catch (e) {
    return `<!-- the engine could not render this diagram: ${String((e as Error).message).replace(/--/g, "—")} -->\n`
  }
}

function architectureMd(title: string, overview: string | null, index: string[], m: { sha: string; generated: string; repo: string }): string {
  const lines = [
    "---",
    `project: ${title}`,
    `source: ${m.repo}`,
    `verified_at: ${m.sha || "(not a git project)"}`,
    `exported_at: ${m.generated}`,
    "---",
    "",
    `# ${title}: architecture`,
    "",
    "Read this first. Each diagram below has its own document with every part and connection written out as text;",
    "the .svg next to it is the same diagram for people. The .archdraw file is the source of truth.",
    "",
  ]
  if (overview) lines.push(overview.replace(/^#\s+.*\n+/, "").trim(), "")
  else
    lines.push(
      "## What this is",
      "",
      "TODO(agent): 3–5 lines on the problem, who it is for, and what is built vs planned. (No `.archdraw/README.md` yet: ask archdraw to write the project overview.)",
      "",
    )
  lines.push("## Diagrams", "", ...index, "")
  return lines.join("\n")
}

function diagramMd(name: string, g: Graph, doc: string | null, m: { project: string; sha: string }): string {
  const parts = g.nodes.filter(n => n.shape !== "none")
  const notes = g.nodes.filter(n => n.shape === "none")
  const role = (n: Graph["nodes"][number]) => [n.style, n.badge === "database" ? "store" : n.badge, n.icon, n.shape].filter(Boolean).join(", ") || "—"
  const esc = (s: string) => s.replace(/\|/g, "\\|")
  const lines = [`# ${g.title || name}`, "", g.summary ? `${g.summary}` : "", "", `Project: ${m.project} · diagram \`${name}\` · source \`${name}.archdraw\` · picture \`${name}.svg\`${m.sha ? ` · verified at \`${m.sha.slice(0, 12)}\`` : ""}`, ""]
  if (doc) lines.push(doc.replace(/^#\s+.*\n+/, "").trim(), "")
  else lines.push("## Purpose", "", "TODO(agent): what question this diagram answers, and what it leaves out.", "")
  lines.push("## Parts", "", "| id | name | detail | role | inside | links to |", "|---|---|---|---|---|---|")
  for (const n of parts) lines.push(`| \`${n.id}\` | ${esc(n.label)} | ${esc(n.detail) || "—"} | ${role(n)} | ${n.parent ? `\`${n.parent}\`` : "—"} | ${n.url || "—"} |`)
  lines.push("", "## Connections", "", ...g.edges.map(e => `- \`${e.from}\` → \`${e.to}\`${e.label ? `: ${e.label}` : ""}${e.style ? ` (${e.style})` : ""}`), "")
  if (notes.length) lines.push("## Notes on the diagram", "", ...notes.map(n => `- ${n.label}${n.detail ? " " + n.detail : ""}`), "")
  const unlabelled = g.edges.filter(e => !e.label)
  if (unlabelled.length) lines.push("## Open questions", "", ...unlabelled.map(e => `- The connection \`${e.from}\` → \`${e.to}\` has no label: what goes over it?`), "")
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n")
}
