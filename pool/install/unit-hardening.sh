#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Shared [Service] hardening for the long-lived ForgeDock units (router, agent, schedd). Source it; it defines functions only.
# A kill of these drops every in-flight lane, so they get the lowest OOM score the manager allows and survive repeated SIGTERMs.

# unit_oom_score_adj user|system: root may go negative; an unprivileged user manager cannot go below its own value.
unit_oom_score_adj() {
  if [ "$1" = system ]; then echo -500; return; fi
  local pid v
  pid="$(ps -o pid= -C systemd -U "$(id -u)" 2>/dev/null | head -1 | tr -d ' ')"
  v="$(cat "/proc/${pid:-self}/oom_score_adj" 2>/dev/null || echo 0)"
  echo "${v:-0}"
}

# unit_hardening user|system: the [Service] lines (no section header), for use inside a unit heredoc.
unit_hardening() {
  printf 'OOMScoreAdjust=%s\nRestart=always\nRestartSec=5\nStartLimitIntervalSec=0\n' "$(unit_oom_score_adj "${1:-user}")"
}

# unit_oom_hint <process title>: one line when a userspace OOM killer runs. Never edits any OOM config.
unit_oom_hint() {
  if pgrep -x earlyoom >/dev/null 2>&1; then
    echo "[forgedock] earlyoom is running: exempt this service by name with: --avoid '(^|/)$1\$' (earlyoom -h)"
  elif pgrep -x systemd-oomd >/dev/null 2>&1; then
    echo "[forgedock] systemd-oomd is running: add ManagedOOMPreference=omit to the unit via a drop-in to exempt $1"
  fi
  return 0
}
