#!/usr/bin/env bash
# =============================================================================
# RaPiSys — deployment script for Raspberry Pi 5 (Raspberry Pi OS Bookworm)
# =============================================================================
#   sudo ./deploy.sh install     first-time setup (deps, secrets, agent, app)
#   sudo ./deploy.sh upgrade     snapshot -> rebuild -> health-gate -> rollback on failure
#   sudo ./deploy.sh rollback    restore the newest snapshot
#   sudo ./deploy.sh status      show app + agent + health state
#   sudo ./deploy.sh uninstall   stop and remove (data kept unless --purge)
#
# Idempotent: safe to re-run install at any time.
# =============================================================================

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${APP_DIR}/data"
AGENT_DIR="/opt/rapisys/agent"
AGENT_ENV="/etc/rapisys/agent.env"
SNAP_DIR="/var/lib/rapisys/snapshots"
HEALTH_URL="http://localhost:3001/api/health"
DEEP_URL="http://localhost:3001/api/health/deep"
COMPOSE="docker compose"

log()  { echo -e "\033[36m[rapisys]\033[0m $*"; }
ok()   { echo -e "\033[32m  ✓\033[0m $*"; }
warn() { echo -e "\033[33m  !\033[0m $*"; }
die()  { echo -e "\033[31m  ✗ $*\033[0m" >&2; exit 1; }

require_root() { [[ $EUID -eq 0 ]] || die "run with sudo"; }

# -----------------------------------------------------------------------------
# Checks
# -----------------------------------------------------------------------------
check_platform() {
  log "Checking platform…"
  if grep -q "Raspberry Pi 5" /proc/device-tree/model 2>/dev/null; then
    ok "Raspberry Pi 5 detected"
  else
    warn "Not a Raspberry Pi 5 — continuing, but Pi-5 hardware features may be unavailable"
  fi
  if grep -qE "bookworm|trixie" /etc/os-release 2>/dev/null; then
    ok "Raspberry Pi OS $(grep VERSION_CODENAME /etc/os-release | cut -d= -f2)"
  else
    warn "OS is not Bookworm/Trixie — untested configuration"
  fi
  command -v docker >/dev/null || die "Docker is required: https://docs.docker.com/engine/install/debian/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is required"
  ok "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1) + Compose"
  command -v node >/dev/null || {
    log "Installing Node.js for the host agent…"
    apt-get update -qq && apt-get install -y -qq nodejs
  }
  ok "Node $(node --version) (host, for the agent)"
}

install_deps() {
  log "Installing host packages (cifs-utils, nfs-common, vnstat)…"
  apt-get update -qq
  apt-get install -y -qq cifs-utils nfs-common curl >/dev/null
  # vnStat is optional but tiny — install unless explicitly skipped
  if [[ "${RAPISYS_NO_VNSTAT:-0}" != "1" ]]; then
    apt-get install -y -qq vnstat >/dev/null && systemctl enable --now vnstat >/dev/null 2>&1 || true
    ok "vnstat installed (network history)"
  fi
  ok "host dependencies present"
}

# -----------------------------------------------------------------------------
# Secrets / env
# -----------------------------------------------------------------------------
gen_env() {
  log "Generating secrets…"
  local env_file="${APP_DIR}/.env"
  touch "$env_file" && chmod 600 "$env_file"
  chown "${SUDO_USER:-root}":"${SUDO_USER:-root}" "$env_file"

  ensure_var() { # name generator
    if ! grep -q "^$1=..*" "$env_file" 2>/dev/null; then
      sed -i "/^$1=/d" "$env_file"
      echo "$1=$2" >> "$env_file"
      ok "$1 generated"
    else
      ok "$1 already set (kept)"
    fi
  }

  ensure_var ADMIN_TOKEN "$(openssl rand -hex 16)"
  ensure_var SECRET_KEY  "$(openssl rand -hex 32)"
  ensure_var AGENT_SECRET "$(openssl rand -hex 32)"

  # Default CORS to this Pi's LAN address instead of *
  if ! grep -q "^CORS_ORIGINS=..*" "$env_file"; then
    local ip; ip=$(hostname -I | awk '{print $1}')
    echo "CORS_ORIGINS=http://${ip}:3001,http://localhost:3001,http://$(hostname).local:3001" >> "$env_file"
    ok "CORS restricted to LAN origin (http://${ip}:3001)"
  fi

  ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' "$env_file" | cut -d= -f2)
  AGENT_SECRET=$(grep '^AGENT_SECRET=' "$env_file" | cut -d= -f2)
}

