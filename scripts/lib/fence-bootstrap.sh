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
# numeric-validated: a tampered file never reaches gh
[ -n "${PR_NUMBER:-}" ] || { [ -r "$_SD/staging_pr_number" ] && PR_NUMBER=$(sed -n '1{/^[0-9][0-9]*$/p;q}' "$_SD/staging_pr_number"); }
[ -n "${ALL_PR_NUMBERS:-}" ] || { [ -n "${PR_NUMBER:-}" ] && [ -r "$_SD/${PR_NUMBER}_bundle-prs.txt" ] && ALL_PR_NUMBERS=$(grep -E '^[0-9]+$' "$_SD/${PR_NUMBER}_bundle-prs.txt"); }
[ -n "${PR_NUMBER:-}" ] || echo "WARNING: PR_NUMBER is empty after reload (no staging_pr_number in $_SD): this fence cannot key its scratch files or post to a PR."
