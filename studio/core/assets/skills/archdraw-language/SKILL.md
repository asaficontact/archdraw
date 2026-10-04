---
name: archdraw-language
description: "How to write an archdraw diagram (reladraw syntax): statements, placement, containers, edges, styles, notes and links, with the house style block every diagram starts from. Read before your first diagram."
---

# archdraw, the language

A text language where you state where things go; the engine works out only distances. Nothing is guessed: an
ambiguous file is refused with an error naming the line. The full reference is `syntax.md` beside this file.

## Statements
A statement starts at the start of a line; an indented line continues it. `//` comments. Keywords: `node`, `edge`,
`style`, `icon`, `default`, `diagram`. There is no `note`, `box`, `link`, braces, `-->` or subgraph.

```
node api "API server / [dim]FastAPI[/dim]"  right of web (gap: wide)  style: ours
```
` / ` (spaced) breaks a line in a text. `[dim]…[/dim]` borrows a style's text color for a stretch.

## Placement (no coordinates, ever)
`above X`, `below X`, `left of X`, `right of X`, the four diagonals, `level with X`, `top|bottom|left|right level
with X`. A lone direction binds both axes (`right of a` also centers on a). Two on one axis with nothing on the
other is an error: add a `level with`. Exactly one node may be unplaced: everything hangs off it. Gaps are named and
minimal: `none`, `tight`, `normal`, `wide`, in brackets after a placement: `below a (gap: wide)`.

## Containers
A dotted name nests: `node server "Server"` then `node server.api "API"`. Children stack in written order unless placed.
Place the container against other things; place children against siblings.

## Edges
`edge a -> b "label"  from: right  to: left`. Also `<-`, `<->`, `--`. `from:`/`to:` name the side of the first and
second node written. `between a and b`, `below c` steer a line. `line: (path: square, pattern: dashed)`. A labelled
edge widens its own corridor, so labels are safe.

## Notes, links, shapes
A note is a node with no body: `node n "text" (wrap: 34)  shape: none  below x`. Always give it a wrap.
`url: "#/<project>/<file>"` on a node links it to the diagram that explains it. `shape: document | circle | none`;
`icon: database | desktop | laptop | cube | cubes | package | disk` draws the node as a picture; `badge:` puts one beside
the text. Do not paste raw SVG icons: the studio strips them.

## The house style block (every file: the `// title:` and `// summary:` lines, then this)
```
style ours   fill: theme-primary-subtle  border: theme-primary
style store  fill: theme-fill  border: theme-border  badge: database
style ext    border: theme-secondary
style job    fill: none  border: theme-primary
style zone   fill: none  border: theme-border  text: (color: theme-muted)
style dim    text: (color: theme-muted)
style async  line: (pattern: dashed)
```
`ours` our code; `store` data; `ext` a third party; `job` a cron or async worker; `zone` where something runs (a
container: `node modal "Modal" style: zone`); `async` a callback or queue edge. Theme colors only.

## What bites
- Two children hung off the same side of the same target overlap: place one against the other.
- A note without `(wrap: n)` draws one long line across everything.
- `#` is not a comment; it starts a hex color.
- A file that renders states the arrangement; it does not prove the picture is clear. Keep each file small.
