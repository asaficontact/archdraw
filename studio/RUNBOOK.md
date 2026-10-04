# archdraw — runbook

One TypeScript server (`dist/server.mjs`): headless on trex behind Tailscale Serve, and the same code inside the
desktop app (Electron, on 127.0.0.1 with a per-launch token). Diagrams live in each connected repo's `.archdraw/`;
every change waits on the repo's `archdraw/update` branch until it is approved in the Inbox.

| | |
|---|---|
| **Unit** | `archdraw-studio.service` (user), from `studio/systemd/` |
| **Port** | `127.0.0.1:8088`; Serve `https://trex.tailcbcba5.ts.net:8445` (its own origin, tailnet only) |
| **Up?** | `curl -s http://127.0.0.1:8088/api/health` from this uid → `{"ok":true,...,"mode":"tailnet"}` |
| **Logs** | `journalctl --user -u archdraw-studio -n 50` (refusals name their reason; each sync logs its outcome) |
| **State** | `ARCHDRAW_HOME=~/work/data/archdraw`: `config.json` (projects, settings, tour), `repos/<slug>` (the app's own clones; never edited by hand), `work/<slug>` (the update branch's worktree), `conversations/`, `spend.json` |
| **Secrets** | LLM keys from `~/work/secrets/providers.env` (owner-only, read by the program); git and PRs use this box's git login (`gh auth git-credential`). Nothing is logged or sent to the browser. |
| **Gate** | `ARCHDRAW_GATE=tailnet`: Tawab, through Serve, from a non-agent node (identity from Serve's headers + `tailscale whois`); this uid on loopback may read `/api/health` |
| **Deploy** | from its own worktree, `~/work/projects/archdraw-live`, detached at the reviewed commit (the dev checkouts are never what runs): once, `git -C ~/work/projects/archdraw worktree add --detach ~/work/projects/archdraw-live <commit>`; then `git -C ~/work/projects/archdraw fetch && git -C ~/work/projects/archdraw-live checkout --detach <commit>` → in it `npm ci && npm run build` → `cd studio && npm ci && (cd ui && bun install --frozen-lockfile && npx vite build) && node scripts/build.mjs server` → `cp studio/systemd/archdraw-studio.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user restart archdraw-studio`. Only one server may use `~/work/data/archdraw`: stop any preview first. |
| **Rollback** | `checkout --detach <previous>` in `archdraw-live`, rebuild, restart. Back to the Python studio (before archdraw#2): `~/work/projects/archdraw` stays on `feat/studio` (92ae7eb) with its venv; `git -C ~/work/projects/archdraw show 92ae7eb:studio/systemd/archdraw-studio.service > ~/.config/systemd/user/archdraw-studio.service`, daemon-reload, restart. |

## Desktop builds

`npm run dist:linux` (AppImage + deb) on Linux; macOS packages come from the `desktop` workflow's macOS runner
(ad-hoc signed; unsigned builds cannot run on Apple Silicon). Each run's artifacts are on its Actions page for 14 days.

## Checks

`npx vitest run` (core + server) · `cd ui && npx vitest run` · `npx tsx e2e/app.e2e.ts` · `npx tsx e2e/tour.e2e.ts` ·
`xvfb-run -a npx tsx e2e/desktop.e2e.ts [--exe <packaged binary>]` (the e2e need `PLAYWRIGHT_CORE` and
`PLAYWRIGHT_BROWSERS_PATH`).

## When it is down

1. `systemctl --user status archdraw-studio`; restart; read the journal.
2. `tailscale serve status` lacks `:8445` → `tailscale serve --bg --https=8445 http://127.0.0.1:8088`. Never Funnel,
   never `0.0.0.0`.
3. A project's sync shows "waiting: …" in the Inbox: a draft failed for that commit (no key, no push rights); fix the
   cause and press Sync now.
4. Approve says the branch changed the same diagrams: Discard the update; the next check drafts again from main.
