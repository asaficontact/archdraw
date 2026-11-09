# archdraw

**archdraw** is Tawab's fork of [reladraw](https://github.com/reladraw/reladraw): architecture diagrams, explained in the
most aesthetic and plainly clear way. It is the language his agents use to discuss, plan and maintain the architecture
of every project they work on.

- **The engine** (`src/`, `dist/`, `SYNTAX.md`) is reladraw's, unchanged, and tracks upstream releases: the `upstream`
  remote is reladraw/reladraw, and a release is merged in by a reviewed PR (the daily archdraw task notices new tags).
  Licensed Apache-2.0 (see `LICENSE` and `NOTICE`); the name "reladraw" and its marks belong to that project, which is
  why this fork is called archdraw.
- **The studio** (`studio/`) is ours: projects, each a collection of `.archdraw` files, rendered on an infinite canvas.
  Its library is the brain (`~/work/brain/projects/<project>/archdraw/*.archdraw`), so the diagrams are the same
  documents every agent reads. See `studio/README.md`.

A `.archdraw` file is reladraw syntax, with two comment lines first that the studio reads:

```
// title: Daily edition, end to end
// summary: One reader's edition from capture to the page they read.
```
