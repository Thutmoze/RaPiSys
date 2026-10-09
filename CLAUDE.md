# CLAUDE.md

Guidance for Claude Code working on RaPiSys. This file is public: no IPs, hostnames,
usernames, or credentials here. Machine-specific details live in `~/.claude/CLAUDE.md`.

## What this is

RaPiSys is a self-hosted Raspberry Pi 5 monitoring and management dashboard, a
production-grade enhancement of zepgram/pi-dashboard. Single owner/developer.
Full design and as-built history: `ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`
(read the relevant section on demand; do not load it wholesale).

## Stack and layout

- Backend: Node 22, Express 5, ESM. `server/index.js` is the composition root.
  - `server/core/` db (better-sqlite3, `node:sqlite` fallback), migrations, scheduler,
    crypto (AES-256-GCM secrets), agent-client, node-identity, totp
  - `server/collectors/` read-only "read -> normalized object" functions
  - `server/repositories/` all SQL lives here, one file per domain
  - `server/services/` domain logic (alerting, mailer, peer-poller, ...)
  - `server/routes/` one Express router per domain
  - `server/stats.js` is the legacy upstream collector; keep its output shape intact
- Migrations: `server/core/migrations/NNN_name.sql`, numbered, never edit an applied one.
- Host agent: `agent/rapisys-agent.cjs` (+ `.service`). Runs as root on the host via
  systemd, listens on a local Unix socket, executes ONLY an allowlist of named ops.
  Never network it, never add a generic "run command" op, `execFile` only.
- Frontend: vanilla JS + Vite, no framework. Most UI lives in `src/modules/app.js`;
  also `layout.js` (GridStack), `summary-widgets.js`, `node-switcher.js`.
  `src/main.js` and `src/style.css` are the upstream base.
- Deployed as Docker (`network_mode: host`, ports 3001 HTTP / 3443 HTTPS) plus the
  agent systemd unit. `deploy.sh` handles install/upgrade/rollback on the Pi.
- Multi-node is federated peers (read-only HTTPS between Express servers, API key,
  TOFU cert pinning). There is no primary/secondary and no shared database.

## Commands

```bash
npm test            # vitest run, full suite. Run before EVERY backend commit.
npm run build       # vite build (frontend)
npm run dev         # local server + vite
```

Hardware-backed code paths (vcgencmd, sysfs, agent ops) cannot be exercised on the Mac.
Test them with fixtures; say explicitly when something can only be verified on the Pi.

## Workflow (mandatory)

1. `git pull --rebase` before starting. Other sessions may have pushed.
2. Read the live code before designing. Use targeted `grep -n` and line ranges.
3. For any UI change: build a standalone HTML mockup in `mockups/` (gitignored) using
   the real design tokens from `src/style.css`, interactive where behavior matters.
   Tell me the path, then STOP and wait for explicit approval.
4. Implement only after approval. Keep the change scoped to what was approved.
5. Run `npm test`. Fix failures before committing.
6. Commit with a conventional message (`feat(scope):`, `fix(scope):`, `perf:`,
   `chore:`, `docs:`), subject explains the user-visible effect. Then push.
7. End the turn with the Pi deploy command (see below).

## Deploy handoff (print after every push)

One command per Pi, agent included:
```bash
cd ~/RaPiSys && sudo ./deploy.sh upgrade
```

It pulls (as the checkout's owner), snapshots, reinstalls and restarts the agent
only when `agent/` changed, rebuilds, health-gates, and rolls everything back
(agent included) on failure. Still say in bold when the pushed commits touch
`agent/`, so an agent restart is expected.

Do not deploy with a bare `docker compose up -d --build`: it updates the container
only, and a new container talking to an old agent fails with "operation not
allowed".

## Interaction conventions

- CLI instructions for me: ONE at a time, wait for the result. Exception: the deploy
  handoff above is always given in full.
- Questions: ONE per turn, with options, the recommended one marked "(Recommended)".
- Diagnosis: ask for real output instead of speculating.

## UI conventions

- Preserve the design language: dark theme, glass cards, cyan/purple accents,
  CSS variables from `:root`, Lucide-style inline SVG icons, toasts.
- Every new component needs normal, `body.compact`, and `body.ultra` styles.
- Buttons: `set-btn-detect` (purple) for read-only inspect/scan, `set-btn-edit` (cyan)
  for edits, neutral `set-btn-cancel` for cancel (never red or amber).
- Settings forms collapse when configured.
- Pagination: reuse `.inv-pager` / `.net-toggle`; no new styles needed.
- No em dashes in UI text.
- API: internal under `/api/`, external under `/api/v1/` (API key). Mutations are
  gated by `requireControl`. Keep legacy upstream endpoint shapes byte-compatible.
- Update README.md when adding features, endpoints, or config options.

## Hard-won learnings (do not relearn these)

- `rapisys.db` stays on LOCAL storage. SQLite over CIFS puts better-sqlite3's sync reads
  into kernel D state and freezes the event loop. NAS gets gzip backups only (same
  pattern as `pihole-FTL.db`).
- The `nas_mounts` table is unused. NAS config lives only in
  `settings.rapisys.nas` in `settings.json`.
- Raspberry Pi package tagging: `archive.raspberrypi.com` origin is the authoritative
  signal, not name prefixes or dpkg text. `+rptN` (small int) = Debian rebuild, not
  tagged; `+rpt<date>` = RPi fork, tagged.
- Raspberry Pi's own firmware (`rpi-eeprom`, `raspi-firmware`) carries both the
  `firmware` and `raspberry pi` tags. Generic firmware (`firmware-*`) never gets the
  Pi tag from its summary, only from origin. Kernels never get it (deferred).
- binNMU (`+bN`): the newest changelog entry predates the installed version, so the
  highlighted entry must come from version comparison, not array index.
- Peer health is sampled as an ordinary metric (`peer.<n>.up`, 60 s); peer-down alerts
  use the normal alert engine, no special condition type.
- Pi-hole v6: `queries` is a view over `query_storage`; domains are normalized into
  `domain_by_id`; full wipe via `pihole-FTL sqlite3`; `pihole -f` only deletes outside
  the retention window.

## Open items

- Kernel tagging decision (deferred).
- Pi-hole rebuild (container was pruned).
