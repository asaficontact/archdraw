# Writing archdraw: the guide

archdraw diagrams are written in reladraw (engine 0.23.1), a text language where the file states the arrangement in
the words a person would say out loud (`right of api`, `below worker (gap: tight)`, `even with queue`) and the engine
draws exactly that. Nothing is chosen for you: a file that leaves something ambiguous is refused with an
error naming the line, never guessed. Adapted from upstream's own agent skill; the full reference is `archdraw/references/syntax.md`.

## Why this matters to you

You cannot see the picture. With auto-layout you would be guessing where things landed; here the arrangement is in
the sentences you wrote, so re-reading your source tells you where everything is. Be honest about the limit:
re-reading confirms *intent* (the worker sits under the API), not *outcome* (whether a line crosses four others, or a
long text crowds its neighbour). The engine draws such things as written and reports them as findings, but
`check_diagram` returns only errors, so you will not hear about them: prevent them as you write. For a dense diagram,
say you stated the arrangement and did not see the render.

## The loop

1. Write the whole file.
2. `check_diagram` it (outside the studio: `reladraw check file.archdraw`, which also prints the findings;
   `reladraw render file.archdraw -o out.svg` draws it).
3. On an error, read it: it names the line and usually the word to write instead (`archdraw/references/pitfalls.md` lists them). Fix
   that line only and check again.
4. When it says `renders`, re-read your source once top to bottom and confirm it says what you meant.

## The one idea: the file says where things go, and nothing moves

A gap is exactly the distance written, and nothing widens it: not a box put between, not a line's text, not an
arrowhead. Putting something between two things does not push them apart; you make the room:

```archdraw
node hub    "Hub"
node side   "Side"    left of hub (gap: 16)
node wedge  "Wedged"  right of side  left of hub  even with hub
```

`side` is exactly 16 units from `hub` (a unit is 12 pixels; a one-line box is about 4 units tall), and `wedge` sits
centered in the space they leave. Make that space too small and `wedge` is drawn over them, not refused. Distances are
the gap words or a number of units; there are no coordinates in any form.

## Statements

A statement starts at the beginning of a line; an indented line continues the one above (indentation never nests
anything). `//` starts a comment, also after a statement. After the keyword, the id and the text, attributes and
placements come in any order: a token ending in a colon opens an attribute and nothing else does. No commas between
attributes, no semicolons, no braces. The keywords are `node`, `edge`, `style`, `default`, `icon`, `diagram`, and
for the rarer jobs `point`, `region`, `bundle` and `guide` (`archdraw/references/syntax.md`).

### Nodes

```text
node <id> ["<text>" [(<text properties>)]] [<placement> | <attribute>] ...
```

Leave the text out and the id is the text. ` / ` (a slash with spaces) breaks a line; `TCP/IP` is safe. Containment
is a dotted id, parent declared first. A container says how its children sit: `layout: column` or `layout: row` puts
them in written order, or exactly one child is unplaced and the others are placed against it:

```archdraw
node server         "Server"  layout: column
node server.api     "API"
node server.worker  "Worker"
```

The layout's bracket takes `gap:`, `widths: match` and `align-children:`: `layout: column (widths: match)`. A
container's title is centered along its top; `"Server" (inside top, align: left)` puts it at the top left.

A stretch of text can borrow a style's text color, which is how a box carries a quiet qualifier:

```archdraw
style dim  text: (color: theme-muted)
node grinder "Grinder / [dim]medium-fine[/dim]"
```

Text properties go in brackets after the text, never among the node's attributes: `color`, `size`
(`small | normal | large`), `wrap` (fold every n characters), `align`, and on a container where its title sits
(`inside top`, `on top`, `outside top`, `center`).

### The body

`shape: rectangle | document | circle | none` is the outline the house uses (`none` is bare text: a note; the engine
also has `cylinder`, `diamond` and the flowchart shapes). `icon: <name>` draws the
node as a picture instead: `disk desktop laptop package cubes cube database`. Writing both is an error. `badge:` puts
one of those pictures beside the text of a box.

```archdraw
node dump   "nightly dump"  shape: document
node aside  "a remark that folds onto two lines" (wrap: 20)  shape: none  below dump (gap: tight)
node unit   icon: cube  right of dump
node drive  "External HD"  badge: disk  right of unit
```

A picture with no text shows none. In the studio, file icons are refused; use the built-ins.

### Colors name the part they color

