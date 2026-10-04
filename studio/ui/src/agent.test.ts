import { describe, expect, it } from "vitest"
import { diffCount, hunks, lineDiff, looksLikeAsk, prose, rank, score, transcript, type AgentEvent, type Target } from "./agent"

const ev = (type: string, extra: Record<string, unknown> = {}, n = 0): AgentEvent => ({ n, at: 0, type, ...extra })

describe("transcript", () => {
  it("builds a message from deltas and replaces them with the completed text", () => {
    const t = transcript([
      ev("user", { text: "draw it" }, 0),
      ev("assistant_start", { id: "m1" }, 1),
      ev("delta", { id: "m1", text: "Hel" }, 2),
      ev("delta", { id: "m1", text: "lo" }, 3),
    ])
    expect(t.turns.map(x => x.kind)).toEqual(["user", "agent"])
    expect(t.turns[1]).toMatchObject({ text: "Hello", done: false })
    expect(t.busy).toBe(true)
    const done = transcript([ev("user", { text: "x" }), ev("assistant_start", { id: "m1" }), ev("delta", { id: "m1", text: "Hel" }), ev("assistant", { id: "m1", text: "Hello." }), ev("settled")])
    expect(done.turns[1]).toMatchObject({ text: "Hello.", done: true })
    expect(done.busy).toBe(false)
  })

  it("drops the empty bubble of a tool-only turn and keeps proposals, costs and the end", () => {
    const t = transcript([
      ev("assistant_start", { id: "m1" }),
      ev("assistant", { id: "m1", text: "" }),
      ev("tool", { name: "read", args: "{}" }),
      ev("proposal", { kind: "archdraw", name: "system", source: "node a\n", error: null }, 7),
      ev("cost", { usd: 0.02 }),
      ev("closed", { why: "idle" }),
    ])
    expect(t.turns.map(x => x.kind)).toEqual(["tool", "proposal", "note"])
    const open = transcript([ev("assistant_start", { id: "m1" }), ev("tool", { name: "read", args: "{}" }), ev("assistant_start", { id: "m2" })])
    expect(open.turns.map(x => x.kind)).toEqual(["tool", "agent"])
    expect(t.cost).toBe(0.02)
    expect(t.ended).toBe(true)
  })
})

describe("prose", () => {
  it("cuts the fenced files out of a message", () => {
    expect(prose("Here.\n\n```archdraw file=system\nnode a\n```\n\nWhich store?")).toBe("Here.\n\nWhich store?")
    expect(prose("```js\nkeep\n```")).toBe("```js\nkeep\n```")
  })
})

describe("lineDiff", () => {
  it("marks added and removed lines and keeps the rest", () => {
    const d = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")
    expect(d.map(l => l.op + l.text)).toEqual([" a", "-b", "+B", " c", "+d"])
    expect(diffCount(d)).toEqual({ added: 2, removed: 1 })
  })
  it("treats a new file as all added", () => {
    expect(diffCount(lineDiff("", "x\ny\n"))).toEqual({ added: 2, removed: 0 })
  })
  it("collapses long unchanged stretches", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n")
    const b = a.replace("l10", "L10")
    const h = hunks(lineDiff(a, b), 1)
    expect(h.map(l => (l ? l.op + l.text : "…"))).toEqual([" l9", "-l10", "+L10", " l11"])
  })
})

describe("palette", () => {
  const targets: Target[] = [
    { kind: "project", project: "ohara", title: "Ohara", hint: "7 diagrams" },
    { kind: "file", project: "ohara", file: "daily-edition", title: "The daily edition", hint: "ohara" },
    { kind: "file", project: "ohara", file: "data-model", title: "Data model", hint: "ohara" },
  ]
  it("ranks a prefix above a scattered match and drops non-matches", () => {
    expect(score("dat", "Data model")).toBeGreaterThan(score("dat", "The daily edition"))
    expect(score("zz", "Data model")).toBe(-1)
    expect(rank("data", targets)[0].file).toBe("data-model")
    expect(rank("dly ed", targets)[0].file).toBe("daily-edition")
  })
  it("tells a question from a name", () => {
    expect(looksLikeAsk("data model")).toBe(false)
    expect(looksLikeAsk("add a cache in front of convex")).toBe(true)
    expect(looksLikeAsk("why?")).toBe(true)
  })
})
