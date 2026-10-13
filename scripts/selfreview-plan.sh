#!/usr/bin/env bash
# selfreview-plan.sh — build-time self-review plan: run or skip, and which roster (forge#3971).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Pure decision script: flags in, key=value lines out. No network, no git, no eval; every flag value is data.
# It calls scripts/review-roster.sh (resolved through forge_resolve, never from the repo under build) on the staged
# diff's file list so the self-review roster equals the roster /review-pr would pick for the same diff.
#
# Usage: selfreview-plan.sh --files-file PATH|- [--changed-lines N] [--changed-files N] [--contract-flags "HIGH_RISK ..."]
#          [--spec-cli true|false] [--review-depth STANDARD|EXTENDED] [--scores "AUTH=n ..."]
#          [--agent-available true|false] [--tree HASH] [--done-trees "HASH HASH ..."]
# Env:   FORGE_SELFREVIEW=off|0|false|disabled   operator off switch
# Output (stdout, always all four lines):
#          SELFREVIEW=run|skip   SKIP_REASON=<reason or empty>   TIER=<roster tier or empty>   SELECTED_AGENTS=<domains>
# Skip reasons (first match wins): disabled, empty-diff, docs-only, no-agent-tool, already-done, roster-unavailable,
#          small-security-only (small tier, Security-only roster, no path or contract trigger fired).
# Exit: 0 for every parseable call, including every degrade-to-skip path (self-review never blocks build); 2 on an unknown flag.
# Bash 3.2 portable (no mapfile, associative arrays, grep -P).
set -u

FILES_FILE=""; LINES=""; NFILES=""; CFLAGS=""; SPEC_CLI=false; DEPTH=STANDARD; SCORES=""
AGENT_AVAILABLE=true; TREE=""; DONE_TREES=""

while [ $# -gt 0 ]; do
    case "$1" in
        --files-file) FILES_FILE="${2:-}"; shift 2 ;;
        --changed-lines) LINES="${2:-}"; shift 2 ;;
        --changed-files) NFILES="${2:-}"; shift 2 ;;
        --contract-flags) CFLAGS="${2:-}"; shift 2 ;;
        --spec-cli) SPEC_CLI="${2:-false}"; shift 2 ;;
        --review-depth) DEPTH="${2:-STANDARD}"; shift 2 ;;
        --scores) SCORES="${2:-}"; shift 2 ;;
        --agent-available) AGENT_AVAILABLE="${2:-true}"; shift 2 ;;
        --tree) TREE="${2:-}"; shift 2 ;;
        --done-trees) DONE_TREES="${2:-}"; shift 2 ;;
        *) echo "selfreview-plan: unknown argument: $1" >&2; exit 2 ;;
    esac
done

emit() { # <run|skip> <skip reason> <tier> <agents>
    printf 'SELFREVIEW=%s\nSKIP_REASON=%s\nTIER=%s\nSELECTED_AGENTS=%s\n' "$1" "$2" "$3" "$4"
    exit 0
}

case "$(printf '%s' "${FORGE_SELFREVIEW:-}" | tr '[:upper:]' '[:lower:]')" in
    off|0|false|disabled|no) emit skip disabled "" "" ;;
esac

FILES=""
if [ "$FILES_FILE" = "-" ]; then FILES=$(cat)
elif [ -n "$FILES_FILE" ] && [ -f "$FILES_FILE" ]; then FILES=$(cat "$FILES_FILE"); fi
FILES=$(printf '%s\n' "$FILES" | grep -v '^[[:space:]]*$' || true)

[ -n "$FILES" ] || emit skip empty-diff "" ""

# Docs-only: every file is documentation. commands/**, .agents/** and skills/** are executable spec, never docs.
CODE_FILES=$(printf '%s\n' "$FILES" | grep -vE '^(docs/|README|CHANGELOG|LICENSE|NOTICE)|\.(md|txt|rst)$' || true)
SPEC_FILES=$(printf '%s\n' "$FILES" | grep -E '^(commands|\.agents|skills)/.*\.md$' || true)
[ -n "$CODE_FILES" ] || [ -n "$SPEC_FILES" ] || emit skip docs-only "" ""

[ "$AGENT_AVAILABLE" = "true" ] || emit skip no-agent-tool "" ""

if [ -n "$TREE" ]; then
    for _t in $DONE_TREES; do
        [ "$_t" = "$TREE" ] && emit skip already-done "" ""
    done
fi

type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; _SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" "${CLAUDE_PLUGIN_ROOT:-}" "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/* "$_SELF_ROOT"; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }  # allowlist:portability — canonical resolver block; readlink -f is guarded (2>/dev/null) and optional
ROSTER_SCRIPT=$(forge_resolve review-roster.sh)
[ -n "$ROSTER_SCRIPT" ] && [ -f "$ROSTER_SCRIPT" ] || emit skip roster-unavailable "" ""

set -- --files-file - --contract-flags "$CFLAGS" --spec-cli "$SPEC_CLI" --review-depth "$DEPTH"
[ -n "$LINES" ] && set -- "$@" --changed-lines "$LINES"
[ -n "$NFILES" ] && set -- "$@" --changed-files "$NFILES"
[ -n "$SCORES" ] && set -- "$@" --scores "$SCORES"
OUT=$(printf '%s\n' "$FILES" | bash "$ROSTER_SCRIPT" "$@" 2>/dev/null) || emit skip roster-unavailable "" ""

SEL=$(printf '%s\n' "$OUT" | sed -n 's/^SELECTED_AGENTS=//p' | head -n 1)
TIER=$(printf '%s\n' "$OUT" | sed -n 's/^TIER=//p' | head -n 1)
[ -n "$SEL" ] && [ -n "$TIER" ] || emit skip roster-unavailable "" ""

# Cost guard: the small tier runs only when a path or contract trigger widened the roster past Security.
if [ "$TIER" = "small" ] && [ "$SEL" = "security" ]; then emit skip small-security-only "$TIER" "$SEL"; fi
emit run "" "$TIER" "$SEL"
