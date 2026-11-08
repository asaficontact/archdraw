import { describe, expect, it } from "vitest"
import { THEMES, compile } from "@engine"
import { CARD_HEAD, CARD_PAD, GAP, bounds, fit, hashFor, layout, meta, parseHash, svgSize, zoomAt } from "./model"

describe("meta", () => {
  it("reads the leading title and summary comments only", () => {
    expect(meta("// title: System\n// summary: All of it.\n\nnode a")).toEqual({ title: "System", summary: "All of it." })
    expect(meta('node a "A"\n// title: late')).toEqual({})
  })
})

describe("layout", () => {
  it("puts cards in rows and wraps past the row width", () => {
    const r = layout([{ w: 1000, h: 400 }, { w: 1000, h: 600 }, { w: 1000, h: 200 }], 2400)
    expect(r[0]).toEqual({ x: 0, y: 0, w: 1000 + CARD_PAD * 2, h: 400 + CARD_PAD * 2 + CARD_HEAD })
    expect(r[1].x).toBe(r[0].w + GAP)
    expect(r[2].x).toBe(0)
    expect(r[2].y).toBe(600 + CARD_PAD * 2 + CARD_HEAD + GAP) // below the tallest of the first row
  })

  it("by default packs many wide cards into a wide grid, not one column", () => {
    const r = layout(Array.from({ length: 7 }, () => ({ w: 3000, h: 1600 })))
    const b = bounds(r)
    expect(b.w / b.h).toBeGreaterThan(1)
    expect(new Set(r.map(x => x.y)).size).toBeLessThan(7)
  })
})

describe("camera", () => {
  it("zooming keeps the point under the cursor fixed", () => {
    const c = { x: 10, y: 20, k: 1 }
    const z = zoomAt(c, 2, 300, 200)
    const world = { x: (300 - c.x) / c.k, y: (200 - c.y) / c.k }
    expect(world.x * z.k + z.x).toBeCloseTo(300)
    expect(world.y * z.k + z.y).toBeCloseTo(200)
  })
  it("fit centres a rect inside the viewport", () => {
    const c = fit({ x: 100, y: 100, w: 400, h: 200 }, 1000, 800, 50, 4)
    expect(100 * c.k + c.x + (400 * c.k) / 2).toBeCloseTo(500)
    expect(100 * c.k + c.y + (200 * c.k) / 2).toBeCloseTo(400)
  })
  it("bounds covers every rect", () => {
    expect(bounds([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 30 }])).toEqual({ x: 0, y: 0, w: 30, h: 35 })
  })
})

describe("route", () => {
  it("round-trips project and file, and drops anything that is not a slug", () => {
    expect(parseHash(hashFor("ohara", "system"))).toEqual({ project: "ohara", file: "system" })
    expect(parseHash("#/../etc")).toEqual({ project: undefined, file: undefined })
  })
})

describe("the engine the studio renders with", () => {
  it("renders a file to an SVG whose size the canvas can read", () => {
    const svg = compile('node a "A"\nnode b "B" right of a\nedge a -> b', { theme: THEMES.dark })
    const s = svgSize(svg)
    expect(svg.startsWith("<svg")).toBe(true)
    expect(s.w).toBeGreaterThan(50)
    expect(s.h).toBeGreaterThan(20)
  })
})
