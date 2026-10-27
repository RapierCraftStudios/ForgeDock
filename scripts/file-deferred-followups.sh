#!/usr/bin/env bash
# file-deferred-followups.sh — file the deferred out-of-scope items of one build as ONE follow-up issue per class.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The builder decides fold-vs-defer (judgment, build.md B2.0); this script does the mechanics for the items
# that stay deferred: trusted lookup (claim marker <!-- FORGE:DEFERRED_ISSUE: #M --> on the parent, then a state-all search) of a follow-up carrying
# <!-- FORGE:DEFERRED_FROM: #N -->, append the missing items (exact path match; a closed one is reopened), or create ONE issue
# with a checklist, claim it on the parent and re-check once for a concurrent lower-numbered duplicate.
# Items are grouped by class (engineering | post-deploy | external | ops, #4664): one follow-up per class per parent, each
# labelled `followup:<class>`, carrying `<!-- FORGE:DEFERRED_CLASS: <class> -->` (absent = engineering, for older issues) and the
# parent's milestone (a shipped/closed one: the next open milestone by due date, else FORGE_FOLLOWUPS_DEFAULT_MILESTONE).
#
# Usage: file-deferred-followups.sh --parent N --repo OWNER/REPO [--items FILE|-] [--folded N]
#   items TSV, one per line: <path|-> TAB <why> TAB <known-flaw flag: known-flaw|1|yes|true, else empty> [TAB <class> [TAB <label>]]
#   Column 1 must look like a path or be `-` (a requirement-level item): requirement text or an `R<n>:` prefix there is a usage
#   error (exit 2, DEFERRED_TSV=INVALID, nothing filed). The label (default: the path) is the item's identity in the checklist
#   and in the stdout rows; repeated `R<n>: R<m>:` prefixes in it collapse to the first. Class: column 4, else the why's
#   `post-deploy:|external:|ops:` prefix, else engineering.
#   #4724 buckets: a why carrying `[bucket:<kind>]` is routed by it: `owner` is always class external (never the rollup),
#   `new-issue` engineering, `verify-now` (the parent is already on the default branch) its own per-parent follow-up class
#   `verify-now` that the gate releases at once, and `post-deploy`/`date` go to the ONE open rollup of the release lane.
#   The rollup (class post-deploy) is found by `<!-- FORGE:POSTDEPLOY_ROLLUP: <lane> -->`, not by parent: every lane appends
#   its items under a `### #<root parent>` heading (a follow-up of a follow-up is filed under the root parent), deduplicated
#   on normalized text across parents. Env: FORGE_RELEASE_LANE (the deploy lane, default `default`), FORGE_RELEASE_SHA (informational).
#   A post-deploy why starts `post-deploy: [check:<id>] ...` (#4626); the token is kept verbatim in the checklist line.
# Env: DRY_RUN (non-empty: no create/edit, issue number 0), FORGE_TRAIL_TRUSTED_ASSOCIATIONS (default
#      OWNER,MEMBER,COLLABORATOR), FORGE_TRAIL_TRUSTED_LOGINS (default empty), FORGE_DEFERRED_RETRY_SLEEP (secs),
#      FORGE_FOLLOWUP_MILESTONE (the parent's milestone title; default: read from the parent), FORGE_FOLLOWUPS_DEFAULT_MILESTONE
#      (forge.yaml followups.default_milestone), FORGE_EXTERNAL_PREREQ (issue number an external follow-up links to).
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
CLASSES="engineering post-deploy external ops verify-now"
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
    if ! printf '%s' "$p" | grep -qE '^[][A-Za-z0-9_.@~/*{}+,-]+$'; then bad_row "column 1 is not a path (\`$p\`)"; continue; fi
  fi
  # Identity: the label, else the path. Repeated `R1: R2:` prefixes collapse to the first.
  id="${lab:-$p}"
  while [[ "$id" =~ ^(R[0-9]+:)[[:space:]]*R[0-9]+:[[:space:]]*(.*)$ ]]; do id="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"; done
  if [ "$id" = "-" ]; then bad_row "no path and no label"; continue; fi
  w=$(printf '%s' "$w" | tr '\r\n' '  ')
  if [ -z "$c" ]; then
    case "$w" in post-deploy:*) c="post-deploy" ;; external:*) c="external" ;; ops:*) c="ops" ;; *) c="engineering" ;; esac
  fi
  case " $CLASSES " in *" $c "*) ;; *) bad_row "unknown class \`$c\` (engineering|post-deploy|external|ops)"; continue ;; esac
  # #4724: the bucket token decides the class: owner actions never join the post-deploy rollup, verify-now needs no release.
  case "$w" in
    *"[bucket:owner]"*) [ "$c" = "ops" ] || c="external" ;;
    *"[bucket:new-issue]"*) [ "$c" = "post-deploy" ] && c="engineering" ;;
    *"[bucket:verify-now]"*) [ "$c" = "post-deploy" ] && c="verify-now" ;;
  esac
  if cut -d "$SEP" -f1 "$TMP/items" | grep -qxF -- "$id"; then continue; fi
  case "${k:-}" in known-flaw|1|yes|true) k="known-flaw" ;; *) k="" ;; esac
  printf '%s%s%s%s%s%s%s%s%s\n' "$id" "$SEP" "$w" "$SEP" "$k" "$SEP" "${p:--}" "$SEP" "$c" >> "$TMP/items"
