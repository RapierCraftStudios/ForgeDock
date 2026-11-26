#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# macOS agent install (#5883): node and the agent code under /usr/local/computeshare, config and agent token in /usr/local/etc/computeshare,
# state in /usr/local/var/computeshare, LaunchDaemon io.forgedock.computeshare-agent. Always outbound: the agent dials the router (no inbound port).
# Needs a running docker runtime (Docker Desktop, colima, OrbStack): it is never installed here (a GUI app with licence and permission prompts).
# Usage: install-agent-macos.sh --router URL --token CODE [--name N] [--port P] [--cpus N] [--mem GB] [--bundle FILE] [--outbound] [--dry-run]
# Rerun: an existing agent token is kept (never re-enrolled); without --bundle the installed code is reused (no download).
# Uninstall: uninstall-agent-macos.sh.
set -euo pipefail
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --router) ROUTER_URL="${2:?}"; shift 2 ;;
    --token) ENROLL_TOKEN="${2:?}"; shift 2 ;;
    --name) AGENT_NAME="${2:?}"; shift 2 ;;
    --port) AGENT_PORT="${2:?}"; shift 2 ;;
    --cpus) ALLOW_CPUS="${2:?}"; shift 2 ;;
    --mem) ALLOW_MEM_GB="${2:?}"; shift 2 ;;
    --bundle) BUNDLE="${2:?}"; shift 2 ;;
    --outbound) shift ;; # the only mode on macOS; accepted so the /install bootstrap passes the same flags on both systems
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
: "${ROUTER_URL:?--router or ROUTER_URL required}" "${ENROLL_TOKEN:?--token or ENROLL_TOKEN required}"
NODE_VERSION=22.12.0
ROOT=/usr/local/computeshare ETC=/usr/local/etc/computeshare STATE=/usr/local/var/computeshare
LABEL=io.forgedock.computeshare-agent PLIST="/Library/LaunchDaemons/io.forgedock.computeshare-agent.plist"
PORT="${AGENT_PORT:-7711}"
AGENT_NAME="${AGENT_NAME:-$(hostname -s 2>/dev/null || hostname)}"
AGENT_NAME="$(printf '%s' "$AGENT_NAME" | tr 'A-Z' 'a-z')"
# Same defaults as the Linux installer: logical CPUs minus 4 (min 2); half of physical RAM (min 4 GB).
CPUS="${ALLOW_CPUS:-0}"
if [ "$CPUS" -le 0 ]; then CPUS=$(( $(sysctl -n hw.ncpu 2>/dev/null || echo 6) - 4 )); [ "$CPUS" -ge 2 ] || CPUS=2; fi
MEM="${ALLOW_MEM_GB:-0}"
if [ "$MEM" -le 0 ]; then MEM=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 8589934592) / 1073741824 / 2 )); [ "$MEM" -ge 4 ] || MEM=4; fi
log() { echo "[computeshare] $*"; }

# The docker endpoint of the console user (Docker Desktop / colima keep their socket in that user's home); root's launchd job gets it as DOCKER_HOST.
DOCKER_BIN="$(command -v docker || true)"
for d in /usr/local/bin/docker /opt/homebrew/bin/docker /Applications/Docker.app/Contents/Resources/bin/docker; do [ -n "$DOCKER_BIN" ] || { [ -x "$d" ] && DOCKER_BIN="$d"; }; done

if [ "$DRY" = 1 ]; then
  echo "router=$ROUTER_URL name=$AGENT_NAME url= port=$PORT cpus=$CPUS mem_gb=$MEM bundle=${BUNDLE:-<download>} root=$ROOT docker=${DOCKER_BIN:-<missing>} token=<redacted>"
  exit 0
