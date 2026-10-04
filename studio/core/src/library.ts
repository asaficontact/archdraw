// Projects and their diagrams. A GitHub project is a clone the app keeps for itself (never a checkout someone works
// in), and its diagrams live in the repo's `.archdraw/` folder:
//
//   <home>/repos/<slug>   the clone; its working tree follows origin/<branch> and is never edited
//   <home>/work/<slug>    a worktree on `archdraw/update`, the one pending update of the project
//
// Every change (an edit, an accepted proposal, a drafted update) is a commit on `archdraw/update`, pushed, and shown
// as "changes waiting"; approving publishes them (a merged pull request, or a push to the branch when the project is
// set to publish directly). A folder project has no git of its own: its files are written in place.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { AppError, checkSlug, DIAGRAM_DIR, type Project, type Store, slugFrom } from "./config.js"
import { check } from "./engine.js"
import { git, lastChange, lsTree, revParse, show } from "./git.js"

export const EXT = ".archdraw"
export const UPDATE_BRANCH = "archdraw/update"
/** Names the page uses as routes (`#/inbox`), never a project's. */
const RESERVED = ["inbox", "settings"]
const MAX_BYTES = 200_000
const META = /^\/\/\s*(title|summary)\s*:\s*(.+?)\s*$/

export type FileStatus = "same" | "added" | "changed"
export type DiagramMeta = { name: string; title: string; summary: string; updated: number; version: string; status: FileStatus; bytes: number }
export type DiagramDoc = { project: string; name: string; source: string; version: string; doc: string | null; title?: string; summary?: string }
export type Pending = { head: string; base: string; behind: number; files: { name: string; status: "added" | "changed" | "removed" }[]; pr?: { number: number; url: string; state: string } | null }

export const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)

/** `// title:` and `// summary:` from the comment lines at the top of a file. */
export function meta(source: string): { title?: string; summary?: string } {
  const out: { title?: string; summary?: string } = {}
  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (!line.startsWith("//")) break
    const m = META.exec(line)
    if (m && !(m[1] in out)) out[m[1] as "title" | "summary"] = m[2]
  }
  return out
}

export function starter(title: string): string {
  return `// title: ${title}\n// summary: One sentence on what this diagram shows.\n\nnode app "App"\nnode store "Store"  right of app\nedge app -> store  "reads"  from: right  to: left\n`
}

/** Pull requests, merges and the like on the repo's host. The internal build uses the `gh` CLI (gh.ts). */
export interface Forge {
  ensurePullRequest(p: Project, cwd: string, title: string, body: string): Promise<{ number: number; url: string; state: string }>
  pullRequest(p: Project, cwd: string): Promise<{ number: number; url: string; state: string } | null>
  merge(p: Project, cwd: string, number: number, subject: string): Promise<void>
  close(p: Project, cwd: string, number: number): Promise<void>
}

/** One lock per project: git operations on one clone never interleave. */
class Locks {
  private tails = new Map<string, Promise<unknown>>()
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.tails.set(key, next.catch(() => undefined))
    return next
  }
}

export class Library {
  private locks = new Locks()

  constructor(
    readonly store: Store,
    readonly forge: Forge | null,
    readonly by: string = "archdraw",
  ) {}

  // -- paths -----------------------------------------------------------------------------------------------------

  clonePath(slug: string) {
    return join(this.store.home, "repos", slug)
  }
  workPath(slug: string) {
    return join(this.store.home, "work", slug)
  }
  get(slug: string): Project {
    const p = this.store.project(checkSlug(slug, "project"))
    if (!p) throw new AppError(404, `no project ${JSON.stringify(slug)}`)
    return p
  }

  // -- connecting ------------------------------------------------------------------------------------------------

  private freeSlug(base: string): string {
    const taken = new Set([...this.store.read().projects.map(p => p.slug), ...RESERVED])
    let s = slugFrom(base)
    for (let i = 2; taken.has(s); i++) s = `${slugFrom(base).slice(0, 58)}-${i}`
    return s
  }

