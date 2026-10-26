#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Installs the computeshare router as a systemd --user service on the host that runs ForgeDock.
# It listens only on this machine's Tailscale IP. Re-running keeps existing tokens and agent enrollments.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/computeshare"
PORT="${ROUTER_PORT:-7710}"
TS_IP="$(tailscale ip -4 | head -1)"
[[ "$TS_IP" == 100.* ]] || { echo "no Tailscale IPv4 found" >&2; exit 1; }
NODE="$(command -v node)"

mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
umask 077
for t in forgedock enroll; do
  [ -s "$CONF_DIR/$t.token" ] || openssl rand -hex 32 > "$CONF_DIR/$t.token"
done

# repos: slug -> gitignored forge.yaml that lanes need (passed to the sandbox, never committed). Extend as needed.
# An existing router.json is kept (re-running the installer must not drop repos or settings added later).
[ -s "$CONF_DIR/router.json" ] || cat > "$CONF_DIR/router.json" <<EOF
{
  "listen": { "host": "$TS_IP", "port": $PORT },
  "public_url": "http://$TS_IP:$PORT",
  "state_dir": "$CONF_DIR/state",
  "lane": { "cpus": ${LANE_CPUS:-2}, "mem_gb": ${LANE_MEM_GB:-3} },
  "lease_interval_s": 60,
  "abandon_after_s": 1800,
  "retry_after_s": 60,
  "repos": {}
}
EOF

mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/computeshare-router.service" <<EOF
[Unit]
Description=computeshare router
After=network-online.target tailscaled.service

[Service]
ExecStart=$NODE $REPO_ROOT/bin/pool/cli.mjs router --config $CONF_DIR/router.json
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now computeshare-router >/dev/null
systemctl --user restart computeshare-router
loginctl enable-linger "$USER" 2>/dev/null || true

# ForgeDock reads execution.token_env from the env, then the OS keychain (service forgedock, account = the name).
if command -v secret-tool >/dev/null; then
  secret-tool store --label "forgedock COMPUTESHARE_TOKEN" service forgedock account COMPUTESHARE_TOKEN < "$CONF_DIR/forgedock.token" \
    && echo "[computeshare] stored the ForgeDock token in the keychain as COMPUTESHARE_TOKEN"
fi

for i in $(seq 1 15); do
  curl -fsS "http://$TS_IP:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
echo "[computeshare] router: $(curl -fsS "http://$TS_IP:$PORT/health")"
echo
echo "Install an agent: run this in an elevated PowerShell on the Windows host:"
"$NODE" "$REPO_ROOT/bin/pool/cli.mjs" install-command --config "$CONF_DIR/router.json"