# -----------------------------------------------------------------------------
# Host agent
# -----------------------------------------------------------------------------
install_agent() {
  log "Installing rapisys-agent (host systemd unit)…"
  mkdir -p "$AGENT_DIR" /etc/rapisys /mnt/rapisys
  install -m 0755 "${APP_DIR}/agent/rapisys-agent.cjs" "${AGENT_DIR}/rapisys-agent.cjs"

  umask 077
  cat > "$AGENT_ENV" <<EOF
AGENT_SECRET=${AGENT_SECRET}
AGENT_SOCKET_GROUP=rapisys
EOF
  chmod 600 "$AGENT_ENV"

  getent group rapisys >/dev/null || groupadd -r rapisys
  local gid; gid=$(getent group rapisys | cut -d: -f3)
  sed -i "/^RAPISYS_GID=/d" "${APP_DIR}/.env"
  echo "RAPISYS_GID=${gid}" >> "${APP_DIR}/.env"
  ok "rapisys group GID ${gid} recorded in .env"

  install -m 0644 "${APP_DIR}/agent/rapisys-agent.service" /etc/systemd/system/rapisys-agent.service
  systemctl daemon-reload
  systemctl enable --now rapisys-agent
  sleep 1
  systemctl is-active --quiet rapisys-agent && ok "agent running on /run/rapisys/agent.sock" \
    || die "agent failed to start — journalctl -u rapisys-agent"
}

# -----------------------------------------------------------------------------
# App lifecycle
# -----------------------------------------------------------------------------
health_gate() {
  local url="$1" timeout="${2:-90}" t=0
  log "Health gate: ${url} (timeout ${timeout}s)…"
  until curl -fsS "$url" >/dev/null 2>&1; do
    sleep 3; t=$((t+3))
    [[ $t -ge $timeout ]] && return 1
  done
  ok "healthy after ${t}s"
}

start_app() {
  log "Building and starting RaPiSys…"
  # data dir must be writable by the container user (uid 990, host rapisys group)
  local dgid; dgid=$(getent group rapisys | cut -d: -f3 || echo 990)
  install -d -m 0775 -o 990 -g "${dgid}" "$DATA_DIR"
  local dgid; dgid=$(getent group rapisys | cut -d: -f3 || echo 990)
  install -d -m 0775 -o 990 -g "${dgid}" "$DATA_DIR"
  (cd "$APP_DIR" && $COMPOSE up -d --build)
  health_gate "$HEALTH_URL" 120 || die "app failed health check — docker logs rapisys"
  health_gate "$DEEP_URL" 60 || warn "deep health not green yet (agent/scheduler still settling)"
}

snapshot() {
  log "Taking snapshot…"
  mkdir -p "$SNAP_DIR"
  local stamp; stamp=$(date +%Y%m%d-%H%M%S)
  local dir="${SNAP_DIR}/${stamp}"
  mkdir -p "$dir"
  docker tag rapisys:latest "rapisys:snap-${stamp}" 2>/dev/null || true
  echo "rapisys:snap-${stamp}" > "${dir}/image.txt"
  # Online SQLite backup of the LOCAL db (NAS db users: snapshot covers config;
  # the NAS itself should have its own backup policy)
  if [[ -f "${DATA_DIR}/rapisys.db" ]]; then
    docker run --rm -v "${DATA_DIR}:/d" rapisys:latest \
      node -e "const{createRequire}=require('module');const r=createRequire('/app/server/core/db.js');try{const D=r('better-sqlite3');new D('/d/rapisys.db').backup('/d/rapisys.db.bak')}catch{require('fs').copyFileSync('/d/rapisys.db','/d/rapisys.db.bak')}" \
      2>/dev/null || cp "${DATA_DIR}/rapisys.db" "${DATA_DIR}/rapisys.db.bak"
    cp "${DATA_DIR}/rapisys.db.bak" "${dir}/rapisys.db"
  fi
  tar -czf "${dir}/config.tgz" -C "$APP_DIR" .env data/settings.json 2>/dev/null || true
  # keep last 3
  ls -1dt "${SNAP_DIR}"/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
  ok "snapshot ${stamp} (kept: $(ls -1d "${SNAP_DIR}"/*/ | wc -l))"
}

