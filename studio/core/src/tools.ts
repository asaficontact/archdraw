// What the agent may do: read the project's code and diagrams, look at its git history, check a diagram with the
// engine, and propose a diagram. Nothing here writes: a proposal is handed to the app, which shows it and writes it
// only when the user accepts.
//
// Every path is jailed to the project's folder (the app's own clone, or the connected folder): resolved, symlinks
// followed, and refused outside the root; `.git/` internals, `.env*`, keys and other secret-looking files are never
// read, nor anything the project's settings ignore. Output is capped so one call cannot flood the context.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core"
import { type Static, type TSchema, Type } from "@earendil-works/pi-ai"
import { git } from "./git.js"
import { check } from "./engine.js"
import { graph, outline } from "./graph.js"

const CAP = 32_000
// Never read, matched case-insensitively (macOS volumes are case-insensitive: `.ENV` is `.env`, review of #2 F5)
const SECRET = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env(\..*)?$/,
  /\.env(\.[^/]*)?$/, // providers.env, app.env.local and the like (re-review of #2 R1)
  /(^|\/)(secrets?|credentials?)\//, // anything inside a secrets/ or credentials/ folder (R1)
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /(^|\/)(secrets?|credentials?)(\.[a-z]+)?$/,
  /(^|\/)\.(npmrc|netrc|pypirc|git-credentials)$/,
  /(^|\/)\.(ssh|aws|gnupg|kube|docker)(\/|$)/,
  /(^|\/)\.config(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
]
/** The same refusals as git pathspecs, so git_diff/git_log/grep never print a secret's contents (review of #2 F1). */
const SECRET_PATHSPECS = [
  "**/.env", "**/.env.*", "**/*.env", "**/*.env.*", "**/secret/**", "**/secrets/**", "**/credential/**", "**/credentials/**", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.keystore", "**/*.jks", "**/*.kdbx",
  "**/id_rsa*", "**/id_ed25519*", "**/id_ecdsa*", "**/id_dsa*", "**/secret", "**/secrets", "**/secret.*", "**/secrets.*",
  "**/credential*", "**/.npmrc", "**/.netrc", "**/.pypirc", "**/.git-credentials", "**/.ssh/**", "**/.aws/**", "**/.gnupg/**",
  "**/.kube/**", "**/.docker/**", "**/.config/**", "**/node_modules/**",
].map(g => `:(exclude,glob,icase)${g}`)

export type Proposal = { name: string; source: string; doc: string | null; error: string | null }

export type ToolContext = {
  root: string // the project's folder the agent may read
  folder?: boolean // a connected folder (confined to the server's folder root), not the app's own clone
  rev: string | null // the branch commit (a GitHub project), for git_log/git_diff defaults
  ignore: string[] // extra path patterns the project's settings exclude
  diagrams: () => Promise<{ name: string; title: string; summary: string }[]>
  readDiagram: (name: string) => Promise<{ source: string; doc: string | null }>
  skills: Record<string, string> // skill file path → content (shipped with the app)
  onProposal: (p: Proposal) => void
}

export class Jail {
  readonly root: string
  constructor(
    root: string,
    private ignore: string[] = [],
    confine = false, // a folder project: re-check the server's folder root (the app's own clones live in its home)
  ) {
    this.root = realpathSync(root)
    // a server that confines projects (trex: ~/work) re-checks the resolved root each time, so a symlink retargeted
    // after connecting cannot escape it (re-review of #2 L5)
    const top = process.env.ARCHDRAW_FOLDER_ROOT
    if (top && confine) {
      const t = realpathSync(top)
      if (this.root !== t && !this.root.startsWith(t + sep)) throw new Error(`this project's folder is outside ${t}`)
    }
  }
  /** The real absolute path of `p` inside the root, or a refusal that says why. */
  path(p: string): string {
    const abs = resolve(this.root, p.replace(/^\/+/, ""))
    let real = abs
    if (existsSync(abs)) real = realpathSync(abs)
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new Error(`${p} is outside the project`)
    const rel = relative(this.root, real)
    if (this.refused(rel)) throw new Error(`${p} is not readable here (secrets, git internals and ignored paths are never read)`)
    return real
  }
  refused(rel: string): boolean {
    const low = rel.toLowerCase()
    return SECRET.some(r => r.test(low)) || this.ignore.some(g => globMatch(g.toLowerCase(), low))
  }
  /** Pathspecs that exclude every refused path (secrets and the project's ignore list). */
  excludes(): string[] {
    return [...SECRET_PATHSPECS, ...this.ignore.filter(g => typeof g === "string" && g.trim()).map(g => `:(exclude,glob,icase)${g.includes("/") ? g : "**/" + g}`)]
  }
}

