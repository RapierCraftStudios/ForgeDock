#!/usr/bin/env bash
# review-template-resolve.sh: sourced helper — the ONE resolution chain for the review-pr-agents persona templates.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Source it, never exec it. `review_template_resolve [repo_path]` sets:
#   TEMPLATE_SOURCE    plugin_root | forge_home | repo_path | monolithic_catalog | none
#   TEMPLATE_BASE      directory holding protocols.md and the persona files (empty for monolithic_catalog / none)
#   MONOLITHIC_CATALOG path of the last-resort catalog (monolithic_catalog only)
# Chain: the running plugin root (CLAUDE_PLUGIN_ROOT, absolute only), then FORGE_HOME, then the trusted install root from
# forge_root when the resolver is loaded, then the repo path argument, then the monolithic catalog (it must contain `### Agent:`
# headers: a post-split repo ships a router stub at that path that points back to the missing directory). `none` is a fatal setup
# error: the caller must stop and never review inline. The repo path is data, only ever read for template files.
review_template_resolve() {
    local _plugin _root _repo="${1:-}"
    TEMPLATE_BASE=""; TEMPLATE_SOURCE="none"; MONOLITHIC_CATALOG=""
    _plugin="${CLAUDE_PLUGIN_ROOT:-}"; case "$_plugin" in /*) ;; *) _plugin="" ;; esac
    if [ -n "$_plugin" ] && [ -f "$_plugin/commands/review-pr-agents/protocols.md" ]; then
        TEMPLATE_BASE="$_plugin/commands/review-pr-agents"; TEMPLATE_SOURCE="plugin_root"; return 0
    fi
    case "${FORGE_HOME:-}" in
        /*) if [ -f "$FORGE_HOME/commands/review-pr-agents/protocols.md" ]; then
                TEMPLATE_BASE="$FORGE_HOME/commands/review-pr-agents"; TEMPLATE_SOURCE="forge_home"; return 0
            fi ;;
    esac
    if type forge_root >/dev/null 2>&1; then
        _root=$(forge_root)
        if [ -n "$_root" ] && [ -f "$_root/commands/review-pr-agents/protocols.md" ]; then
            TEMPLATE_BASE="$_root/commands/review-pr-agents"; TEMPLATE_SOURCE="forge_home"; return 0
        fi
    fi
    if [ -n "$_repo" ]; then
        if [ -f "$_repo/commands/review-pr-agents/protocols.md" ]; then
            TEMPLATE_BASE="$_repo/commands/review-pr-agents"; TEMPLATE_SOURCE="repo_path"; return 0
        fi
        if [ -f "$_repo/commands/review-pr-agents.md" ] && grep -q "^### Agent:" "$_repo/commands/review-pr-agents.md" 2>/dev/null; then
            MONOLITHIC_CATALOG="$_repo/commands/review-pr-agents.md"; TEMPLATE_SOURCE="monolithic_catalog"; return 0
        fi
    fi
    return 0
}
