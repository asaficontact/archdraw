import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppError, Store } from "../src/config.js"
import { Library, digest, parseRepo } from "../src/library.js"

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })

const SYSTEM = '// title: The system\n// summary: Everything.\n\nnode web "Web"\nnode api "API" right of web\nedge web -> api "calls" from: right to: left\n'
const LINKER = '// title: Detail\n\nnode a "A"  url: "#/demo/system"\n'

let root: string
let origin: string

/** A bare "GitHub" repo with main holding .archdraw/system.archdraw and a link to it from detail. */
function makeOrigin(): string {
  const seed = join(root, "seed")
  mkdirSync(join(seed, ".archdraw"), { recursive: true })
  sh(seed, "init", "-q", "-b", "main")
  writeFileSync(join(seed, "README.md"), "# demo\n")
  writeFileSync(join(seed, ".archdraw", "system.archdraw"), SYSTEM)
  writeFileSync(join(seed, ".archdraw", "detail.archdraw"), LINKER)
  sh(seed, "add", "-A")
  sh(seed, "commit", "-q", "-m", "seed")
  const bare = join(root, "origin.git")
  sh(root, "clone", "-q", "--bare", seed, bare)
  return bare
}

function lib(home = join(root, "home")): Library {
  return new Library(new Store(home), null, "test")
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "archdraw-lib-"))
  origin = makeOrigin()
})
afterEach(() => {
  /* tmp is cleaned by the OS */
})

describe("parseRepo", () => {
  it("reads owner/name, URLs and local paths", () => {
    expect(parseRepo("asaficontact/ohara")).toEqual({ repo: "asaficontact/ohara", url: "https://github.com/asaficontact/ohara.git" })
    expect(parseRepo("https://github.com/a/b.git").repo).toBe("a/b")
    expect(parseRepo("git@github.com:a/b").repo).toBe("a/b")
    expect(parseRepo("/tmp/x/origin.git").url).toBe("/tmp/x/origin.git")
    expect(() => parseRepo("not a repo")).toThrow(AppError)
  })
})

