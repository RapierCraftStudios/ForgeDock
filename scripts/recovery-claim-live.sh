#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# recovery-claim-live.sh — is an issue currently claimed by a /recover-orphans sweep?
#
# Single source of truth for the dispatcher-side check of FORGE:RECOVERY_CLAIM, used by
# /work-on Phase 0B and /orchestrate Phase 4 so a dispatcher never re-enters an issue a sweep is
# resuming. Same semantics as `claim_orphan` in commands/recover-orphans.md: a claim is LIVE when it
# is an unreleased `<!-- FORGE:RECOVERY_CLAIM -->` comment, its `updated_at` is within
# RECOVERY_CLAIM_TTL_MIN (default 30) minutes, and no `FORGE:RECOVERY_CLAIM_RELEASED` comment names
# its sweep id. FORGE:HEARTBEAT is deliberately NOT counted: a dispatcher must not defer to another
# dispatcher's heartbeat (that is the lease/claims-board job).
#
# Usage:
#   recovery-claim-live.sh <issue> -R <owner/repo> [--exempt-sweep <sweep-id>]
#
#   --exempt-sweep  Ignore the claim held by this sweep id (the calling sweep's own claim), so the
#                   holder's inline /work-on is not blocked by its own claim. A claim with no
#                   parsable sweep id is never exempt (and `unknown` is rejected as an exemption id).
#
# Output (stdout): CLAIM: LIVE <sweep-id> | CLAIM: FREE | CLAIM: ERROR
# Exit codes: 0 free, 1 live, 2 error (unreadable comments or usage; fails closed — callers must
# treat 2 like "live" and defer, never like "free").
#
# Trust note: any commenter's claim marker counts (same as claim_orphan). A spoofed claim can only
# defer an issue for RECOVERY_CLAIM_TTL_MIN unless it is refreshed.
# END-HELP (`-h` prints the header up to this line; keep it last)

set -uo pipefail

ISSUE=""; REPO=""; EXEMPT=""
err() { echo "CLAIM: ERROR"; echo "$1" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -R|--repo)
      [ $# -ge 2 ] && [ -n "${2:-}" ] || err "usage error: $1 needs a value"
      REPO="$2"; shift 2 ;;
    --exempt-sweep)
      [ $# -ge 2 ] && [ -n "${2:-}" ] || err "usage error: $1 needs a value"
      [ "$2" != "unknown" ] || err "usage error: --exempt-sweep 'unknown' is the no-sweep-id sentinel and cannot exempt a claim"
      EXEMPT="$2"; shift 2 ;;
    -h|--help) awk 'NR >= 5 { if (/^# END-HELP/) exit; print }' "$0"; exit 0 ;;
    *)
      if [ -z "$ISSUE" ] && [[ "$1" =~ ^[0-9]+$ ]]; then ISSUE="$1"; shift
      else err "usage error: unexpected argument '$1'"; fi ;;
  esac
done
[ -n "$ISSUE" ] && [ -n "$REPO" ] || err "usage: recovery-claim-live.sh <issue> -R <owner/repo> [--exempt-sweep <id>]"

TTL="${RECOVERY_CLAIM_TTL_MIN:-30}"
[[ "$TTL" =~ ^[0-9]+$ ]] || TTL=30
CUTOFF=$(( $(date -u +%s) - TTL * 60 ))

# pipefail: a gh failure (rate limit, 403) must not look like "no comments".
COMMENTS=$(gh api --paginate "repos/${REPO}/issues/${ISSUE}/comments" 2>/dev/null | jq -s 'add // []') \
  || err "could not read comments for #${ISSUE}"

LIVE=$(echo "$COMMENTS" | jq -r --argjson cutoff "$CUTOFF" --arg exempt "$EXEMPT" '
  def sweepid: ((.body | capture("Sweep: (?<id>[^ \n*]+)")?) // {id: "unknown"}).id;
  # "unknown" is the no-id sentinel, never a matchable id: an unparsable release frees nothing (fail closed).
  ([.[] | select(.body | contains("FORGE:RECOVERY_CLAIM_RELEASED")) | sweepid] | map(select(. != "unknown"))) as $rel
  | [ .[] | select(.body | contains("<!-- FORGE:RECOVERY_CLAIM -->"))
          | select((.body | contains("FORGE:RECOVERY_CLAIM_RELEASED")) | not)
          | select(((.updated_at // "") | fromdateiso8601? // 9999999999) >= $cutoff)
          | select(sweepid as $sid | ($rel | index($sid)) == null)
          | select($exempt == "" or sweepid == "unknown" or sweepid != $exempt)
          | sweepid ] | first // empty') \
  || err "could not evaluate recovery claims for #${ISSUE}"

if [ -n "$LIVE" ]; then echo "CLAIM: LIVE ${LIVE}"; exit 1; fi
echo "CLAIM: FREE"; exit 0
