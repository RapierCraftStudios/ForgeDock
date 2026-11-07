#!/usr/bin/env bash
# file-deferred-followups.sh — file the deferred out-of-lane items of one build into the batch AGGREGATES (never a per-parent issue).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# #5207: engineering work is never deferred. A row of class engineering or backlog (an explicit class, `[bucket:new-issue]`, or
# a why with no class prefix) is rejected (stderr `engineering deferral: build it in-lane (#5207)`, DEFERRED_TSV=INVALID, exit 2,
# nothing filed): the lane builds it. What remains goes to ONE of three aggregates, never to a per-parent follow-up:
#   post-deploy (and verify-now, date, owner:orchestrator / owner:promote / post-promotion text) -> the release-lane rollup,
#     found by `<!-- FORGE:POSTDEPLOY_ROLLUP: <lane> -->` (or the lowest open trusted issue labelled FORGE_ROLLUP_LABEL,
#     forge.yaml followups.rollup_issue_label); env FORGE_RELEASE_LANE (default `default`), FORGE_RELEASE_SHA (informational).
#   external and ops (credentials, spend, an account, a third party or a customer) -> ONE aggregate per batch, found by
#     `<!-- FORGE:EXTERNAL_BATCH: <FORGE_BATCH_ID or adhoc> -->` (labels followup:external, external-prerequisite, needs-human).
#   host (read-only production data or capture, work needed before promotion) -> ONE host aggregate per batch, found by
#     `<!-- FORGE:HOST_BATCH: <batch> -->` (labels followup:host + host-task, never needs-human, #5078).
# Every lane appends its items under a `### #<root parent>` heading (a follow-up of a follow-up is filed under the root parent),
# deduplicated on normalized text across parents; the lowest open trusted aggregate is canonical (a concurrent duplicate is closed).
# Existing per-parent follow-ups (`FORGE:DEFERRED_FROM`) of older runs are never read, edited, reopened or closed here (no migration).
#
# Usage: file-deferred-followups.sh --parent N --repo OWNER/REPO [--items FILE|-] [--folded N]
#   items TSV, one per line: <path|-> TAB <why> TAB <known-flaw flag: known-flaw|1|yes|true, else empty> [TAB <class> [TAB <label>]]
#   Column 1 must look like a path (any legal path characters; spaced values need a `/` or extension) or be `-` (a requirement-level item): requirement text or an `R<n>:` prefix there is a usage
#   error (exit 2, DEFERRED_TSV=INVALID, nothing filed). The label (default: the path) is the item's identity in the checklist
#   and in the stdout rows; repeated `R<n>: R<m>:` prefixes in it collapse to the first. Class: column 4, else the why's
#   `post-deploy:|external:|ops:|host:` prefix, else engineering (rejected).
#   #4724 buckets: a why carrying `[bucket:<kind>]` is routed by it (#5078): `owner` is class external only for credentials, spend,
#   an account, a third party or a customer; `owner: orchestrator`, `owner: promote...` and post-promotion text join the rollup and
#   read-only production data or capture is class host; `host` post-promotion text joins the rollup (#5186).
#   A post-deploy why starts `post-deploy: [check:<id>] ...` (#4626); the token is kept verbatim in the checklist line.
# Env: DRY_RUN (non-empty: no create/edit, issue number 0), FORGE_TRAIL_TRUSTED_ASSOCIATIONS (default
#      OWNER,MEMBER,COLLABORATOR), FORGE_TRAIL_TRUSTED_LOGINS (default empty), FORGE_DEFERRED_RETRY_SLEEP (secs),
#      FORGE_FOLLOWUP_MILESTONE (the parent's milestone title; default: read from the parent), FORGE_FOLLOWUPS_DEFAULT_MILESTONE
#      (forge.yaml followups.default_milestone; a shipped milestone moves to the next open one), FORGE_EXTERNAL_PREREQ (issue number
#      the external aggregate links to), FORGE_BATCH_ID.
# Stdout: `identity<TAB>issue` per item, then DEFERRED_TELEMETRY deferred_items=N folded=N batched_into=#M[,#M2] filed=N classes=a,b buckets=kind:N,...
# Exit: 0 ok | 2 usage or malformed TSV row | 3 lookup failed (DEFERRED_LOOKUP=FAILED) | 4 create/append failed (DEFERRED_FILE=FAILED).
# A failed lookup is never "none found". bash 3.2 portable.

