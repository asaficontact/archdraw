import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModels } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { Conversations } from "../src/agent.js"
import { Store } from "../src/config.js"
import { Library } from "../src/library.js"
import { MemoryKeys } from "../src/models.js"
import { installSample } from "../src/sample.js"
import { Spend } from "../src/spend.js"

describe("the sample", () => {
  it("is a real git project with a waiting update, and its agent answers without a key", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "archdraw-sample-")))
    const lib = new Library(store, null)
    const p = await installSample(lib)
    expect(p).toMatchObject({ slug: "bean-there", sample: true, settings: { syncEveryMinutes: 0 } })
    expect((await lib.files("bean-there")).map(f => f.name).sort()).toEqual(["ordering", "overview", "payments"])
    expect((await lib.pending("bean-there"))!.files).toEqual([{ name: "overview", status: "changed" }])
    expect((await lib.read("bean-there", "overview", "base")).source).toContain("Fax orders")
    // reinstalling resets it
    await installSample(lib)
    expect(store.read().projects.filter(x => x.slug === "bean-there")).toHaveLength(1)

    const talks = new Conversations({ store, lib, keys: new MemoryKeys(), models: createModels(), spend: new Spend(store) })
    const c = talks.open("bean-there")
    c.say("Add a loyalty program")
    for (let i = 0; i < 100 && !c.events.some(e => e.type === "settled"); i++) await new Promise(r => setTimeout(r, 20))
    const prop = c.events.find(e => e.type === "proposal") as { source: string } | undefined
    expect(prop?.source).toContain("Loyalty service")
    expect((c.events.find(e => e.type === "assistant") as unknown as { text: string }).text).toContain("Demo · scripted reply, no AI used")
    expect(c.summary().model).toContain("demo")
  })
})