fi
[ "$(uname -s)" = Darwin ] || { echo "install-agent-macos.sh is for macOS; on Linux use install-agent-linux.sh" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
OWNER="${SUDO_USER:-$(stat -f %Su /dev/console 2>/dev/null || id -un)}"
DOCKER_HOST_URL="${DOCKER_HOST:-}"
if [ -z "$DOCKER_HOST_URL" ] && [ -n "$DOCKER_BIN" ]; then
  DOCKER_HOST_URL="$(sudo -u "$OWNER" "$DOCKER_BIN" context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
fi
if [ -z "$DOCKER_BIN" ] || ! DOCKER_HOST="$DOCKER_HOST_URL" "$DOCKER_BIN" info >/dev/null 2>&1; then
  echo "no running docker runtime found. Install and start Docker Desktop (https://www.docker.com/products/docker-desktop/) or colima (brew install colima docker && colima start), then rerun." >&2
  exit 1
fi
export DOCKER_HOST="$DOCKER_HOST_URL"

install -d -m 0755 "$ROOT"
install -d -m 0700 "$ETC" "$STATE"
MARKER="$ETC/installed-by"
mark() { grep -qx "$1" "$MARKER" 2>/dev/null || echo "$1" >> "$MARKER"; }

if [ ! -x "$ROOT/node/bin/node" ] || [ "$("$ROOT/node/bin/node" --version)" != "v${NODE_VERSION}" ]; then
  log "node ${NODE_VERSION}"
  case "$(uname -m)" in arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac
  rm -rf "$ROOT/node" "$ROOT/node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz" | tar -xz -C "$ROOT"
  mv "$ROOT/node-v${NODE_VERSION}-darwin-${NODE_ARCH}" "$ROOT/node"
  mark node
fi
NODE="$ROOT/node/bin/node"

TMP="$(mktemp -d /tmp/computeshare-install.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
if [ -z "${BUNDLE:-}" ]; then
  BUNDLE="$TMP/bundle.tar.gz"
  if [ -s "$ETC/agent.token" ] && [ -f "$ROOT/package.json" ]; then
    log "already enrolled: reinstalling from $ROOT (no bundle download)"
    tar --exclude ./node -czf "$BUNDLE" -C "$ROOT" .
  else
    curl -fsS "${ROUTER_URL}/bootstrap/bundle.tar.gz?token=${ENROLL_TOKEN}" -o "$BUNDLE"
  fi
fi
log "agent code"
mkdir -p "$TMP/code"
tar -xzf "$BUNDLE" -C "$TMP/code"
# Replace everything under $ROOT but node, so a rerun neither keeps stale files nor downloads node again.
find "$ROOT" -mindepth 1 -maxdepth 1 ! -name node -exec rm -rf {} +
( cd "$TMP/code" && tar -cf - . ) | ( cd "$ROOT" && tar -xf - )

if [ ! -s "$ETC/agent.token" ]; then
  log "enrolling ${AGENT_NAME} (outbound) with ${ROUTER_URL}"
  body="$("$NODE" -e 'process.stdout.write(JSON.stringify({ token: process.argv[1], name: process.argv[2] }))' "$ENROLL_TOKEN" "$AGENT_NAME")"
  resp="$(curl -fsS -X POST "${ROUTER_URL}/enroll" -H 'content-type: application/json' -d "$body")"
  tok="$(printf '%s' "$resp" | "$NODE" -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).agent_token??""))}catch{}})')"
  [ -n "$tok" ] || { echo "enrollment failed: $resp" >&2; exit 1; }
  ( umask 077; printf '%s\n' "$tok" > "$ETC/agent.token" )
fi

# Lanes reach the agent through host.docker.internal, which Docker Desktop / colima forward to this Mac's loopback.
"$NODE" -e '
const [name, router, port, cpus, mem, etc, root, state] = process.argv.slice(1);
require("fs").writeFileSync(`${etc}/agent.json`, JSON.stringify({
  name, listen: { host: "127.0.0.1", port: Number(port) }, token_file: `${etc}/agent.token`, router_url: router, code_root: root, state_dir: state,
  allow_cpus: Number(cpus), allow_mem_gb: Number(mem), lease_ttl_s: 600, max_lifetime_s: 21600, keep_exited_s: 7200, reap_interval_s: 30, outbound: true,
}, null, 2) + "\n", { mode: 0o600 });' "$AGENT_NAME" "$ROUTER_URL" "$PORT" "$CPUS" "$MEM" "$ETC" "$ROOT" "$STATE"

log "building lane image (first run takes several minutes)"
FD_VERSION="$("$NODE" -p 'require(process.argv[1]).version' "$ROOT/package.json")"
"$DOCKER_BIN" build -q -t "forgedock-lane:${FD_VERSION}" --build-arg "FORGEDOCK_VERSION=${FD_VERSION}" "$ROOT/pool/image" >/dev/null

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>${ROOT}/bin/pool/cli.mjs</string><string>agent</string><string>--config</string><string>${ETC}/agent.json</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$DOCKER_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DOCKER_HOST</key><string>${DOCKER_HOST_URL}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${STATE}/agent.log</string>
  <key>StandardErrorPath</key><string>${STATE}/agent.log</string>
</dict>
</plist>
EOF
chmod 0644 "$PLIST"
launchctl bootout "system/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap system "$PLIST"

for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    log "agent healthy: $(curl -fsS "http://127.0.0.1:${PORT}/health")"
    exit 0
  fi
  sleep 1
done
echo "agent did not become healthy; see: ${STATE}/agent.log" >&2
exit 1
