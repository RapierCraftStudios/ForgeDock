#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs `forgedock schedd` (the host scheduler daemon) as a systemd --user service with the shared OOM/restart hardening.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE="$(command -v node)"
. "$REPO_ROOT/pool/install/unit-hardening.sh"

mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/forgedock-schedd.service" <<UNIT
[Unit]
Description=forgedock schedd
$(unit_start_limit)

[Service]
ExecStart=$NODE $REPO_ROOT/bin/forgedock.mjs schedd
$(unit_hardening user)
$(unit_priority user)

[Install]
WantedBy=default.target
UNIT
# #4780: a wedged daemon is alive, so Restart=always never fires; this timer signals one whose heartbeat went stale.
cat > "$HOME/.config/systemd/user/forgedock-schedd-watchdog.service" <<UNIT
[Unit]
Description=forgedock schedd watchdog

[Service]
Type=oneshot
ExecStart=$NODE $REPO_ROOT/bin/forgedock.mjs schedd watchdog
UNIT
cat > "$HOME/.config/systemd/user/forgedock-schedd-watchdog.timer" <<UNIT
[Unit]
Description=forgedock schedd watchdog

[Timer]
OnBootSec=60
OnUnitActiveSec=30s

[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now forgedock-schedd >/dev/null
systemctl --user restart forgedock-schedd
systemctl --user enable --now forgedock-schedd-watchdog.timer >/dev/null
unit_oom_hint forgedock-schedd
loginctl enable-linger "$USER" 2>/dev/null || true
echo "[forgedock] schedd unit installed"
