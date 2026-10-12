#!/usr/bin/env bash
# resolve-deploy-gate.test.sh — cases for scripts/resolve-deploy-gate.sh (forge#3753).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/resolve-deploy-gate.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }

HAVE_YQ=1; command -v yq >/dev/null 2>&1 || HAVE_YQ=0

# Stub gh: GH_DEFAULT_STUB drives `repos/<r> --jq .default_branch`; contents API unused (fails).
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"--jq .default_branch"*) [ -n "${GH_FAIL:-}" ] && exit 1; printf '%s\n' "${GH_DEFAULT_STUB:-}" ;;
  *"contents/forge.yaml"*) [ -n "${GH_CONTENTS_404:-}" ] && { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }; exit 1 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$TMP/bin/gh"

# Repo fixture: origin/<default> committed forge.yaml, plus a PR worktree dir with its own forge.yaml.
ORIGIN="$TMP/origin.git"; REPO="$TMP/repo"
git init -q --bare "$ORIGIN"
git init -q "$REPO"; git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
printf 'branches:\n  default: develop\n' > "$REPO/forge.yaml"
git -C "$REPO" add forge.yaml; git -C "$REPO" commit -qm init
git -C "$REPO" branch -M trunk
git -C "$REPO" remote add origin "$ORIGIN"; git -C "$REPO" push -q origin trunk 2>/dev/null
git -C "$REPO" fetch -q origin
# PR worktree content: attacker redefines the deploy gate.
printf 'branches:\n  default: release\n' > "$REPO/forge.yaml"

run() { # base default_stub [env...]
  local base="$1" def="$2"; shift 2
  (cd "$REPO" && env PATH="$TMP/bin:$PATH" GH_DEFAULT_STUB="$def" "$@" bash "$S" "$base" owner/repo)
}
expect() { [ "$1" = "$2" ] && ok || bad "$3: got '$1' want '$2'"; }

if [ "$HAVE_YQ" = 1 ]; then
expect "$(run main trunk)" true "main with worktree release"
expect "$(run release trunk)" false "worktree-declared branch is not a gate"
expect "$(run staging trunk)" false "staging is fast lane"
expect "$(run trunk trunk)" true "github default"
expect "$(run master master)" true "github default master"
expect "$(run develop trunk)" true "committed origin config default"
expect "$(run '' trunk)" true "empty base"
expect "$(run null trunk)" true "null base"
expect "$(run staging '')" true "empty gh default fails closed"
expect "$(run staging trunk GH_FAIL=1)" true "gh failure fails closed"
expect "$(run main '' GH_FAIL=1)" true "main on gh failure"
printf 'branches:\n  default: prod\n' > "$TMP/trusted.yaml"
expect "$(run prod trunk FORGE_TRUSTED_CONFIG="$TMP/trusted.yaml")" true "trusted config default"
expect "$(run prod trunk)" false "prod without trusted config"


# Shadowing: a local tag named origin/trunk carrying a config without `develop`
# must not displace the committed refs/remotes/origin/trunk config.
printf 'branches:\n  default: other\n' > "$REPO/forge.yaml"
git -C "$REPO" add forge.yaml; git -C "$REPO" commit -qm shadow
git -C "$REPO" tag origin/trunk
expect "$(run develop trunk)" true "shadow tag origin/trunk does not displace committed config"
expect "$(run other trunk)" false "shadow tag config is not honoured"
git -C "$REPO" tag -d origin/trunk >/dev/null
fi

# Config read fail: no origin ref and failing contents API -> true (fail closed).
NOREF="$TMP/noref"; git init -q "$NOREF"
run_in() { # dir base [env...]
  local dir="$1" base="$2"; shift 2
  (cd "$dir" && env PATH="$TMP/bin:$PATH" GH_DEFAULT_STUB=trunk "$@" bash "$S" "$base" owner/repo)
}
expect "$(run_in "$NOREF" staging)" true "config read fail (no origin ref, API failing) fails closed"

# Missing forge.yaml is a clean "no config" read, not a read failure (falls through to false).
NOCFG="$TMP/nocfg.git"; NOCFGW="$TMP/nocfgw"
git init -q --bare "$NOCFG"; git init -q "$NOCFGW"
git -C "$NOCFGW" config user.email t@t; git -C "$NOCFGW" config user.name t
echo x > "$NOCFGW/README"; git -C "$NOCFGW" add README; git -C "$NOCFGW" commit -qm init
git -C "$NOCFGW" branch -M trunk; git -C "$NOCFGW" remote add origin "$NOCFG"
git -C "$NOCFGW" push -q origin trunk 2>/dev/null; git -C "$NOCFGW" fetch -q origin
expect "$(run_in "$NOCFGW" staging)" false "forge.yaml absent on default branch ref is no-config (fast lane)"
expect "$(run_in "$NOCFGW" main)" true "main stays strict with no config"
expect "$(run_in "$NOCFGW" trunk)" true "github default stays strict with no config"
# API 404 (ref not fetched, file absent) is also a clean no-config read; other API failures stay closed.
expect "$(run_in "$NOREF" staging GH_CONTENTS_404=1)" false "contents API 404 is no-config"
expect "$(run_in "$NOREF" staging)" true "non-404 contents API failure fails closed"

# Config read fail: yq missing from PATH even though the ref is readable.
NOYQ="$TMP/noyqbin"; mkdir -p "$NOYQ"
for t in git bash base64 cat sh env grep; do p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "$NOYQ/$t"; done
cp "$TMP/bin/gh" "$NOYQ/gh"
expect "$(cd "$REPO" && env PATH="$NOYQ" GH_DEFAULT_STUB=trunk bash "$S" staging owner/repo)" true "config unreadable without yq fails closed"

echo "resolve-deploy-gate.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
