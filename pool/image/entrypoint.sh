#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Prepares the checkout ForgeDock expects, then execs the lane command (`forgedock run-issue ...`).
# All output goes to /csout/lane.log, which the agent streams back to ForgeDock.
set -euo pipefail
mkdir -p /csout /result /cache
exec > >(tee -a /csout/lane.log) 2>&1

export HOME=/root
export UV_CACHE_DIR=/cache/uv npm_config_cache=/cache/npm POETRY_CACHE_DIR=/cache/poetry PIP_CACHE_DIR=/cache/pip
export TMPDIR=/tmp
# ForgeDock's dependency cache (its pnpm store and snapshots) and pnpm's own store live in the persistent per-repo
# cache volume, so a lane installs from a warm store instead of downloading every package (a cold monorepo install
# took ~15 min and hit ForgeDock's install timeout). /cache and /work are different volumes, so pnpm imports by copy.
export FORGE_DEPCACHE_ROOT=/cache/forge-depcache npm_config_store_dir=/cache/pnpm-store
# Testcontainers' Ryuk reaper never logs "Started" on the sandbox's private dockerd, so every DB test setup failed.
# The sandbox and its dockerd are discarded after the lane, so the reaper has nothing to add.
export TESTCONTAINERS_RYUK_DISABLED=true

echo "[computeshare] sandbox ${CS_SANDBOX_ID:-?} repo ${CS_REPO_SLUG:-?} ref ${CS_REPO_REF:-default} on $(hostname)"

# GitHub auth: the token is fetched on demand through the agent (installation tokens expire hourly), so a long lane
# never runs on a stale token. `gh` is a shim that exports a fresh GH_TOKEN; git uses the same source as a helper.
if [ -n "${CS_CRED_BASE:-}" ]; then
  # Scoped to github.com: the installation token is never offered to another HTTPS git host (#4565).
  git config --global credential.https://github.com.helper '!f() { echo username=x-access-token; echo "password=$(cs-cred github)"; }; f'
elif [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git >/dev/null 2>&1 || true
fi
checkout_repo() {
  if [ -n "${CS_REPO_URL:-}" ]; then
    # Shared bare mirror in the cache volume: later lanes fetch a delta instead of a full clone.
    mirror="/cache/git/$(echo "${CS_REPO_SLUG:-repo}" | tr '/' '_').git"
    if [ -d "$mirror" ]; then
      git -C "$mirror" fetch --prune --quiet origin '+refs/heads/*:refs/heads/*' || true
    else
      mkdir -p /cache/git
      git clone --mirror --quiet "$CS_REPO_URL" "$mirror"
    fi
    rm -rf /work/repo
    git clone --quiet --reference "$mirror" ${CS_REPO_REF:+--branch "$CS_REPO_REF"} "$CS_REPO_URL" /work/repo
    cd /work/repo
  fi
}

# Warm sandbox (#4912): prepare the checkout, then wait for the agent's claim (lane env, command, ref in /claim/claim.json).
# The container env is fixed at start, so the lane arrives as a file that is read once and deleted.
if [ "${CS_WARM:-}" = "1" ]; then
  checkout_repo
  # Prime the lockfile-keyed dependency cache (best effort): the lane's own install is then a hit, not a download.
  fd_bin="$(dirname "$(readlink -f "$(command -v forgedock)")" 2>/dev/null || true)"
  if [ -f "$fd_bin/lean/depcache.mjs" ] && [ -d /work/repo ]; then
    node --input-type=module -e 'const { makeDepCache } = await import(process.argv[1]); const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util"); const x = promisify(execFile);
      await makeDepCache({ exec: async (c, a, o = {}) => String((await x(c, a, { cwd: o.cwd, env: { ...process.env, ...(o.env ?? {}) }, timeout: o.timeoutMs ?? 0, maxBuffer: 1 << 28 })).stdout) }).prepare({ wt: "/work/repo", repoKey: process.argv[2] });' \
      "$fd_bin/lean/depcache.mjs" "${CS_REPO_SLUG:-repo}" || echo "[computeshare] warm dependency prime skipped"
  fi
  touch /csout/warm-ready
  while [ ! -f /claim/claim.json ]; do sleep 0.5; done
  eval "$(node -e '
    const c = JSON.parse(require("fs").readFileSync("/claim/claim.json", "utf8")), q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    const out = Object.entries(c.env ?? {}).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => "export " + k + "=" + q(v));
    out.push("CS_CLAIM_REF=" + q(c.ref ?? ""), "set -- " + (c.command ?? []).map(q).join(" "));
    console.log(out.join("\n"));
  ')"
  rm -f /claim/claim.json
  unset CS_WARM
  warm_claimed=1
fi

# #4778: allowlisted read-only host wrappers (e.g. obs-psql) run through cs-relay on the dispatching host, unchanged argv.
if [ -n "${CS_RELAY_COMMANDS:-}" ]; then
  mkdir -p /opt/cs/bin
  IFS=',' read -ra relay_cmds <<<"$CS_RELAY_COMMANDS"
  for c in "${relay_cmds[@]}"; do
    [[ "$c" =~ ^[A-Za-z0-9._-]+$ ]] || continue
    printf '#!/usr/bin/env bash\nexec cs-relay %s "$@"\n' "$c" > "/opt/cs/bin/$c"
    chmod 0755 "/opt/cs/bin/$c"
  done
fi
git config --global user.name "${GIT_AUTHOR_NAME:-forgedock}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-forgedock@localhost}"

if [ -z "${warm_claimed:-}" ]; then
  checkout_repo
else
  (cd /work/repo && /usr/local/bin/cs-warm-refresh "${CS_CLAIM_REF:-}")
  cd /work/repo
fi

if [ -n "${CS_FORGE_YAML_B64:-}" ]; then
  echo "$CS_FORGE_YAML_B64" | base64 -d > forge.yaml
  unset CS_FORGE_YAML_B64
fi

if [ -n "${DOCKER_HOST:-}" ]; then
  # Docker-enabled sandbox: wait for the private daemon sidecar before the lane starts its stack.
  for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker info >/dev/null 2>&1 && echo "[computeshare] private docker daemon ready ($(docker version --format '{{.Server.Version}}'))" \
    || echo "[computeshare] WARNING: private docker daemon not reachable at $DOCKER_HOST"
fi

echo "[computeshare] running: $*"
exec "$@"