cmd_install() {
  require_root
  check_platform
  install_deps
  gen_env
  install_agent
  start_app
  local ip; ip=$(hostname -I | awk '{print $1}')
  echo
  log "RaPiSys is up:  http://${ip}:3001"
  log "API token:      ${ADMIN_TOKEN}   (for scripts/automation; in ${APP_DIR}/.env)"
  log "First visit opens the setup wizard (mode & admin account, NAS, retention, email)."
}

cmd_upgrade() {
  require_root
  snapshot
  log "Pulling latest source & rebuilding…"
  (cd "$APP_DIR" && git pull --ff-only 2>/dev/null || warn "git pull skipped (not a clone or local changes)")
  install -m 0755 "${APP_DIR}/agent/rapisys-agent.cjs" "${AGENT_DIR}/rapisys-agent.cjs"
  systemctl restart rapisys-agent
  if (cd "$APP_DIR" && $COMPOSE up -d --build) && health_gate "$HEALTH_URL" 120; then
    ok "upgrade complete"
  else
    warn "upgrade failed — rolling back automatically"
    cmd_rollback
  fi
}

cmd_rollback() {
  require_root
  local latest; latest=$(ls -1dt "${SNAP_DIR}"/*/ 2>/dev/null | head -1)
  [[ -n "$latest" ]] || die "no snapshots available"
  log "Rolling back to $(basename "$latest")…"
  local image; image=$(cat "${latest}/image.txt")
  docker tag "$image" rapisys:latest
  [[ -f "${latest}/rapisys.db" ]] && cp "${latest}/rapisys.db" "${DATA_DIR}/rapisys.db"
  tar -xzf "${latest}/config.tgz" -C "$APP_DIR" 2>/dev/null || true
  (cd "$APP_DIR" && $COMPOSE up -d --no-build)
  health_gate "$HEALTH_URL" 90 && ok "rollback complete" || die "rollback unhealthy — inspect docker logs rapisys"
}

cmd_status() {
  echo "── app ─────────────────────────────"
  (cd "$APP_DIR" && $COMPOSE ps) || true
  echo "── agent ───────────────────────────"
  systemctl status rapisys-agent --no-pager -l | head -8 || true
  echo "── health ──────────────────────────"
  curl -fsS "$DEEP_URL" 2>/dev/null | head -c 800 || echo "(unreachable)"
  echo
}

cmd_uninstall() {
  require_root
  log "Stopping RaPiSys…"
  (cd "$APP_DIR" && $COMPOSE down) || true
  systemctl disable --now rapisys-agent 2>/dev/null || true
  rm -f /etc/systemd/system/rapisys-agent.service
  # remove NAS mount units created by the agent (dead automount traps
  # otherwise break the next install's mount step with ENODEV)
  for u in /etc/systemd/system/mnt-rapisys-*.automount /etc/systemd/system/mnt-rapisys-*.mount; do
    [[ -e "$u" ]] || continue
    systemctl disable --now "$(basename "$u")" 2>/dev/null || true
    rm -f "$u"
  done
  umount -l /mnt/rapisys/* 2>/dev/null || true
  systemctl daemon-reload
  if [[ "${1:-}" == "--purge" ]]; then
    rm -rf "$DATA_DIR" /etc/rapisys /opt/rapisys /var/lib/rapisys
    warn "data purged"
  else
    log "data kept in ${DATA_DIR} (use 'uninstall --purge' to remove)"
  fi
  ok "uninstalled"
}

case "${1:-}" in
  install)   cmd_install ;;
  upgrade)   cmd_upgrade ;;
  rollback)  cmd_rollback ;;
  status)    cmd_status ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  *) echo "Usage: sudo ./deploy.sh {install|upgrade|rollback|status|uninstall [--purge]}"; exit 1 ;;
esac
