#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Linux side of the agent install. Runs as root inside the dedicated `computeshare` WSL distro (or any systemd Linux host).
# Required env: ROUTER_URL ENROLL_TOKEN AGENT_NAME AGENT_URL ALLOW_CPUS ALLOW_MEM_GB BUNDLE
set -euo pipefail
: "${ROUTER_URL:?}" "${ENROLL_TOKEN:?}" "${AGENT_NAME:?}" "${AGENT_URL:?}" "${ALLOW_CPUS:?}" "${ALLOW_MEM_GB:?}" "${BUNDLE:?}"
# Never resolve tools through the Windows PATH that WSL appends (e.g. Docker Desktop's docker CLI).
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
NODE_VERSION=22.12.0
PORT="${AGENT_PORT:-7711}"
log() { echo "[computeshare] $*"; }

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
pidof systemd >/dev/null || [ "$(ps -p 1 -o comm=)" = systemd ] || { echo "systemd is not PID 1; enable it in /etc/wsl.conf and restart the distro" >&2; exit 1; }

log "base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git jq xz-utils >/dev/null

if [ ! -x /usr/bin/dockerd ]; then
  log "docker engine"
  install -d -m 0755 /etc/apt/keyrings
  . /etc/os-release
  DOCKER_DISTRO=ubuntu; [ "${ID:-}" = debian ] && DOCKER_DISTRO=debian
  curl -fsSL "https://download.docker.com/linux/${DOCKER_DISTRO}/gpg" -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DOCKER_DISTRO} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null
fi
# WSL mirrored networking usually has no IPv6 route; dockerd would still dial registries over IPv6 and fail.
if grep -qi microsoft /proc/sys/kernel/osrelease && [ -z "$(ip -6 route show default 2>/dev/null)" ]; then
  printf 'net.ipv6.conf.all.disable_ipv6=1\nnet.ipv6.conf.default.disable_ipv6=1\n' > /etc/sysctl.d/90-computeshare-noipv6.conf
  sysctl -q -p /etc/sysctl.d/90-computeshare-noipv6.conf
  systemctl restart docker 2>/dev/null || true
fi
systemctl enable --now docker >/dev/null

if [ ! -x /opt/node/bin/node ] || [ "$(/opt/node/bin/node --version)" != "v${NODE_VERSION}" ]; then
  log "node ${NODE_VERSION}"
  rm -rf /opt/node
  case "$(uname -m)" in aarch64|arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" | tar -xJ -C /opt
  mv "/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}" /opt/node
fi

log "agent code"
rm -rf /opt/computeshare.new && mkdir -p /opt/computeshare.new
tar -xzf "$BUNDLE" -C /opt/computeshare.new
rm -rf /opt/computeshare && mv /opt/computeshare.new /opt/computeshare

install -d -m 0700 /etc/computeshare /var/lib/computeshare
if [ ! -s /etc/computeshare/agent.token ]; then
  log "enrolling ${AGENT_NAME} (${AGENT_URL}) with ${ROUTER_URL}"
  resp=$(curl -fsS -X POST "${ROUTER_URL}/enroll" -H 'content-type: application/json' \
    -d "$(jq -n --arg t "$ENROLL_TOKEN" --arg n "$AGENT_NAME" --arg u "$AGENT_URL" '{token:$t,name:$n,url:$u}')")
  umask 077
  echo "$resp" | jq -r .agent_token > /etc/computeshare/agent.token
  [ -s /etc/computeshare/agent.token ] && [ "$(cat /etc/computeshare/agent.token)" != null ] || { echo "enrollment failed: $resp" >&2; rm -f /etc/computeshare/agent.token; exit 1; }
fi

jq -n --arg name "$AGENT_NAME" --arg router "$ROUTER_URL" --argjson port "$PORT" --argjson cpus "$ALLOW_CPUS" --argjson mem "$ALLOW_MEM_GB" '{
  name: $name, listen: {host: "0.0.0.0", port: $port}, token_file: "/etc/computeshare/agent.token",
  router_url: $router, code_root: "/opt/computeshare",
  state_dir: "/var/lib/computeshare",
  allow_cpus: $cpus, allow_mem_gb: $mem, lease_ttl_s: 600, max_lifetime_s: 21600, keep_exited_s: 7200, reap_interval_s: 30
}' > /etc/computeshare/agent.json
chmod 0600 /etc/computeshare/agent.json

log "building lane image (first run takes several minutes)"
FD_VERSION="$(jq -r .version /opt/computeshare/package.json)"
docker build -q -t "forgedock-lane:${FD_VERSION}" --build-arg "FORGEDOCK_VERSION=${FD_VERSION}" /opt/computeshare/pool/image >/dev/null

. /opt/computeshare/pool/install/unit-hardening.sh
cat > /etc/systemd/system/computeshare-agent.service <<EOF
[Unit]
Description=computeshare agent
After=docker.service network-online.target
Requires=docker.service

[Service]
ExecStart=/opt/node/bin/node /opt/computeshare/bin/pool/cli.mjs agent --config /etc/computeshare/agent.json
$(unit_hardening system)

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable computeshare-agent >/dev/null
systemctl restart computeshare-agent
unit_oom_hint forgedock-pool-agent

for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    log "agent healthy: $(curl -fsS "http://127.0.0.1:${PORT}/health")"
    exit 0
  fi
  sleep 1
done
echo "agent did not become healthy; see: journalctl -u computeshare-agent" >&2
exit 1
