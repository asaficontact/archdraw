import { describe, expect, it } from "vitest"
import { check, lint } from "../src/engine.js"

describe("the engine check", () => {
  it("returns the engine's error with its line for a refused file", () => {
    expect(check('node a "A"\nnode b "B"  level with a\n')).toMatch(/^line 2: .*even with/)
    expect(lint('node a "A"\nnode b "B"  level with a\n').error).toMatch(/^line 2: /)
  })

  it("reports findings for a file that renders but overlaps, which check alone does not", () => {
    // Since engine 0.17 nothing moves to make room: two boxes on one spot are drawn there and reported.
    const src = 'node a "A"\nnode c "C"  right of a\nnode d "D"  right of a\n'
    expect(check(src)).toBeNull()
    const r = lint(src)
    expect(r.error).toBeNull()
    expect(r.findings.some((f) => /warning\(node-overlap\)/.test(f))).toBe(true)
  })

  it("is clean for a file with nothing to report", () => {
    expect(lint('node a "A"\nnode b "B"  right of a (gap: wide)\nedge a -> b\n')).toEqual({ error: null, findings: [] })
  })
})
