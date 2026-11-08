# archdraw studio

Projects of architecture diagrams on an infinite canvas. Tailnet only: https://trex.tailcbcba5.ts.net:8445/

- **Library:** the brain. A project is `~/work/brain/projects/<slug>/archdraw/`; its diagrams are the `*.archdraw` files
  in it (reading order from an optional `order.json`). The project's title comes from its hub note's `# heading`.
- **Canvas:** every diagram of the project as a card. Drag to pan, wheel/pinch (or ctrl-wheel) to zoom, double-click a
  card to fly to it; selecting a diagram in the sidebar flies to it. `All` fits everything. Light and dark follow the
  system or the toggle, and the diagrams render in the matching engine theme.
- **Links between diagrams:** `url: "#/<project>/<file>"` on a node makes it open that diagram in the studio, so a box
  can drill into the diagram that explains it. http(s) links open a new tab; other schemes are dropped.
- **Editing:** `Source` opens the file beside the canvas; the card re-renders as you type and shows the engine's error
  in place. Save (⌘/Ctrl-S) is refused unless the engine renders the file, and refused if the file changed since you
  opened it; a save commits that one path to the brain under its writer lock (pushed by the brain's publish step).
- **Rendering** is the engine in this repo (`dist/`), in the browser and in the server's check, so the studio, the CLI
  and every agent draw the same picture.

## Develop

```
npm ci && npm run build                 # the engine (repo root)
cd studio && uv sync && uv run pytest   # server
cd ui && bun install && bun run test && bun run build
ARCHDRAW_LIBRARY=/some/dir ARCHDRAW_ALLOW_LOCAL=1 uv run uvicorn --factory archdraw_studio.app:main_app --app-dir server --port 8088
```

## Audit

`cd studio/server && ../.venv/bin/python -m archdraw_studio.audit --since 24h` lists diagrams the engine refuses,
projects worked on without a diagram change, projects with no diagrams, and whether the newest reladraw release is
merged. The daily task `banna-archdraw-daily` runs it.