set -uo pipefail

PARENT=""; REPO=""; ITEMS="-"; FOLDED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --parent|--repo|--items|--folded)
      [ $# -ge 2 ] || { echo "file-deferred-followups: $1 requires a value" >&2; exit 2; }
      case "$1" in --parent) PARENT="$2" ;; --repo) REPO="$2" ;; --items) ITEMS="$2" ;; --folded) FOLDED="$2" ;; esac
      shift 2 ;;
    *) echo "usage: file-deferred-followups.sh --parent N --repo OWNER/REPO [--items FILE|-] [--folded N]" >&2; exit 2 ;;
  esac
done
case "$PARENT" in ''|*[!0-9]*) echo "file-deferred-followups: --parent must be a number" >&2; exit 2 ;; esac
case "$FOLDED" in ''|*[!0-9]*) FOLDED=0 ;; esac
[ -n "$REPO" ] || { echo "file-deferred-followups: --repo required" >&2; exit 2; }
if [ "$ITEMS" != "-" ] && [ ! -f "$ITEMS" ]; then echo "file-deferred-followups: items file not found: $ITEMS" >&2; exit 2; fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/deferred-followups.XXXXXX") || exit 2
trap 'rm -rf "$TMP"' EXIT
if [ "$ITEMS" = "-" ]; then cat > "$TMP/items.raw"; else cat "$ITEMS" > "$TMP/items.raw"; fi

