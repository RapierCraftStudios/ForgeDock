#!/usr/bin/env bash
# resolve-review-templates.test.sh — tier-ordering cases for scripts/resolve-review-templates.sh (forge#3405).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/resolve-review-templates.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAILN=0
mk_split() { mkdir -p "$1/commands/review-pr-agents"; : > "$1/commands/review-pr-agents/protocols.md"; }
check() { # name want-rc want-source-regex ; runs in $TMP/cwd with extra args from $ARGS and env from $ENVS
  local name="$1" wrc="$2" wsrc="$3" out rc
  out=$(cd "$TMP/cwd" && env -u FORGE_HOME -u FORGE_CONFIG ${ENVS[@]+"${ENVS[@]}"} bash "$S" ${ARGS[@]+"${ARGS[@]}"} 2>&1); rc=$?
  if [ "$rc" = "$wrc" ] && { [ "$wsrc" = "-" ] || printf '%s\n' "$out" | grep -qE "^TEMPLATE_SOURCE=($wsrc)$"; }; then PASS=$((PASS+1))
  else FAILN=$((FAILN+1)); echo "FAIL: $name (rc=$rc want $wrc; out=$out)"; fi
}
mkdir -p "$TMP/cwd"; git -C "$TMP/cwd" init -q 2>/dev/null
mk_split "$TMP/plugin"; mk_split "$TMP/home"; mk_split "$TMP/cwd"

ENVS=(FORGE_HOME="$TMP/home"); ARGS=(--plugin-root "$TMP/plugin")
check "plugin root wins over FORGE_HOME" 0 plugin_root
ENVS=(FORGE_HOME="$TMP/home"); ARGS=(--plugin-root '${CLAUDE_PLUGIN_ROOT}')
check "unsubstituted placeholder is ignored" 0 forge_home
ENVS=(FORGE_HOME="$TMP/home"); ARGS=(--plugin-root "$TMP/missing")
check "plugin root without templates falls through" 0 forge_home
ENVS=(); ARGS=()
check "repo path when FORGE_HOME unset" 0 repo_path
ENVS=(FORGE_HOME="$TMP/missing"); ARGS=()
check "FORGE_HOME without templates falls through" 0 repo_path
rm -rf "$TMP/cwd/commands"; mkdir -p "$TMP/cwd/commands"
printf '### Agent: Security\n' > "$TMP/cwd/commands/review-pr-agents.md"
ENVS=(); ARGS=()
check "monolithic catalog with Agent headers" 0 monolithic_catalog
printf 'see commands/review-pr-agents/ directory\n' > "$TMP/cwd/commands/review-pr-agents.md"
check "router stub is not a catalog" 1 none
rm -rf "$TMP/cwd/commands"
check "nothing resolves" 1 none
ARGS=(--bogus)
check "usage error" 2 -

# --fragments mode: tiers plugin root, FORGE_HOME, script's own root, repo path; welcome.md is the marker.
mk_frag() { mkdir -p "$1/commands/review-pr"; : > "$1/commands/review-pr/welcome.md"; }
fcheck() { # name want-rc want-dir-suffix
  local out rc; out=$(cd "$TMP/cwd" && env -u FORGE_HOME -u FORGE_CONFIG ${ENVS[@]+"${ENVS[@]}"} bash "$S" --fragments ${ARGS[@]+"${ARGS[@]}"} 2>&1); rc=$?
  if [ "$rc" = "$2" ] && printf '%s\n' "$out" | grep -qE "^FRAGMENTS_DIR=$3\$"; then PASS=$((PASS+1))
  else FAILN=$((FAILN+1)); echo "FAIL: $1 (rc=$rc; out=$out)"; fi
}
mk_frag "$TMP/plugin"; mk_frag "$TMP/home"
ENVS=(FORGE_HOME="$TMP/home"); ARGS=(--plugin-root "$TMP/plugin")
fcheck "fragments: plugin root wins" 0 "$TMP/plugin/commands/review-pr"
ENVS=(FORGE_HOME="$TMP/home"); ARGS=()
fcheck "fragments: FORGE_HOME next" 0 "$TMP/home/commands/review-pr"
ENVS=(FORGE_HOME="$TMP/missing"); ARGS=()
fcheck "fragments: falls through to the script's own root" 0 ".*/commands/review-pr"
CP="$TMP/copy"; mkdir -p "$CP/scripts"; cp "$S" "$CP/scripts/"; S="$CP/scripts/resolve-review-templates.sh"
ENVS=(); ARGS=()
fcheck "fragments: unresolved in a bare tree" 1 ""

echo "resolve-review-templates.test.sh: ${PASS} passed, ${FAILN} failed"
[ "$FAILN" -eq 0 ]
