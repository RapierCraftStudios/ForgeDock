#!/usr/bin/env bash
# fence-bootstrap.sh — sourced by every review-pr-staging fence that consumes cross-fence state.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# A fresh Bash call loses shell state: this re-derives config and the cross-fence PR state from the
# scratchpad. Source it (never exec it) so the variables reach the calling fence.
_SD="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}"; mkdir -p "$_SD"
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
[ -n "${GH_REPO:-}" ] || GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE" 2>/dev/null)
[ -n "${DEFAULT_BRANCH:-}" ] || DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE" 2>/dev/null)
[ -n "${STAGING_BRANCH:-}" ] || STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE" 2>/dev/null)
# run-keyed pointer (concurrent runs share $_SD); numeric-validated: a tampered file never reaches gh
FORGE_RUN_KEY="${FORGE_RUN_KEY:-${FORGE_RUN_ID:-${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-${CODEX_THREAD_ID:-${OPENCODE_SESSION_ID:-$PPID}}}}}}"; FORGE_RUN_KEY=$(printf '%s' "$FORGE_RUN_KEY" | tr -c 'A-Za-z0-9_-' '_')
[ -n "${PR_NUMBER:-}" ] || { [ -r "$_SD/staging_pr_number.${FORGE_RUN_KEY}" ] && PR_NUMBER=$(sed -n '1{/^[0-9][0-9]*$/p;q}' "$_SD/staging_pr_number.${FORGE_RUN_KEY}"); }
[ -n "${ALL_PR_NUMBERS:-}" ] || { [ -n "${PR_NUMBER:-}" ] && [ -r "$_SD/${PR_NUMBER}_bundle-prs.txt" ] && ALL_PR_NUMBERS=$(grep -E '^[0-9]+$' "$_SD/${PR_NUMBER}_bundle-prs.txt"); }
[ -n "${PR_NUMBER:-}" ] || echo "WARNING: PR_NUMBER is empty after reload (no staging_pr_number.${FORGE_RUN_KEY} in $_SD): this fence cannot key its scratch files or post to a PR."
