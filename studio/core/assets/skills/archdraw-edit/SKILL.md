---
name: archdraw-edit
description: Use when the user asks to change an existing archdraw diagram — add, remove, rename, move or restyle a box, an edge or a note, or bring a diagram up to date with the code. Makes the smallest change that keeps everything else true, checks it, and proposes it.
---

# Changing a diagram (J3)

The user will compare your proposal with the original side by side, line by line. A good change is the fewest lines
that make the diagram true, with everything else untouched. Read `archdraw/references/conventions.md` once if you
have not, and keep `archdraw/references/pitfalls.md` for the errors.

## 1. Read the whole file

`read_diagram <name>` and read the source top to bottom, not only the outline. Note:

- the anchor: the one node with no placement. Everything hangs off it.
- what each node you will touch is placed against, and what is placed against it (`grep` the id in the source with
  your eyes: `right of api`, `level with api`, `below api and db`, `between api and x`, edge clauses `below api`).
- the containers, and which children stack in written order (no placement of their own).
- the style names in use. Use them; do not add new ones unless nothing fits.

If the change comes from the code ("the worker moved to Modal"), confirm it in the code first and name the file.

## 2. Change the fewest lines

- **Never reorder lines.** Order is meaning here: children stack in written order, identical placements form a list
  in written order, later edges jump earlier ones where they cross, edges sharing sides take lanes by order. Moving a
  line moves the picture.
- **Add a child at the end of its container's children**, after the last line that starts with `<container>.`, so
  the existing stack does not shift. A child with no placement joins the bottom of the stack.
- **Add a top-level node with a placement.** Without one it is a second unplaced node:
  `line 2: exactly one node may say nothing about where it goes, but 2 do: "a", "b"`.
- **Place it against a sibling** (same container, or both top level). Against a node in another container:
  `line 4: "b.y" is placed against "a.x", which is not one of its siblings or its parent`.
- **Add edges with the other edges**, at the end of the group they belong to, with text and sides.
- **Edit in place**: change the text inside the quotes, or one attribute; leave alignment spaces as they are.
- **Restyle by changing `style:`**, never by adding a color.

## 3. Removing

Delete the node's line, then every line that names it: its children (`id.`), its edges, and **every placement against
it**. A placement against a deleted node fails with the node's name; a node whose only placement was against it
becomes unplaced (the error above). Re-anchor those nodes on a neighbour that stays, with the same direction, so they
land near where they were.

## 4. Renaming

Change the **text**, not the id, whenever the user means "call it something else": the id is what links, edges,
placements and the studio's change list track. When the id itself must change (it is misleading or collides), work the
checklist:

1. the declaration line;
2. every child: `old.x` becomes `new.x`;
3. every edge end: `old ->`, `-> old`, `old.x`;
4. every placement: `of old`, `with old`, `and old`, `between old and`;
5. every edge clause: `below old`, `left of old`;
6. in other diagrams, `url: "#/<project>/<old-file>"` when it is a file you are renaming. You can only propose one
   file at a time: tell the user which others link to it.

`check_diagram` catches any you missed: `line N: edge to "old", which does not exist`.

## 5. Check, then propose

1. `check_diagram` the complete file. Fix only the line named; check again (`archdraw/SKILL.md`, the loop).
2. An overlap error after adding a node (`"a" and "b" overlap, and nothing says which side of the other either one
   sits on`) means your node and an existing one now claim the same spot: place yours against the other one, or give
   it the identical placement so they form a list. Do not move the existing node.
3. Re-read your diff against the original: only the lines you meant changed.
4. `propose_diagram` with the same name and the complete file. Pass the explanation too when the meaning changed:
   a new or removed part, a changed flow, a broken invariant. The explanation you pass replaces the whole `.md`, so
   pass the complete text: the sections the change touched updated, the rest verbatim. Leave it out and the current
   `.md` stays as it is.

## 6. Say what changed

In the reply, at most three bullets: **added** (ids and what they are), **removed**, **renamed** or **changed** (old →
new), with the file in the code that justifies each. Then anything you chose not to change and why, and at most two
questions. If the request would push the diagram past 25 boxes or a second purpose, say so and offer a linked detail
diagram instead (`archdraw-ideate/SKILL.md`, the split).

## Example

The user: "the API now also writes to a Redis cache". The diagram has `node api … style: ours` placed `right of web`
and `node db … right of api (gap: wide)  style: store`. Two lines, appended in their groups:

```archdraw
node web    "Web app"  style: ours
node api    "Orders API"  right of web (gap: wide)  style: ours
node db     "Orders / [dim]Postgres[/dim]"  right of api (gap: wide)  style: store
node cache  "Sessions / [dim]Redis[/dim]"  below db  style: store

edge web -> api    "REST"  from: right  to: left
edge api -> db     "SQL"  from: right  to: left
edge api -> cache  "GET, SET"  from: right  to: left
```

Reply: added `cache` (Redis, `style: store`, below `db`) and `api → cache: GET, SET`, per `api/cache.py`.
