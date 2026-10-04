# House conventions

How every archdraw diagram in a project looks, so a reader who has seen one has seen the vocabulary of all. The
language allows much more; these are the choices. When a project's own diagrams already follow a variant, match the
project and say so.

## Where a diagram lives

- `.archdraw/<name>.archdraw` in the project's repo, and beside it `<name>.md`, its explanation.
- `<name>` is lowercase letters, digits and dashes (`system`, `daily-edition`). It is the file name and the last part
  of every link to it.
- `.archdraw/order.json` is a JSON array of names, the order the studio lists them in: `["system", "pipeline",
  "data-model"]`. Names it leaves out come after, alphabetically. Put `system` first. You cannot write it: when you
  propose a new diagram, tell the user where it belongs in `order.json`.
- `.archdraw/README.md`, when there is one, is the project's own page: what it is, non-goals, invariants. Read it
  (`read`) before drawing anything new.

## The file header

The first lines of every file, before any statement. The studio shows them in the diagram list and above the
picture, and reads only the comment lines at the top, so nothing may come before them:

```archdraw
// title: Bean There, the whole system
// summary: How a coffee order goes from the customer's phone to the barista, and how it is paid.

node app "Customer app"
```

- `title`: the project, a comma, what this diagram is. A few words.
- `summary`: one sentence, the question the diagram answers. Not a list of its boxes.

## The house style block

Copied verbatim after the header, identical in every file of every project. Never edit it inside a diagram; a style a
single diagram needs goes on its own line under it (`style lane  text: (color: theme-muted)`).

```archdraw
// title: Example
// summary: The house block on its own.

// --- house styles: identical at the top of every diagram ---------------------
style ours   fill: theme-primary-subtle  border: theme-primary
style job    fill: theme-fill            border: theme-primary
style store  fill: theme-fill            border: theme-border     badge: database
style ext    fill: theme-fill            border: theme-secondary
style zone   fill: none                  border: theme-border     text: (color: theme-muted)
style dim    text: (color: theme-muted)
style note   text: (size: small, color: theme-muted)
style async  line: (pattern: dashed)
default edge  text: (size: small)

node a "A box"  style: ours
```

| style | on | means |
|---|---|---|
| `ours` | a box | code this project owns and runs on request: an app, a service, an API route, a function |
| `job` | a box | code this project owns that runs on a clock or off a queue: a cron, a worker, a consumer, a scheduled function |
| `store` | a box | data at rest: a database, a table group, a bucket, a cache, a queue or topic. Draws a database badge |
| `ext` | a box | someone else's system: a SaaS, a provider API, an auth service, a legacy system the project does not own |
| `zone` | a container | where things run: a cloud account, a machine, a browser, a region, a cluster. Also the trust boundary |
| `dim` | a stretch of text | the quiet qualifier: `[dim]Postgres[/dim]`, `[dim]cron, 15 min[/dim]`, `[dim]/api/orders[/dim]` |
| `note` | a `shape: none` node | the one sentence a reader would otherwise get wrong |
| `async` | an edge | the sender does not wait for the answer: a publish, a webhook, a callback, a fire-and-forget |
| `default edge` | every edge | edge texts set small, so labels stay quieter than boxes |

What has no style: a person or a device is `icon: laptop` (or `icon: desktop`) with its role as the text ("Reader",
"Customer"); there is no phone or person icon, so do not invent one. A produced artifact (an export, a report, a PDF,
a dump) is `shape: document`, with no style.

### Colors and theme

The studio renders every diagram in its own light and dark theme and overrides any `diagram theme:` line, so a
diagram never writes one. Use `theme-*` colors only, and only through the block above: a hex color reads on one theme
and disappears on the other. A new meaning gets a new style built from theme colors, never a color on one node.

## Names (ids)

- Lowercase, short, `snake_case`: `api`, `db`, `sync_worker`, `stripe`. Never `:` or `;`.
- A dotted name is containment: `aws.db` is inside `aws`, which must be declared above it.
- The id is what the studio's change list, every edge, every placement and other diagrams track; the text is what a
  reader sees. To rename what a reader sees, change the text and keep the id.
- Notes end in `_note` (`api_note`); zones are named for the place (`aws`, `browser`, `trex`).

## Text in a box

- Two to four words naming the thing as the code names it, then ` / ` and a `[dim]` qualifier when one helps:
  `"Orders API / [dim]FastAPI[/dim]"`, `"Daily scheduler / [dim]cron, 15 min[/dim]"`.
- A zone's qualifier stays on its title line, after two spaces: `"AWS  [dim]us-east-1, private VPC[/dim]"`.
- ` / ` (spaced) breaks a line in an edge text too, so write `GET, SET`, not `GET / SET`. `TCP/IP` and paths are safe.
- No secrets, keys, personal data or real customer names in any text.

## Edges

- The text is the mechanism: `HTTPS`, `SQL`, `REST, JWT`, `publish`, `webhook, signed`, `cron`, `gRPC`, `S3 PUT`.
  Where an edge crosses a zone border, say how it is authenticated (`HMAC`, `JWT`, `mTLS`).
- The arrow points from whoever initiates to whoever is called. A worker that polls a queue points at the queue; a
  queue that pushes points at the worker. Data flowing back is the reply, not a second arrow.
- `style: async` when the sender does not wait. A callback that reports a result later is its own `async` edge from
  the caller back.
- Give sides (`from:` / `to:`) that match the layout: `from: right  to: left` along a row, `from: bottom  to: top`
  down a column. `from:` is always the first name written.
- Every edge has a text. An unlabeled edge is a question the reader cannot answer.

## Zones and layout

- Zones (containers) first, then their contents, then edges, then notes. Order matters to the engine: children stack
  in written order, and later edges jump earlier ones where they cross.
- Place zones against zones, with `(gap: wide)` between them and `top level with` to line their tops up. Place a
  zone's children against siblings in the same zone, never against a node in another zone.
- One level of zones; two at most (a machine inside a cloud account).
- Pick one main direction and keep it: requests flow left to right, callers above callees, time down the page.

## Notes

`node <id>_note "<one sentence>" (wrap: 36)  shape: none  style: note  <placement>`. Write `shape: none` on the
node, not in a style: the studio's outline lists a node as a note only when the node itself says it. Wrap 34 to 44.
Anchor it to the node it explains (`below api (gap: tight)  left level with api`). At most two per diagram; a third
belongs in the explanation.

## Drill-downs

`url: "#/<project>/<file>"` on a node opens that diagram when the node is clicked. Project and file are lowercase
letters, digits and dashes only: the studio drops any other link silently. Copy the project slug from an existing
link in the project's diagrams; if there is none, ask. Put the link on the node the detail diagram expands, in the
system diagram; a detail diagram does not link back. A container's link covers its children.

## Sizes

- One purpose per diagram: the question in its `summary`.
- 8 to 25 boxes. Past 25, split: a `system` diagram with the zones and the main parts, each linked to a detail
  diagram for one subsystem or one flow.
- A flow over time (steps in order across places) is its own diagram: steps numbered in their text (`"3 Charge
  card"`), time running down the page.
- A file stays well under the studio's 200 KB cap; a diagram that approaches it is several diagrams.

## The explanation (`<name>.md`)

```
# <the title>

## Purpose
The question it answers, and what it deliberately leaves out.

## Key flows
1. <who> <does what> <over which mechanism>.
2. ...

## Invariants
- <X> never calls <Y>.
- <a fact that must stay true, and the file that enforces it>.

## Open questions
- <what is not decided or not known>.
```

Short, specific, and nothing the picture already says. Name the source file behind a claim where one exists.
