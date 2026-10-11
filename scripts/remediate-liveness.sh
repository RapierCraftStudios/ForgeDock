#!/usr/bin/env bash
# remediate-liveness.sh — is an earlier remediation of this PR still alive? (remediate.md Phase M0, forge#3792)
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: remediate-liveness.sh <pr> <issue> <owner/repo> [lease-holder]
# Env:   DRY_RUN       non-empty: print the deferral record instead of posting it
#        FORGE_LIVENESS_NOW_MS  override the clock (tests)
#
# The decision is deterministic and comes from GitHub state only, never from how partial trail comments look:
#   (a) lease: the FORGE:STATE block in the issue body carries lease.until in (now, now + MAX_LEASE_TTL] for a
#       lease.by that is not the dispatching holder and not a provably dead same-host engine pid. An until past
#       the TTL cap is not a lease an engine could have written (the issue body is author-editable), so it is dead.
#   (b) review: the newest trusted FORGE:REVIEW_ROUTE comment is younger than REVIEW_PENDING_MAX_S and no trusted
#       FORGE:REVIEW-AGENT:* or FORGE:REVIEW-CARRIED comment carries a Reviewed-SHA that prefix-matches the routed sha (either direction).
#   A deferral is bounded: after MAX_DEFERRALS trusted FORGE:REMEDIATION_DEFERRED records for this PR the answer is
#   EXHAUSTED (a human is needed), so a flapping lease or a dead review can never park a PR forever.
#
# The last stdout line is the verdict; the exit code mirrors it:
#   LIVENESS: DEAD                     exit 0   proceed (adopt the interrupted attempt)
#   LIVENESS: DEFER <kind> <detail>    exit 10  a live run owns the PR; a FORGE:REMEDIATION_DEFERRED record was posted
#   LIVENESS: EXHAUSTED <n>            exit 11  deferral budget used up; escalate
#   LIVENESS: ERROR <why>              exit 2   unreadable state; fail closed (never "no lease", never delete)
# Trust predicate for comments: Bot, or OWNER/MEMBER/COLLABORATOR (same default as scripts/trusted-comments.sh).
set -uo pipefail
# Telemetry (forge#3834): best-effort decision record; never changes stdout, stderr or the exit code.
_TEL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/telemetry.sh"; [ -f "$_TEL" ] && . "$_TEL" 2>/dev/null
type forge_emit >/dev/null 2>&1 || forge_emit() { :; }
[ -z "${DRY_RUN:-}" ] || FORGE_TELEMETRY=off

PR="${1:-}"; ISSUE="${2:-}"; REPO="${3:-}"; HOLDER="${4:-}"
MAX_LEASE_TTL_MS=1800000      # 3x the engine's 10 min lease TTL
REVIEW_PENDING_MAX_S=1800     # a review with no verdict after 30 min is dead, not in flight
MAX_DEFERRALS=3

err() { printf 'LIVENESS: ERROR %s\n' "$1"; exit 2; }
case "$PR" in ''|*[!0-9]*) err "bad pr" ;; esac
case "$ISSUE" in ''|*[!0-9]*) err "bad issue" ;; esac
[ -n "$REPO" ] || err "no repo"
printf '%s' "$HOLDER" | grep -qE '^[A-Za-z0-9._-]{1,128}$' || HOLDER=""
NOW_MS="${FORGE_LIVENESS_NOW_MS:-$(( $(date +%s) * 1000 ))}"
NOW_S=$(( NOW_MS / 1000 ))

TRUST='((.user.type // "") == "Bot" or ((.author_association // "") | IN("OWNER","MEMBER","COLLABORATOR")))'

