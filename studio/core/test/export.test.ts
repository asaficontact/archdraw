import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unzipSync, strFromU8 } from "fflate"
import { describe, expect, it } from "vitest"
import { Store } from "../src/config.js"
import { bundle, zip } from "../src/export.js"
import { Library } from "../src/library.js"

const SYSTEM = '// title: The system\n// summary: Everything.\n\nstyle dim  text: (color: theme-muted)\nnode web "Web / [dim]SvelteKit[/dim]"\nnode api "API" right of web\nnode db "DB" right of api  badge: database\nedge web -> api "calls" from: right to: left\nedge api -> db from: right to: left\n'

describe("export", () => {
  it("bundles an entry doc, per-diagram docs with every part and connection as text, svg, graph json", async () => {
    const root = mkdtempSync(join(tmpdir(), "archdraw-export-"))
    const dir = join(root, "proj")
    mkdirSync(join(dir, ".archdraw"), { recursive: true })
    writeFileSync(join(dir, ".archdraw", "system.archdraw"), SYSTEM)
    writeFileSync(join(dir, ".archdraw", "system.md"), "# The system\n\n## Purpose\n\nShows how a request reaches the DB.\n")
    writeFileSync(join(dir, ".archdraw", "README.md"), "# Proj\n\n## What this is\n\nA shop.\n\n## Non-goals\n\nNo payments yet.\n")
    const lib = new Library(new Store(join(root, "home")), null)
    lib.addFolder(dir, { slug: "proj", title: "Proj" })
    const b = await bundle(lib, "proj", { now: new Date("2026-10-04T00:00:00Z") })
    expect(Object.keys(b.files).sort()).toEqual([
      "ARCHITECTURE.md",
      "architecture.json",
      "diagrams/system/system.archdraw",
      "diagrams/system/system.graph.json",
      "diagrams/system/system.md",
      "diagrams/system/system.svg",
      "manifest.json",
    ])
    const arch = b.files["ARCHITECTURE.md"]
    expect(arch).toContain("## Non-goals")
    expect(arch).toContain("- [The system](diagrams/system/system.md): Everything.")
    const md = b.files["diagrams/system/system.md"]
    expect(md).toContain("Shows how a request reaches the DB.")
    expect(md).toContain("| `web` | Web | SvelteKit |")
    expect(md).toContain("- `web` → `api`: calls")
    expect(md).toContain("## Open questions") // api → db has no label
    expect(b.files["diagrams/system/system.svg"]).toMatch(/^<svg/)
    const unzipped = unzipSync(zip(b))
    expect(strFromU8(unzipped[`${b.root}/ARCHITECTURE.md`])).toBe(arch)
  })
})
