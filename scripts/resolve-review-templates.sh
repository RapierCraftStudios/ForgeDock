#!/usr/bin/env bash
# resolve-review-templates.sh — resolve where the review-pr-agents persona templates live.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One shared copy of the template-resolution chain used by /review-pr (Phase 3C) and
# /review-pr-staging (Phase 5) (forge#3405, devdocs/decisions/2447).
#
# Usage: resolve-review-templates.sh [--fragments] [--plugin-root <abs-path>]
#   --fragments    resolve the directory of on-demand /review-pr phase fragments (commands/review-pr/)
#                  instead of the persona templates. Output: FRAGMENTS_DIR=<dir>; exit 1 when unresolved.
#   --plugin-root  the running plugin's root as substituted by Claude Code. Anything that
#                  does not start with `/` (an unsubstituted placeholder: install.sh, Codex,
#                  OpenCode) is ignored.
# Env:   FORGE_HOME   installed ForgeDock location (tier 1)
#        FORGE_CONFIG forge.yaml path used to find paths.root (tier 2)
# Output (stdout, KEY=value lines; read with sed, never eval):
#   TEMPLATE_SOURCE=plugin_root|forge_home|repo_path|monolithic_catalog|none
#   TEMPLATE_BASE=<dir holding protocols.md + persona files>   (empty for monolithic_catalog/none)
#   MONOLITHIC_CATALOG=<file>                                  (monolithic_catalog only)
# Output with --fragments: FRAGMENTS_DIR=<dir holding the review-pr phase fragments>
# Exit:  0 a source resolved, 1 none resolved (HARD STOP for the caller), 2 usage error.
set -u

PLUGIN_ROOT=""
FRAGMENTS=0
USAGE="usage: resolve-review-templates.sh [--fragments] [--plugin-root <path>]"
while [ $# -gt 0 ]; do
  case "$1" in
    --fragments) FRAGMENTS=1; shift ;;
    --plugin-root) PLUGIN_ROOT="${2-}"; shift 2 || { echo "$USAGE" >&2; exit 2; } ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
case "$PLUGIN_ROOT" in /*) ;; *) PLUGIN_ROOT="" ;; esac

if [ "$FRAGMENTS" = 1 ]; then
  # Same tiers as the templates, plus this script's own install root (the script was found there, so its
  # sibling commands/ directory is the same install). welcome.md is the presence marker.
  SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
  FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"
  REPO_PATH=$(yq '.paths.root' "$FORGE_YAML" 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || pwd)
  for _r in "$PLUGIN_ROOT" "${FORGE_HOME:-}" "$SELF_ROOT" "$REPO_PATH"; do
    case "$_r" in /*) [ -f "$_r/commands/review-pr/welcome.md" ] && { printf 'FRAGMENTS_DIR=%s\n' "$_r/commands/review-pr"; exit 0; } ;; esac
  done
  printf 'FRAGMENTS_DIR=\n'; exit 1
fi

emit() { printf 'TEMPLATE_SOURCE=%s\nTEMPLATE_BASE=%s\nMONOLITHIC_CATALOG=%s\n' "$1" "$2" "$3"; }

# Tier 0: the running plugin's own root. Wins over an exported FORGE_HOME, which may name an older checkout.
if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/commands/review-pr-agents/protocols.md" ]; then
  emit plugin_root "$PLUGIN_ROOT/commands/review-pr-agents" ""; exit 0
fi
# Tier 1: $FORGE_HOME (the installed location). An unset FORGE_HOME must never degrade to a root-anchored path.
if [ -n "${FORGE_HOME:-}" ] && [ -f "$FORGE_HOME/commands/review-pr-agents/protocols.md" ]; then
  emit forge_home "$FORGE_HOME/commands/review-pr-agents" ""; exit 0
fi
# Tier 2: repo-path fallback (forge.yaml paths.root, else the git top-level, else cwd).
FORGE_YAML="${FORGE_CONFIG:-$(git rev-parse --show-toplevel 2>/dev/null)/forge.yaml}"
REPO_PATH=$(yq '.paths.root' "$FORGE_YAML" 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -f "$REPO_PATH/commands/review-pr-agents/protocols.md" ]; then
  emit repo_path "$REPO_PATH/commands/review-pr-agents" ""; exit 0
fi
# Tier 3: monolithic catalog, last resort. The `### Agent:` content check is required: a post-split repo
# still ships a small router stub at this path that only points back to the missing persona directory.
if [ -f "$REPO_PATH/commands/review-pr-agents.md" ] && grep -q "^### Agent:" "$REPO_PATH/commands/review-pr-agents.md" 2>/dev/null; then
  emit monolithic_catalog "" "$REPO_PATH/commands/review-pr-agents.md"; exit 0
fi
emit none "" ""
exit 1