# Body + provenance (issue-body FORGE:STATE trust gate): the LAST EDITOR (editor // author) must be a Bot,
# or the creator with OWNER/MEMBER/COLLABORATOR, or a distinct editor with write/maintain/admin permission.
# Unreadable provenance fails closed. An untrusted body is treated as having no FORGE:STATE (no lease).
OWNER_PART="${REPO%%/*}"; NAME_PART="${REPO#*/}"
PROV_Q='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){body authorAssociation author{login __typename} editor{login __typename}}}}'
PROV=$(gh api graphql -f query="$PROV_Q" -F owner="$OWNER_PART" -F name="$NAME_PART" -F number="$ISSUE" 2>/dev/null) || err "issue unreadable"
ISSUE_JSON=$(printf '%s' "$PROV" | jq -c '.data.repository.issue | {body: (.body // "")}' 2>/dev/null) || err "issue unreadable"
ACTOR_ROW=$(printf '%s' "$PROV" | jq -r '.data.repository.issue | (.editor // .author) as $a | [($a.__typename // ""), ($a.login // ""), (if .editor != null and .editor.login != .author.login then "EDITOR" else (.authorAssociation // "NONE") end)] | @tsv' 2>/dev/null) || err "issue unreadable"
A_TYPE=$(printf '%s' "$ACTOR_ROW" | cut -f1); A_LOGIN=$(printf '%s' "$ACTOR_ROW" | cut -f2); A_ASSOC=$(printf '%s' "$ACTOR_ROW" | cut -f3)
BODY_TRUSTED=false
if [ "$A_TYPE" = "Bot" ]; then BODY_TRUSTED=true
else
  case "$A_ASSOC" in
    OWNER|MEMBER|COLLABORATOR) BODY_TRUSTED=true ;;
    EDITOR)
      if printf '%s' "$A_LOGIN" | grep -qE '^[A-Za-z0-9-]{1,39}$'; then
        PERM=$(gh api "repos/$REPO/collaborators/$A_LOGIN/permission" --jq .permission 2>/dev/null || true)
        case "$PERM" in admin|maintain|write) BODY_TRUSTED=true ;; esac
      fi ;;
  esac
fi
[ "$BODY_TRUSTED" = "true" ] || ISSUE_JSON='{"body":""}'
ISSUE_COMMENTS=$(gh api --paginate "repos/$REPO/issues/$ISSUE/comments" 2>/dev/null) || err "issue comments unreadable"
PR_COMMENTS=$(gh api --paginate "repos/$REPO/issues/$PR/comments" 2>/dev/null) || err "PR comments unreadable"
[ -n "$PR_COMMENTS" ] || err "PR comments unreadable"

# (a) lease. No FORGE:STATE block = no lease; a block that is present but unparseable fails closed.
STATE_JSON=$(printf '%s' "$ISSUE_JSON" | jq -r '.body // ""' | awk '/^<!-- FORGE:STATE[[:space:]]*$/{f=1;next} f&&/^-->/{exit} f')
LEASE_BY=""; LEASE_UNTIL=0; LEASE_LIVE=false
if [ -n "$STATE_JSON" ]; then
  ROW=$(printf '%s' "$STATE_JSON" | jq -r '(.lease // {}) as $l | [($l.by // "" | tostring), (if ($l.until|type)=="number" then ($l.until|floor) else 0 end)] | @tsv' 2>/dev/null) \
    || err "FORGE:STATE block unparseable"
  LEASE_BY=$(printf '%s' "$ROW" | cut -f1); LEASE_UNTIL=$(printf '%s' "$ROW" | cut -f2)
  case "$LEASE_UNTIL" in ''|*[!0-9]*) LEASE_UNTIL=0 ;; esac
  if [ -n "$LEASE_BY" ] && [ "$LEASE_BY" != "$HOLDER" ] && [ "$LEASE_UNTIL" -gt "$NOW_MS" ] && [ "$LEASE_UNTIL" -le $(( NOW_MS + MAX_LEASE_TTL_MS )) ]; then
    LEASE_LIVE=true
    # Provably dead same-host engine (id cli_<host>_<pid>, pid gone): not live, as the engine's own I3 guard decides.
    if [[ "$LEASE_BY" =~ ^cli_(.+)_([0-9]+)$ ]]; then
      _h="${BASH_REMATCH[1]}"; _p="${BASH_REMATCH[2]}"
      _me=$(uname -n 2>/dev/null | sed 's/[^A-Za-z0-9.-]/-/g')
      if [ "$_h" = "${_me:-unknown}" ] && ! kill -0 "$_p" 2>/dev/null && ! ps -p "$_p" >/dev/null 2>&1; then LEASE_LIVE=false; fi
    fi
  fi
fi