`fill` (inside), `border` (outline), `text: (color: …)`, and `line` on an edge. A word on a kind without that part is
refused (`border:` on a `shape: none` node). Use theme colors through styles (`archdraw/references/conventions.md`); there is no `stroke`,
`label`, `color` or top-level `size` attribute.

## Placement

```text
above X          below X          left of X        right of X
above-left of X  above-right of X below-left of X  below-right of X
even with X      top even with X     bottom even with X
                 left even with X    right even with X
```

Any of them may name several targets, `right of a and b`, meaning the box bounding them. A gap goes in brackets on
its placement, never on the node: `below a (gap: wide)`, with `none`, `tight`, `normal` (default), `wide`, which are
0, 2, 4 and 8 units, or a number of units, `(gap: 12)` or `12 below a`. An alignment takes no gap.

The three rules that decide most of what you write:

- **A lone direction binds both axes.** `right of api` also centers the node vertically on the API. That half drops
  away when another placement claims the axis.
- **Two placements on one axis and none on the other is an error**: `right of a  left of b` needs `even with a`.
  The box is then centered in the space `a` and `b` already leave; it moves neither.
- **Exactly one node may be unplaced.** Everything else hangs off it, directly or through others.

And two that follow:

- **Nothing moves a box.** Two nodes both `right of hub` land on one spot and are drawn on top of each other, with
  no error. Chain them (`b right of a`, `c below b`) or put them in a container with `layout: column`.
- **Place against siblings.** The engine lets a child be placed against a box in another container, but the house
  places a zone's children against their siblings and zones against zones, so a zone moves as one piece.

## Edges

```text
edge <a> -> <b> ["<text>" [(<text placement>)]] [from: <side>] [to: <side>] [via: <place>, ...] [attributes]
```

`<-`, `<->`, `--` (no head) and `-->` (the same as `->`, valid since 0.14.0) all work; there is no `-.->`. Ends may be
marked (`a o--> b`, `a *--o b`). `from:` and `to:` name the side of the **first and second name written**, whatever
way the arrow points; name them so the line leaves and arrives the way the layout reads. With no side named, an end
meets the side facing the other box.

A line is straight between its two boxes and goes through anything in between: nothing is avoided.
`line: (path: square)` or `(path: curved)` gives a route read off the line's own two boxes and sides. `via:` lists the places it
passes: `via: c bottom` runs just below `c`, `via: between x and y` through the point between two nodes, `via: c`
through a box's center. That is how a line goes round something.

A line's text sits at the middle of its line and never widens a gap, so size the gap for it
(`archdraw/references/pitfalls.md`, "Drawing in 0.23"), or place it: `(at: 1/4)`, `(above edge)`, `(left of edge)`.

`line: (path: square, corners: rounded, pattern: dashed, thickness: thick)` says how the line is drawn; `line: red`
alone is a color. Two edges between the same two boxes on the same sides fan side by side and never cross; other
lines make no room for each other.

## Notes

A note is a node with no body, anchored so it travels with what it explains. Always give it a wrap, or a sentence is
one long line across the diagram:

```archdraw
node api  "API"
node api_note "The worker shares the database but takes no HTTP traffic." (wrap: 30)  shape: none  below api (gap: tight)
```

## Strict attributes

Every attribute is checked by name, and a real word on a kind that has no use for it is refused too (`gap:` on an
edge, `fill:` on a note). A key written twice on one statement is refused. A style may carry keys a kind cannot use,
so one style can dress nodes and edges, but a style that gives a node nothing at all is refused.

## A complete small file

```archdraw
// title: Shop, the request path
// summary: How a browser request reaches the database, and where the worker fits.

style store  fill: theme-primary-subtle  border: theme-primary  badge: database

node browser  "Browser"
node api      "API server"  right of browser
node db       "Postgres"    right of api    style: store
node worker   "Worker"      below api

edge browser -> api  "HTTP"    from: right  to: left
edge api -> db       "SQL"     from: right  to: left
edge worker -> db    "writes"  from: right  to: bottom

node aside "The worker shares the database / but takes no HTTP traffic." (wrap: 30)  shape: none  below worker (gap: tight)
```

(A house diagram uses the house block from `archdraw/references/conventions.md` instead of its own `style` lines.)

## When something is not here

Check `archdraw/references/syntax.md` before inventing syntax. If a line goes the wrong way, say more about it (`from:`/`to:`,
`via:`, `line: (path: square)`); if a node is in the wrong place, add a placement or a distance (`3 below a`). There
are no coordinates.
