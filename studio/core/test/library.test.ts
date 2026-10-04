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
    expect(parseRepo("asaficontact/ohara")).toEqual({ repo: "asaficontact/ohara", url: "https://github.com/asaficontact/ohara.git", ssh: "git@github.com:asaficontact/ohara.git" })
    expect(parseRepo("git@github.com:a/b.git").url).toBe("git@github.com:a/b.git") // an SSH address is tried as SSH first
    expect(() => parseRepo("file://--upload-pack=touch /tmp/x")).toThrow(AppError) // never an option to git
    expect(() => parseRepo("-c/x")).toThrow(AppError)
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
      ["system", "The system", "same"], // system first, then the rest (no order.json)
      ["detail", "Detail", "same"],
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
    expect((await l.files("demo")).map(f => f.name)).toEqual(["system", "detail"])
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

describe("publishing safely (review of #2)", () => {
  it("refuses an explicit slug that is taken, and the sample's slug", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    const other = join(root, "other.git")
    sh(root, "clone", "-q", "--bare", origin, other)
    await expect(l.addRepo(other, { slug: "demo" })).rejects.toMatchObject({ status: 409 })
    expect((await l.addRepo(other, { slug: "bean-there" })).slug).not.toBe("bean-there")
  })

  it("approves and discards only the head the user saw", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    await l.refresh("demo")
    l.store.update(c => {
      c.settings.publish = "direct"
    })
    await l.save("demo", "one", '// title: One\n\nnode x "X"\n', null)
    const seen = (await l.pending("demo"))!.head
    await l.save("demo", "two", '// title: Two\n\nnode y "Y"\n', null) // lands after the user looked
    await expect(l.approve("demo", seen)).rejects.toMatchObject({ status: 409 })
    await expect(l.discard("demo", seen)).rejects.toMatchObject({ status: 409 })
    const now = (await l.pending("demo"))!.head
    await l.approve("demo", now)
    expect(sh(origin, "ls-tree", "--name-only", "main:.archdraw").split("\n")).toEqual(expect.arrayContaining(["one.archdraw", "two.archdraw"]))
  })

  it("approving after main moved merges main into the update first", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    await l.refresh("demo")
    l.store.update(c => {
      c.settings.publish = "direct"
    })
    await l.save("demo", "one", '// title: One\n\nnode x "X"\n', null)
    // someone pushes code to main meanwhile
    const other = join(root, "dev")
    sh(root, "clone", "-q", origin, other)
    writeFileSync(join(other, "code.ts"), "export const x = 1\n")
    sh(other, "add", "-A")
    sh(other, "commit", "-q", "-m", "code")
    sh(other, "push", "-q", "origin", "main")
    await l.approve("demo")
    expect(sh(origin, "show", "main:code.ts")).toContain("x = 1")
    expect(sh(origin, "ls-tree", "--name-only", "main:.archdraw")).toContain("one.archdraw")
  })

  it("a push without permission says so, not that another device was first", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    await l.refresh("demo")
    writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho 'remote: Permission to demo denied' >&2\nexit 1\n", { mode: 0o755 })
    await expect(l.save("demo", "one", '// title: One\n\nnode x "X"\n', null)).rejects.toMatchObject({ status: 403, message: expect.stringContaining("pre-receive hook declined") })
  })
})