done < "$TMP/items.raw"
if [ "$BAD" -gt 0 ]; then echo "DEFERRED_TSV=INVALID"; exit 2; fi
TOTAL=$(wc -l < "$TMP/items" | tr -d ' ')

MARKER="<!-- FORGE:DEFERRED_FROM: #${PARENT} -->"
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

# --- Trusted lookup (author predicate applied before path match), one retry ---------------------------------
# Sources, in order: (1) claim markers `<!-- FORGE:DEFERRED_ISSUE: #M -->` on the parent's REST comments (read-after-write
# consistent), (2) a search over ALL issue states (eventually consistent, so only a fallback). Every candidate is then
# verified by number over REST (trusted author, DEFERRED_FROM marker, not a PR); the lowest number is canonical.
JQ_PRE='def lst: split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0));
  def trusted: ((.author_association // "") as $x | ($assoc | lst) | index($x) != null)
    or ((.user.type // "") == "Bot")
    or ((.user.login // "") as $x | ($logins | lst) | index($x) != null);'
CLAIM_RE='^\s*<!-- FORGE:DEFERRED_ISSUE: #(?<n>[0-9]+)(?: class=[a-z-]+)? -->'
claim_nums() {
  gh api --paginate "repos/${REPO}/issues/${PARENT}/comments" 2>/dev/null \
  | jq -s -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg re "$CLAIM_RE" "$JQ_PRE"'
      [.[][] | select(trusted) | (.body // "") | capture($re) | .n | tonumber] | unique | .[]' 2>/dev/null
}
search_nums() {
  gh api -X GET search/issues -f per_page=50 \
    -f q="\"FORGE:DEFERRED_FROM: #${PARENT}\" in:body repo:${REPO} is:issue" 2>/dev/null \
  | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg m "$MARKER" "$JQ_PRE"'
      [.items[] | select(trusted) | select((.body // "") | contains($m)) | .number] | sort | .[]' 2>/dev/null
}
verify_num() { # number -> `number<TAB>state` when a trusted, non-PR issue of class $CLS carries the marker; empty when not (a 404 is "not it")
  local out rc
  out=$(gh api "repos/${REPO}/issues/$1" 2>"$TMP/verr"); rc=$?
  if [ "$rc" -ne 0 ]; then grep -qE '404|Not Found|410' "$TMP/verr" 2>/dev/null && return 0; return 1; fi
  printf '%s' "$out" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg m "$MARKER" --arg cls "$CLS" "$JQ_PRE"'
      select(.pull_request == null) | select(trusted) | select((.body // "") | contains($m))
      | select((((.body // "") | capture("FORGE:DEFERRED_CLASS: (?<c>[a-z-]+)") | .c) // "engineering") == $cls)
      | "\(.number)\t\(.state)"' 2>/dev/null
}
CANON=""; CSTATE=""
pick_verified() { # numbers... ; sets CANON/CSTATE from the first verified one; non-zero only when a fetch failed
  local n r
  for n in "$@"; do
    r=$(verify_num "$n") || return 1
    if [ -n "$r" ]; then CANON="${r%%$'\t'*}"; CSTATE="${r#*$'\t'}"; return 0; fi
  done
  return 0
}
find_canonical() {
  local cands
  CANON=""; CSTATE=""
  cands=$(claim_nums) || return 1
  # shellcheck disable=SC2086
  pick_verified $cands || return 1
  [ -n "$CANON" ] && return 0
  cands=$(search_nums) || return 1
  # shellcheck disable=SC2086
  pick_verified $cands || return 1
  return 0
}
# --- #4724: the post-deploy rollup: ONE open issue per release lane, found by marker (not by parent) ------------------
RELEASE_LANE="${FORGE_RELEASE_LANE:-default}"
ROLLUP_MARKER="<!-- FORGE:POSTDEPLOY_ROLLUP: ${RELEASE_LANE} -->"
verify_rollup() { # number -> `number<TAB>open` when a trusted, open, non-PR issue carries the rollup marker
  local out rc
  out=$(gh api "repos/${REPO}/issues/$1" 2>"$TMP/verr"); rc=$?
  if [ "$rc" -ne 0 ]; then grep -qE '404|Not Found|410' "$TMP/verr" 2>/dev/null && return 0; return 1; fi
  printf '%s' "$out" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg m "$ROLLUP_MARKER" "$JQ_PRE"'
      select(.pull_request == null) | select(trusted) | select(.state == "open") | select((.body // "") | contains($m))
      | "\(.number)\t\(.state)"' 2>/dev/null
}
find_rollup() { # sets CANON/CSTATE to the lowest open rollup of the lane; non-zero only when a lookup failed
  local cands n r
  CANON=""; CSTATE=""
  cands=$(gh api -X GET search/issues -f per_page=50 -f q="\"FORGE:POSTDEPLOY_ROLLUP: ${RELEASE_LANE}\" in:body repo:${REPO} is:issue is:open" 2>/dev/null \
    | jq -r '[.items[].number] | sort | .[]' 2>/dev/null) || return 1
  for n in $cands; do
    r=$(verify_rollup "$n") || return 1
    if [ -n "$r" ]; then CANON="${r%%$'\t'*}"; CSTATE="${r#*$'\t'}"; return 0; fi
  done
  return 0
}
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
file_rollup() { # items in $ITEMS_F; sets FILED_N, FILED_NEW
  local n_items; n_items=$(wc -l < "$ITEMS_F" | tr -d ' ')
  FILED_N=""; FILED_NEW=0
  resolve_root
  CANON=$(cut -f1 "$TMP/canon.$CLS")
  if [ -n "$CANON" ]; then
    rollup_append "$CANON" || { echo "DEFERRED_FILE=FAILED"; exit 4; }
    FILED_N="$CANON"; return 0
  fi
  : > "$TMP/body"; rollup_missing "$ITEMS_F" "$TMP/body"
  {
    printf '## Problem\n\nPost-deploy checklist of release lane `%s`%s. Every merged lane appends its post-deploy items under a `### #<parent>` heading (deduplicated), so one read-only verification works through this one issue per release.\n\n' "$RELEASE_LANE" "${FORGE_RELEASE_SHA:+ (deploy target at $FORGE_RELEASE_SHA)}"
    printf '## Acceptance Criteria\n\n### #%s\n<!-- FORGE:DEFERRED_FROM: #%s -->\n\n' "$ROOT" "$ROOT"
    cat "$TMP/add"
    printf '\n%s\n<!-- FORGE:DEFERRED_CLASS: post-deploy -->\n' "$ROLLUP_MARKER"
  } > "$TMP/newissue"
  local NUM
  if [ -n "${DRY_RUN:-}" ]; then
    echo "DRY_RUN: gh issue create (post-deploy rollup ${RELEASE_LANE}: ${n_items} item(s) from #${PARENT})" >&2
    NUM=0
  else
    resolve_milestone
    local args=() URL
    gh label create "followup:post-deploy" -R "$REPO" --force --color BFD4F2 --description "Deferred post-deploy checks. Managed by ForgeDock." >/dev/null 2>&1 || true
    args=(--label "followup:post-deploy")
    [ -n "$MS_TITLE" ] && args+=(--milestone "$MS_TITLE")
    URL=$(gh issue create -R "$REPO" --title "post-deploy: release checklist (${RELEASE_LANE})" --body-file "$TMP/newissue" "${args[@]}" 2>/dev/null) || URL=""
    NUM=$(printf '%s' "$URL" | grep -oE '[0-9]+$' | tail -n 1)
    [ -n "$NUM" ] || { echo "DEFERRED_FILE=FAILED"; exit 4; }
    # Post-create re-check: a concurrent lane may have filed first. The lowest open rollup is canonical; the newer one is closed.
    if find_rollup; then
      if [ -n "$CANON" ] && [ "$CANON" -lt "$NUM" ]; then
        if rollup_append "$CANON"; then
          gh issue close "$NUM" -R "$REPO" --reason "not planned" --comment "Duplicate of #${CANON}: the post-deploy items of lane ${RELEASE_LANE} are tracked there." >/dev/null 2>&1 \
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

CLS_LIST=$(cut -d "$SEP" -f5 "$TMP/items" | sort -u)
CLS=""
# Phase 1: look up the canonical follow-up of every class before filing anything (a failed lookup files nothing).
for CLS in $CLS_LIST; do
  LOOKUP_OK=""
  for attempt in 1 2; do
    if { [ "$CLS" = "post-deploy" ] && find_rollup; } || { [ "$CLS" != "post-deploy" ] && find_canonical; }; then LOOKUP_OK=1; break; fi
    [ "$attempt" = 1 ] && sleep "${FORGE_DEFERRED_RETRY_SLEEP:-2}"
  done
  if [ -z "$LOOKUP_OK" ]; then
    echo "DEFERRED_LOOKUP=FAILED"
    exit 3
  fi
  printf '%s\t%s\n' "$CANON" "$CSTATE" > "$TMP/canon.$CLS"
  awk -F"$SEP" -v c="$CLS" '$5 == c' "$TMP/items" > "$TMP/items.$CLS"
done

# Checklist line for one item. Path always backticked so review-pr 6B.5 `contains` verification holds.
entry() { # path why flag
  local l="- [ ] \`$1\`"
  [ -n "$3" ] && l="$l **known-flaw**"
  [ -n "$2" ] && l="$l — $2"
  printf '%s\n' "$l"
}
has_entry() { # body-file path : exact checklist-line match, not substring
  grep -qE '^- \[[ xX]\] `' "$1" 2>/dev/null || return 1
  grep -F -- "\`$2\`" "$1" | grep -qE "^- \[[ xX]\] \`$(printf '%s' "$2" | sed 's/[][\.*^$+?(){}|]/\\&/g')\`( |\$)"
}

# Append the missing items to follow-up $1 (state $2), then reopen it when closed (review-finalize needs it open).
append_items() { # number state ; non-zero = failure
  local num="$1" state="$2" note=""
  # Re-read the body immediately before editing (parallel builds of the same parent), then append what is missing.
  gh api "repos/${REPO}/issues/${num}" --jq '.body // ""' > "$TMP/body" 2>/dev/null || return 1
  : > "$TMP/add"
  while IFS="$SEP" read -r p w k fp cl; do
    has_entry "$TMP/body" "$p" || entry "$p" "$w" "$k" >> "$TMP/add"
  done < "$ITEMS_F"
  [ "$state" = "closed" ] && note=" (follow-up was closed; reopened)"
  if [ -s "$TMP/add" ]; then
    { cat "$TMP/body"; printf '\n### Added by a later build of #%s%s\n\n' "$PARENT" "$note"; cat "$TMP/add"; } > "$TMP/newbody"
    if [ -n "${DRY_RUN:-}" ]; then
      echo "DRY_RUN: gh issue edit $num (append $(wc -l < "$TMP/add" | tr -d ' ') item(s))" >&2
    else
      gh issue edit "$num" -R "$REPO" --body-file "$TMP/newbody" >/dev/null 2>&1 || return 1
    fi
  fi
  if [ "$state" = "closed" ]; then
    if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: gh issue reopen $num" >&2
    else gh issue reopen "$num" -R "$REPO" >/dev/null 2>&1 || return 1; fi
  fi
  return 0
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

# File one class ($CLS, items in $ITEMS_F): append to its canonical follow-up, or create one. Sets FILED_N, FILED_NEW.
file_class() {
  local n_items; n_items=$(wc -l < "$ITEMS_F" | tr -d ' ')
  FILED_N=""; FILED_NEW=0
  CANON=$(cut -f1 "$TMP/canon.$CLS"); CSTATE=$(cut -f2 "$TMP/canon.$CLS")
  if [ -n "$CANON" ]; then
    append_items "$CANON" "$CSTATE" || { echo "DEFERRED_FILE=FAILED"; exit 4; }
    FILED_N="$CANON"; return 0
  fi
  local claim="<!-- FORGE:DEFERRED_ISSUE: #%s -->" title="follow-up: ${n_items} deferred item(s) (deferred from #${PARENT})"
  if [ "$CLS" != "engineering" ]; then claim="<!-- FORGE:DEFERRED_ISSUE: #%s class=${CLS} -->"; title="follow-up (${CLS}): ${n_items} deferred item(s) (deferred from #${PARENT})"; fi
  local paths; paths=$(awk -F"$SEP" '$4 != "-" { print $4 }' "$ITEMS_F" | awk '!seen[$0]++')
  {
    printf '## Problem\n\n'
    printf 'Deferred from #%s: the items below were declared out of scope in its contract and are tracked here, in one issue per class (%s), instead of surfacing later as review findings.\n\n' "$PARENT" "$CLS"
    if [ "$CLS" = "external" ]; then
      printf 'External prerequisite of #%s: these items wait on something outside the repo (credentials, an account, a third party).' "$PARENT"
      [ -n "${FORGE_EXTERNAL_PREREQ:-}" ] && printf ' Linked prerequisite: #%s.' "${FORGE_EXTERNAL_PREREQ#\#}"
      printf '\n\n'
    fi
    printf '## Affected Files\n\n'
    if [ -n "$paths" ]; then printf '%s\n' "$paths" | while IFS= read -r fp; do printf -- '- `%s`\n' "$fp"; done
    else printf -- '- None (requirement-level items, see the checklist)\n'; fi
    printf '\n## Acceptance Criteria\n\n'
    while IFS="$SEP" read -r p w k fp cl; do entry "$p" "$w" "$k"; done < "$ITEMS_F"
    printf '\n%s\n<!-- FORGE:DEFERRED_CLASS: %s -->\n' "$MARKER" "$CLS"
  } > "$TMP/newissue"
  local NUM
  if [ -n "${DRY_RUN:-}" ]; then
    echo "DRY_RUN: gh issue create (follow-up ${CLS}: ${n_items} deferred item(s) from #${PARENT})" >&2
    NUM=0
  else
    resolve_milestone
    local lbl="followup:${CLS}" args=() URL
    gh label create "$lbl" -R "$REPO" --force --color BFD4F2 --description "Deferred follow-up (${CLS}). Managed by ForgeDock." >/dev/null 2>&1 || true
    args=(--label "$lbl")
    if [ "$CLS" = "external" ]; then
      gh label create external-prerequisite -R "$REPO" --force --color E99695 --description "External prerequisite. Managed by ForgeDock." >/dev/null 2>&1 || true
      args+=(--label external-prerequisite)
    fi
    [ -n "$MS_TITLE" ] && args+=(--milestone "$MS_TITLE")
    URL=$(gh issue create -R "$REPO" --title "$title" --body-file "$TMP/newissue" "${args[@]}" 2>/dev/null) || URL=""
    NUM=$(printf '%s' "$URL" | grep -oE '[0-9]+$' | tail -n 1)
    [ -n "$NUM" ] || { echo "DEFERRED_FILE=FAILED"; exit 4; }
  fi
  if [ -z "${DRY_RUN:-}" ]; then
    # Claim the follow-up on the parent (REST comments are read-after-write consistent; best effort, the search still finds it).
    # shellcheck disable=SC2059
    gh issue comment "$PARENT" -R "$REPO" --body "$(printf "$claim" "$NUM")" >/dev/null 2>&1 \
      || echo "file-deferred-followups: warning: could not post claim marker for #${NUM} on #${PARENT}" >&2
    # Post-create re-check: a concurrent build may have filed first. The lowest trusted number is canonical; the newer one is closed.
    if find_canonical; then
      if [ -n "$CANON" ] && [ "$CANON" -lt "$NUM" ]; then
        if append_items "$CANON" "$CSTATE"; then
          gh issue close "$NUM" -R "$REPO" --reason "not planned" --comment "Duplicate of #${CANON}: deferred items of #${PARENT} are tracked there." >/dev/null 2>&1 \
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

[ "$TOTAL" -gt 0 ] || { finish "" 0; exit 0; }

# Phase 2: one issue per class.
INTO=""; FILED=0
for CLS in $CLS_LIST; do
  ITEMS_F="$TMP/items.$CLS"
  if [ "$CLS" = "post-deploy" ]; then file_rollup; else file_class; fi
  case " $INTO " in *" $FILED_N "*) ;; *) INTO="${INTO:+$INTO }$FILED_N" ;; esac
  FILED=$((FILED + FILED_NEW))
  while IFS="$SEP" read -r p w k fp cl; do printf '%s\t%s\n' "$p" "$FILED_N"; done < "$ITEMS_F"
done
finish "$INTO" "$FILED"
exit 0
