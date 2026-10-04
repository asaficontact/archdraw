import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { diff, graph, outline, plain } from "../src/graph.js"

const A = `// title: Shop
// summary: How an order flows.

node web "Web / [dim]SvelteKit[/dim]"
node api "API" right of web
node db "Orders" right of api  badge: database
node old "Fax intake" below web
edge web -> api "calls" from: right to: left
edge api -> db "writes" from: right to: left
edge old -> api "faxes" from: right to: bottom
`
const B = `// title: Shop
// summary: How an order flows.

node web "Web / [dim]SvelteKit 5[/dim]"
node api "API" right of web
node db "Orders" right of api  badge: database
node pay "Payments" below api
edge web -> api "HTTPS" from: right to: left
edge api -> db "writes" from: right to: left
edge api -> pay "charges" from: bottom to: top
`

describe("graph", () => {
  it("reads labels, details, parents and roles from the source", () => {
    expect(plain("Pipeline run / [dim]5 stages[/dim]")).toEqual({ label: "Pipeline run", detail: "5 stages" })
    const g = graph(A)
    expect(g.title).toBe("Shop")
    expect(g.nodes.find(n => n.id === "web")).toMatchObject({ label: "Web", detail: "SvelteKit" })
    expect(g.nodes.find(n => n.id === "db")!.badge).toBe("database")
    expect(g.edges.map(e => e.id)).toEqual(["web->api:calls", "api->db:writes", "old->api:faxes"])
  })

  it("diffs node by node and edge by edge", () => {
    const d = diff(graph(A), graph(B))
    const rows = d.changes.map(c => `${c.on} ${c.kind} ${c.id}`)
    expect(rows).toEqual(expect.arrayContaining(["node removed old", "node added pay", "node changed web", "edge changed web->api:HTTPS", "edge added api->pay:charges"]))
    expect(rows).not.toContain("edge removed old->api:faxes") // it went with its node
    expect(d).toMatchObject({ added: 2, removed: 1, changed: 2 })
  })

  it("outlines a real house diagram as text an agent can read", () => {
    const src = readFileSync(new URL("../assets/sample/bean-there/main/overview.archdraw", import.meta.url), "utf8")
    const o = outline(graph(src))
    expect(o).toContain("Parts:")
    expect(o).toMatch(/Connections:\n- \S+ → \S+/)
    expect(diff(graph(src), graph(src)).changes).toEqual([])
  })
})
