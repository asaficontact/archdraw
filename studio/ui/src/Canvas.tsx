import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { CARD_HEAD, CARD_PAD, bounds, fit, layout, lerp, zoomAt, type Camera, type Rect } from "./model"
import type { Rendered } from "./render"

/** Dot spacing on screen: 24 world units, doubled until at least 14 px apart, so zooming out never greys the page. */
const dotStep = (k: number) => {
  let step = 24 * k
  while (step < 14) step *= 2
  return step
}

/** A diagram on the canvas. A `ghost` is a proposal shown beside the diagram it would replace; `badge` and
 *  `actions` sit in its header. */
export type Card = { key: string; title: string; summary: string; r: Rendered; ghost?: boolean; badge?: string; actions?: ReactNode }

/**
 * The infinite canvas: every diagram of the project as a card, laid out in rows. Drag to pan, wheel or pinch to
 * zoom, double-click a card to fly to it. `focus` (a key plus a counter, so the same card can be asked for twice)
 * flies the camera to that card; `fitAll` to all of them.
 */
export function Canvas({
  cards,
  selected,
  onSelect,
  focus,
  fitAll,
  dark,
  insetRight = 0,
  insetBottom = 0,
}: {
  cards: Card[]
  selected?: string
  onSelect: (key: string) => void
  focus: { key?: string; with?: string; n: number } // `with`: a second card framed together (a proposal and its original)
  fitAll: number
  dark: boolean
  insetRight?: number // pixels on the right covered by a panel (the source editor): cards are fitted left of it
  insetBottom?: number // pixels at the bottom covered by the agent's sheet: cards are fitted above it
}) {
  const host = useRef<HTMLDivElement>(null)
  const [cam, setCam] = useState<Camera>({ x: 40, y: 40, k: 0.5 })
  const camRef = useRef(cam)
  camRef.current = cam
  const anim = useRef<number | null>(null)
  const rects = useMemo(() => layout(cards.map(c => c.r.size)), [cards])
  const byKey = useMemo(() => new Map(cards.map((c, i) => [c.key, rects[i]])), [cards, rects])

  const flyTo = useCallback((r: Rect, maxK = 1.4) => {
    const el = host.current
    if (!el) return
    const visible = Math.max(240, el.clientWidth - insetRight)
    const target = fit(r, visible, Math.max(200, el.clientHeight - insetBottom), visible < 640 ? 16 : 56, maxK)
    const from = camRef.current
    const t0 = performance.now()
    if (anim.current) cancelAnimationFrame(anim.current)
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 450)
      setCam(lerp(from, target, p))
      anim.current = p < 1 ? requestAnimationFrame(step) : null
    }
    anim.current = requestAnimationFrame(step)
  }, [insetRight, insetBottom])

  // fly to the asked-for card, or fit everything when there is none
  useLayoutEffect(() => {
    const r = focus.key ? byKey.get(focus.key) : undefined
    const other = focus.with ? byKey.get(focus.with) : undefined
    if (r && other) flyTo(bounds([r, other]), 1.4)
    else if (r) flyTo(r)
    else if (rects.length) flyTo(bounds(rects), 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.key, focus.with, focus.n, rects.length, insetRight, insetBottom])
  useEffect(() => {
    if (fitAll && rects.length) flyTo(bounds(rects), 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitAll])

  // wheel: ctrl/meta or a pinch on a trackpad zooms; plain wheel pans
  useEffect(() => {
    const el = host.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const box = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        setCam(c => zoomAt(c, Math.exp(-e.deltaY * 0.01), e.clientX - box.left, e.clientY - box.top))
      } else {
        setCam(c => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }))
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // pointers: one drags, two pinch
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number } | null>(null)
  const moved = useRef(0)
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("a, button")) return
    host.current?.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved.current = 0
    if (anim.current) cancelAnimationFrame(anim.current)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const now = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, now)
    const pts = [...pointers.current.values()]
    if (pts.length === 2) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const box = host.current!.getBoundingClientRect()
      const mx = (pts[0].x + pts[1].x) / 2 - box.left
      const my = (pts[0].y + pts[1].y) / 2 - box.top
      if (pinch.current) setCam(c => zoomAt(c, d / pinch.current!.d, mx, my))
      pinch.current = { d }
      return
    }
    moved.current += Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y)
    setCam(c => ({ ...c, x: c.x + now.x - prev.x, y: c.y + now.y - prev.y }))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }

  const zoomBy = (f: number) => {
    const el = host.current!
    setCam(c => zoomAt(c, f, el.clientWidth / 2, el.clientHeight / 2))
  }

  return (
    <div
      ref={host}
      data-testid="canvas"
      className="ad-canvas absolute inset-0 touch-none select-none overflow-hidden"
      style={{
        backgroundSize: `${dotStep(cam.k)}px ${dotStep(cam.k)}px`,
        backgroundPosition: `${cam.x}px ${cam.y}px`,
        cursor: pointers.current.size ? "grabbing" : "grab",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})` }}>
        {cards.map((c, i) => {
          const r = rects[i]
          const on = c.key === selected
          return (
            <section
              key={c.key}
              data-card={c.key}
              className={`ad-card absolute ${on ? "ad-card-on" : ""} ${c.ghost ? "ad-card-ghost" : ""}`}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
              onClick={() => moved.current < 6 && !c.ghost && onSelect(c.key)}
              onDoubleClick={() => flyTo(r)}
            >
              <header className="relative" style={{ height: CARD_HEAD, padding: `20px ${CARD_PAD}px 0` }}>
                {c.badge && <span className="ad-card-badge">{c.badge}</span>}
                {c.actions && <div className="ad-card-actions">{c.actions}</div>}
                <h2 className="ad-card-title">{c.title}</h2>
                {c.summary && <p className="ad-card-summary">{c.summary}</p>}
              </header>
              {c.r.svg ? (
                <div className="ad-svg" style={{ padding: `0 ${CARD_PAD}px ${CARD_PAD}px` }} dangerouslySetInnerHTML={{ __html: c.r.svg }} />
              ) : (
                <pre className="ad-card-error" style={{ margin: `0 ${CARD_PAD}px` }}>{c.r.error}</pre>
              )}
            </section>
          )
        })}
      </div>
      <div className="ad-zoom absolute bottom-4 right-4 flex items-center gap-1" data-dark={dark || undefined}>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>−</button>
        <span className="w-12 text-center tabular-nums" data-testid="zoom">{Math.round(cam.k * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
        <button type="button" onClick={() => rects.length && flyTo(bounds(rects), 1)}>Fit</button>
      </div>
    </div>
  )
}
