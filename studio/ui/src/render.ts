import { THEMES, compile } from "@engine"
import { svgSize, type Size } from "./model"

export type Rendered = { svg: string; size: Size; error?: undefined } | { svg?: undefined; size: Size; error: string }

/** Render a source with the engine in a theme. A refusal is returned, not thrown: the card shows it in place. */
export function renderSource(source: string, dark: boolean): Rendered {
  try {
    const svg = sanitize(compile(source, { theme: dark ? THEMES.dark : THEMES.light }))
    return { svg, size: svgSize(svg) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), size: { w: 560, h: 120 } }
  }
}

/**
 * Links in a diagram: `#/<project>/<file>` stays in the studio (a box that drills into the diagram that explains
 * it); http(s) opens a new tab; any other scheme (javascript:, data:) loses its link. The engine escapes text but
 * passes a `url:` through as written, and this SVG goes into the page as markup.
 */
export function sanitize(svg: string): string {
  if (!svg.includes("<a ")) return svg
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
  for (const a of Array.from(doc.querySelectorAll("a"))) {
    const href = a.getAttribute("href") ?? ""
    if (href.startsWith("#/")) {
      a.removeAttribute("target")
      a.removeAttribute("rel")
      a.setAttribute("class", "ad-link")
    } else if (/^https?:\/\//i.test(href)) {
      a.setAttribute("target", "_blank")
      a.setAttribute("rel", "noopener noreferrer")
    } else {
      a.removeAttribute("href")
    }
  }
  for (const s of Array.from(doc.querySelectorAll("script, foreignObject"))) s.remove()
  return new XMLSerializer().serializeToString(doc.documentElement)
}
