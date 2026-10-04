# Writing archdraw: the guide

archdraw diagrams are written in reladraw (engine 0.16.0), a text language where the file states the arrangement in
the words a person would say out loud (`right of api`, `between web and worker`, `level with queue`) and the engine
works out only the distances. Nothing is chosen for you: a file that leaves something ambiguous is refused with an
error naming the line, never guessed. Adapted from upstream's own agent skill; the full reference is `archdraw/references/syntax.md`.

## Why this matters to you

You cannot see the picture. With auto-layout you would be guessing where things landed; here the arrangement is in
the sentences you wrote, so re-reading your source tells you where everything is. Be honest about the limit:
re-reading confirms *intent* (the worker sits under the API), not *outcome* (whether a line crosses four others, or a
long text crowds its neighbour). For a dense diagram, say you stated the arrangement and did not see the render.

## The loop

1. Write the whole file.
2. `check_diagram` it (outside the studio: `reladraw file.archdraw -o out.svg`).
3. On an error, read it: it names the line and usually the word to write instead (`archdraw/references/pitfalls.md` lists them). Fix
   that line only and check again.
4. When it says `renders`, re-read your source once top to bottom and confirm it says what you meant.

## The one idea: a gap is a minimum

Everything ends up as close together as your statements allow. Putting something between two things is what pushes
them apart, by exactly what it needs:

```archdraw
node hub    "Hub"
node side   "Side"    left of hub
node wedge  "Wedged"  right of side  left of hub  level with hub
```

Nothing says how far apart `hub` and `side` are. Delete `wedge` and they close back up. You never pick a number, and
there are no coordinates in any form.

## Statements

A statement starts at the beginning of a line; an indented line continues the one above (indentation never nests
anything). `//` starts a comment, also after a statement. After the keyword, the id and the text, attributes and
placements come in any order: a token ending in a colon opens an attribute and nothing else does. No commas between
attributes, no semicolons, no braces. The keywords are `node`, `edge`, `style`, `default`, `icon`, `diagram`.

### Nodes

```text
node <id> ["<text>" [(<text properties>)]] [<placement> | <attribute>] ...
```

Leave the text out and the id is the text. ` / ` (a slash with spaces) breaks a line; `TCP/IP` is safe. Containment
is a dotted id, parent declared first; children stack down in written order unless one is placed:

```archdraw
node server         "Server"
node server.api     "API"
node server.worker  "Worker"
```

A stretch of text can borrow a style's text color, which is how a box carries a quiet qualifier:

```archdraw
style dim  text: (color: theme-muted)
node grinder "Grinder / [dim]medium-fine[/dim]"
```

Text properties go in brackets after the text, never among the node's attributes: `color`, `size`
(`small | normal | large`), `wrap` (fold every n characters), `align`, `at`.

### The body

`shape: rectangle | document | circle | none` is the outline (`none` is bare text: a note). `icon: <name>` draws the
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
level with X     top level with X    bottom level with X
                 left level with X   right level with X
```

Any of them may name several targets, `right of a and b`, meaning the box bounding them. A gap goes in brackets on
its placement: `below a (gap: wide)`, with `none`, `tight`, `normal` (default), `wide`. An alignment takes no gap.

The three rules that decide most of what you write:

- **A lone direction binds both axes.** `right of api` also centers the node vertically on the API. That half drops
  away when another placement claims the axis.
- **Two placements on one axis and none on the other is an error**: `right of a  left of b` needs `level with a`.
- **Exactly one node may be unplaced.** Everything else hangs off it, directly or through others.

And two that follow:

- **Identical placements form a list.** Three nodes all `right of hub` stack down the page, centered on the hub, in
  written order. Two nodes with *different* placements that nothing orders are an error naming the pair: place one
  against the other.
- **Place against siblings.** A child is placed against its siblings or its parent; containers are placed against
  containers.

## Edges

```text
edge <a> -> <b> ["<text>"] [between <x> and <y>] [below|above|left of|right of <node>] [attributes]
```

`<-`, `<->`, `--` (no head) and `-->` (the same as `->`, valid since 0.14.0) all work; there is no `-.->`. Ends may be
marked (`a o--> b`, `a *--o b`). `from:` and `to:` name the side of the **first and second name written**, whatever
way the arrow points; name them so the line leaves and arrives the way the layout reads. A line never passes through
a box: it takes the shortest way round. `between x and y` sends it down the gap between two nodes, `below c` past one
side of a node. An edge with text widens its own corridor, so labels are safe.

`line: (path: square, corners: rounded, pattern: dashed, thickness: thick)` says how the line is drawn; `line: red`
alone is a color. Two edges between the same sides take lanes and never cross.

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

Check `archdraw/references/syntax.md` before inventing syntax. If a line goes the wrong way, say more about it (`between`, `below <node>`,
`from:`/`to:`); if a node is in the wrong place, add a placement. There are no waypoints, offsets or coordinates.