# (b) a routed review that is still inside its window and has produced no verdict (FORGE:REVIEW-AGENT or, for BASE_SYNC_ONLY, FORGE:REVIEW-CARRIED) for the routed sha.
ROUTE=$(printf '%s' "$PR_COMMENTS" | jq -rs "[.[][] | select($TRUST) | select((.body // \"\") | test(\"^<!-- FORGE:REVIEW_ROUTE mode=[^ ]+ spec=review-pr.md sha=[0-9a-f]{7,40} -->\")) | select((.body | test(\"mode=spec-evolution-blocked\")) | not)] | last | if . == null then \"\" else ((.body | capture(\"sha=(?<s>[0-9a-f]{7,40})\").s) + \" \" + ((.created_at // \"\") | fromdateiso8601? // 0 | tostring)) end" 2>/dev/null) \
  || err "review comments unparseable"
ROUTE_SHA="${ROUTE%% *}"; ROUTE_AT="${ROUTE##* }"; REVIEW_PENDING=false
if [ -n "$ROUTE_SHA" ]; then
  case "$ROUTE_AT" in ''|*[!0-9]*) ROUTE_AT=0 ;; esac
  VERDICTS=$(printf '%s' "$PR_COMMENTS" | jq -rs --arg r "$ROUTE_SHA" "[.[][] | select($TRUST) | select((.body // \"\") | test(\"^<!-- FORGE:REVIEW-(AGENT:[a-z-]+|CARRIED) -->\")) | ((.body | capture(\"(^|\\\\n)Reviewed-SHA: (?<s>[0-9a-f]{7,40})\")? // {s: \"\"}).s) as \$s | select(\$s != \"\" and ((\$r | startswith(\$s)) or (\$s | startswith(\$r))))] | length" 2>/dev/null) || err "reviewer comments unreadable"
  [ "${VERDICTS:-0}" -eq 0 ] && [ "$ROUTE_AT" -gt 0 ] && [ $(( NOW_S - ROUTE_AT )) -lt "$REVIEW_PENDING_MAX_S" ] && REVIEW_PENDING=true
fi

if [ "$LEASE_LIVE" != "true" ] && [ "$REVIEW_PENDING" != "true" ]; then
  FORGE_REPO="${FORGE_REPO:-$REPO}" FORGE_ISSUE="${FORGE_ISSUE:-$ISSUE}" FORGE_PR="${FORGE_PR:-$PR}" forge_emit liveness decision=PROCEED why=dead
  echo "LIVENESS: DEAD"; exit 0
fi

PRIOR=$(printf '%s' "$ISSUE_COMMENTS" | jq -rs --arg pr "pr=$PR" "[.[][] | select($TRUST) | select((.body // \"\") | startswith(\"<!-- FORGE:REMEDIATION_DEFERRED -->\")) | select((.body | split(\"\\n\") | index(\$pr)) != null)] | length" 2>/dev/null) || err "deferral records unreadable"
if [ "${PRIOR:-0}" -ge "$MAX_DEFERRALS" ]; then FORGE_REPO="${FORGE_REPO:-$REPO}" FORGE_ISSUE="${FORGE_ISSUE:-$ISSUE}" FORGE_PR="${FORGE_PR:-$PR}" forge_emit liveness decision=EXHAUSTED why=deferrals-${PRIOR}
  echo "LIVENESS: EXHAUSTED ${PRIOR}"; exit 11; fi

if [ "$LEASE_LIVE" = "true" ]; then KIND=lease; DETAIL="lease held by ${LEASE_BY} until ${LEASE_UNTIL}"
else KIND=review; DETAIL="re-review of ${ROUTE_SHA} has no reviewer verdicts yet"; fi
BODY="<!-- FORGE:REMEDIATION_DEFERRED -->
## Remediation Deferred

PR #${PR}: an earlier remediation run is still live. This run changed nothing (deferral $(( ${PRIOR:-0} + 1 )) of ${MAX_DEFERRALS}).

pr=${PR}
kind=${KIND}
lease_by=${LEASE_BY:-none}
lease_until=${LEASE_UNTIL}"
if [ -n "${DRY_RUN:-}" ]; then printf 'DRY_RUN: would post:\n%s\n' "$BODY"
else gh issue comment "$ISSUE" -R "$REPO" --body "$BODY" >/dev/null 2>&1 || err "could not post deferral record"; fi
FORGE_REPO="${FORGE_REPO:-$REPO}" FORGE_ISSUE="${FORGE_ISSUE:-$ISSUE}" FORGE_PR="${FORGE_PR:-$PR}" forge_emit liveness decision=DEFER why="$KIND"
echo "LIVENESS: DEFER ${KIND} ${DETAIL}"; exit 10
