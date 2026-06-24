# RaPiSys — Architecture & Implementation

**Project:** Production-grade enhancement of `zepgram/pi-dashboard` for Raspberry Pi 5 (shipped as **RaPiSys**)
**Target platform:** Raspberry Pi 5 · Raspberry Pi OS Bookworm/**Trixie** (arm64) · Docker / Docker Compose
**Status:** IMPLEMENTED — all planned feature areas are built and in production use. This document is the original design (sections 1–11) preserved for context, plus an **as-built addendum** (section 13) covering what shipped and the post-plan DNS/Pi-hole subsystem.
**Plan date:** 2026-06-10 · **Last updated:** 2026-06-24

> **Reading guide:** sections 1–11 are the original architecture/plan and remain largely accurate as the system's foundation. Section 12 (open questions) has been resolved — see §13.1. Section 13 is the current as-built state, including the DNS/Pi-hole integration and NAS-backup subsystem that were added after the original plan.

---

## 1. Current Architecture Analysis

This analysis is based on a direct review of the upstream repository (`main` branch, v1.0.0 tag, ~9,500 lines of first-party code).

### 1.1 Codebase inventory

| File | Lines | Role |
|---|---|---|
| `server/index.js` | 1,063 | Express app: CORS, rate limiting, auth middleware, all 17 API routes, settings persistence, static file serving |
| `server/stats.js` | 868 | All metric collection: `systeminformation`, `vcgencmd` throttle/overclock parsing, Docker stats, WireGuard, top processes, service discovery |
| `server/services-config.js` | 109 | Service check-type/icon inference, valid check types (http/tcp/redis/dns) |
| `src/main.js` | 2,223 | Entire frontend: polling loop, DOM rendering, Smoothie charts, themes, display modes, settings panel, toasts, alert sounds |
| `src/index.html` | 813 | Single-page card layout |
| `src/style.css` | 4,423 | All styles; design tokens in `:root`; per-mode overrides (`body.compact`, `body.ultra`) |

### 1.2 Architecture style

A deliberately simple **two-tier monolith**:

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  Browser (vanilla JS SPA)   │        │  Express server (Node 22)        │
│  - 1s polling of /api/stats │ HTTP   │  - stats.js → systeminformation, │
│  - In-memory history        │◄──────►│    vcgencmd, docker CLI, wg      │
│    (30 samples, lost on     │        │  - settings.json (file + mutex)  │
│    refresh)                 │        │  - serves built dist/            │
└─────────────────────────────┘        └──────────────────────────────────┘
                                                      │ ro bind mounts
                                              /proc /sys / docker.sock
```

Key characteristics relevant to this project:

- **No database.** The only persistence is `settings.json`, guarded by a promise-based file mutex. All time-series history lives in the browser (`HISTORY_LENGTH = 30`) and is lost on refresh. Every historical feature in the requirements (graphs, reports, retention, trends) therefore needs a new storage layer.
- **No framework on the frontend.** Vanilla JS + Vite build. Rendering is imperative DOM manipulation keyed off a polling loop. Smoothie Charts (canvas) renders live graphs. There is no component system, router, or state store.
- **Pull-based collection.** Every `/api/stats` request triggers a fresh `systeminformation` sweep (with a static cache for slow-changing data like disks/OS info). Nothing is collected when no browser is open — another reason historical features need a server-side scheduler.
- **Security model.** Optional `ADMIN_TOKEN` (timing-safe compare) protects mutating endpoints; optional API key protects `/api/v1/*`; in-memory per-IP rate limiting on config writes only; payloads capped at 10 KB; string sanitization on service config. CORS defaults to `*`. There is **no user/login concept** — relevant to feature 6 ("layouts per user").
- **Container posture.** Runs with `pid: host`, `network_mode: host`, `NET_ADMIN`, read-only mounts of `/proc`, `/sys`, `/`, and the Docker socket. It already reaches deep into the host — but it still **cannot** run `apt`, mount NAS shares, or control the fan from inside the container. This constraint shapes the architecture below.
- **Design language** (must be preserved): deep dark theme (`--bg-primary: #0a0a0a`), glassmorphism cards (`--bg-card: rgba(17,17,17,0.8)`), cyan/purple gradients (`--accent-cyan: #00d4ff`, `--accent-purple: #a855f7`), 16px radius, Inter font, 5 color themes, 3 display modes (normal/compact/ultra), Lucide-style inline SVG icons, toast notifications, card-grid layout.

### 1.3 Existing API surface (to remain unbroken)

`GET /api/health`, `/api/stats`, `/api/sysinfo`, `/api/services`, `/api/services/discover`, `/api/services/config`, `/api/settings`, `/api/settings/api`, `/api/settings/wireguard`, `/api/wireguard`; `PUT/POST/DELETE` counterparts under admin token; `GET /api/v1/system` under API key. All of these are kept byte-compatible.

---

## 2. Gap Analysis

| # | Requirement | What exists today | Gap |
|---|---|---|---|
| 1 | Pi 5 hardware monitoring | CPU temp, throttle flags, overclock detection via `vcgencmd` | No fan RPM/PWM, no fan mode, no PMIC voltage/current readings, no undervoltage event log, no server-side temperature history, no thermal alerts |
| 2 | User session monitoring | Nothing | Entire feature: SSH (`who -u` / utmp), VNC, Tailscale, plus login history storage |
| 3 | Network analytics | Per-interface byte counters + connection counts (live only) | No bandwidth history, no protocol/process/DNS analytics, no technology integration (vnStat etc.) |
| 4 | NAS + retention | Nothing (settings.json only) | Entire feature: SMB/NFS mounting, retention policies, storage monitoring, rotation/compression/archival |
| 5 | Reports + export | Nothing | Entire feature: aggregation, daily/weekly/monthly views, PDF/CSV/JSON export, health score |
| 6 | Dynamic layouts | Fixed card grid; 3 display modes | Drag/drop, resize, visibility, multi-page, presets, per-profile layouts (and a minimal profile concept) |
| 7 | Alerting + email | Client-side threshold sounds/toasts only (browser must be open) | Server-side rule engine, SMTP with secure credential storage, severity/suppression/escalation, test send |
| 8 | Update center | `updatesAvailable` count only | Update lists (apt/security/firmware/kernel), one-click + scheduled updates, history — requires privileged host execution |
| 9 | App inventory | Docker container list only | dpkg/systemd/user-app inventory, usage tracking, search/filter |
| 10 | DevOps | Dockerfile + compose + healthcheck | Deployment script with upgrade/rollback, host-side units, NAS mounts, env management |

**Cross-cutting gaps:** server-side time-series storage, a background scheduler, a privileged execution path, and a settings schema extension — these four enable almost every feature above.

---

## 3. Recommended Architecture

### 3.1 Guiding decisions

1. **Stay vanilla.** No React/Vue migration. The existing UI is vanilla JS and works well; rewriting it would violate "avoid breaking existing features" and "preserve design language." New pages are added as modules under `src/modules/`, sharing the existing CSS tokens, card components, and toast/theme systems. A tiny hash router (`#/network`, `#/sessions`, …) adds multi-page navigation without a framework.
2. **SQLite (better-sqlite3) as the storage engine.** Embedded, zero extra daemon, excellent on Pi 5 NVMe/SD, WAL mode for concurrent read/write, trivially relocatable to a NAS mount. A time-series DB (Influx/Timescale) is overkill at this scale (~1 metric row/10s) and would consume 200–500 MB RAM the Pi can better spend elsewhere.
3. **Split the container into "dashboard" + "host agent."** Features 1 (fan control), 4 (NAS mounting), and 8 (apt/firmware updates) **cannot and should not** be done from inside a container, even a privileged one. We introduce `pi-dashboard-agent`: a small (~300-line) Node service installed by the deploy script as a **host systemd unit**, listening on a Unix socket (`/run/pi-dashboard/agent.sock`, bind-mounted into the container, root-owned, 0660). It executes only a **fixed allowlist of parameterized operations** (no arbitrary shell), authenticated by a shared secret. This is the same pattern Portainer/Cockpit-style tools use and is far safer than giving the web container root on the host.
4. **Layered backend ("clean architecture lite").** `server/index.js` becomes a thin composition root. New code is organized as:

```
server/
├── index.js                 # composition root (wires everything, keeps legacy routes)
├── stats.js                 # UNTOUCHED legacy collector (existing dashboard keeps working)
├── services-config.js       # untouched
├── core/
│   ├── db.js                # SQLite open/migrate (WAL, busy_timeout)
│   ├── migrations/          # 001_init.sql, 002_..., versioned
│   ├── scheduler.js         # interval jobs w/ jitter, overlap guards
│   ├── crypto.js            # AES-256-GCM secret-at-rest helper
│   └── agent-client.js      # Unix-socket RPC to host agent (allowlist mirror)
├── collectors/              # pure "read → normalized object" functions
│   ├── hardware.js          # fan, PMIC volts/amps, freq, throttle history
│   ├── sessions.js          # SSH / VNC / Tailscale
│   ├── network.js           # /proc/net/dev deltas, vnStat, conn table, DNS
│   ├── inventory.js         # dpkg, systemd units, containers, ~/Applications
│   └── updates.js           # apt/security/firmware/kernel (via agent)
├── repositories/            # all SQL lives here, one file per domain
├── services/                # domain logic
│   ├── alerting.js          # rule engine, suppression, escalation
│   ├── mailer.js            # nodemailer wrapper, test-send
│   ├── retention.js         # downsampling, rotation, archive, cleanup
│   ├── reports.js           # daily/weekly/monthly aggregation, health score
│   └── storage-monitor.js   # capacity, growth, exhaustion projection
└── routes/                  # express routers, one per domain, mounted in index.js
agent/
└── pi-dashboard-agent.js    # host-side allowlisted executor (own systemd unit)
```

5. **Push collection to the server.** A scheduler samples metrics every 10 s (configurable) into SQLite regardless of whether a browser is open. The existing 1 s live polling endpoint is untouched; live charts keep their Smoothie feel, while historical charts read from `/api/history/*`.

### 3.2 Component diagram (target)

```
 Browser SPA (vanilla JS, hash-routed pages)
   Overview │ Hardware │ Sessions │ Network │ Reports │ Updates │ Inventory │ Alerts │ Settings
        │ 1s live poll                 │ on-demand history/config
        ▼                              ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ pi-dashboard container (unprivileged user, host net/pid)     │
 │  Express routes ── services ── repositories ── SQLite (WAL)  │
 │       │                │                                     │
 │   collectors      scheduler (10s metrics, 60s sessions,      │
 │   (read /proc,     5m vnStat sync, 1h retention, daily       │
 │    /sys, CLIs)     reports, 6h update check)                 │
 └───────┬──────────────────────────────────────────────────────┘
         │ /run/pi-dashboard/agent.sock (allowlisted RPC + HMAC)
 ┌───────▼──────────────────────────────────────────────────────┐
 │ pi-dashboard-agent (host systemd unit, root)                 │
 │  ops: fan.setMode/setDuty · nas.mount/umount/status ·        │
 │       apt.list/upgrade(pkgs) · eeprom.check/update ·         │
 │       sys.reboot(confirm) — nothing else                     │
 └──────────────────────────────────────────────────────────────┘
 Optional sidecars: vnstatd (or host package) · SQLite archive on NAS mount
```

### 3.3 Per-feature design

**F1 — Pi 5 hardware.** The Pi 5's official cooler exposes everything via sysfs: fan RPM at `/sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input`, PWM duty at `.../pwm1` (0–255 → %), and the cooling state under `/sys/class/thermal/cooling_device*`. The Pi 5's PMIC adds rich telemetry via `vcgencmd pmic_read_adc` (per-rail volts/amps — we'll surface VDD_CORE, EXT5V, and total computed wattage), plus `vcgencmd measure_volts`, `get_throttled` (already parsed upstream — we extend it to **log transitions** so undervoltage events are recorded with timestamps even if nobody is watching). Fan mode read from `/sys/.../pwm1_enable`; manual duty set only through the agent. GPU temp via `vcgencmd measure_temp` (on Pi 5 it shares the SoC sensor; we label it accordingly rather than faking a second sensor).

**F2 — Sessions.** SSH via `who -u` + `/var/run/utmp` semantics (user, tty, source IP, login time, idle) cross-checked with `ss -tnp 'sport = :22'`; VNC by detecting wayvnc/RealVNC processes and established connections on :5900–5910; Tailscale via `tailscale status --json` (peers, last-seen, active flag) — feature auto-hides if the binary is absent. A 60 s sampler diffs current vs. known sessions and writes `session_log` rows (open/close events), giving login history and duration analytics for free.

**F3 — Network analytics. Technology selection:**

| Option | Verdict | Why |
|---|---|---|
| **vnStat** | ✅ **Adopt** | ~1 MB RAM daemon, kernel-counter based (no packet capture), gives 5-min/hour/day/month bandwidth history per interface instantly via `vnstat --json`. Perfect Pi fit. |
| **Built-in /proc collectors** | ✅ **Adopt** | Real-time throughput from `/proc/net/dev` deltas (already partially done upstream); protocol distribution from `ss -s` + per-port classification of `/proc/net/tcp|udp`; per-process bandwidth by sampling `/proc/<pid>/net` socket ownership via `ss -tunp` deltas. Zero new daemons. |
| **nethogs** | ⚙️ Optional | `nethogs -t` trace mode as an *optional* per-process refinement (uses pcap ≈ CPU). Off by default; toggle in UI. |
| **dnsmasq/Pi-hole log tail** | ⚙️ Optional | If Pi-hole or dnsmasq with query logging is detected, tail its log for domain stats. Otherwise DNS panel shows resolver stats from `resolvectl statistics` or hides. We will **not** sniff port 53 by default. |
| ntopng | ❌ Reject | 300–600 MB RAM + Redis dependency; duplicates our UI; defeats "lightweight." |
| Netdata | ❌ Reject | Excellent tool but it *is* a dashboard — embedding it breaks the design-language requirement and costs ~150 MB RAM. |
| eBPF (custom) | ❌ Defer | Bookworm's 6.6+ kernel supports it, but maintaining CO-RE programs for marginal gain over `ss`-sampling isn't justified in v1. Architecture leaves a collector slot for a future eBPF module. |
| tcpdump | ❌ Reject as daemon | Used only behind the optional nethogs-style deep-inspection toggle, never continuously. |

Geographic distribution (optional requirement): offline MaxMind-style lookup via the `geoip-lite` npm package (bundled DB, no external calls) — toggleable, default off to save ~60 MB RAM.

**F4 — NAS & retention.** Mount management goes through the agent, which writes **systemd `.mount` + `.automount` units** (not fstab edits — cleaner rollback, automatic retry, no boot hangs when the NAS is off). CIFS with `vers=` selectable (the WD My Book World Edition II is SMB1-only — we'll surface `vers=1.0` with a security warning; the EX2 Ultra speaks SMB2/3 and NFS). Credentials in root-only `/etc/pi-dashboard/creds/*.cred` files referenced by `credentials=`. Retention presets (7/30/90/180/365/custom) drive a tiered downsampler: raw 10 s → 1 min after 48 h → 10 min after 30 d → hourly after 90 d; expired partitions are exported to zstd-compressed monthly archive files on the NAS before deletion. Storage monitor samples `df` on data dir + NAS mount, fits a linear regression over 14 days of growth, projects exhaustion date.

**F5 — Reports.** Nightly job materializes `report_daily` rows (min/avg/max/p95 per metric, peak windows, anomaly flags via simple z-score on the daily mean, session counts, bandwidth totals); weekly/monthly are computed from dailies on demand. Health score = weighted rubric (thermal headroom, throttle events, undervoltage events, storage runway, service-check failures, update lag) → 0–100 with per-factor breakdown. Export: CSV/JSON server-side; **PDF generated client-side via a print-optimized stylesheet + `window.print()`** in v1 (zero server dependencies, preserves the dashboard's visual identity in the report), with a server-side `pdfkit` option flagged as a stretch goal.

**F6 — Layouts.** Adopt **GridStack.js** (MIT, ~40 KB gzip, framework-agnostic, touch support) for drag/resize. Every existing card gets wrapped in a grid item with its current position as the default — pixel-identical until the user enters "Edit layout" mode. Layouts (JSON: pages → widgets → x/y/w/h/visible) stored server-side per **profile**. Profiles are lightweight named layout owners (name + optional PIN), *not* a full auth system — selected via a header dropdown, remembered per device. Presets: "Default" (upstream layout), "Ops" (hardware+alerts focus), "Network", "Kiosk".

**F7 — Alerting.** Server-side rule engine evaluated every collector cycle: rule = metric + comparator + threshold + sustain-duration + severity (info/warning/critical). State machine (ok → pending → firing → resolved) prevents flapping; suppression windows (per-rule cooldown + global quiet hours); escalation = "if still firing after N minutes, re-notify at next severity's channel set." Channels: email (nodemailer) + the existing in-UI toast/sound path. SMTP credentials encrypted at rest with AES-256-GCM keyed from `SECRET_KEY` env (generated by deploy script); password never returned by the API (write-only field). **SMTP provider recommendations (verified current, June 2026):**

| Provider | Free tier | Verdict |
|---|---|---|
| **Brevo** | 300 emails/day | **Recommended default** — plain SMTP AUTH with API key as password, reliable, no domain required |
| **SMTP2GO** | 1,000/month | Recommended alternative — great deliverability, simple setup |
| **Gmail** | ~500/day | Works via **App Password** (requires 2FA on the Google account); fine for personal use |
| **Outlook / Microsoft 365** | — | **Not recommended:** Microsoft finished retiring basic SMTP authentication in April 2026; password/app-password SMTP no longer works and OAuth 2.0 app registration is required — impractical for a self-hosted dashboard. The UI will show this note. |

Per your note, we assume authenticated SMTP everywhere (STARTTLS/465), with a "Send test email" button and last-delivery status display.

**F8 — Updates.** Collector (6 h cadence + manual refresh) runs `apt-get update` (agent) then parses `apt list --upgradable`, tags security updates via `apt-get -s dist-upgrade` against `-security` pockets, kernel via `linux-image-rpi-*` presence, firmware via `rpi-eeprom-update`. One-click/scheduled upgrades execute through the agent as `apt-get install --only-upgrade <explicit package list>` (never bare `dist-upgrade` from the UI without confirmation), streamed to the UI via SSE, logged to `update_history`. Changelogs via `apt changelog <pkg> | head`. Container self-update = pull-and-recreate flow documented, optionally via Watchtower.

**F9 — Inventory.** `dpkg-query -W -f` (name/version/install time from `/var/lib/dpkg/info/*.list` mtimes), `systemctl list-units --type=service` + `systemctl show` for uptime/status, Docker containers (reuse existing collector), plus `~/.local/share/applications` for user apps. Usage tracking: service active-enter timestamps from systemd, process last-seen sampling for non-service apps (best-effort, documented limitation). Server-side search/filter endpoints with pagination (a Pi can have 1,500+ packages — we won't ship them all to the browser at once).

**F10 — DevOps.** Single `deploy.sh` with subcommands `install | upgrade | rollback | status | uninstall`. Install: prereq checks (Pi 5 + Bookworm + Docker), creates `/opt/pi-dashboard` + `/var/lib/pi-dashboard`, generates secrets into `.env`, installs the agent unit, optional vnStat, optional NAS wizard, `docker compose up -d`, health-gate (poll `/api/health` + new `/api/health/deep`). Upgrade: snapshot (tag current image + `sqlite3 .backup` + tar config) → pull → migrate → health-gate → auto-rollback on failure. Rollback: restore last snapshot. Idempotent and re-runnable.

---

## 4. Database / Storage Design

SQLite, WAL mode, `synchronous=NORMAL`, single file `/app/data/pi-dashboard.db` (relocatable; archives go to NAS). Schema (abridged DDL — full migrations in implementation):

```sql
-- versioned migrations table
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER);

-- unified time-series (tiered resolution via `res` column: 10s|1m|10m|1h)
CREATE TABLE metrics (
  ts INTEGER NOT NULL, res TEXT NOT NULL DEFAULT '10s',
  metric TEXT NOT NULL,          -- 'cpu.usage','temp.cpu','fan.rpm','fan.duty',
                                 -- 'power.core_v','power.watts','net.<if>.rx', ...
  value REAL NOT NULL,
  vmin REAL, vmax REAL,          -- populated on downsampled rows
  PRIMARY KEY (metric, res, ts)
) WITHOUT ROWID;

CREATE TABLE events (            -- throttle, undervoltage, service up/down, alerts
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL,
  severity TEXT, payload TEXT    -- JSON
);
CREATE INDEX idx_events_ts ON events(ts);

CREATE TABLE session_log (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL,        -- ssh|vnc|tailscale
  username TEXT, source TEXT, started_at INTEGER NOT NULL,
  ended_at INTEGER, last_active INTEGER, meta TEXT
);

CREATE TABLE net_proto_samples (ts INTEGER, proto TEXT, conns INTEGER, bytes INTEGER);
CREATE TABLE net_proc_samples  (ts INTEGER, comm TEXT, pid INTEGER, rx INTEGER, tx INTEGER);
CREATE TABLE dns_stats         (ts INTEGER, domain TEXT, queries INTEGER);

CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY, name TEXT, metric TEXT, op TEXT, threshold REAL,
  sustain_s INTEGER DEFAULT 60, severity TEXT, enabled INTEGER DEFAULT 1,
  cooldown_s INTEGER DEFAULT 900, escalate_after_s INTEGER, channels TEXT
);
CREATE TABLE alert_state   (rule_id INTEGER PRIMARY KEY, state TEXT, since INTEGER, last_notified INTEGER);
CREATE TABLE alert_history (id INTEGER PRIMARY KEY, rule_id INTEGER, fired_at INTEGER,
                            resolved_at INTEGER, peak_value REAL, notified TEXT);

CREATE TABLE report_daily (
  day TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
  payload TEXT NOT NULL          -- JSON: per-metric min/avg/max/p95, peaks,
);                               --       anomalies, sessions, bandwidth, score

CREATE TABLE layouts  (profile_id INTEGER, page TEXT, layout TEXT, PRIMARY KEY(profile_id,page));
CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT UNIQUE, pin_hash TEXT, created_at INTEGER);

CREATE TABLE inventory (
  kind TEXT, name TEXT, version TEXT, installed_at INTEGER, source TEXT,
  status TEXT, last_used INTEGER, meta TEXT, PRIMARY KEY(kind, name)
);
CREATE TABLE update_history (id INTEGER PRIMARY KEY, ts INTEGER, package TEXT,
                             from_v TEXT, to_v TEXT, result TEXT, log TEXT);

CREATE TABLE nas_mounts (id INTEGER PRIMARY KEY, label TEXT, proto TEXT, host TEXT,
                         share TEXT, mountpoint TEXT, options TEXT, enabled INTEGER);
CREATE TABLE secrets (key TEXT PRIMARY KEY, ciphertext BLOB, iv BLOB, tag BLOB); -- SMTP pw etc.
```

**Sizing (worst case, all features on):** ~25 metrics × 8,640 samples/day ≈ 216 k rows/day raw ≈ 6–8 MB/day before downsampling; steady-state DB with default 90-day policy ≈ **300–500 MB**, with zstd archives on NAS beyond that. Settings remain in `settings.json` (extended, backward-compatible) so the upstream file format keeps working.

---

## 5. UI Wireframes

Navigation: a slim icon rail is added on the left (collapses to a bottom bar on mobile), styled with the existing glass tokens. The current dashboard becomes the **Overview** page, pixel-identical by default.

```
┌──┬───────────────────────────────────────────────────────────────┐
│☰ │  pi-dashboard      ⬤ connected     [profile ▾] [🔔3] [⚙] [◐] │  ← existing header, +profile & alert bell
│▣ │ ┌──────── OVERVIEW (unchanged upstream layout) ─────────────┐ │
│♨ │ │  CPU card │ Memory card │ Temp card │ Uptime card  ...    │ │
│👥│ └───────────────────────────────────────────────────────────┘ │
│⇄ │   HARDWARE page                                               │
│▤ │ ┌ Fan ─────────────┐ ┌ Thermal ─────────────┐ ┌ Power ──────┐ │
│⟳ │ │ ◔ 2,340 RPM      │ │ 48.2°C   [24h ▾]     │ │ 5.08 V ✓    │ │
│⬒ │ │ duty ▓▓▓▓░ 42%   │ │ ~~~~/\~~ history     │ │ 4.2 W now   │ │
│⚠ │ │ mode: auto [⇆]   │ │ throttle: none       │ │ undervolt:0 │ │
│  │ └──────────────────┘ └──────────────────────┘ └─────────────┘ │
└──┴───────────────────────────────────────────────────────────────┘

SESSIONS                              NETWORK
┌ Active (3) ───────────────────┐    ┌ Throughput ──────┐┌ Top procs ───┐
│ ssh  pi   192.168.1.50  2h 4m │    │ ▲1.2 ▼14.3 Mb/s  ││ docker  9.1M │
│      idle 3m                  │    │ live area chart  ││ node    2.2M │
│ tsc  iPad  hello@…   active   │    └──────────────────┘└──────────────┘
└───────────────────────────────┘    ┌ Protocols ──┐┌ DNS top domains ──┐
┌ History ──── [7d ▾] ──────────┐    │ ◔ donut     ││ github.com    412 │
│ logins/day bar chart          │    │ https 71%…  ││ api.foo.dev   228 │
└───────────────────────────────┘    └─────────────┘└───────────────────┘

REPORTS: [Daily|Weekly|Monthly] tabs · health-score ring (87) · trend
sparklines · anomaly list · [Export: PDF · CSV · JSON]
UPDATES: summary chips (12 updates · 3 security · firmware ok) · package
table w/ checkboxes · [Update selected] [Schedule ▾] · history accordion
ALERTS: rules table (+ add) · SMTP card (host/port/user/[pw •••]/[Test ✉])
· quiet hours · active alerts banner
LAYOUT EDIT MODE: dashed grid overlay, drag handles, [+ widget] palette,
[Save] [Save as preset ▾] [Reset to default]
```

All new components use existing classes (`.card`, `.card-header`, `.card-icon`, gauges, Smoothie charts) and ship normal/compact/ultra variants per the project's CSS convention.

---

## 6. Implementation Roadmap

Branch: `feature/pi5-enhancement-suite` off `main`; conventional commits (`feat:`, `fix:`, `chore:`, `docs:` per CLAUDE.md); one PR per phase, incremental commits within. Each phase leaves the app shippable.

| Phase | Scope | Key commits | Est. size |
|---|---|---|---|
| **0. Foundation** | SQLite + migrations, scheduler, crypto helper, agent skeleton + socket client, hash router + nav rail, `/api/history` read API, deep health check | `feat(core): sqlite layer + migrations` · `feat(core): scheduler` · `feat(agent): host agent + allowlist RPC` · `feat(ui): nav rail + router` | ~2,500 LoC |
| **1. Hardware (F1)** | hwmon/PMIC collectors, throttle event logging, Hardware page, temp history charts, fan mode/duty control via agent | 4–5 commits | ~1,200 |
| **2. Alerting (F7)** | rule engine, mailer, secrets-at-rest, Alerts page + SMTP UI + test send | 4 commits | ~1,400 |
| **3. Sessions (F2)** | SSH/VNC/Tailscale collectors, session_log, Sessions page + history | 3 commits | ~900 |
| **4. Network (F3)** | vnStat integration, /proc collectors, proto/proc/DNS panels, optional nethogs toggle | 5 commits | ~1,800 |
| **5. NAS + retention (F4)** | agent mount ops, NAS wizard UI, retention/downsampling/archival jobs, storage monitor + projection | 4 commits | ~1,400 |
| **6. Reports (F5)** | daily materializer, weekly/monthly aggregation, health score, Reports page, CSV/JSON/print-PDF export | 4 commits | ~1,200 |
| **7. Layouts (F6)** | GridStack wrap, edit mode, profiles, presets, per-page layouts | 4 commits | ~1,100 |
| **8. Updates + inventory (F8/F9)** | update collectors + agent ops + SSE progress, Inventory collectors + page w/ search | 5 commits | ~1,600 |
| **9. DevOps (F10)** | `deploy.sh`, compose updates, docs (user + admin), release notes, test suite completion | 4 commits | ~1,500 |

Order rationale: phase 0 unblocks everything; alerting early because later features feed it events; layouts late so all widgets exist to lay out.

---

## 7. New Dependencies

| Dependency | Where | Size/impact | Why |
|---|---|---|---|
| `better-sqlite3` | server | native addon, prebuilt arm64 | storage engine |
| `nodemailer` | server | pure JS | SMTP |
| `gridstack` | frontend | ~40 KB gz | drag/resize layouts |
| `geoip-lite` | server, **optional/off** | ~60 MB RAM when on | geo distribution |
| `vnstat` | host/sidecar apt pkg | ~1 MB RAM | bandwidth history |
| `cifs-utils`, `nfs-common` | host (deploy script) | — | NAS mounts |
| `nethogs` | host, **optional** | CPU when on | per-process deep mode |
| dev: `vitest`, `supertest` | dev only | — | tests |

Deliberately *not* added: any frontend framework, Redis, Influx/Prometheus, ntopng, Netdata.

---

## 8. Performance Impact Assessment (Pi 5 budgets)

| Component | CPU (avg) | RAM | Notes |
|---|---|---|---|
| Existing dashboard | ~1–2 % | ~80 MB | unchanged |
| Schedulers + SQLite writes | < 1 % | +30–50 MB | 10 s cadence, batched transactions |
| vnstatd | < 0.1 % | ~1 MB | kernel counters only |
| Agent | ~0 idle | ~25 MB | event-driven |
| Retention/report jobs | brief 5–10 % bursts | — | nightly, niced |
| **Target total** | **< 4 % avg** | **< 200 MB added** | leaves Pi 5 (4/8 GB) untouched for real workloads |
| Optional deep-inspect (nethogs/geoip) | +2–5 % / +60 MB | — | off by default, labeled in UI |

Disk I/O: WAL + grouped inserts ≈ a few hundred KB/min — safe for SD cards, trivial for NVMe. Frontend: history charts fetch downsampled series (≤ 500 points per chart) so page loads stay < 100 KB per panel.

---

## 9. Security Review

**Existing issues we will fix:** `ADMIN_TOKEN` optional (auth silently disabled when empty) → deploy script always generates one, and the server logs a prominent warning + disables mutating agent-backed endpoints if unset; CORS `*` default → deploy defaults to LAN origin; rate limiting only on one route → generalized middleware on all mutating routes.

**New surface, mitigations:**
- **Host agent** is the critical piece: fixed allowlist of named ops with typed, validated params (package names regex-checked against `apt-cache` output; mount options from an allowlist; no string concatenation into shells — `execFile` only); HMAC-authenticated requests using a secret created at install with 0600 perms; socket `0660 root:pi-dashboard`; every op audit-logged to journald + `events` table; destructive ops (upgrade, reboot, mount) require the admin token end-to-end.
- **Secrets at rest:** SMTP/NAS credentials AES-256-GCM encrypted with `SECRET_KEY` from `.env` (0600); API never echoes secrets; NAS creds additionally live only on the host side in root-only files.
- **Container hardening:** drop to non-root user in the image, `cap_drop: ALL` then re-add only `NET_ADMIN` (WireGuard) — possible now that privileged work moved to the agent; Docker socket stays `:ro`.
- **SMB1 warning** surfaced in the NAS wizard for the My Book World Edition II (protocol is inherently insecure; recommend isolating it on a trusted VLAN).
- **Update execution:** explicit package lists only, simulated (`-s`) first, output streamed and stored; scheduled updates run `unattended-upgrades`-style security-only by default.

---

## 10. Testing Strategy

- **Unit (vitest):** collectors against fixture files (recorded `/proc/net/dev`, `vcgencmd` outputs, `who -u`, `tailscale status --json`, `apt list` outputs — fixtures captured from a real Pi 5); alert state machine; downsampler; health-score rubric; crypto round-trips.
- **Integration (supertest + temp SQLite):** every new route incl. auth/rate-limit paths; migration up-from-empty and up-from-v1 (existing `settings.json` untouched); agent client against a mock socket server (and a "deny everything not allowlisted" test).
- **E2E smoke (on-device):** `deploy.sh install` on a clean Bookworm image → health-gate → scripted checks (fan RPM nonzero with official cooler, SMTP test send to a mailpit container, NAS mount/unmount cycle, simulated upgrade+rollback).
- **Regression guard:** snapshot tests asserting the legacy `/api/stats`, `/api/settings`, `/api/v1/system` response shapes are byte-compatible.
- **Performance check:** 24 h soak script recording dashboard CPU/RAM/DB growth vs. the budgets in §8; fails CI-style if exceeded.

---

## 11. Deployment Design (preview)

`deploy.sh` (single file, ~600 lines, POSIX-ish bash with `set -euo pipefail`):

```
sudo ./deploy.sh install     # checks Pi5/Bookworm/Docker → apt deps (cifs-utils,
                             # nfs-common, vnstat?) → dirs + perms → generate
                             # ADMIN_TOKEN/SECRET_KEY/AGENT_SECRET into .env →
                             # install agent systemd unit → optional NAS wizard
                             # (writes .mount/.automount units) → compose up →
                             # health-gate (/api/health/deep, 60s timeout)
sudo ./deploy.sh upgrade     # snapshot (image tag + sqlite .backup + config tar)
                             # → pull/build → compose up → migrate → health-gate
                             # → keep last 3 snapshots; auto-rollback on failure
sudo ./deploy.sh rollback    # restore newest snapshot
sudo ./deploy.sh status|uninstall
```

Compose changes: pinned image tag, non-root user, `cap_drop`, agent socket + `/var/lib/pi-dashboard` volumes, env passthrough for the new secrets, deep healthcheck, optional `vnstat` sidecar profile.

---

## 12. Open Questions Before Implementation

1. **Repository:** you mentioned providing your GitHub repo — please share the URL (and whether it's a fork of upstream or a fresh repo) so commit/PR structure can match it. *(Note: I can prepare the full branch as commits locally and as patch files/bundles for you to push — I won't be able to push to GitHub on your behalf from this environment.)*
2. **Pi storage:** SD card or NVMe? (Affects default sampling cadence and whether I add extra SD-wear mitigations.)
3. **VNC server in use:** RealVNC (Pi OS default) or wayvnc? Both will be supported, but I'll prioritize fixtures for yours.
4. **Profiles scope:** is the lightweight name+PIN profile model (no real authentication) acceptable for "layouts per user," or do you want full login accounts (significantly larger scope)?
5. **One-click `dist-upgrade`:** acceptable behind a confirmation dialog, or should the UI be restricted to per-package and security-only updates?
6. **Default retention:** propose 90 days local + 365 days archived on NAS — OK?

---

**Approval requested.** *(Resolved — the plan was approved and implemented; see §13.)*

---

## 13. As-Built Addendum (2026-06-24)

This section records how the system actually shipped and the major subsystem (DNS/Pi-hole) added after the original plan. Sections 1–11 remain the architectural foundation.

### 13.1 Resolved open questions (§12)

1. **Repository:** [`github.com/Thutmoze/RaPiSys`](https://github.com/Thutmoze/RaPiSys) — a fresh repo (not a GitHub fork), MIT, crediting upstream. Delivered as an ongoing series of conventional-commit patches applied on the Pi.
2. **Pi storage:** runs on a Pi 5 with the metrics DB relocatable to (and in practice hosted on) the NAS; SD-wear mitigations via WAL + grouped inserts retained.
3. **VNC:** RealVNC/wayvnc both supported; sessions surfaced via the Sessions page.
4. **Profiles/layouts:** implemented as named **dashboards** (multi-page, drag-reorderable tabs, per-dashboard GridStack layouts) for the local admin, gated to edit mode — not a multi-user PIN model.
5. **dist-upgrade:** allowed only behind a typed confirmation; per-package and security-only are the defaults.
6. **Retention:** 90-day local default retained; archive policy configurable.

### 13.2 What shipped (status by feature)

All ten feature areas from §2 are implemented: Pi 5 hardware (fan/PMIC/thermal/throttle log), sessions (SSH/VNC/Tailscale + history), network analytics (vnStat + /proc + DNS), NAS + retention, reports (health score + CSV/JSON/print-PDF), dynamic layouts (GridStack dashboards), alerting (rule engine + **SMTP and Telegram**), update center (apt/security/firmware via agent, SSE progress), inventory (apt/systemd/containers, searchable), and DevOps (`deploy.sh` install/upgrade/rollback). The OS target was extended to include **Trixie/Debian 13**.

The test suite covers the new subsystems across 12 files (auth/TOTP, alerting, core, update-scheduler, telegram, updates-repo, remote-access, vnc-proxy, inventory-recommendations, tls, layouts-dashboards, and pihole).

### 13.3 DNS / Pi-hole subsystem (post-plan)

The original plan treated DNS as a light "resolver stats / optional dnsmasq log tail" panel. It grew into a first-class Pi-hole integration:

**Analytics client** (`server/collectors/pihole.js`) — a single client that auto-detects and speaks both **Pi-hole v6** (FTL REST API: `POST /api/auth` → SID via `X-FTL-SID`, `stats/summary`, `stats/top_domains`, `stats/top_clients`, `dns/blocking`) and **v5** (PHP `api.php?summaryRaw/topItems` with token auth). It normalizes both into one snapshot: totals, **query categories** (FTL status breakdown — forwarded/cached/gravity/regex/…), **record types** (A/AAAA/HTTPS/PTR/…), top permitted/blocked domains, blocking state, and the live web port. Self-signed certs tolerated; SID cached with re-auth on 401.

**Privileged agent ops** (`agent/rapisys-agent.cjs`, allowlisted) —
`pihole.detect` (finds host vs docker install and the *real* API port by probing, since host-networking hides docker port maps),
`pihole.install` (one-click: host `curl|bash --unattended` or Docker via the official image, with **automatic free-port selection** and the correct `FTLCONF_webserver_port` specifier),
`pihole.checkUpdate` / `pihole.update` (host `pihole -up`, or docker `compose pull && up -d`),
`pihole.setSystemResolver` / `pihole.systemResolverStatus` (point the Pi's own resolver at Pi-hole with a fallback nameserver; refuses cleanly when Tailscale/MagicDNS manages `resolv.conf`),
`pihole.backupToNas` / `pihole.backupStatus` (see below).

**NAS backup of the Pi-hole DB** — because SQLite over CIFS/NFS is unsafe, the live `pihole-FTL.db` stays on the Pi. A scheduled agent op makes a **consistent copy** (`pihole-FTL sqlite3 … ".backup"` inside the official image, which ships no standalone `sqlite3` CLI; the `sqlite3` CLI or `cp` as fallbacks), gzips it, writes a timestamped `pihole-FTL-<stamp>.db.gz` to `<nas>/pihole-backups/`, and prunes to a retention count. A daily/weekly scheduler job runs it when enabled and a NAS is configured.

**Routes** (`server/routes/network.js`, mutations gated by `requireControl`): `GET/POST /dns/pihole/config`, `/status`, `/test`, `/autoconfig`, `/blocking`, `/detect`, `/install/stream` (SSE), `/update-check`, `/update-status`, `/update/stream` (SSE), `/system-resolver`, `/backup`, `/backup/config`, `/backup/run/stream` (SSE).

**UI** — a redesigned **DNS Analysis** card on the Network page (header/stat-tiles/categories/top-domains sections), an enhanced **DNS** summary widget on the Overview (queries headline + permitted/blocked split bar + top domains), and a **Settings → DNS** tab with: connection (toggle + collapse-when-configured + site-wide Test button), one-click install (method chooser + user-selectable web port), update detection, system-resolver toggle, web-console deep link, and the "Back up logs to NAS" panel.

### 13.4 Brand & UI polish

- **Logo/brand:** RaPiSys is branded with an Eye-of-Horus mark whose pupil is the authentic Raspberry Pi raspberry (leaves reinstated at the eyebrow), recolored at the pixel level from reference art; the square tile was dropped so the eye floats on the rail (the favicon keeps a subtle tile). The "Pi" in the wordmark is rendered in raspberry red.
- **Overview header:** action buttons right-aligned; the Edit-Layout glyph changed to a sliders icon; dashboard-tab editing affordances (rename/delete/add/reorder) appear only in edit mode.
- **Settings:** every tab carries a distinct glyph; the Storage section surfaces the database size and NAS free space.

### 13.5 Storage reality

There are two databases: the **RaPiSys** metrics/inventory/events/reports DB (`rapisys.db`, a single SQLite file, relocatable to and in practice hosted on the NAS) and the **Pi-hole** query DB (`pihole-FTL.db`, kept live on the Pi, archived to the NAS by the backup job). Everything RaPiSys records — temperature/CPU/memory history, software inventory, events, update cache, dashboards/layouts, sessions, reports — lives in the one `rapisys.db`; there is no separate per-category log file.

---

*RaPiSys is MIT-licensed and builds on [zepgram/pi-dashboard](https://github.com/zepgram/pi-dashboard), preserving its visual design.*