function globMatch(glob: string, path: string): boolean {
  const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*").replace(/\?/g, ".") + "(/.*)?$")
  return re.test(path)
}

/** A tool whose `execute` sees its parameters typed from the schema. */
function defineTool<S extends TSchema>(t: { name: string; label: string; description: string; parameters: S; execute: (id: string, p: Static<S>) => Promise<AgentToolResult<any>> }): AgentTool {
  return t as unknown as AgentTool
}

const text = (s: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: s.length > CAP ? s.slice(0, CAP) + `\n… (cut at ${CAP} characters)` : s }], details })

export function makeTools(ctx: ToolContext): AgentTool[] {
  const jail = new Jail(ctx.root, ctx.ignore, !!ctx.folder)

  const list = defineTool({
    name: "list",
    label: "List",
    description: "List a folder of the project (relative to its root; '' for the root). Folders end with '/'.",
    parameters: Type.Object({ path: Type.String({ description: "folder path relative to the project root" }) }),
    execute: async (_id, p) => {
      const dir = jail.path(p.path || ".")
      if (!statSync(dir).isDirectory()) throw new Error(`${p.path} is not a folder`)
      const rows = readdirSync(dir)
        .filter(n => !jail.refused(relative(jail.root, join(dir, n))))
        .slice(0, 400)
        .map(n => (lstatSync(join(dir, n)).isDirectory() ? n + "/" : n))
      return text(rows.join("\n") || "(empty)")
    },
  })

  const read = defineTool({
    name: "read",
    label: "Read",
    description: "Read a text file of the project, optionally from a line (1-based) for a number of lines.",
    parameters: Type.Object({ path: Type.String(), from: Type.Optional(Type.Number()), lines: Type.Optional(Type.Number()) }),
    execute: async (_id, p) => {
      const file = jail.path(p.path)
      if (statSync(file).size > 2_000_000) throw new Error(`${p.path} is too large to read`)
      const all = readFileSync(file, "utf8")
      if (all.includes("\u0000")) throw new Error(`${p.path} is not a text file`)
      const lines = all.split("\n")
      const from = Math.max(1, p.from ?? 1)
      const body = lines.slice(from - 1, from - 1 + (p.lines ?? 800)).map((l, i) => `${from + i}\t${l}`).join("\n")
      return text(body)
    },
  })

  const grep = defineTool({
    name: "grep",
    label: "Search",
    description: "Search the project's text files for an extended regular expression (case-insensitive); returns path:line: text. Optionally limit to a folder.",
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
    execute: async (_id, p) => {
      if (!p.pattern.trim() || p.pattern.length > 300) throw new Error("give a pattern of 1 to 300 characters")
      const start = relative(jail.root, jail.path(p.path || ".")) || "."
      // git grep in a child process with a deadline: a huge tree or a pathological pattern cannot stall the app
      // (review of #2 F13); --no-index searches a plain folder too, and --exclude-standard honours .gitignore
      const r = await git(jail.root, ["grep", "--no-index", "--exclude-standard", "-I", "-n", "-i", "-E", "--max-count=20", "-e", p.pattern, "--", start, ...jail.excludes()], { ok: [1, 128], timeoutMs: 10_000 })
      if (r.code === 128) throw new Error(`the search failed: ${r.stderr.trim().slice(0, 200) || "not a valid pattern"}`)
      const lines = r.stdout.split("\n").filter(Boolean)
      const out = lines.slice(0, 200).map(l => (l.length > 260 ? l.slice(0, 260) + "…" : l))
      return text(out.join("\n") + (lines.length > 200 ? `\n… ${lines.length - 200} more matches` : "") || "no matches")
    },
  })

  const gitLog = defineTool({
    name: "git_log",
    label: "Git log",
    description: "Recent commits of the project's branch: hash, date, subject and changed files. `range` like 'abc123..HEAD' or a count like '20'.",
    parameters: Type.Object({ range: Type.Optional(Type.String()), path: Type.Optional(Type.String()) }),
    execute: async (_id, p) => {
      if (!ctx.rev) throw new Error("this project is a folder, not a git repo")
      const range = p.range && /^[0-9a-f]{4,40}\.\.[0-9a-f]{4,40}$|^[0-9a-f]{4,40}\.\.HEAD$/.test(p.range) ? p.range.replace("HEAD", ctx.rev) : null
      const count = p.range && /^\d+$/.test(p.range) ? Math.min(Number(p.range), 100) : 20
      const args = ["log", "--no-color", "--first-parent", "--stat=120", "--format=%n%h %ad %an%n  %s", "--date=short", ...(range ? [range] : [`-${count}`, ctx.rev])]
      args.push("--", p.path ? relative(jail.root, jail.path(p.path)) || "." : ".", ...jail.excludes())
      return text((await git(jail.root, args)).stdout)
    },
  })

  const gitDiff = defineTool({
    name: "git_diff",
    label: "Git diff",
    description: "The code changes between two commits (e.g. 'abc123..def456'), optionally for one path. Large diffs are cut.",
    parameters: Type.Object({ range: Type.String(), path: Type.Optional(Type.String()) }),
    execute: async (_id, p) => {
      if (!ctx.rev) throw new Error("this project is a folder, not a git repo")
      if (!/^[0-9a-f]{4,40}\.\.([0-9a-f]{4,40}|HEAD)$/.test(p.range)) throw new Error("range must be <commit>..<commit>")
      const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", p.range.replace("HEAD", ctx.rev)]
      args.push("--", p.path ? relative(jail.root, jail.path(p.path)) || "." : ".", ...jail.excludes())
      return text((await git(jail.root, args)).stdout)
    },
  })

  const diagrams = defineTool({
    name: "list_diagrams",
    label: "Diagrams",
    description: "The project's architecture diagrams: name, title, summary.",
    parameters: Type.Object({}),
    execute: async () => text((await ctx.diagrams()).map(d => `${d.name}: ${d.title}${d.summary ? " — " + d.summary : ""}`).join("\n") || "no diagrams yet"),
  })

  const readDiagram = defineTool({
    name: "read_diagram",
    label: "Read diagram",
    description: "One diagram: its outline (parts and connections), its explanation, and its full source.",
    parameters: Type.Object({ name: Type.String() }),
    execute: async (_id, p) => {
      const d = await ctx.readDiagram(p.name)
      let o = ""
      try {
        o = outline(graph(d.source))
      } catch (e) {
        o = `(the engine cannot read it: ${(e as Error).message})`
      }
      return text(`${o}\n\n## Explanation\n${d.doc ?? "(none yet)"}\n\n## Source\n${d.source}`)
    },
  })

  const checkTool = defineTool({
    name: "check_diagram",
    label: "Check",
    description: "Check a diagram source with the engine without proposing it: 'renders' or the engine's error with its line.",
    parameters: Type.Object({ source: Type.String() }),
    execute: async (_id, p) => text(check(p.source) ?? "renders"),
  })

  const readSkill = defineTool({
    name: "read_skill",
    label: "Skill",
    description: `Read one of your skill files: ${Object.keys(ctx.skills).join(", ")}`,
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, p) => {
      const body = ctx.skills[p.path] ?? ctx.skills[p.path.replace(/^skills\//, "")]
      if (!body) throw new Error(`no skill file ${p.path}; there are: ${Object.keys(ctx.skills).join(", ")}`)
      return text(body)
    },
  })

  const propose = defineTool({
    name: "propose_diagram",
    label: "Propose",
    description:
      "Propose a complete diagram file (new or replacing one) and, if useful, its explanation in Markdown. The app checks it with the engine: an error comes back to you to fix and propose again. The user sees it beside the original and accepts or not; nothing is saved by this call.",
    parameters: Type.Object({
      name: Type.String({ description: "file name: lowercase letters, digits, dashes" }),
      source: Type.String({ description: "the complete .archdraw file" }),
      explanation: Type.Optional(Type.String({ description: "the diagram's explanation (.md): purpose, flows, invariants" })),
    }),
    execute: async (_id, p) => {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(p.name)) throw new Error("name must be lowercase letters, digits and dashes")
      const source = p.source.endsWith("\n") ? p.source : p.source + "\n"
      const error = check(source)
      if (error) return { content: [{ type: "text", text: `The engine refused it: ${error}\nFix that line and propose the complete file again.` }], details: { error }, isError: true }
      ctx.onProposal({ name: p.name, source, doc: p.explanation ?? null, error: null })
      return text(`Proposed ${p.name}. It renders; the user now sees it beside the current diagram.`)
    },
  })

  return [list, read, grep, gitLog, gitDiff, diagrams, readDiagram, checkTool, readSkill, propose]
}
