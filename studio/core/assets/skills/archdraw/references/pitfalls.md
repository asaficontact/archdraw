# Pitfalls

Habits from Mermaid, D2, Graphviz and PlantUML that break archdraw, each with the error `check_diagram` returns
(copied from a real run of engine 0.16.0) and the fix. The command-line tool prints the same message as
`file.archdraw:N:` in place of `line N:`. Every fix block below renders, with the house style block above it.

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
`line 3: "a -> b" has label: HTTPS, which is not an attribute. An edge takes style, from, to, from-mark, to-mark, line, text, url`.
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

**A url on an edge with no text**:
`line 3: edge a -> b has a url and no text. A destination needs something to click, and a line is too thin to be it — give the edge a text, or put the url on one of the nodes`.

**A side that is not a side** (`from: east`): `line 3: "from: east" is not a side — use top, bottom, left, right`.

## Nesting

**Braces or indentation for nesting.** Both `node server "Server" {` with an indented `node api` and a bare indented
`node api` under `node server` give:

```text
line 2: `node` cannot continue the statement above — an indented line continues the one before it, so remove the indentation to start a new statement
```

Indentation only continues a statement. Containment is a dotted name, parent first:

```archdraw
node server      "Server"  style: zone
node server.api  "API"  style: ours
node server.db   "Orders"  style: store
```

**The child before the parent**: `line 1: "server.api" is inside "server", which is not declared yet`. Declare the
parent above. The same error comes from a dotted id used as a plain name (`node db.main` with no `db`): use `db_main`.

**A child placed against a node in another container**:
`line 4: "b.y" is placed against "a.x", which is not one of its siblings or its parent`; against a top-level node,
`line 4: "z.b" is placed against "x", which is not one of its siblings or its parent`.
Place the containers against each other and each child against its siblings:

```archdraw
node a    "Zone A"  style: zone
node a.x  "X"  style: ours
node b    "Zone B"  right of a (gap: wide)  top level with a  style: zone
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
`line 4: "m" does not say where it sits vertically: "right of a" and "left of b" would put it in different places`.
Add the other axis:

```archdraw
node a  "A"
node b  "B"  right of a (gap: wide)
node m  "M"  right of a  left of b  level with a
```

**Different placements nothing orders** (one node `right of hub`, another `right of hub  level with hub`):
`line 3: "a" and "b" overlap, and nothing says which side of the other either one sits on — place one against the other, or say overlap: allow`.
Identical placements are fine: they form a list in written order. The error comes from placements that differ, so
the engine cannot stack them. Make them identical, or place one against the other:

```archdraw
node hub  "Hub"  style: ours
node a    "One"  right of hub (gap: wide)
node b    "Two"  below a
```

**Placements that cannot all hold** (`level with a  level with b` on rows that differ):
`line 3: "below a" and "level with b" and "level with a" cannot all hold — they leave no room vertically`. Keep one
alignment per axis.

**Hyphenated directions** (`right-of a`): `line 2: node "b": "right-of" is not a direction`. Write `right of a`. The
diagonals are the hyphenated ones: `above-left of a`.

**A gap on an alignment** (`level with a (gap: tight)`):
`line 3: node "c": "level with a" shares a line rather than leaving a space, so it takes no gap`. Put the gap on a
direction:

```archdraw
node a  "A"
node b  "B"  right of a
node c  "C"  below b (gap: tight)  left level with b
```

**A comma before an attribute** (`right of a, gap: tight`):
`line 2: node "b": the comma after "a" starts another target, but "gap:" is a key — remove the comma`. No commas
between attributes; the gap goes in brackets after its placement: `right of a (gap: tight)`.

**Units on a gap** (`gap: 20px`):
`line 2: "b" asks for gap: 20px, which is not one of none, tight, normal, wide or a number of pixels; write "gap: 20", a gap's number is already in pixels`.
Prefer the names.

## Attributes

Every attribute is checked by name; an invented one is refused.

```text
line 1: "a" has label: Alpha, which is not an attribute. A node takes style, gap, overlap, contents, badge, deck, shape, fill, border, text, url
line 1: "a" has color: red, which is not an attribute. A node takes style, gap, overlap, contents, badge, deck, shape, fill, border, text, url
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

**A shape from another tool** (`shape: cylinder`) **or an icon outside the set** (`icon: server`):

```text
line 1: there is no shape called "cylinder". The shapes are rectangle, document, circle, none, and a picture is `icon:` rather than `shape:`: disk, desktop, laptop, package, cubes, cube, database
line 1: there is no icon called "server". The icons are disk, desktop, laptop, package, cubes, cube, database
```

A database is `style: store`; a person is `icon: laptop`; a server is a box with its name.

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
line 1: node "a": ")" is not a direction
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