# Normalise: validate each row, drop blank lines and duplicate identities (first wins), strip backticks.
# Internal file uses a non-whitespace separator (US, \x1f): a tab IFS collapses an empty `why` and drops the known-flaw flag.
# Fields: identity, why, flag, path (`-` when none), class.
SEP=$(printf '\037')
CLASSES="engineering post-deploy external ops verify-now host backlog"
# #5078/#5186/#5197: routing of an owner or host item (post-deploy rollup, host task, external) has ONE source: ownerRoute and
# hostRoute in bin/lean/conformance.mjs, reached through scripts/followup-route.mjs. No regex is mirrored here. A missing node
# or route CLI aborts the run (exit 2) rather than guessing a route.
ROUTE_CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/followup-route.mjs"
[ -f "$ROUTE_CLI" ] || { echo "file-deferred-followups: route helper not found: $ROUTE_CLI" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "file-deferred-followups: node is required for routing" >&2; exit 2; }
route() { # kind why -> route (aborts the run on failure)
  local out; out=$(node "$ROUTE_CLI" "$1" "$2") || { echo "file-deferred-followups: routing failed for kind $1" >&2; exit 2; }
  printf '%s' "$out"
}
owner_route() { # why -> post-deploy | host | external
  case "$1" in "owner: orchestrator"*|"owner: promote"*) echo "post-deploy"; return 0 ;; esac
  route owner "$1"
}
host_route() { route host "$1"; } # why -> post-deploy | host
: > "$TMP/items"
BAD=0; ROW=0
bad_row() { BAD=$((BAD+1)); echo "file-deferred-followups: row $ROW: $1" >&2; }
while IFS= read -r line || [ -n "$line" ]; do
  ROW=$((ROW+1))
  # Split on TAB by hand: `IFS=$'\t' read` would collapse an empty field and shift the flag into it.
  f=(); rest="$line"; i=0
  while [ $i -lt 5 ]; do
    case "$rest" in *$'\t'*) f[$i]="${rest%%$'\t'*}"; rest="${rest#*$'\t'}" ;; *) f[$i]="$rest"; rest="" ;; esac
    i=$((i+1))
  done
  trim() { printf '%s' "${1:-}" | tr -d '`' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }
  p=$(trim "${f[0]}"); w="${f[1]}"; k="${f[2]}"; c=$(trim "${f[3]}"); lab=$(trim "${f[4]}")
  [ -n "$p" ] || [ -n "$lab" ] || continue
  # Column 1: a path or the literal `-`. Requirement text (spaces, an `R<n>:` prefix) belongs in the label column.
  if [ "$p" != "-" ]; then
    if printf '%s' "$p" | grep -qE '^R[0-9]+:'; then bad_row "column 1 starts with a requirement id (\`$p\`); put it in the label column and use \`-\` or a path"; continue; fi
    # Legal path characters (parentheses, =, #, :, ...) pass. Reject control chars, and whitespace values that are prose:
    # a spaced path needs a `/` or a file extension (`docs/My Notes.md`); `add a saved mapping` has neither.
    if printf '%s' "$p" | LC_ALL=C grep -q '[[:cntrl:]]'; then bad_row "column 1 is not a path (\`$p\`)"; continue; fi
    if [[ "$p" =~ [[:space:]] ]] && ! [[ "$p" == */* || "$p" =~ \.[A-Za-z0-9]+$ ]]; then bad_row "column 1 is not a path (\`$p\`)"; continue; fi
  fi
  # Identity: the label, else the path. Repeated `R1: R2:` prefixes collapse to the first.
  id="${lab:-$p}"
  while [[ "$id" =~ ^(R[0-9]+:)[[:space:]]*R[0-9]+:[[:space:]]*(.*)$ ]]; do id="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"; done
  if [ "$id" = "-" ]; then bad_row "no path and no label"; continue; fi
  w=$(printf '%s' "$w" | tr '\r\n' '  ')
  if [ -z "$c" ]; then
    case "$w" in post-deploy:*) c="post-deploy" ;; external:*) c="external" ;; ops:*) c="ops" ;; host:*) c="host" ;; *) c="engineering" ;; esac
  fi
  case " $CLASSES " in *" $c "*) ;; *) bad_row "unknown class \`$c\` (post-deploy|external|ops|host)"; continue ;; esac
  # #4724: the bucket token decides the class: owner actions never join the post-deploy rollup.
  case "$w" in
    *"[bucket:owner]"*) [ "$c" = "ops" ] || c=$(owner_route "$w") || exit 2 ;;
    *"[bucket:host]"*) c=$(host_route "$w") || exit 2 ;;
    *"[bucket:new-issue]"*) c="engineering" ;; # #5207: in-lane work, rejected below
    *"[bucket:verify-now]"*) case "$c" in engineering|verify-now) c="post-deploy" ;; esac ;;
  esac
  [ "$c" = "verify-now" ] && c="post-deploy" # #5207: verify-now joins the rollup (no per-parent issue)
  # #5207: engineering work is built in-lane, never deferred into an issue.
  case "$c" in engineering|backlog) bad_row "engineering deferral: build it in-lane (#5207) (\`$id\`)"; continue ;; esac
  if cut -d "$SEP" -f1 "$TMP/items" | grep -qxF -- "$id"; then continue; fi
  case "${k:-}" in known-flaw|1|yes|true) k="known-flaw" ;; *) k="" ;; esac
  printf '%s%s%s%s%s%s%s%s%s\n' "$id" "$SEP" "$w" "$SEP" "$k" "$SEP" "${p:--}" "$SEP" "$c" >> "$TMP/items"
done < "$TMP/items.raw"
if [ "$BAD" -gt 0 ]; then echo "DEFERRED_TSV=INVALID"; exit 2; fi
TOTAL=$(wc -l < "$TMP/items" | tr -d ' ')

TRUSTED_ASSOC="${FORGE_TRAIL_TRUSTED_ASSOCIATIONS-OWNER,MEMBER,COLLABORATOR}"
TRUSTED_LOGINS="${FORGE_TRAIL_TRUSTED_LOGINS-}"

finish() { # $1 = batched_into numbers (space separated) or empty, $2 = filed count
  local into="none" bare="none"
  if [ -n "$1" ]; then into=$(printf '%s\n' $1 | sed 's/^/#/' | paste -sd, -); bare=$(printf '%s\n' $1 | paste -sd, -); fi
  local cls; cls=$(cut -d "$SEP" -f5 "$TMP/items" | sort -u | paste -sd, -)
  local bks; bks=$(awk -F"$SEP" '{ b = "none"; if (match($2, /\[bucket:[a-z-]+\]/)) b = substr($2, RSTART + 8, RLENGTH - 9); n[b]++ } END { for (b in n) printf "%s:%d\n", b, n[b] }' "$TMP/items" | sort | paste -sd, -)
  local line="DEFERRED_TELEMETRY deferred_items=${TOTAL} folded=${FOLDED} batched_into=${into} filed=$2 classes=${cls:-none} buckets=${bks:-none}"
  echo "$line"
  # #3834 emitter (scripts/lib/telemetry.sh): optional, never blocks, never changes stdout or the exit code.
  local d; d=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [ -f "$d/lib/telemetry.sh" ]; then
    FORGE_ISSUE="${FORGE_ISSUE:-$PARENT}" FORGE_REPO="${FORGE_REPO:-$REPO}" \
      bash "$d/lib/telemetry.sh" deferred_followups deferred_items="$TOTAL" folded="$FOLDED" \
      batched_into="$bare" filed="$2" classes="${cls:-none}" buckets="${bks:-none}" >/dev/null 2>&1 </dev/null || true
  fi
}

# --- Trusted author predicate (applied before any marker match) -------------------------------------------------------
JQ_PRE='def lst: split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0));
  def trusted: ((.author_association // "") as $x | ($assoc | lst) | index($x) != null)
    or ((.user.type // "") == "Bot")
    or ((.user.login // "") as $x | ($logins | lst) | index($x) != null);'
# --- #4724: the post-deploy rollup: ONE open issue per release lane, found by marker (not by parent) ------------------
# #5078: the same shape holds every external item of one batch (`FORGE:EXTERNAL_BATCH: <batch>`), and the rollup may also
# be a repo's own open issue carrying forge.yaml `followups.rollup_issue_label` (FORGE_ROLLUP_LABEL) when no marked one is open.
RELEASE_LANE="${FORGE_RELEASE_LANE:-default}"
ROLLUP_MARKER="<!-- FORGE:POSTDEPLOY_ROLLUP: ${RELEASE_LANE} -->"
BATCH="${FORGE_BATCH_ID:-adhoc}"
EXTERNAL_MARKER="<!-- FORGE:EXTERNAL_BATCH: ${BATCH} -->"
ROLLUP_LABEL="${FORGE_ROLLUP_LABEL:-}"
HOST_MARKER="<!-- FORGE:HOST_BATCH: ${BATCH} -->"
agg_marker() { case "$1" in post-deploy) printf '%s' "$ROLLUP_MARKER" ;; host) printf '%s' "$HOST_MARKER" ;; *) printf '%s' "$EXTERNAL_MARKER" ;; esac; }
verify_rollup() { # number [marker] -> `number<TAB>open` when a trusted, open, non-PR issue carries the marker
  local out rc m="${2:-$ROLLUP_MARKER}"
  out=$(gh api "repos/${REPO}/issues/$1" 2>"$TMP/verr"); rc=$?
  if [ "$rc" -ne 0 ]; then grep -qE '404|Not Found|410' "$TMP/verr" 2>/dev/null && return 0; return 1; fi
  printf '%s' "$out" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg m "$m" "$JQ_PRE"'
      select(.pull_request == null) | select(trusted) | select(.state == "open") | select((.body // "") | contains($m))
      | "\(.number)\t\(.state)"' 2>/dev/null
}
verify_labelled() { # number -> `number<TAB>open` when a trusted, open, non-PR issue carries label $ROLLUP_LABEL
  local out rc
  out=$(gh api "repos/${REPO}/issues/$1" 2>"$TMP/verr"); rc=$?
  if [ "$rc" -ne 0 ]; then grep -qE '404|Not Found|410' "$TMP/verr" 2>/dev/null && return 0; return 1; fi
  printf '%s' "$out" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg l "$ROLLUP_LABEL" "$JQ_PRE"'
      select(.pull_request == null) | select(trusted) | select(.state == "open") | select(any(.labels[]?; (.name // .) == $l))
      | "\(.number)\t\(.state)"' 2>/dev/null
}
find_aggregate() { # kind (post-deploy|external|host) ; sets CANON/CSTATE to the lowest open one; non-zero only when a lookup failed
  local kind="$1" m q cands n r
  CANON=""; CSTATE=""
  m=$(agg_marker "$kind"); q="${m#<!-- }"; q="${q% -->}"
  cands=$(gh api -X GET search/issues -f per_page=50 -f q="\"${q}\" in:body repo:${REPO} is:issue is:open" 2>/dev/null \
    | jq -r '[.items[].number] | sort | .[]' 2>/dev/null) || return 1
  for n in $cands; do
    r=$(verify_rollup "$n" "$m") || return 1
    if [ -n "$r" ]; then CANON="${r%%$'\t'*}"; CSTATE="${r#*$'\t'}"; return 0; fi
  done
  [ "$kind" = "post-deploy" ] && [ -n "$ROLLUP_LABEL" ] || return 0
  cands=$(gh api -X GET search/issues -f per_page=50 -f q="label:\"${ROLLUP_LABEL}\" repo:${REPO} is:issue is:open" 2>/dev/null \
    | jq -r '[.items[].number] | sort | .[]' 2>/dev/null) || return 1
  for n in $cands; do
    r=$(verify_labelled "$n") || return 1
    if [ -n "$r" ]; then CANON="${r%%$'\t'*}"; CSTATE="${r#*$'\t'}"; return 0; fi
  done
  return 0
}
find_rollup() { find_aggregate post-deploy; }
# The root parent: a parent that is itself a follow-up (or the rollup) files its items under the parent it came from.
ROOT="$PARENT"
resolve_root() {
  local pb first
  pb=$(gh api "repos/${REPO}/issues/${PARENT}" 2>/dev/null | jq -r '.body // ""' 2>/dev/null) || return 0
  first=$(printf '%s' "$pb" | grep -oE 'FORGE:DEFERRED_FROM: #[0-9]+' | head -n 1 | grep -oE '[0-9]+$')
  [ -n "$first" ] && ROOT="$first"
  return 0
}
norm() { # normalized item text: no `R<n>:` prefix, lower case, punctuation and spacing collapsed (dedup across lanes)
  printf '%s' "$1" | sed -E 's/^R[0-9]+:[[:space:]]*//' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' ' ' | tr -s ' ' | sed -E 's/^ //; s/ $//'
}
# Keep only the items of $1 whose normalized text is not yet in $2 (a body); the kept ones are appended to "$TMP/add".
rollup_missing() { # items-file body-file
  local p w k fp cl n
  : > "$TMP/add"; : > "$TMP/have"
  grep -E '^- \[[ xX]\] `' "$2" 2>/dev/null | sed -E 's/^- \[[ xX]\] `([^`]*)`.*/\1/' | while IFS= read -r l; do norm "$l"; echo; done > "$TMP/have"
  while IFS="$SEP" read -r p w k fp cl; do
    n=$(norm "$p")
    grep -qxF -- "$n" "$TMP/have" && continue
    entry "$p" "$w" "$k" >> "$TMP/add"; printf '%s\n' "$n" >> "$TMP/have"
  done < "$1"
}
rollup_append() { # number ; non-zero = failure
  local num="$1"
  gh api "repos/${REPO}/issues/${num}" --jq '.body // ""' > "$TMP/body" 2>/dev/null || return 1
  rollup_missing "$ITEMS_F" "$TMP/body"
  [ -s "$TMP/add" ] || return 0
  awk -v h="### #${ROOT}" -v root="$ROOT" -v addf="$TMP/add" '
    BEGIN { while ((getline l < addf) > 0) add = add l "\n" }
    { if (insec && $0 ~ /^### /) { printf "%s\n", add; insec = 0; done = 1 } if ($0 == h) insec = 1; print }
    END { if (insec) printf "%s", add; else if (!done) printf "\n%s\n<!-- FORGE:DEFERRED_FROM: #%s -->\n\n%s", h, root, add }' "$TMP/body" > "$TMP/newbody"
  if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: gh issue edit $num (append $(wc -l < "$TMP/add" | tr -d ' ') item(s) under #${ROOT})" >&2
  else gh issue edit "$num" -R "$REPO" --body-file "$TMP/newbody" >/dev/null 2>&1 || return 1; fi
  return 0
}
file_rollup() { # items in $ITEMS_F, aggregate $CLS (post-deploy: the release-lane rollup; external: the batch aggregate, #5078; host: the batch host aggregate, #5207); sets FILED_N, FILED_NEW
  local n_items; n_items=$(wc -l < "$ITEMS_F" | tr -d ' ')
  local m title what lbls
  FILED_N=""; FILED_NEW=0
  resolve_root
  CANON=$(cut -f1 "$TMP/canon.$CLS")
  if [ -n "$CANON" ]; then
    rollup_append "$CANON" || { echo "DEFERRED_FILE=FAILED"; exit 4; }
    FILED_N="$CANON"; return 0
  fi
  m=$(agg_marker "$CLS")
  if [ "$CLS" = "post-deploy" ]; then
    title="post-deploy: release checklist (${RELEASE_LANE})"; what="post-deploy rollup ${RELEASE_LANE}"; lbls="followup:post-deploy"
  elif [ "$CLS" = "host" ]; then
    title="host: tasks of batch ${BATCH}"; what="host aggregate of batch ${BATCH}"; lbls="followup:host host-task"
  else
    title="external: prerequisites of batch ${BATCH}"; what="external aggregate of batch ${BATCH}"; lbls="followup:external external-prerequisite needs-human"
  fi
  : > "$TMP/body"; rollup_missing "$ITEMS_F" "$TMP/body"
  {
    if [ "$CLS" = "post-deploy" ]; then
      printf '## Problem\n\nPost-deploy checklist of release lane `%s`%s. Every merged lane appends its post-deploy items under a `### #<parent>` heading (deduplicated), so one read-only verification works through this one issue per release.\n\n' "$RELEASE_LANE" "${FORGE_RELEASE_SHA:+ (deploy target at $FORGE_RELEASE_SHA)}"
    elif [ "$CLS" = "host" ]; then
      printf '## Problem\n\nHost tasks of batch `%s`: every item below is work the host can run (read-only production data or capture) before promotion. Every lane of the batch appends its items under a `### #<parent>` heading (deduplicated), so the batch has ONE host issue.\n\n' "$BATCH"
    else
      printf '## Problem\n\nExternal prerequisites of batch `%s`: every item below waits on something outside the repo (credentials, spend, an account, a third party or a customer). Every lane of the batch appends its items under a `### #<parent>` heading (deduplicated), so the batch has ONE external issue.' "$BATCH"
      [ -n "${FORGE_EXTERNAL_PREREQ:-}" ] && printf ' Linked prerequisite: #%s.' "${FORGE_EXTERNAL_PREREQ#\#}"
      printf '\n\n'
    fi
    printf '## Acceptance Criteria\n\n### #%s\n<!-- FORGE:DEFERRED_FROM: #%s -->\n\n' "$ROOT" "$ROOT"
    cat "$TMP/add"
    printf '\n%s\n<!-- FORGE:DEFERRED_CLASS: %s -->\n' "$m" "$CLS"
  } > "$TMP/newissue"
  local NUM
  if [ -n "${DRY_RUN:-}" ]; then
    echo "DRY_RUN: gh issue create (${what}: ${n_items} item(s) from #${PARENT})" >&2
    NUM=0
  else
    resolve_milestone
    local args=() URL l
    for l in $lbls; do
      case "$l" in
        needs-human) gh label create "$l" -R "$REPO" --color D93F0B --description "Needs a human decision or action." >/dev/null 2>&1 || true ;; # never --force: the repo's own label wins
        external-prerequisite) gh label create "$l" -R "$REPO" --force --color E99695 --description "External prerequisite. Managed by ForgeDock." >/dev/null 2>&1 || true ;;
        host-task) gh label create "$l" -R "$REPO" --color 0E8A16 --description "Work the host can run (read-only production access)." >/dev/null 2>&1 || true ;;
        *) gh label create "$l" -R "$REPO" --force --color BFD4F2 --description "Deferred follow-up (${CLS}). Managed by ForgeDock." >/dev/null 2>&1 || true ;;
      esac
      args+=(--label "$l")
    done
    [ -n "$MS_TITLE" ] && args+=(--milestone "$MS_TITLE")
    URL=$(gh issue create -R "$REPO" --title "$title" --body-file "$TMP/newissue" "${args[@]}" 2>/dev/null) || URL=""
    NUM=$(printf '%s' "$URL" | grep -oE '[0-9]+$' | tail -n 1)
    [ -n "$NUM" ] || { echo "DEFERRED_FILE=FAILED"; exit 4; }
    if [ "$CLS" = "external" ]; then # the parent's claim marker, as for a per-parent follow-up (best effort)
      gh issue comment "$PARENT" -R "$REPO" --body "<!-- FORGE:DEFERRED_ISSUE: #${NUM} class=external -->" >/dev/null 2>&1 \
        || echo "file-deferred-followups: warning: could not post claim marker for #${NUM} on #${PARENT}" >&2
    fi
    # Post-create re-check: a concurrent lane may have filed first. The lowest open one is canonical; the newer one is closed.
    if find_aggregate "$CLS"; then
      if [ -n "$CANON" ] && [ "$CANON" -lt "$NUM" ]; then
        if rollup_append "$CANON"; then
          gh issue close "$NUM" -R "$REPO" --reason "not planned" --comment "Duplicate of #${CANON}: the ${what} items are tracked there." >/dev/null 2>&1 \
            || echo "file-deferred-followups: warning: could not close duplicate #${NUM}" >&2
          NUM="$CANON"
        else
          echo "file-deferred-followups: warning: could not move items to #${CANON}; keeping #${NUM}" >&2
        fi
      fi
    else
      echo "file-deferred-followups: warning: post-create re-check failed; keeping #${NUM}" >&2
    fi
  fi
  FILED_N="$NUM"; FILED_NEW=1
}

