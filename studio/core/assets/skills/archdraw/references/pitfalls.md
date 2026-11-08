# Pitfalls

Habits from Mermaid, D2, Graphviz and PlantUML that break archdraw, each with the error `check_diagram` returns
(copied from a real run of engine 0.23.1) and the fix. The command-line tool prints the same message as
`file.archdraw:N:` in place of `line N:`. Every fix block below checks with no error and no finding, with the house
style block above it. The last two sections are about 0.23 itself: the old spellings it refuses, and what it draws
badly without an error.

Read the error literally: it names the line and, almost always, the word to write instead.

## Statements that do not exist

**A diagram-type header** (`graph TD`, `flowchart LR`, `digraph G {`, `subgraph x`, D2's `direction: right`).

```text
line 1: unknown statement "graph"
line 1: unknown statement "digraph"
line 1: unknown statement "subgraph"
line 1: unknown statement "direction:"
```

Delete it. There is no header, no direction setting and no subgraph: the direction is in each placement, and a group
is a container (a dotted name, below).

**Mermaid node shorthand** `A[Web] --> B[API]`: `line 1: unknown statement "A[Web]"`. Declare each node, then the
edge:

```archdraw
node web  "Web"
node api  "API"  right of web (gap: wide)
edge web -> api  "HTTPS"  from: right  to: left
```

**`note`, `box`, `link`.**

```text
line 2: reladraw has no `note` statement — a note is a node with no body, so try `node "remember this" shape: none`
line 1: reladraw calls these nodes, so there is no `box` statement — try `node a "A"`
line 3: reladraw calls these edges, so there is no `link` statement — try `edge a -> b`
```

A note still needs an id, a wrap and a placement (the suggestion in the first error leaves out the id):

```archdraw
node api  "API"  style: ours
node api_note "Remember this." (wrap: 36)  shape: none  style: note  below api (gap: tight)
```

**`#` comments.** `# the system` gives `line 1: unknown statement "#"`; trailing, `node a "A"  # the API` gives
`line 1: node "a": "#" is not a direction`. Comments are `//`; `#` opens a hex color.

**Semicolons.** `node a "A";` gives `line 1: node "a": ";" separates nothing — clauses are separated by spaces alone`.

## Edges

**A label after a colon** (`a -> b: label`, Mermaid sequence and D2 style):
`line 3: edge a -> b:: a name may not contain ":", because a colon makes the word before it a key, with or without a space after it`.
**A label attribute** (`label: "HTTPS"`):
`line 3: "a -> b" has label: HTTPS, which is not an attribute. An edge takes style, from, to, via, from-mark, to-mark, line, text, url, depth`.
**Graphviz brackets** (`[label="x"]`): `line 3: edge a -> b: "[label=" is not a direction`.
**An unquoted label** (`edge a -> b HTTPS`): `line 3: edge a -> b: "HTTPS" is not a direction`.
**Mermaid's pipe label** (`a -->|HTTPS| b`):
`line 3: "-->|HTTPS|": ">|HTTPS|" is not a mark. The marks are arrow, oarrow, dot, odot, diamond, odiamond, bar, none, and the glyphs > |> * o | and < <|`.

The text is a quoted string straight after the two names:

```archdraw
node a  "Web"
node b  "API"  right of a (gap: wide)
edge a -> b  "HTTPS"  from: right  to: left
```

`-->` itself is fine (since 0.14.0 it is a line of dashes with an arrowhead, the same as `->`). What is not:

**A dotted arrow** `a -.-> b`: `line 3: "-.->" is not an arrow — the line is one run of dashes, with a mark at either end`.
A dashed line is a pattern, not an arrow; the house writes it as `style: async`:

```archdraw
node a  "API"  style: ours
node b  "Queue"  right of a (gap: wide)  style: store
edge a -> b  "publish"  from: right  to: left  style: async
```

**`line: dashed`**:

```text
line 3: `line: dashed` — `line:` on its own takes a color. The line's other properties go in its bracket: `line: (pattern: dashed)`
```

Use `style: async` (which is `line: (pattern: dashed)`), or the bracket.

**A chain** `edge a -> b -> c`: `line 4: edge a -> b: "->" is not a direction`. One edge per statement:

```archdraw
node a  "A"
node b  "B"  right of a (gap: wide)
node c  "C"  right of b (gap: wide)
edge a -> b  "x"  from: right  to: left
edge b -> c  "y"  from: right  to: left
```

**An edge to a node that is not declared** (D2 and Mermaid create it): `line 2: edge to "b", which does not exist`.
Declare every node with a placement first.

**A url on an edge.** Accepted since 0.23, with or without a text, but a drill-down belongs on the node the detail
diagram expands (`archdraw/references/conventions.md`, Drill-downs).

**A side that is not a side** (`from: east`):
`line 3: edge a -> b: "from: east" is not a side or a point — write a side (top, bottom, left, right), a point such as bottom-center, a side and how far along it such as left 3/4 down, or center`.

## Nesting

**Braces or indentation for nesting.** Both `node server "Server" {` with an indented `node api` and a bare indented
`node api` under `node server` give:

```text
line 2: `node` cannot continue the statement above — an indented line continues the one before it, so remove the indentation to start a new statement
```

Indentation only continues a statement. Containment is a dotted name, parent first, and the container lays its
children out (or places all but one of them):

```archdraw
node server      "Server"  layout: column  style: zone
node server.api  "API"  style: ours
node server.db   "Orders"  style: store
```

**The child before the parent**: `line 1: "server.api" is inside "server", which is not declared yet`. Declare the
parent above. The same error comes from a dotted id used as a plain name (`node db.main` with no `db`): use `db_main`.

**Two children with no placement and no layout**:
`line 3: "s" has 2 children that say nothing about where they go ("s.a", "s.b"). One is the anchor and the rest are placed against it — or give the container a layout: such as layout: column to place them in order`.
Add `layout: column` (or `row`) to the container, as above.

**A child placed against a node in another container** is allowed, but then its container must not place itself on
the same axis: `line 3: "z" is placed twice across: by its own "right of x" and by "z.b right of x", which is inside it — keep one of the two`.
The house places the containers against each other and each child against its siblings:

```archdraw
node a    "Zone A"  layout: column  style: zone
node a.x  "X"  style: ours
node b    "Zone B"  right of a (gap: wide)  top even with a  layout: column  style: zone
node b.y  "Y"  style: ours
edge a.x -> b.y  "HTTPS"  from: right  to: left
```

## Placement

**Two nodes with no placement** (D2, Mermaid and Graphviz place everything for you):
`line 2: exactly one node may say nothing about where it goes, but 2 do: "a", "b"`. One anchor; everything else
says where it goes. The same error appears when an edit adds a top-level node and forgets its placement.

**Every node placed, none free** (a loop): `line 1: every node is placed relative to another, so nothing anchors the diagram`.
Remove the placement from the one node everything hangs off.

**Two placements on one axis and none on the other** (`right of a  left of b`):
`line 3: "m" says where it goes across ("right of a" and "left of b") but not up and down — add a placement that says how high, such as even with one of them`.
Add the other axis. `m` is then centered in the space `a` and `b` already leave, which must be wide enough for it:

```archdraw
node a  "A"
node b  "B"  right of a (gap: 12)
node m  "M"  right of a  left of b  even with a
```

**Two nodes placed on one spot** (both `right of hub`, the way Mermaid lists siblings): no error. Both are drawn
there, one over the other, and `check_diagram` says `renders`. Identical placements do not form a list. Place one
against the other, or put them in a container with `layout: column`:

```archdraw
node hub  "Hub"  style: ours
node a    "One"  right of hub (gap: wide)
node b    "Two"  below a
```

**Two placements on one axis** (`even with a  even with b`):
`line 3: "c" says where it goes up and down more than once: "even with a" and "even with b". Each axis is stated once — keep one, or pin two opposite edges with even with to give it a size`.
Keep one per axis, even where the two would agree.

**Hyphenated directions** (`right-of a`): `line 2: node "b": "right-of" is not a direction`. Write `right of a`. The
diagonals are the hyphenated ones: `above-left of a`.

**A gap on an alignment** (`left even with b (gap: tight)`):
`line 3: node "c": "left even with b" shares a line rather than leaving a space, so it takes no gap`. Put the gap on
a direction:

```archdraw
node a  "A"
node b  "B"  right of a
node c  "C"  below b (gap: tight)  left even with b
```

**A comma before an attribute** (`right of a, gap: tight`):
`line 2: node "b": the comma after "a" starts another target, but "gap:" is a key — remove the comma`. No commas
between attributes; the gap goes in brackets after its placement: `right of a (gap: tight)`.

**A gap on the node** (`right of a  gap: wide`):

```text
line 2: node "b": a node has no gap:, only a placement does — write it in the placement's bracket, such as `right of a (gap: wide)`
```

**A gap's number in pixels.** `(gap: 20)` is 20 units, 240 pixels, with no error: a number is in units of 12 pixels
(`tight` 2, `normal` 4, `wide` 8). Prefer the names; use a number when a text needs the room (below).

## Attributes

Every attribute is checked by name; an invented one is refused.

```text
line 1: "a" has label: Alpha, which is not an attribute. A node takes style, overlap, layout, gather-children, padding, padding-top, padding-right, padding-bottom, padding-left, width, height, min-width, max-width, min-height, max-height, heading, join-with, badge, cards, shape, fill, border, corners, text, url, depth, top-edge-order, bottom-edge-order, left-edge-order, right-edge-order
line 1: "a" has color: red, which is not an attribute. A node takes style, overlap, layout, gather-children, padding, padding-top, padding-right, padding-bottom, padding-left, width, height, min-width, max-width, min-height, max-height, heading, join-with, badge, cards, shape, fill, border, corners, text, url, depth, top-edge-order, bottom-edge-order, left-edge-order, right-edge-order
line 1: `size:` belongs to the text rather than to the node — write it in the brackets after the text, as in `"…" (size: small)`, or as `text: (size: small)` in a style
line 1: `wrap:` belongs to the text rather than to the node — write it in the brackets after the text, as in `"…" (wrap: 20)`, or as `text: (wrap: 20)` in a style
line 1: node "api": a text is quoted — write "API" rather than API
```

The text is the quoted string after the id; its own properties go in brackets after it; colors come from a style:

```archdraw
node a  "Alpha" (wrap: 20)  style: ours
```

**A quoted color** (`fill: "red"`): `line 1: "fill" takes a color and a quoted value is text — drop the quotes if red is a color`.
**An invented theme color** (`fill: theme-blue`): `line 1: node "a": there is no theme color "theme-blue" — the theme colors are theme-page, theme-text, theme-muted, theme-fill, theme-border, theme-line, theme-primary, theme-primary-subtle, theme-on-primary, theme-secondary, theme-secondary-subtle, theme-on-secondary`.
In a diagram, neither: use a house style.

**A shape from another tool** (`shape: person`, `shape: cloud`) **or an icon outside the set** (`icon: server`):

```text
line 1: there is no shape called "person". The shapes are rectangle, document, circle, diamond, pill, parallelogram, hexagon, trapezoid, triangle, cylinder, flow-subprocess, flow-document, flow-off-page, flow-delay, flow-manual-input, flow-stored-data, flow-loop-start, flow-loop-end, flow-card, flow-display, flow-tape, flow-punched-tape, flow-collate, none, and a picture is `icon:` rather than `shape:`: disk, desktop, laptop, package, cubes, cube, database
line 1: there is no icon called "server". The icons are disk, desktop, laptop, package, cubes, cube, database
```

`shape: cylinder` is accepted, but the house draws a database as `style: store`; a person is `icon: laptop`; a server
is a box with its name.

**Both a shape and an icon**:

```text
line 1: shape: document and icon: cube both say what this node is drawn as, and it has one body — `shape:` is the outline it is drawn with, `icon:` is the picture it is drawn as
```

**An icon from a file** (`icon rack "./rack.svg"`), refused by the studio:
`line 1: icon "rack" names a file, "./rack.svg", and files can be read only by the command-line tool — paste the SVG itself between """ marks instead`.
Use a built-in. Paste SVG only when the user supplies it; the studio sanitizes it, and script in it is refused.

**A dashed node border.** There is none. `border: (pattern: dashed)`, then `line: (pattern: dashed)` on a node,
then `style: async` on a node give:

```text
line 1: a border has no "pattern" — it takes color, thickness
line 1: "a" is a node and has line: (pattern: dashed). A node is a fill, a border and text, so it has no line — it takes `fill:`, `border:`, `text: (color: …)`
line 2: style "async" gives "a" nothing. It carries line; a node is a fill, a border and text
```

Worst, `border: dashed` is **accepted in silence** as a color name and draws a border no browser understands. To mark
a node as planned or optional, say it in its qualifier: `"Search / [dim]planned[/dim]"`.

**A border on a note**:

```text
line 2: "n" is a node with no body and has border: red. A node with no body is text and nothing else, so it has no border — it takes `text: (color: …)`
```

**A url without quotes** (`url: #/proj/detail`):

```text
line 1: node "a": a url is written in quotes — `url: "https://example.com"`. Without them everything from the `//` onwards is read as a comment
```


```archdraw
node a  "Payments"  style: ours  url: "#/bean-there/payments"
```

A url with capitals (`"#/Ohara/System"`) renders, and the studio drops the link silently: slugs are lowercase.

## Things declared twice or missing

```text
line 3: "a" is declared twice
line 2: style "ours" is declared twice
line 1: no style named "ours"
line 1: "a": its text marks [dim], and there is no style called "dim"
line 2: the diagram is described twice
```

The second and third mean the house block was pasted twice or left out: exactly one copy, at the top. Do not write a
`diagram` statement at all; the studio sets the theme.

## Old reladraw spellings (0.16 and earlier)

A diagram written for engine 0.16 is refused at its first old spelling, and the message names the new one. When
you change such a file, translate each refused line as the message says; that is a translation, not a change of
meaning, and you say so in the reply.

```text
line 2: node "b": "level with" is now "even with" — write `even with …`
line 2: node "b": "below of" is written "below" — `below a`
line 1: node "s": contents: is gone — a container's children are arranged with layout:, and its settings go in its bracket: `layout: column (widths: match, align: center)`
line 4: edge a -> b: "below c" on an edge is gone — it said what the line keeps clear of, and a line now says the places it passes: `via: c bottom`
line 5: edge a -> b: "between c and d" on an edge is gone — a line says the places it passes, so write `via: between c and d`
line 1: "a": at: is gone from a node's text — a title says which side it sits against, such as (inside top, align: left), (on top) or (outside bottom)
line 1: node "drive": deck: is gone — a deck is a container and its cards are its children, the front one first: `node drive ""  layout: deck  cards: "Drive 1" "Drive 2" "Drive 3"`; a card that holds things is written as a child, such as node drive.1
```

The `contents:` message's own suggestion is refused next (`align:` in a layout is gone): write `layout: column
(widths: match)`, and `align-children: center` in the bracket only if you need it. A `gap:` on the node moves into
the placement's bracket (above). Three changes give no error and draw differently: a gap's number is units, not
pixels (`(gap: 12)` was 12 pixels and is now 144; write `1`), and `size: 22` on a text or `thickness: 3` on a line is
now a multiple of normal (write `22px`, `3px`). Old files also counted on gaps that widened and lines that went round
boxes; read the next section before you trust one that checks.

## Drawing in 0.23: what checks clean and still draws badly

The engine draws what the file says and refuses nothing for looking bad. It reports overlaps as findings, both on
the command line and in `check_diagram`; a line through a container's title is not reported at all. These are the
usual ways a diagram that `renders` reads badly:

- **A line's text never widens its gap.** Size the gap to the text of the line that runs across it: about 0.7 units
  per character at normal size and 0.6 at small (the house sets edge texts small), plus a unit or two for the patch
  behind it. `"HTTPS, session cookie"` is 21 small characters, so `(gap: 14)`; `wide` (8) holds about ten.
- **A container's title is centered along its top by default**, where a line coming into a child from above or
  aslant runs through it, and `check_diagram` (or `reladraw check`) does not report a line crossing a container's
  title. Put the title at the left, or take the line round it with `via:`:

```archdraw
node user        "Customer"  icon: laptop
node cloud       "Cloud" (inside top, align: left)  below user (gap: wide)  layout: column  style: zone
node cloud.api   "Orders API"  style: ours
node cloud.db    "Orders / [dim]Postgres[/dim]"  style: store
edge user -> cloud.api  "HTTPS"  from: bottom  to: top
```

- **A long text on a vertical line** sits across the line and covers what is beside it. Move it off the line:
  `"SQL over TLS, pooled" (left of edge)` or `(right of edge)`.
- **A pinned line end** (`straight down`, `to: top 1/4 across`, `from: right, even with x`) splits its side, and the
  other ends on that side spread on either side of it, so they can cross it or bunch up. Pin them all, or name the
  pinned line and order the others against it: `edge ord a -> bus  "emit"  to: top 1/4 across`, then
  `to: top, left of ord` on another. A `straight` line can't be named that way ("no line named ord meets bus's top
  side"); pin the others. Crossings are not reported by default.
- **A style on a `layout: deck`** draws a box round the stack instead of colouring the cards. Write the cards as
  children, each with the style:

```archdraw
node drives    ""  layout: deck
node drives.1  "Drive 1"  style: ours
node drives.2  "Drive 2"  style: ours
node drives.3  "Drive 3"  style: ours
```

- **A point waypoint on a square line lies on a leg, not at a corner.** `via: p` with `line: (path: square)` passes
  through `p` partway along a leg. `line: (path: square, turn: 1)` puts the corner on the point. A named point is
  drawn as a dot unless declared as `guide point p …`.
- **A line goes through whatever is between its boxes**, and two boxes placed alike sit on one spot (above). Look at
  what lies on the straight line between two ends; take the line round with `via: c top` or `line: (path: square)`.