  /** Connect a GitHub repo ("owner/name", a github.com URL, or any git URL for tests): clone it for the app. */
  async addRepo(input: string, opts: { title?: string; branch?: string; slug?: string } = {}): Promise<Project> {
    const { repo, url } = parseRepo(input)
    if (this.store.read().projects.some(p => p.source.kind === "github" && p.source.repo === repo)) throw new AppError(409, `${repo} is already connected`)
    const slug = opts.slug && !RESERVED.includes(opts.slug) ? checkSlug(opts.slug, "project") : this.freeSlug(opts.slug || repo)
    const dir = this.clonePath(slug)
    mkdirSync(join(this.store.home, "repos"), { recursive: true })
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    try {
      await git(this.store.home, ["clone", "--filter=blob:none", "--no-tags", url, dir], { timeoutMs: 600_000 })
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      const msg = String((e as Error).message)
      if (/not found|could not read|Authentication|403|404/i.test(msg)) throw new AppError(404, `could not clone ${repo}: is the name right, and can this machine's git reach it?`)
      throw new AppError(502, `could not clone ${repo}: ${msg.slice(0, 200)}`)
    }
    const head = (await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { ok: [1, 128] })).stdout.trim()
    const branch = opts.branch || head.replace(/^origin\//, "") || "main"
    // tracking starts now: the sync drafts from the commits that land after connecting, not the project's whole past
    const checkedThrough = (await revParse(dir, `origin/${branch}`)) ?? undefined
    const project: Project = { slug, title: opts.title || repo.split("/").pop()!, source: { kind: "github", repo, url, branch }, addedAt: Date.now(), checkedThrough }
    this.store.update(c => {
      c.projects.push(project)
    })
    return project
  }

  /** Connect a local folder; its diagrams are read and written in `<path>/.archdraw/`. */
  addFolder(path: string, opts: { title?: string; slug?: string } = {}): Project {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new AppError(404, `no folder ${path}`)
    const slug = opts.slug && !RESERVED.includes(opts.slug) ? checkSlug(opts.slug, "project") : this.freeSlug(opts.slug || path)
    const project: Project = { slug, title: opts.title || path.split("/").filter(Boolean).pop()!, source: { kind: "folder", path }, addedAt: Date.now() }
    mkdirSync(join(path, DIAGRAM_DIR), { recursive: true })
    this.store.update(c => {
      c.projects.push(project)
    })
    return project
  }

  /** Forget a project. The clone and worktree the app made are removed; the repo itself is untouched. */
  async disconnect(slug: string): Promise<void> {
    const p = this.get(slug)
    await this.locks.run(slug, async () => {
      if (p.source.kind === "github") {
        rmSync(this.workPath(slug), { recursive: true, force: true })
        rmSync(this.clonePath(slug), { recursive: true, force: true })
      }
      this.store.update(c => {
        c.projects = c.projects.filter(x => x.slug !== slug)
      })
    })
  }

  setProject(slug: string, patch: Partial<Pick<Project, "title" | "archived" | "settings">>): Project {
    this.get(slug)
    const c = this.store.update(c => {
      const p = c.projects.find(x => x.slug === slug)!
      if (patch.title !== undefined) p.title = patch.title.trim().slice(0, 80) || p.title
      if (patch.archived !== undefined) p.archived = patch.archived
      if (patch.settings !== undefined) p.settings = { ...p.settings, ...patch.settings }
    })
    return c.projects.find(x => x.slug === slug)!
  }

  // -- reading ---------------------------------------------------------------------------------------------------

  /** Fetch the branch and the pending update from the remote; the clone's tree follows the branch. */
  async refresh(slug: string): Promise<void> {
    const p = this.get(slug)
    if (p.source.kind !== "github") return
    const s = p.source
    await this.locks.run(slug, async () => {
      const dir = this.clonePath(slug)
      // the branch must arrive (a failure is an error); the update branch may not exist, so it is fetched on its own
      await git(dir, ["fetch", "--prune", "origin", `+refs/heads/${s.branch}:refs/remotes/origin/${s.branch}`], { timeoutMs: 300_000 })
      const upd = await git(dir, ["fetch", "origin", `+refs/heads/${UPDATE_BRANCH}:refs/remotes/origin/${UPDATE_BRANCH}`], { ok: [1, 128] })
      if (upd.code !== 0) await git(dir, ["update-ref", "-d", `refs/remotes/origin/${UPDATE_BRANCH}`], { ok: [1] })
      if (!(await revParse(dir, `origin/${UPDATE_BRANCH}`))) await git(dir, ["update-ref", "-d", `refs/remotes/origin/${UPDATE_BRANCH}`], { ok: [1] })
      await git(dir, ["checkout", "--quiet", "--detach", `origin/${s.branch}`])
    })
  }

