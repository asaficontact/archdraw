---
name: archdraw-read
description: Use when the user asks what an archdraw diagram shows, wants it walked through, or asks a specific question about the system it draws (does X call Y, where does Z run, what happens when, who owns this data). Reads the diagram, traces the question through it, and confirms the answer in the code.
---

# Reading a diagram (J1 explain, J2 answer)

A diagram is a claim about the code. Your job is to read the claim precisely, check it where it matters, and say
plainly what the diagram does not show. Read `archdraw/references/conventions.md` once if you do not yet know what
the house styles mean: the style on a box is half its meaning.

## 1. Read it

- `list_diagrams` if you do not know which diagram the user means; pick by title and summary, and say which you
  picked.
- `read_diagram <name>`: the outline (parts as a tree, notes, connections), the explanation, and the source.
- Read the explanation first: its Purpose says what the diagram answers and what it leaves out. Then the outline.
  Go to the source only for what the outline drops: sides, `async` on an edge, placements, comments.

## 2. Outline the parts, with roles

Build the tree in your head (or in the reply, for J1): zones and what runs in each.

| you see | it means |
|---|---|
| a container, `style: zone` | where its children run: an account, a machine, a browser. Also a trust boundary |
| `ours` | code this project owns, run on request |
| `job` | code this project owns, run on a clock or off a queue; the cadence is in its `[dim]` qualifier |
| `store` (database badge) | data at rest: database, bucket, cache, queue |
| `ext` | a system the project does not own |
| `icon: laptop` / `desktop` | a person or a device; the text is their role |
| `shape: document` | an artifact produced, not run |
| `shape: none` | a note: the thing the author feared you would get wrong. Read every one |
| `→ #/<project>/<file>` in the outline | a `url:` drill-down; the detail is in that diagram |

## 3. Walk it (J1)

In reading order: the zones from where a request starts (usually the person or the left) to where data lands, then
the jobs and the async paths. For each zone: what runs there, in one line. Then the main flow as numbered steps over
the edges, each naming the mechanism on the edge. End with the notes and what the diagram leaves out.

## 4. Trace a question (J2)

1. Find the node(s) the question names. Match on the text and the qualifier, not only the id; if two match, say so.
2. Follow edges **in both directions**: what calls it (edges ending at it) and what it calls (edges starting at it).
   The arrow is who initiates; the text is the mechanism; `async` means the sender does not wait.
3. Go up the containers: the zone a node sits in is where it runs, and an edge to a container is to the zone as a whole.
4. Follow `url:` links: when the answer is inside a box that has one, `read_diagram` the linked file and continue
   there. Say you did.
5. Absence is an answer only within the diagram's stated purpose: "the diagram shows no edge from the app to the
   database" is a fact about the drawing; whether the code has one is step 5.

## 5. Confirm in the code

When the answer matters (the user will act on it, or the diagram might be stale), check it:

- `grep` for the names on the boxes and edges: the route (`/hooks/stripe`), the queue name, the client
  (`ConvexHttpClient`), the table, the cron expression.
- `read` the file that does it, the lines that matter; `git_log` / `git_diff` when the question is "since when" or
  the code and the diagram disagree.
- Name the files. If the code disagrees with the diagram, say which is right as far as you can tell, and offer the
  fix as a J3 change (`archdraw-edit/SKILL.md`); do not change anything unasked.
- If you did not check, say "per the diagram" rather than stating it as fact.

## 6. Say what it does not show

Every diagram leaves things out: say the one or two that bear on the question (retries, auth, the data shape, another
diagram's territory). Do not invent them to fill the gap.

## Answer shape

- At most three bullets: the answer first, then the path that shows it (`app → api: HTTPS`, `worker → queue: poll`),
  then the caveat or what is not shown.
- Citations: the diagram (`system`, node ids) and the files you confirmed in (`convex/sync.ts`).
- At most two questions back, each with the answer you would pick.
- For J1 on a large diagram: the zones in one bullet each is fine past three bullets only if the user asked for a
  walk-through; otherwise offer it.

Example (J2 on the sample Bean There `overview`, "does the customer app talk to the database?"; the file names
stand for whatever the code search finds):

- No, per the diagram: `app → api: HTTPS`, and only `api → menu: SQL` reaches a store. The README's invariant says the
  same ("the app never talks to the database").
- Confirmed in `<the app's API client file>`: its only base URL is the Orders API; no database driver in its
  dependencies.
- Not shown: how orders are stored; `ordering` has that (the `api` box links to it).
