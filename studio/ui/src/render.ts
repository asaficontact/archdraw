import DOMPurify from "dompurify"
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

const INTERNAL = /^#\/[a-z0-9][a-z0-9-]{0,62}(\/[a-z0-9][a-z0-9-]{0,62})?$/
const ANCHOR = /^#[A-Za-z][\w.-]*$/
const WEB = /^https?:\/\/[^\s"'<>]+$/i

let hooked = false
function hook() {
  if (hooked) return
  hooked = true
  DOMPurify.addHook("afterSanitizeAttributes", node => {
    for (const name of ["href", "xlink:href"]) {
      if (!node.hasAttribute(name)) continue
      const v = (node.getAttribute(name) ?? "").trim()
      if (INTERNAL.test(v)) {
        node.removeAttribute("target")
        node.removeAttribute("rel")
        node.setAttribute("class", "ad-link")
      } else if (WEB.test(v)) {
        node.setAttribute("target", "_blank")
        node.setAttribute("rel", "noopener noreferrer")
      } else if (!ANCHOR.test(v)) {
        node.removeAttribute(name)
      }
    }
  })
}

/**
 * Every diagram is sanitized before it goes into the page as markup. A `.archdraw` file may paste raw SVG as an
 * icon and the engine's own filter is a regex (review of archdraw#1, H1: `<img src=x/onerror=…>`, a `<style>`, an
 * `<a` broken over lines all got through). DOMPurify with the SVG profile drops scripts, event handlers, style,
 * foreignObject, image and use; links survive only as `#/<project>/<file>` (stays in the studio), `#id`, or http(s)
 * (new tab). The page's CSP (script-src 'self') is the second line.
 */
export function sanitize(svg: string): string {
  if (!DOMPurify.isSupported) throw new Error("this browser cannot sanitize diagrams, so none is shown")
  hook()
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: false },
    FORBID_TAGS: ["style", "foreignObject", "image", "use", "script", "animate", "set", "animateTransform", "animateMotion"],
    FORBID_ATTR: ["style"],
    ADD_ATTR: ["target", "rel"],
  })
}
