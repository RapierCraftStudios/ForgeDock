#!/usr/bin/env bash
# spawn-depth-check.sh — will a /work-on dispatching phase (review, remediate) have the Agent tool?
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Claude Code grants the Agent tool to sub-agents down to CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH layers
# below the main conversation (default 3 since 2.1.219; 5 for 2.1.172-2.1.216; 1 for 2.1.217-2.1.218).
# A sub-agent at layer L can spawn only when L < depth. The router invokes review/remediate at
# router layer + 1, so they can spawn reviewers only when router layer + 2 <= depth (forge#3398,
# docs/WORK-ON-RUNTIME.md).
#
# Usage: spawn-depth-check.sh [--router-layer N]      (N = 0 solo, 1 under /orchestrate; default 0)
# Env:   CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH  explicit limit (wins over the version default)
#        FORGE_CLAUDE_VERSION                  version string override (tests); else `claude --version`
# Exit:  0 OK / SKIP / UNKNOWN (never blocks on what it cannot determine), 1 FAIL, 2 usage error.
set -u

ROUTER_LAYER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --router-layer) ROUTER_LAYER="${2:-}"; shift 2 || { echo "usage: spawn-depth-check.sh [--router-layer N]" >&2; exit 2; } ;;
    *) echo "usage: spawn-depth-check.sh [--router-layer N]" >&2; exit 2 ;;
  esac
done
case "$ROUTER_LAYER" in ''|*[!0-9]*) echo "spawn-depth-check: --router-layer must be a non-negative integer" >&2; exit 2 ;; esac
ROUTER_LAYER=$((10#$ROUTER_LAYER))   # leading zeros are decimal, not octal

# Non-Claude runtimes (Codex, OpenCode) have their own sub-agent models; this check does not apply.
if [ "${FORGE_RUNTIME:-}" = "codex" ] || [ "${FORGE_RUNTIME:-}" = "opencode" ] ||
   [ -n "${OPENCODE_SESSION_ID:-}" ] || [ -n "${OPENCODE_PID:-}" ] || [ -n "${OPENCODE:-}" ]; then
  echo "SPAWN_DEPTH: SKIP (non-Claude runtime)"
  exit 0
fi

REQUIRED=$((ROUTER_LAYER + 2))
DEPTH=""
SOURCE=""
ENV_DEPTH="${CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH:-}"
if [ -n "$ENV_DEPTH" ]; then
  case "$ENV_DEPTH" in
    *[!0-9]*) echo "SPAWN_DEPTH: UNKNOWN (CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH='${ENV_DEPTH}' is not an integer)"; exit 0 ;;
  esac
  DEPTH=$((10#$ENV_DEPTH)); SOURCE="CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"
else
  VERSION="${FORGE_CLAUDE_VERSION:-}"
  [ -n "$VERSION" ] || VERSION=$(claude --version 2>/dev/null | head -1 || true)
  VERSION=$(printf '%s' "$VERSION" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -z "$VERSION" ]; then
    echo "SPAWN_DEPTH: UNKNOWN (Claude Code version not readable; required=${REQUIRED})"
    exit 0
  fi
  MAJ=${VERSION%%.*}; REST=${VERSION#*.}; MIN=${REST%%.*}; PAT=${REST#*.}
  MAJ=$((10#$MAJ)); MIN=$((10#$MIN)); PAT=$((10#$PAT))
  if [ "$MAJ" -gt 2 ] || { [ "$MAJ" -eq 2 ] && [ "$MIN" -gt 1 ]; }; then DEPTH=3
  elif [ "$MAJ" -eq 2 ] && [ "$MIN" -eq 1 ]; then
    if [ "$PAT" -ge 219 ]; then DEPTH=3
    elif [ "$PAT" -ge 217 ]; then DEPTH=1
    elif [ "$PAT" -ge 172 ]; then DEPTH=5
    fi
  fi
  if [ -z "$DEPTH" ]; then
    echo "SPAWN_DEPTH: UNKNOWN (no documented nesting default for Claude Code ${VERSION}; required=${REQUIRED})"
    exit 0
  fi
  SOURCE="Claude Code ${VERSION} default"
fi

if [ "$DEPTH" -ge "$REQUIRED" ]; then
  echo "SPAWN_DEPTH: OK depth=${DEPTH} required=${REQUIRED} (${SOURCE})"
  exit 0
fi
echo "SPAWN_DEPTH: FAIL depth=${DEPTH} required=${REQUIRED} (${SOURCE}) — review/remediate would run without the Agent tool and could not spawn /review-pr reviewers. Set CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH>=${REQUIRED}."
exit 1
