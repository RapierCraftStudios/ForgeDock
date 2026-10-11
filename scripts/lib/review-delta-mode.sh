#!/usr/bin/env bash
# review-delta-mode.sh: sourced helper for commands/review-pr.md (the review-delta mode functions).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Source it, never exec it; the spec resolves it with `forge_resolve lib/review-delta-mode.sh` (install roots only, never the
# working directory or the PR checkout). When it is unresolved the spec defines FULL-only fallbacks, so a missing helper
# can only cause a full review, never a skipped one.
is_sha() { case "${1}" in *[!0-9a-f]*|"") return 1 ;; esac; [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]; }
# Prints "<MODE> <ARG> <FULL_ROUNDS>" from scripts/review-delta.sh: "FULL - n", "DELTA <reviewed-sha> n" or "BASE_SYNC_ONLY <reviewed-sha> n".
# Needs REPO PR_NUMBER REVIEW_SHA BASE_BRANCH TRUSTED_SCRIPT REVIEW_DELTA_SCRIPT in scope. Every failure (unresolved script, bad output, bad SHA, empty delta) prints FULL, never a skipped review.
review_delta_mode() {
    local out l1 l2 kind arg from to rounds=0 top
    is_sha "$REVIEW_SHA" || { echo "FULL - 0"; return 0; }
    if [ -z "$TRUSTED_SCRIPT" ] || [ -z "$REVIEW_DELTA_SCRIPT" ] || [ -z "$BASE_BRANCH" ]; then echo "FULL - 0"; return 0; fi
    top=$(git rev-parse --show-toplevel 2>/dev/null) || top=""
    [ -n "$top" ] || { echo "FULL - 0"; return 0; }
    out=$(bash "$REVIEW_DELTA_SCRIPT" --pr "$PR_NUMBER" --head "$REVIEW_SHA" --base "$BASE_BRANCH" --trusted-script "$TRUSTED_SCRIPT" --repo "$REPO" --repo-path "$top" 2>/dev/null) || out=""
    l1=$(printf '%s\n' "$out" | sed -n 1p); l2=$(printf '%s\n' "$out" | sed -n 2p)
    case "$l2" in FULL_ROUNDS=*) rounds="${l2#FULL_ROUNDS=}" ;; esac
    case "$rounds" in ''|*[!0-9]*) echo "FULL - 0"; return 0 ;; esac
    kind="${l1%% *}"; arg="${l1#* }"
    if [ "$kind" = "BASE_SYNC_ONLY" ] && is_sha "$arg" && [ "$arg" != "$REVIEW_SHA" ]; then echo "BASE_SYNC_ONLY $arg $rounds"; return 0; fi
    if [ "$kind" = "DELTA" ]; then
        from="${arg%%..*}"; to="${arg##*..}"
        if is_sha "$from" && [ "$to" = "$REVIEW_SHA" ] && [ "$from" != "$to" ]; then echo "DELTA $from $rounds"; return 0; fi
    fi
    echo "FULL - $rounds"
}
# Prints the Carried-From-SHA only when a TRUSTED FORGE:REVIEW-CARRIED record for this head names it AND the resolver
# still answers BASE_SYNC_ONLY from that same reviewed SHA right now. Needs COMMENTS_JSON as well. Marker text alone never counts.
carry_verified_from() {
    local kind from rounds n
    if [ -z "$TRUSTED_SCRIPT" ] || [ -z "$COMMENTS_JSON" ]; then return 0; fi
    read -r kind from rounds <<< "$(review_delta_mode)"
    [ "$kind" = "BASE_SYNC_ONLY" ] || return 0
    n=$(printf '%s' "$COMMENTS_JSON" | bash "$TRUSTED_SCRIPT" count "\\A(?=[\\s\\S]*\\nReviewed-SHA: ${REVIEW_SHA}\\r?(\\n|$))(?=[\\s\\S]*\\nCarried-From-SHA: ${from}\\r?(\\n|$))<!-- FORGE:REVIEW-CARRIED -->" 2>/dev/null || echo "")
    case "$n" in ''|*[!0-9]*) return 0 ;; esac
    [ "$n" -ge 1 ] && printf '%s' "$from"
    return 0
}