# #5207: the aggregate of each class: ops shares the external batch aggregate.
agg_of() { case "$1" in ops) echo external ;; *) echo "$1" ;; esac; }
CLS_LIST=$(cut -d "$SEP" -f5 "$TMP/items" | while IFS= read -r c; do agg_of "$c"; done | sort -u)
CLS=""
# Phase 1: look up the canonical aggregate of every kind before filing anything (a failed lookup files nothing).
for CLS in $CLS_LIST; do
  LOOKUP_OK=""
  for attempt in 1 2; do
    if find_aggregate "$CLS"; then LOOKUP_OK=1; break; fi
    [ "$attempt" = 1 ] && sleep "${FORGE_DEFERRED_RETRY_SLEEP:-2}"
  done
  if [ -z "$LOOKUP_OK" ]; then
    echo "DEFERRED_LOOKUP=FAILED"
    exit 3
  fi
  printf '%s\t%s\n' "$CANON" "$CSTATE" > "$TMP/canon.$CLS"
  awk -F"$SEP" -v c="$CLS" '$5 == c || (c == "external" && $5 == "ops")' "$TMP/items" > "$TMP/items.$CLS"
done

# Checklist line for one item. Path always backticked so review-pr 6B.5 `contains` verification holds.
entry() { # path why flag
  local l="- [ ] \`$1\`"
  [ -n "$3" ] && l="$l **known-flaw**"
  [ -n "$2" ] && l="$l — $2"
  printf '%s\n' "$l"
}
MS_DONE=""; MS_TITLE=""
resolve_milestone() { # sets MS_TITLE (empty = none): the parent's milestone, or for a shipped one the next open milestone, else the configured default
  [ -n "$MS_DONE" ] && return 0
  MS_DONE=1; MS_TITLE=""
  local t="${FORGE_FOLLOWUP_MILESTONE:-}" all
  if [ -z "$t" ]; then t=$(gh api "repos/${REPO}/issues/${PARENT}" --jq '.milestone.title // ""' 2>/dev/null) || t=""; fi
  [ -n "$t" ] || return 0
  all=$(gh api "repos/${REPO}/milestones?state=all&per_page=100" 2>/dev/null) || { MS_TITLE="$t"; return 0; }
  MS_TITLE=$(printf '%s' "$all" | jq -r --arg t "$t" --arg d "${FORGE_FOLLOWUPS_DEFAULT_MILESTONE:-}" '
    . as $all | ($all | map(select(.title == $t)) | first // null) as $cur
    | if $cur == null or $cur.state == "open" then $t
      else (($all | map(select(.state == "open" and .due_on != null and ($cur.due_on == null or .due_on > $cur.due_on))) | sort_by(.due_on) | (first // {}) | .title // "") as $next
            | if $next != "" then $next elif ($d != "" and ($all | map(select(.title == $d and .state == "open")) | length) > 0) then $d else "" end) end' 2>/dev/null) || MS_TITLE="$t"
}

[ "$TOTAL" -gt 0 ] || { finish "" 0; exit 0; }

# Phase 2: one aggregate per kind.
INTO=""; FILED=0
for CLS in $CLS_LIST; do
  ITEMS_F="$TMP/items.$CLS"
  file_rollup
  case " $INTO " in *" $FILED_N "*) ;; *) INTO="${INTO:+$INTO }$FILED_N" ;; esac
  FILED=$((FILED + FILED_NEW))
  while IFS="$SEP" read -r p w k fp cl; do printf '%s\t%s\n' "$p" "$FILED_N"; done < "$ITEMS_F"
done
finish "$INTO" "$FILED"
exit 0
