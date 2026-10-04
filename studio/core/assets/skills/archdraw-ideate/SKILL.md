---
name: archdraw-ideate
description: Use when the user is designing a new feature or product, or wants a first diagram of a system that has none — ideation by short Socratic questions, then a new archdraw system diagram (and linked detail diagrams when it grows) with an explanation recording what was decided, what is open, and the first slice.
---

# Ideating and drawing something new (J4)

The diagram is the product of a conversation, not its opening move. Understand first, draw once enough is known,
then refine with the user. Read `archdraw/references/conventions.md` and `archdraw/references/cookbook.md` before the
first line.

## 1. Read before asking

If there is code, read it first (`list`, `grep`, `read`, the README, `.archdraw/README.md`, `list_diagrams`). Never
ask what the code answers. If there are diagrams already, the new one must use the same names for the same things.

## 2. Ask in this order, one theme per turn

| turn | theme | what you need |
|---|---|---|
| 1 | the goal | what changes for whom when this exists; what is out of scope |
| 2 | who uses it | the people and systems that touch it, and on what device or channel |
| 3 | the one scenario | the single most important end-to-end path, step by step |
| 4 | the parts | what must exist to carry that path: apps, services, jobs, providers |
| 5 | the data and its owner | what is stored, where, and which part is the only writer |
| 6 | where it runs | the hosts, accounts, machines: these become the zones |

Each turn: what you understood in at most three bullets, then **at most two questions, each carrying the answer you
would pick**, so a "yes" moves on:

> Who uses it first — just the shop's staff on a tablet, not customers yet? (I'd start there: one role, one device.)

Skip a theme the user or the code already answered; say what you assumed. Stop asking when the scenario, the parts,
the data owner and the hosts are known; a reasonable assumption beats a fifth question.

## 3. Draw it, in this order

1. **Header**: `// title: <Product>, the whole system` and a one-sentence `// summary:`; then the house block verbatim.
2. **The anchor and the main direction**: the person or entry point is the one unplaced node; the scenario flows left
   to right (callers left of callees), async and jobs below.
3. **Zones first**, placed against each other with `(gap: wide)` and `top level with`; one per place things run.
4. **Nodes**, each in its zone, two to four words plus a `[dim]` qualifier (technology, cadence, route), styled by
   role: `ours`, `job`, `store`, `ext`. Children stack in written order: write them in scenario order.
5. **Edges**, the scenario's first, each with the mechanism as text, sides (`from:`/`to:`) matching the layout, and
   `style: async` where the sender does not wait. Arrow = who initiates.
6. **One note** for the thing a reader would get wrong (the only writer, the trust boundary, the cost cap).
7. `check_diagram`, fix, check again (`archdraw/SKILL.md`, the loop). Then re-read the source as the user will.

Use the cookbook's snippets for the recurring shapes (request path, queue and worker, cron, webhook back, zones).

## 4. Keep it under 25 boxes

Past about 25 boxes, or a second purpose (deployment and a data model, a system and a step-by-step flow), split:

- `system`: the zones and the main parts only, each subsystem one box with `url: "#/<project>/<detail>"`.
- one detail diagram per subsystem or per flow (`checkout-flow`, `data-model`), each with its own header and block.
- Propose `system` first; offer the details one at a time. Tell the user the `order.json` line to add
  (`["system", "checkout-flow", ...]`): you cannot write it.

Draw only what was said or decided. A part the user has not confirmed is an open question in the explanation, not a
box. A planned part that is decided but not built says so in its qualifier: `"Search / [dim]planned[/dim]"`.

## 5. End with the system diagram and a decisions record

`propose_diagram` named `system` (or the user's name for it), and the explanation:

```
# <Product>, the whole system

## Purpose
The question it answers; what it leaves out (and which detail diagram has it).

## Key flows
1. <the scenario, step by step, naming each mechanism>.

## Decisions
- <decided>: <the choice> — because <the reason the user gave>.

## Open questions
- <not decided>: <the options>, <the one you would pick>.

## First slice
The smallest end-to-end piece worth building first: which boxes and edges of this diagram, and what it proves.

## Invariants
- <X never calls Y>; <Z is the only writer of W>.
```

Then, in the reply: what the diagram shows in at most three bullets, and the one or two questions that most change it.
Revise on each answer by the edit rules (`archdraw-edit/SKILL.md`): fewest lines, never reorder.

## Example first draft

After six short turns about a café ordering feature: one person, one zone per host, five boxes, the scenario's edges.

```archdraw
// title: Bean There, the whole system
// summary: How a coffee order goes from the customer's phone to the barista, and how it is paid.

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

node customer  "Customer / [dim]phone[/dim]"  icon: laptop

node cloud         "Cloud  [dim]one region[/dim]"  right of customer (gap: wide)  style: zone
node cloud.api     "Orders API / [dim]Node[/dim]"  style: ours  url: "#/bean-there/ordering"
node cloud.db      "Orders, menu / [dim]Postgres[/dim]"  style: store

node shop          "Shop"  below customer (gap: wide)  style: zone
node shop.tablet   "Barista queue / [dim]tablet app[/dim]"  style: ours

node stripe  "Stripe / [dim]cards[/dim]"  right of cloud (gap: wide)  style: ext

edge customer -> cloud.api      "HTTPS"  from: right  to: left
edge cloud.api -> cloud.db      "SQL"
edge cloud.api -> stripe        "charge, HTTPS"  from: right  to: left
edge shop.tablet -> cloud.api   "poll orders"  from: right  to: left

node pay_note "An order reaches the barista only after the card is authorized." (wrap: 36)  shape: none  style: note  below shop (gap: tight)  left level with shop
```
