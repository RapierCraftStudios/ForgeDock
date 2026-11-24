#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Removes the computeshare agent from macOS (#5883): the io.forgedock.computeshare-agent LaunchDaemon, this agent's lane containers, volumes
# and forgedock-lane images, /usr/local/computeshare (code and node), /usr/local/etc/computeshare and /usr/local/var/computeshare.
# The docker runtime (Docker Desktop / colima) was never installed by us and is left alone; never `docker system prune`.
# Usage: uninstall-agent-macos.sh [--dry-run]   (idempotent: on a clean host it removes nothing and exits 0)
# CS_PREFIX (tests only) roots every path under a scratch dir and lifts the root check.
set -euo pipefail
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
export PATH="${PATH:+$PATH:}/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"
P="${CS_PREFIX:-}"
LABEL=io.forgedock.computeshare-agent
ROOT="$P/usr/local/computeshare" ETC="$P/usr/local/etc/computeshare" STATE="$P/usr/local/var/computeshare"
PLIST="$P/Library/LaunchDaemons/${LABEL}.plist"
log() { echo "[computeshare] $*"; }
run() { if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@" || log "note: '$*' failed (continuing)"; fi; }
del() { for f in "$@"; do if [ -e "$f" ] || [ -L "$f" ]; then if [ "$DRY" = 1 ]; then echo "would remove: $f"; else rm -rf "$f"; log "removed $f"; fi; fi; done; }
[ -n "$P" ] || [ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

AGENT_ID=""
if [ -f "$ETC/agent.json" ]; then
  AGENT_ID="$(sed -n 's/^[[:space:]]*"agent_id":[[:space:]]*"\([^"]*\)".*/\1/p' "$ETC/agent.json" | head -1)"
  [ -n "$AGENT_ID" ] || AGENT_ID="$(sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*/\1/p' "$ETC/agent.json" | head -1)"
  AGENT_ID="$(printf '%s' "$AGENT_ID" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_.-]/-/g' | cut -c1-60)"
fi
# The launchd job's DOCKER_HOST (the console user's Docker Desktop / colima socket), so docker reaches the daemon the agent used.
if [ -z "${DOCKER_HOST:-}" ] && [ -f "$PLIST" ]; then
  dh="$(sed -n '/<key>DOCKER_HOST<\/key>/s/.*<string>\(.*\)<\/string>.*/\1/p' "$PLIST" | head -1)"
  [ -z "$dh" ] || export DOCKER_HOST="$dh"
fi

# 1. The LaunchDaemon first, so the agent cannot start new lanes while they are removed.
if command -v launchctl >/dev/null 2>&1 && { [ -e "$PLIST" ] || launchctl print "system/${LABEL}" >/dev/null 2>&1; }; then
  run launchctl bootout "system/${LABEL}"
fi
del "$PLIST"

# 2. Docker objects carrying this agent's label (#5881), plus the lane images.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if [ -n "$AGENT_ID" ]; then
    for c in $(docker ps -a --filter "label=computeshare.agent=${AGENT_ID}" --format '{{.Names}}'); do run docker rm -f -v "$c"; done
    for v in $(docker volume ls -q --filter "label=computeshare.agent=${AGENT_ID}"); do run docker volume rm -f "$v"; done
  else
    log "no agent.json: lane containers and volumes are left alone (cannot tell this agent's from another's)"
  fi
  for i in $(docker image ls --format '{{.Repository}}:{{.Tag}}' forgedock-lane); do run docker image rm -f "$i"; done
else
  log "docker not reachable: no containers, volumes or images to remove"
fi

# 3. Code (with node), config (agent token) and state.
del "$ROOT" "$ETC" "$STATE"
if [ "$DRY" = 1 ]; then log "dry run: nothing removed"; else log "agent removed. Remove it from the router with: forgedock pool remove ${AGENT_ID:-<agent>}"; fi
