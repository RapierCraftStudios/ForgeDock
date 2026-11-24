#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Native Linux (systemd) agent install: the Windows installer without the VM layer. Resolves host settings, then runs install-agent.sh,
# which installs docker, node, enrolls the agent, builds the lane image and installs the computeshare-agent systemd unit.
# Usage: install-agent-linux.sh --router URL --token CODE [--name N] [--port P] [--cpus N] [--mem GB] [--bundle FILE] [--outbound] [--dry-run]
# Env equivalents: ROUTER_URL ENROLL_TOKEN AGENT_NAME AGENT_PORT ALLOW_CPUS ALLOW_MEM_GB BUNDLE AGENT_URL OUTBOUND
# --outbound (OUTBOUND=1): the agent dials the router (no Tailscale, no inbound port); it enrolls without a URL and listens only on the docker bridge.
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
    --outbound) OUTBOUND=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
: "${ROUTER_URL:?--router or ROUTER_URL required}" "${ENROLL_TOKEN:?--token or ENROLL_TOKEN required}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${AGENT_PORT:-7711}"
AGENT_NAME="${AGENT_NAME:-$(hostname | tr 'A-Z' 'a-z')}"
# Same defaults as install-agent.ps1: logical CPUs minus 4 (min 2); half of physical RAM (min 4 GB).
CPUS="${ALLOW_CPUS:-0}"
if [ "$CPUS" -le 0 ]; then CPUS=$(( $(nproc) - 4 )); [ "$CPUS" -ge 2 ] || CPUS=2; fi
MEM="${ALLOW_MEM_GB:-0}"
if [ "$MEM" -le 0 ]; then MEM=$(( $(awk '/MemTotal/ {print int($2/1024/1024)}' /proc/meminfo) / 2 )); [ "$MEM" -ge 4 ] || MEM=4; fi
OUTBOUND="${OUTBOUND:-0}"
if [ "$OUTBOUND" = 1 ]; then
  AGENT_URL=""
elif [ -z "${AGENT_URL:-}" ]; then
  if [ "$DRY" = 1 ] && ! command -v tailscale >/dev/null; then TS_IP="<tailscale-ip>"; else
    TS_IP="$(tailscale ip -4 | head -1)"
    [[ "$TS_IP" == 100.* ]] || { echo "no Tailscale IPv4 found (got '$TS_IP')" >&2; exit 1; }
  fi
  AGENT_URL="http://${TS_IP}:${PORT}"
fi

if [ "$DRY" = 1 ]; then
  echo "router=$ROUTER_URL name=$AGENT_NAME url=$AGENT_URL port=$PORT cpus=$CPUS mem_gb=$MEM bundle=${BUNDLE:-<download>} token=<redacted>"
  exit 0
fi
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

if [ -z "${BUNDLE:-}" ]; then
  BUNDLE="$(mktemp /tmp/computeshare-bundle.XXXXXX.tar.gz)"
  trap 'rm -f "$BUNDLE"' EXIT
  curl -fsS "${ROUTER_URL}/bootstrap/bundle.tar.gz?token=${ENROLL_TOKEN}" -o "$BUNDLE"
fi
export ROUTER_URL ENROLL_TOKEN AGENT_NAME AGENT_URL BUNDLE OUTBOUND
export AGENT_PORT="$PORT" ALLOW_CPUS="$CPUS" ALLOW_MEM_GB="$MEM"
bash "$HERE/install-agent.sh"

# #5884: periodic discard so freed lane blocks return to the thin disk / VHDX (best effort: absent timer, no systemd or an unsupported fs is not an install failure).
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files fstrim.timer >/dev/null 2>&1; then
  systemctl enable --now fstrim.timer >/dev/null 2>&1 || echo "note: could not enable fstrim.timer (the agent also runs fstrim itself)" >&2
fi