describe("a GitHub project", () => {
  it("is cloned for the app and lists its diagrams with meta", async () => {
    const l = lib()
    const p = await l.addRepo(origin, { slug: "demo", title: "Demo" })
    expect(p.source).toMatchObject({ kind: "github", branch: "main" })
    await l.refresh("demo")
    const files = await l.files("demo")
    expect(files.map(f => [f.name, f.title, f.status])).toEqual([
      ["detail", "Detail", "same"],
      ["system", "The system", "same"],
    ])
    const doc = await l.read("demo", "system")
    expect(doc.source).toBe(SYSTEM)
    expect(doc.version).toBe(digest(SYSTEM))
    await expect(l.addRepo(origin)).rejects.toMatchObject({ status: 409 })
  })

  it("puts an edit on the waiting update, never on main, and approving publishes it", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    await l.refresh("demo")
    const edited = SYSTEM.replace('"API"', '"API server"')
    const r = await l.save("demo", "system", edited, digest(SYSTEM))
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(sh(origin, "show", "main:.archdraw/system.archdraw")).toBe(SYSTEM) // main untouched
    expect(sh(origin, "show", "archdraw/update:.archdraw/system.archdraw")).toBe(edited)
    expect((await l.files("demo")).find(f => f.name === "system")!.status).toBe("changed")
    expect((await l.read("demo", "system", "base")).source).toBe(SYSTEM)
    const pending = await l.pending("demo")
    expect(pending!.files).toEqual([{ name: "system", status: "changed" }])
    // publish directly (no forge in tests)
    l.store.update(c => {
      c.settings.publish = "direct"
    })
    await l.approve("demo")
    expect(sh(origin, "show", "main:.archdraw/system.archdraw")).toBe(edited)
    expect(sh(origin, "branch", "--list", "archdraw/update").trim()).toBe("")
    expect(await l.pending("demo")).toBeNull()
  })

  it("refuses an engine error, a stale base and a new file over an existing one", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    await l.refresh("demo")
    await expect(l.save("demo", "system", "node a \"A\" right of nowhere\n", digest(SYSTEM))).rejects.toMatchObject({ status: 422 })
    await expect(l.save("demo", "system", SYSTEM + "\n", "0000000000000000")).rejects.toMatchObject({ status: 409 })
    await expect(l.save("demo", "system", SYSTEM, null)).rejects.toMatchObject({ status: 409 })
    await l.save("demo", "fresh", '// title: Fresh\n\nnode x "X"\n', null)
    expect((await l.files("demo")).find(f => f.name === "fresh")!.status).toBe("added")
  })

  it("discarding drops the waiting update", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    await l.refresh("demo")
    await l.save("demo", "fresh", '// title: Fresh\n\nnode x "X"\n', null)
    await l.discard("demo")
    expect(await l.pending("demo")).toBeNull()
    expect((await l.files("demo")).map(f => f.name)).toEqual(["detail", "system"])
  })

  it("renames and fixes links, duplicates, archives, deletes to the trash and restores", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    await l.refresh("demo")
    await l.rename("demo", "system", "overview")
    expect((await l.read("demo", "detail")).source).toContain('url: "#/demo/overview"')
    await l.duplicate("demo", "overview", "overview-2")
    expect((await l.read("demo", "overview-2")).title).toBe("The system (copy)")
    await l.archive("demo", "overview-2")
    expect(await l.archived("demo")).toEqual(["overview-2"])
    expect((await l.files("demo")).map(f => f.name)).toEqual(["detail", "overview"])
    await l.archive("demo", "overview-2", true)
    await l.remove("demo", "overview-2")
    expect((await l.trash("demo")).map(t => t.name)).toEqual(["overview-2"])
    await l.restore("demo", "overview-2")
    expect((await l.files("demo")).map(f => f.name)).toContain("overview-2")
    expect(await l.trash("demo")).toEqual([])
  })

  it("two devices: the one that pushes second is told to reload, and nothing is lost", async () => {
    const a = lib(join(root, "home-a"))
    const b = lib(join(root, "home-b"))
    await a.addRepo(origin, { slug: "demo" })
    await b.addRepo(origin, { slug: "demo" })
    await a.refresh("demo")
    await b.refresh("demo")
    await a.save("demo", "one", '// title: One\n\nnode x "X"\n', null)
    // b has not fetched: its push would overwrite a's branch, and the lease refuses it
    await expect(b.save("demo", "two", '// title: Two\n\nnode y "Y"\n', null)).rejects.toMatchObject({ status: 409 })
    await b.refresh("demo")
    await b.save("demo", "two", '// title: Two\n\nnode y "Y"\n', null)
    expect(sh(origin, "ls-tree", "--name-only", "archdraw/update:.archdraw").split("\n")).toEqual(expect.arrayContaining(["one.archdraw", "two.archdraw"]))
  })

  it("disconnecting removes the app's clone, not the repo", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    await l.disconnect("demo")
    expect(existsSync(l.clonePath("demo"))).toBe(false)
    expect(sh(origin, "show", "main:.archdraw/system.archdraw")).toBe(SYSTEM)
  })
})

describe("a folder project", () => {
  it("reads and writes .archdraw/ in place", async () => {
    const dir = join(root, "local")
    mkdirSync(dir)
    const l = lib()
    l.addFolder(dir, { slug: "local" })
    await l.save("local", "system", SYSTEM, null, { doc: "# The system\n" })
    expect(readFileSync(join(dir, ".archdraw", "system.archdraw"), "utf8")).toBe(SYSTEM)
    expect((await l.read("local", "system")).doc).toBe("# The system\n")
    await l.rename("local", "system", "overview")
    expect((await l.files("local")).map(f => f.name)).toEqual(["overview"])
  })
})
