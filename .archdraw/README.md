# archdraw: architecture

## What this is

archdraw, architecture diagrams for code projects kept current from git: a fork of the reladraw engine, the studio app (server, UI, desktop shell) and its agent.

## Diagrams

Read `system` first; the others go a level deeper.

- `system` — archdraw, the whole system: One server runs the engine, your repos' diagrams and the agent; the desktop app runs the same server in-process. Every change is a commit on archdraw/update that you approve.

These files are maintained with archdraw: every change arrives as a reviewed update on the `archdraw/update` branch.