describe("commit identity", () => {
  it("commits as this machine's git user, so a host like Vercel builds it; a made-up address only without one (ohara#135)", async () => {
    const was = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM, e: process.env.ARCHDRAW_AUTHOR_EMAIL }
    delete process.env.ARCHDRAW_AUTHOR_EMAIL
    const cfg = join(root, "gitconfig")
    writeFileSync(cfg, "[user]\n\tname = Tawab\n\temail = tawab@example.com\n")
    process.env.GIT_CONFIG_GLOBAL = cfg
    process.env.GIT_CONFIG_NOSYSTEM = "1"
    try {
      const l = lib()
      await l.addRepo(origin, { slug: "demo" })
      await l.refresh("demo")
      await l.save("demo", "who", '// title: Who\n\nnode x "X"\n', null)
      expect(sh(origin, "log", "-1", "--format=%an <%ae>", "archdraw/update").trim()).toBe("Tawab <tawab@example.com>")
      writeFileSync(cfg, "")
      expect(await l.identity(root)).toEqual({ name: "test", email: "archdraw@users.noreply.github.com" })
      process.env.ARCHDRAW_AUTHOR_EMAIL = "banna@example.com"
      expect(await l.identity(root)).toEqual({ name: "test", email: "banna@example.com" })
    } finally {
      for (const [k, v] of [["GIT_CONFIG_GLOBAL", was.g], ["GIT_CONFIG_NOSYSTEM", was.n], ["ARCHDRAW_AUTHOR_EMAIL", was.e]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe("importing", () => {
  it("brings diagrams, explanations and order in as one waiting change, and refuses a broken diagram", async () => {
    const l = lib()
    await l.addRepo(origin, { slug: "demo" })
    await l.refresh("demo")
    await expect(l.importFiles("demo", { "bad.archdraw": 'node a "A" right of nowhere\n' }, "import")).rejects.toMatchObject({ status: 422 })
    await expect(l.importFiles("demo", { "../x.md": "x" }, "import")).rejects.toMatchObject({ status: 400 })
    await l.importFiles("demo", { "flow.archdraw": '// title: Flow\n\nnode a "A"\n', "flow.md": "# Flow\n", "order.json": '["flow","system"]' }, "archdraw: import the diagrams")
    expect((await l.files("demo")).map(f => f.name)).toEqual(["flow", "system", "detail"])
    expect(sh(origin, "log", "-1", "--format=%s", "archdraw/update").trim()).toBe("archdraw: import the diagrams")
    // third review of #2: a size limit, a checked order.json, and no silent overwrite
    await expect(l.importFiles("demo", { "big.md": "x".repeat(2_000_000) }, "import")).rejects.toMatchObject({ status: 413 })
    await expect(l.importFiles("demo", { "order.json": "{" }, "import")).rejects.toMatchObject({ status: 400 })
    await expect(l.importFiles("demo", { "order.json": "[1]" }, "import")).rejects.toMatchObject({ status: 400 })
    await expect(l.importFiles("demo", { "flow.archdraw": '// title: Flow 2\n\nnode b "B"\n' }, "import")).rejects.toMatchObject({ status: 409 })
    await expect(l.importFiles("demo", { "flow.md": "# Other\n" }, "import")).rejects.toMatchObject({ status: 409 })
    await l.importFiles("demo", { "flow.archdraw": '// title: Flow 2\n\nnode b "B"\n' }, "import again", { replace: true })
    expect((await l.read("demo", "flow")).source).toContain("Flow 2")
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

  it("keeps the reading order itself: new diagrams go last, system first", async () => {
    const dir = join(root, "ordered")
    mkdirSync(dir)
    const l = lib()
    l.addFolder(dir, { slug: "ordered" })
    await l.save("ordered", "zeta", '// title: Z\n\nnode z "Z"\n', null)
    await l.save("ordered", "alpha", '// title: A\n\nnode a "A"\n', null)
    expect((await l.files("ordered")).map(f => f.name)).toEqual(["zeta", "alpha"])
    expect(JSON.parse(readFileSync(join(dir, ".archdraw", "order.json"), "utf8"))).toEqual(["zeta", "alpha"])
    const bare = join(root, "bare")
    mkdirSync(join(bare, ".archdraw"), { recursive: true })
    for (const n of ["api", "system", "web"]) writeFileSync(join(bare, ".archdraw", `${n}.archdraw`), `// title: ${n}\n\nnode x "X"\n`)
    l.addFolder(bare, { slug: "bare" })
    expect((await l.files("bare")).map(f => f.name)).toEqual(["system", "api", "web"])
  })

  it("a project's first new diagram goes after the ones already there; a broken order.json is never rewritten (fourth review of #2)", async () => {
    const l = lib()
    const had = join(root, "had")
    mkdirSync(join(had, ".archdraw"), { recursive: true })
    for (const n of ["api", "system", "web"]) writeFileSync(join(had, ".archdraw", `${n}.archdraw`), `// title: ${n}\n\nnode x "X"\n`)
    l.addFolder(had, { slug: "had" })
    await l.save("had", "zeta", '// title: Z\n\nnode z "Z"\n', null)
    expect((await l.files("had")).map(f => f.name)).toEqual(["system", "api", "web", "zeta"])
    await l.duplicate("had", "api", "api-copy")
    await l.save("had", "later", '// title: L\n\nnode z "Z"\n', null)
    expect((await l.files("had")).map(f => f.name)).toEqual(["system", "api", "web", "zeta", "api-copy", "later"])
    await l.remove("had", "web")
    expect(JSON.parse(readFileSync(join(had, ".archdraw", "order.json"), "utf8"))).not.toContain("web")
    await l.archive("had", "zeta")
    await l.archive("had", "zeta", true)
    expect((await l.files("had")).map(f => f.name).at(-1)).toBe("zeta")

    const partial = join(root, "partial")
    mkdirSync(join(partial, ".archdraw"), { recursive: true })
    for (const n of ["api", "system", "web"]) writeFileSync(join(partial, ".archdraw", `${n}.archdraw`), `// title: ${n}\n\nnode x "X"\n`)
    writeFileSync(join(partial, ".archdraw", "order.json"), '["system"]')
    l.addFolder(partial, { slug: "partial" })
    await l.save("partial", "zeta", '// title: Z\n\nnode z "Z"\n', null)
    expect((await l.files("partial")).map(f => f.name)).toEqual(["system", "api", "web", "zeta"])

    const imp = join(root, "imp")
    mkdirSync(join(imp, ".archdraw"), { recursive: true })
    for (const n of ["api", "web"]) writeFileSync(join(imp, ".archdraw", `${n}.archdraw`), `// title: ${n}\n\nnode x "X"\n`)
    l.addFolder(imp, { slug: "imp" })
    await l.importFiles("imp", { "b.archdraw": '// title: B\n\nnode b "B"\n', "c.archdraw": '// title: C\n\nnode c "C"\n' }, "import")
    expect((await l.files("imp")).map(f => f.name)).toEqual(["api", "web", "b", "c"])

    const broken = join(root, "broken")
    mkdirSync(join(broken, ".archdraw"), { recursive: true })
    writeFileSync(join(broken, ".archdraw", "order.json"), "{mine")
    l.addFolder(broken, { slug: "broken" })
    await l.save("broken", "one", '// title: One\n\nnode x "X"\n', null)
    expect(readFileSync(join(broken, ".archdraw", "order.json"), "utf8")).toBe("{mine")
  })
})
