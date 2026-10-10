# archdraw studio — runbook

| | |
|---|---|
| **Unit** | `archdraw-studio.service` (user), from `studio/systemd/` |
| **Port** | `127.0.0.1:8088`; Serve `https://trex.tailcbcba5.ts.net:8445` (its own origin, tailnet only) |
| **Up?** | `curl -s http://127.0.0.1:8088/api/health` from this uid → `{"ok": true, ...}` |
| **Logs** | `journalctl --user -u archdraw-studio -n 50` (refusals name their reason) |
| **Library** | `ARCHDRAW_LIBRARY` (default `~/work/brain/projects`); saves commit to the brain checkout under `brain-write.lock` |
| **Secrets** | none; identity is Serve's headers + `tailscale whois` (same gate as the Ohara Inspector) |
| **Deploy** | in `~/work/projects/archdraw` (detached at the reviewed commit): `npm ci && npm run build` → `cd studio && uv sync --locked` → `cd ui && bun install --frozen-lockfile && bun run build` → `cp studio/systemd/archdraw-studio.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now archdraw-studio` → `tailscale serve --bg --https=8445 http://127.0.0.1:8088` |
| **Rollback** | `git checkout --detach <previous>`, rebuild engine and ui, `systemctl --user restart archdraw-studio` |

## When it is down
1. `systemctl --user status archdraw-studio`; restart; read the journal.
2. `tailscale serve status` lacks `:8445` → re-add it as above. Never Funnel, never `0.0.0.0`.
3. A save fails with "commit failed": another writer holds the brain lock or the checkout is mid-rebase; the file is
   written, so retry the save once the brain is quiet.