  /** The two revisions a GitHub project shows: what is published (base) and what is waiting (head), if anything. */
  async revisions(slug: string): Promise<{ base: string; head: string | null }> {
    const p = this.get(slug)
    if (p.source.kind !== "github") return { base: "", head: null }
    const dir = this.clonePath(slug)
    const base = (await revParse(dir, `origin/${p.source.branch}`)) ?? ""
    const head = await revParse(dir, `origin/${UPDATE_BRANCH}`)
    return { base, head: head && head !== base ? head : null }
  }

  private async namesAt(dir: string, rev: string): Promise<string[]> {
    return (await lsTree(dir, rev, DIAGRAM_DIR)).filter(f => f.endsWith(EXT)).map(f => f.slice(0, -EXT.length))
  }

  private folderDir(p: Project) {
    return join((p.source as { path: string }).path, DIAGRAM_DIR)
  }

  /** The project's diagrams as they stand with any waiting changes, each marked against what is published. */
  async files(slug: string): Promise<DiagramMeta[]> {
    const p = this.get(slug)
    let rows: DiagramMeta[]
    let order: string[] = []
    if (p.source.kind === "folder") {
      const dir = this.folderDir(p)
      const names = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(EXT)).map(f => f.slice(0, -EXT.length)) : []
      rows = names.map(name => {
        const file = join(dir, name + EXT)
        const source = readFileSync(file, "utf8")
        const m = meta(source)
        return { name, title: m.title ?? name, summary: m.summary ?? "", updated: statSync(file).mtimeMs / 1000, version: digest(source), status: "same" as const, bytes: Buffer.byteLength(source) }
      })
      order = readOrder(existsSync(join(dir, "order.json")) ? readFileSync(join(dir, "order.json"), "utf8") : null)
    } else {
      const dir = this.clonePath(slug)
      const { base, head } = await this.revisions(slug)
      if (!base) return []
      const rev = head ?? base
      const names = await this.namesAt(dir, rev)
      const baseNames = new Set(head ? await this.namesAt(dir, base) : names)
      rows = []
      for (const name of names) {
        const path = `${DIAGRAM_DIR}/${name}${EXT}`
        const source = (await show(dir, rev, path)) ?? ""
        let status: FileStatus = "same"
        if (head) status = !baseNames.has(name) ? "added" : (await show(dir, base, path)) === source ? "same" : "changed"
        const m = meta(source)
        rows.push({ name, title: m.title ?? name, summary: m.summary ?? "", updated: await lastChange(dir, rev, path), version: digest(source), status, bytes: Buffer.byteLength(source) })
      }
      order = readOrder(await show(dir, rev, `${DIAGRAM_DIR}/order.json`))
    }
    rows.sort((a, b) => rank(order, a.name) - rank(order, b.name) || a.name.localeCompare(b.name))
    return rows
  }

  /** One diagram (with its explanation .md, if any), as it stands with waiting changes, or at `at` = "base". */
  async read(slug: string, name: string, at: "head" | "base" = "head"): Promise<DiagramDoc> {
    checkSlug(name, "diagram name")
    const p = this.get(slug)
    let source: string | null
    let doc: string | null
    if (p.source.kind === "folder") {
      const file = join(this.folderDir(p), name + EXT)
      source = existsSync(file) ? readFileSync(file, "utf8") : null
      const md = join(this.folderDir(p), name + ".md")
      doc = existsSync(md) ? readFileSync(md, "utf8") : null
    } else {
      const { base, head } = await this.revisions(slug)
      const rev = at === "base" ? base : (head ?? base)
      const dir = this.clonePath(slug)
      source = rev ? await show(dir, rev, `${DIAGRAM_DIR}/${name}${EXT}`) : null
      doc = rev ? await show(dir, rev, `${DIAGRAM_DIR}/${name}.md`) : null
    }
    if (source === null) throw new AppError(404, `no diagram ${slug}/${name}`)
    return { project: slug, name, source, version: digest(source), doc, ...meta(source) }
  }

  // -- writing ---------------------------------------------------------------------------------------------------

  /** The worktree on the update branch, created from the published branch (or the existing update) when needed. */
  private async worktree(p: Project): Promise<string> {
    const s = p.source as { branch: string }
    const clone = this.clonePath(p.slug)
    const work = this.workPath(p.slug)
    const remoteUpdate = await revParse(clone, `origin/${UPDATE_BRANCH}`)
    const start = remoteUpdate ?? `origin/${s.branch}`
    if (!existsSync(join(work, ".git"))) {
      rmSync(work, { recursive: true, force: true })
      mkdirSync(join(this.store.home, "work"), { recursive: true })
      await git(clone, ["worktree", "prune"])
      await git(clone, ["worktree", "add", "--force", "-B", UPDATE_BRANCH, work, start])
    } else {
      // the worktree always restarts from what the remote has: another device may have pushed the update
      await git(work, ["checkout", "--quiet", "-B", UPDATE_BRANCH, start])
      await git(work, ["reset", "--quiet", "--hard", start])
      await git(work, ["clean", "-fdq", "--", DIAGRAM_DIR])
    }
    await git(work, ["config", "user.name", this.by])
    await git(work, ["config", "user.email", "archdraw@users.noreply.github.com"])
    return work
  }

  /** Commit the worktree's changes under .archdraw/ and push the update branch (compare-and-swap on the remote). */
  private async commitAndPush(p: Project, work: string, message: string): Promise<string | null> {
    await git(work, ["add", "-A", "--", DIAGRAM_DIR])
    const staged = await git(work, ["diff", "--cached", "--quiet"], { ok: [1] })
    if (staged.code === 0) return null
    // one trailer block: when the message already ends in trailers (Archdraw-Base: …), Agent joins them
    const trailing = /\n[A-Za-z][A-Za-z-]*: \S[^\n]*$/.test(message)
    await git(work, ["commit", "--quiet", "-m", `${message}${trailing ? "\n" : "\n\n"}Agent: ${this.by}`])
    const sha = (await git(work, ["rev-parse", "HEAD"])).stdout.trim()
    const clone = this.clonePath(p.slug)
    const expected = (await revParse(clone, `origin/${UPDATE_BRANCH}`)) ?? ""
    try {
      await git(work, ["push", `--force-with-lease=refs/heads/${UPDATE_BRANCH}:${expected}`, "origin", `HEAD:refs/heads/${UPDATE_BRANCH}`], { timeoutMs: 300_000 })
    } catch (e) {
      throw new AppError(409, `another device changed this project's waiting update first; reload and try again (${String((e as Error).message).slice(0, 120)})`)
    }
    await git(clone, ["update-ref", `refs/remotes/origin/${UPDATE_BRANCH}`, sha])
    return sha
  }

  /**
   * Write one diagram (and optionally its .md). `base` is the version the editor started from: null for a new file,
   * refused when the file exists; a version that no longer matches is refused too (409), so nothing is overwritten
   * unseen. The engine checks the source first.
   */
  async save(slug: string, name: string, source: string, base: string | null, opts: { doc?: string | null; message?: string } = {}): Promise<{ version: string; commit: string | null }> {
    checkSlug(name, "diagram name")
    if (Buffer.byteLength(source) > MAX_BYTES) throw new AppError(413, `a diagram is at most ${MAX_BYTES} bytes`)
    const error = check(source)
    if (error) throw new AppError(422, error)
    if (!source.endsWith("\n")) source += "\n"
    const p = this.get(slug)
    return this.locks.run(slug, async () => {
      let current: string | null = null
      try {
        current = (await this.read(slug, name)).source
      } catch (e) {
        if (!(e instanceof AppError && e.status === 404)) throw e
      }
      if (base === null && current !== null) throw new AppError(409, `${slug}/${name} already exists; open it to edit it`)
      if (base !== null && current === null) throw new AppError(409, "the diagram was removed since you opened it")
      if (base !== null && current !== null && digest(current) !== base) throw new AppError(409, "the diagram changed since you opened it; your edit is kept in the editor")
      const message = opts.message ?? `archdraw: ${current === null ? "new diagram" : "edit"} ${name}`
      if (p.source.kind === "folder") {
        const dir = this.folderDir(p)
        mkdirSync(dir, { recursive: true })
        atomicWrite(join(dir, name + EXT), source)
        if (opts.doc != null) atomicWrite(join(dir, name + ".md"), opts.doc)
        return { version: digest(source), commit: null }
      }
      const work = await this.worktree(p)
      mkdirSync(join(work, DIAGRAM_DIR), { recursive: true })
      writeFileSync(join(work, DIAGRAM_DIR, name + EXT), source)
      if (opts.doc != null) writeFileSync(join(work, DIAGRAM_DIR, name + ".md"), opts.doc)
      const commit = await this.commitAndPush(p, work, message)
      return { version: digest(source), commit }
    })
  }

  /** Rename a diagram, fixing the `#/<project>/<old>` links other diagrams have to it. */
  async rename(slug: string, from: string, to: string): Promise<void> {
    checkSlug(from, "diagram name")
    checkSlug(to, "new name")
    if (from === to) return
    await this.mutate(slug, `archdraw: rename ${from} to ${to}`, async dir => {
      const src = join(dir, from + EXT)
      if (!existsSync(src)) throw new AppError(404, `no diagram ${from}`)
      if (existsSync(join(dir, to + EXT))) throw new AppError(409, `${to} already exists`)
      renameSync(src, join(dir, to + EXT))
      if (existsSync(join(dir, from + ".md"))) renameSync(join(dir, from + ".md"), join(dir, to + ".md"))
      const link = new RegExp(`#/${slug}/${from}(?![a-z0-9-])`, "g")
      for (const f of readdirSync(dir).filter(f => f.endsWith(EXT))) {
        const text = readFileSync(join(dir, f), "utf8")
        if (link.test(text)) writeFileSync(join(dir, f), text.replace(link, `#/${slug}/${to}`))
      }
      renameInOrder(dir, from, to)
    })
  }

  async duplicate(slug: string, from: string, to: string): Promise<void> {
    checkSlug(to, "new name")
    await this.mutate(slug, `archdraw: duplicate ${from} as ${to}`, async dir => {
      const src = join(dir, from + EXT)
      if (!existsSync(src)) throw new AppError(404, `no diagram ${from}`)
      if (existsSync(join(dir, to + EXT))) throw new AppError(409, `${to} already exists`)
      const text = readFileSync(src, "utf8").replace(/^(\/\/\s*title\s*:\s*)(.+)$/m, "$1$2 (copy)")
      writeFileSync(join(dir, to + EXT), text)
    })
  }

  /** Archive: the diagram moves to `.archdraw/archive/`, out of the canvas, one click to bring back. */
  async archive(slug: string, name: string, back = false): Promise<void> {
    await this.mutate(slug, `archdraw: ${back ? "restore" : "archive"} ${name}`, async dir => {
      const arch = join(dir, "archive")
      const [from, to] = back ? [arch, dir] : [dir, arch]
      if (!existsSync(join(from, name + EXT))) throw new AppError(404, `no ${back ? "archived " : ""}diagram ${name}`)
      if (existsSync(join(to, name + EXT))) throw new AppError(409, `${name} already exists there`)
      mkdirSync(to, { recursive: true })
      for (const ext of [EXT, ".md"]) if (existsSync(join(from, name + ext))) renameSync(join(from, name + ext), join(to, name + ext))
    })
  }

  async archived(slug: string): Promise<string[]> {
    const p = this.get(slug)
    if (p.source.kind === "folder") {
      const d = join(this.folderDir(p), "archive")
      return existsSync(d) ? readdirSync(d).filter(f => f.endsWith(EXT)).map(f => f.slice(0, -EXT.length)) : []
    }
    const { base, head } = await this.revisions(slug)
    return (await lsTree(this.clonePath(slug), head ?? base, `${DIAGRAM_DIR}/archive`)).filter(f => f.endsWith(EXT)).map(f => f.slice(0, -EXT.length))
  }

  /** Delete: the file is removed in a commit, so it stays in git history; `trash` lists those and `restore` brings one back. */
  async remove(slug: string, name: string): Promise<void> {
    await this.mutate(slug, `archdraw: delete ${name}`, async dir => {
      if (!existsSync(join(dir, name + EXT))) throw new AppError(404, `no diagram ${name}`)
      for (const ext of [EXT, ".md"]) if (existsSync(join(dir, name + ext))) unlinkSync(join(dir, name + ext))
    })
  }

  /** Diagrams deleted in the last 30 days of the project's history (GitHub projects only). */
  async trash(slug: string): Promise<{ name: string; deletedAt: number; commit: string }[]> {
    const p = this.get(slug)
    if (p.source.kind !== "github") return []
    const { base, head } = await this.revisions(slug)
    const rev = head ?? base
    const r = await git(this.clonePath(slug), ["log", "--since=30.days", "--diff-filter=D", "--name-only", "--format=@%H %ct", rev, "--", `${DIAGRAM_DIR}/*${EXT}`], { ok: [128] })
    const out: { name: string; deletedAt: number; commit: string }[] = []
    const alive = new Set(await this.namesAt(this.clonePath(slug), rev))
    let commit = ""
    let at = 0
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("@")) [commit, at] = [line.slice(1).split(" ")[0], Number(line.split(" ")[1])]
      else if (line.startsWith(`${DIAGRAM_DIR}/`) && !line.includes("/archive/")) {
        const name = line.slice(DIAGRAM_DIR.length + 1, -EXT.length)
        if (!alive.has(name) && !out.some(o => o.name === name)) out.push({ name, deletedAt: at, commit })
      }
    }
    return out
  }

  async restore(slug: string, name: string): Promise<void> {
    const gone = (await this.trash(slug)).find(t => t.name === name)
    if (!gone) throw new AppError(404, `${name} is not in the trash`)
    const clone = this.clonePath(slug)
    const text = await show(clone, `${gone.commit}^`, `${DIAGRAM_DIR}/${name}${EXT}`)
    const doc = await show(clone, `${gone.commit}^`, `${DIAGRAM_DIR}/${name}.md`)
    if (text === null) throw new AppError(404, `cannot find ${name} before it was deleted`)
    await this.mutate(slug, `archdraw: restore ${name}`, async dir => {
      writeFileSync(join(dir, name + EXT), text)
      if (doc !== null) writeFileSync(join(dir, name + ".md"), doc)
    })
  }

  /** Run a file change in the project's `.archdraw/` folder (the worktree for a GitHub project) and commit it. */
  private async mutate(slug: string, message: string, change: (dir: string) => Promise<void>): Promise<void> {
    const p = this.get(slug)
    await this.locks.run(slug, async () => {
      if (p.source.kind === "folder") return change(this.folderDir(p))
      const work = await this.worktree(p)
      mkdirSync(join(work, DIAGRAM_DIR), { recursive: true })
      await change(join(work, DIAGRAM_DIR))
      await this.commitAndPush(p, work, message)
    })
  }

  // -- the waiting update ----------------------------------------------------------------------------------------

  /** What waits to be published: the files changed since the branch, and the pull request if one is open. */
  async pending(slug: string): Promise<Pending | null> {
    const p = this.get(slug)
    if (p.source.kind !== "github") return null
    const { base, head } = await this.revisions(slug)
    if (!head) return null
    const dir = this.clonePath(slug)
    const mb = (await git(dir, ["merge-base", base, head])).stdout.trim()
    const behind = Number((await git(dir, ["rev-list", "--count", `${mb}..${base}`])).stdout.trim()) || 0
    const r = await git(dir, ["diff", "--name-status", "--no-renames", mb, head, "--", `${DIAGRAM_DIR}/*${EXT}`])
    const files = r.stdout
      .split("\n")
      .filter(Boolean)
      .map(l => {
        const [st, path] = l.split("\t")
        return { name: path.slice(DIAGRAM_DIR.length + 1, -EXT.length), status: (st === "A" ? "added" : st === "D" ? "removed" : "changed") as "added" | "changed" | "removed" }
      })
      .filter(f => !f.name.includes("/"))
    return { head, base, behind, files, pr: await this.prOf(p, head) }
  }

  private prCache = new Map<string, { at: number; head: string; pr: { number: number; url: string; state: string } | null }>()

  /** The waiting update's pull request, if the repo is on GitHub; remembered for a minute per head (it is a network call). */
  private async prOf(p: Project, head: string) {
    if (!this.forge || p.source.kind !== "github" || p.source.repo.startsWith("local/")) return null
    const hit = this.prCache.get(p.slug)
    if (hit && hit.head === head && Date.now() - hit.at < 60_000) return hit.pr
    const pr = await this.forge.pullRequest(p, this.clonePath(p.slug)).catch(() => null)
    this.prCache.set(p.slug, { at: Date.now(), head, pr })
    return pr
  }

  /** Publish the waiting update: merge its pull request, or push it onto the branch when the project publishes directly. */
  async approve(slug: string): Promise<{ published: string }> {
    const p = this.get(slug)
    if (p.source.kind !== "github") throw new AppError(400, "a folder project has nothing waiting")
    const s = p.source
    // a repo that is not on GitHub (a plain git remote) has no pull requests: publishing pushes to its branch
    const mode = !this.forge || s.repo.startsWith("local/") ? "direct" : this.store.settingsFor(slug).publish
    return this.locks.run(slug, async () => {
      const { head } = await this.revisions(slug)
      if (!head) throw new AppError(409, "nothing is waiting")
      const dir = this.clonePath(slug)
      if (mode === "direct") {
        await git(dir, ["push", "origin", `${head}:refs/heads/${s.branch}`], { timeoutMs: 300_000 }).catch(e => {
          throw new AppError(409, `could not push onto ${s.branch} (it moved, or it is protected): ${String(e.message).slice(0, 160)}`)
        })
        await git(dir, ["push", "origin", "--delete", UPDATE_BRANCH], { ok: [1] })
      } else {
        if (!this.forge) throw new AppError(501, "this build cannot open pull requests; set the project to publish directly")
        const pr = await this.forge.ensurePullRequest(p, dir, "archdraw: architecture update", "The architecture diagrams in `.archdraw/`, updated by archdraw.")
        await this.forge.merge(p, dir, pr.number, "archdraw: architecture update")
      }
      await git(dir, ["update-ref", "-d", `refs/remotes/origin/${UPDATE_BRANCH}`], { ok: [1] })
      return { published: head }
    }).then(async r => {
      await this.refresh(slug)
      return r
    })
  }

  /** Throw the waiting update away: close its pull request and delete the branch. */
  async discard(slug: string): Promise<void> {
    const p = this.get(slug)
    if (p.source.kind !== "github") return
    await this.locks.run(slug, async () => {
      const dir = this.clonePath(slug)
      const pr = this.forge ? await this.forge.pullRequest(p, dir).catch(() => null) : null
      if (pr && pr.state === "OPEN" && this.forge) await this.forge.close(p, dir, pr.number)
      await git(dir, ["push", "origin", "--delete", UPDATE_BRANCH], { ok: [1] })
      await git(dir, ["update-ref", "-d", `refs/remotes/origin/${UPDATE_BRANCH}`], { ok: [1] })
      rmSync(this.workPath(slug), { recursive: true, force: true })
      await git(dir, ["worktree", "prune"])
      await git(dir, ["branch", "-D", UPDATE_BRANCH], { ok: [1] })
    })
  }

  /** Open (or update) the pull request for the waiting update, so it can be read on GitHub too. */
  async openPullRequest(slug: string): Promise<{ number: number; url: string; state: string }> {
    const p = this.get(slug)
    if (!this.forge || p.source.kind !== "github") throw new AppError(501, "no pull requests for this project")
    const dir = this.clonePath(slug)
    return this.forge.ensurePullRequest(p, dir, "archdraw: architecture update", "The architecture diagrams in `.archdraw/`, updated by archdraw. Review it in archdraw's inbox, or here.")
  }
}

export function parseRepo(input: string): { repo: string; url: string } {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "")
  const gh = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s)
  if (gh && !s.startsWith("/") && !s.startsWith("file:")) return { repo: `${gh[1]}/${gh[2]}`, url: `https://github.com/${gh[1]}/${gh[2]}.git` }
  if (/^(file:\/\/|\/)/.test(input.trim())) {
    const path = input.trim().replace(/^file:\/\//, "")
    return { repo: `local/${path.split("/").filter(Boolean).pop()!.replace(/\.git$/, "")}`, url: path }
  }
  throw new AppError(400, `"${input}" is not a GitHub repo: write owner/name or paste its URL`)
}

function readOrder(text: string | null): string[] {
  try {
    const v = JSON.parse(text ?? "null")
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

const rank = (order: string[], name: string) => (order.includes(name) ? order.indexOf(name) : order.length)

function renameInOrder(dir: string, from: string, to: string) {
  const f = join(dir, "order.json")
  if (!existsSync(f)) return
  const order = readOrder(readFileSync(f, "utf8"))
  if (order.includes(from)) writeFileSync(f, JSON.stringify(order.map(n => (n === from ? to : n)), null, 1) + "\n")
}

function atomicWrite(file: string, text: string) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
