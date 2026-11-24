#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Removes the computeshare agent from a native Linux (systemd) host (#5883): the computeshare-agent unit, this agent's lane containers,
# volumes and forgedock-lane images, /opt/computeshare, /etc/computeshare, /var/lib/computeshare and the sysctl drop-in. Docker, /opt/node
# and fstrim.timer are removed only when /etc/computeshare/installed-by says the installer added them. Never `docker system prune`:
# containers and volumes of other workloads on the same daemon are left alone. No user is created by the installer, so none is removed.
# Usage: uninstall-agent-linux.sh [--dry-run]   (idempotent: on a clean host it removes nothing and exits 0)
# CS_PREFIX (tests only) roots every path under a scratch dir and lifts the root check.
set -euo pipefail
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
# Appended, not prepended, so a caller's PATH wins; never resolve tools through a Windows PATH first.
export PATH="${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
P="${CS_PREFIX:-}"
CODE="$P/opt/computeshare" ETC="$P/etc/computeshare" STATE="$P/var/lib/computeshare" NODE_DIR="$P/opt/node"
UNIT="$P/etc/systemd/system/computeshare-agent.service" SYSCTL="$P/etc/sysctl.d/90-computeshare-noipv6.conf"
log() { echo "[computeshare] $*"; }
run() { if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@" || log "note: '$*' failed (continuing)"; fi; }
del() { for f in "$@"; do if [ -e "$f" ] || [ -L "$f" ]; then if [ "$DRY" = 1 ]; then echo "would remove: $f"; else rm -rf "$f"; log "removed $f"; fi; fi; done; }
[ -n "$P" ] || [ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

MARKS=""; [ -f "$ETC/installed-by" ] && MARKS="$(cat "$ETC/installed-by")"
marked() { printf '%s\n' "$MARKS" | grep -qx "$1"; }
# The agent id the agent labels its containers and volumes with (agent_id, else name; normalised as in bin/pool/agent.mjs).
AGENT_ID=""
if [ -f "$ETC/agent.json" ]; then
  AGENT_ID="$(sed -n 's/^[[:space:]]*"agent_id":[[:space:]]*"\([^"]*\)".*/\1/p' "$ETC/agent.json" | head -1)"
  [ -n "$AGENT_ID" ] || AGENT_ID="$(sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*/\1/p' "$ETC/agent.json" | head -1)"
  AGENT_ID="$(printf '%s' "$AGENT_ID" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_.-]/-/g' | cut -c1-60)"
fi

# 1. The service first, so the agent cannot start new lanes while they are removed.
if command -v systemctl >/dev/null 2>&1; then
  if [ -e "$UNIT" ] || systemctl list-unit-files computeshare-agent.service 2>/dev/null | grep -q computeshare-agent; then
    run systemctl disable --now computeshare-agent.service
  fi
fi
del "$UNIT"
command -v systemctl >/dev/null 2>&1 && run systemctl daemon-reload

# 2. Docker objects carrying this agent's label (#5881), plus the lane images. Nothing unlabelled, nothing of another agent.
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

# 3. Optional components, only when this installer added them.
if marked fstrim.timer && command -v systemctl >/dev/null 2>&1; then run systemctl disable --now fstrim.timer; fi
if [ -e "$SYSCTL" ]; then
  del "$SYSCTL"
  command -v sysctl >/dev/null 2>&1 && [ -z "$P" ] && run sysctl -q -w net.ipv6.conf.all.disable_ipv6=0 net.ipv6.conf.default.disable_ipv6=0
fi
if marked node; then del "$NODE_DIR"; fi
if marked docker; then
  if command -v systemctl >/dev/null 2>&1; then run systemctl disable --now docker.service docker.socket containerd.service; fi
  command -v apt-get >/dev/null 2>&1 && run apt-get purge -y -qq docker-ce docker-ce-cli containerd.io
  del "$P/etc/apt/sources.list.d/docker.list" "$P/etc/apt/keyrings/docker.asc"
fi

# 4. Code, config (agent token) and state.
del "$CODE" "$P/opt/computeshare.new" "$ETC" "$STATE"
if [ "$DRY" = 1 ]; then log "dry run: nothing removed"; else log "agent removed. Remove it from the router with: forgedock pool remove ${AGENT_ID:-<agent>}"; fi
