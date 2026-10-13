#!/usr/bin/env bash
# file-deferred-followups.sh — file ALL deferred out-of-scope items of one build as ONE follow-up issue.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The builder decides fold-vs-defer (judgment, build.md B2.0); this script does the mechanics for the items
# that stay deferred: trusted lookup (claim marker <!-- FORGE:DEFERRED_ISSUE: #M --> on the parent, then a state-all search) of a follow-up carrying
# <!-- FORGE:DEFERRED_FROM: #N -->, append the missing items (exact path match; a closed one is reopened), or create ONE issue
# with a checklist, claim it on the parent and re-check once for a concurrent lower-numbered duplicate.
#
# Usage: file-deferred-followups.sh --parent N --repo OWNER/REPO [--items FILE|-] [--folded N]
#   items TSV, one per line: <path> TAB <why> TAB <known-flaw flag: known-flaw|1|yes|true, else empty>
# Env: DRY_RUN (non-empty: no create/edit, issue number 0), FORGE_TRAIL_TRUSTED_ASSOCIATIONS (default
#      OWNER,MEMBER,COLLABORATOR), FORGE_TRAIL_TRUSTED_LOGINS (default empty), FORGE_DEFERRED_RETRY_SLEEP (secs).
# Stdout: `path<TAB>issue` per item, then DEFERRED_TELEMETRY deferred_items=N folded=N batched_into=#M filed=N.
# Exit: 0 ok | 2 usage | 3 lookup failed (DEFERRED_LOOKUP=FAILED) | 4 create/append failed (DEFERRED_FILE=FAILED).
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

# Normalise: drop blank lines and duplicate paths (first wins), strip backticks from the path.
# Internal file uses a non-whitespace separator (US, \x1f): a tab IFS collapses an empty `why` and drops the known-flaw flag.
SEP=$(printf '\037')
: > "$TMP/items"
while IFS= read -r line || [ -n "$line" ]; do
  # Split on TAB by hand: `IFS=$'\t' read` would collapse an empty why field and shift the flag into it.
  p="${line%%$'\t'*}"; rest=""; w=""; k=""
  case "$line" in *$'\t'*) rest="${line#*$'\t'}"; w="${rest%%$'\t'*}"; case "$rest" in *$'\t'*) k="${rest#*$'\t'}" ;; esac ;; esac
  p=$(printf '%s' "${p:-}" | tr -d '`' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  [ -n "$p" ] || continue
  if cut -d "$SEP" -f1 "$TMP/items" | grep -qxF -- "$p"; then continue; fi
  case "${k:-}" in known-flaw|1|yes|true) k="known-flaw" ;; *) k="" ;; esac
  w=$(printf '%s' "${w:-}" | tr '\r\n' '  ')
  printf '%s%s%s%s%s\n' "$p" "$SEP" "$w" "$SEP" "$k" >> "$TMP/items"
done < "$TMP/items.raw"
TOTAL=$(wc -l < "$TMP/items" | tr -d ' ')

MARKER="<!-- FORGE:DEFERRED_FROM: #${PARENT} -->"
TRUSTED_ASSOC="${FORGE_TRAIL_TRUSTED_ASSOCIATIONS-OWNER,MEMBER,COLLABORATOR}"
TRUSTED_LOGINS="${FORGE_TRAIL_TRUSTED_LOGINS-}"

finish() { # $1 = batched_into number or empty, $2 = filed count
  local into="none"; [ -n "$1" ] && into="#$1"
  local line="DEFERRED_TELEMETRY deferred_items=${TOTAL} folded=${FOLDED} batched_into=${into} filed=$2"
  echo "$line"
  # #3834 emitter (scripts/lib/telemetry.sh): optional, never blocks, never changes stdout or the exit code.
  local d; d=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [ -f "$d/lib/telemetry.sh" ]; then
    FORGE_ISSUE="${FORGE_ISSUE:-$PARENT}" FORGE_REPO="${FORGE_REPO:-$REPO}" \
      bash "$d/lib/telemetry.sh" deferred_followups deferred_items="$TOTAL" folded="$FOLDED" \
      batched_into="${1:-none}" filed="$2" >/dev/null 2>&1 </dev/null || true
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
CLAIM_RE='^\s*<!-- FORGE:DEFERRED_ISSUE: #(?<n>[0-9]+) -->'
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
verify_num() { # number -> `number<TAB>state` when a trusted, non-PR issue carries the marker; empty when not (a 404 is "not it")
  local out rc
  out=$(gh api "repos/${REPO}/issues/$1" 2>"$TMP/verr"); rc=$?
  if [ "$rc" -ne 0 ]; then grep -qE '404|Not Found|410' "$TMP/verr" 2>/dev/null && return 0; return 1; fi
  printf '%s' "$out" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg m "$MARKER" "$JQ_PRE"'
      select(.pull_request == null) | select(trusted) | select((.body // "") | contains($m))
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
LOOKUP_OK=""
for attempt in 1 2; do
  if find_canonical; then LOOKUP_OK=1; break; fi
  [ "$attempt" = 1 ] && sleep "${FORGE_DEFERRED_RETRY_SLEEP:-2}"
done
if [ -z "$LOOKUP_OK" ]; then
  echo "DEFERRED_LOOKUP=FAILED"
  exit 3
fi

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
  while IFS="$SEP" read -r p w k; do
    has_entry "$TMP/body" "$p" || entry "$p" "$w" "$k" >> "$TMP/add"
  done < "$TMP/items"
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

if [ -n "$CANON" ]; then
  append_items "$CANON" "$CSTATE" || { echo "DEFERRED_FILE=FAILED"; exit 4; }
  while IFS="$SEP" read -r p w k; do printf '%s\t%s\n' "$p" "$CANON"; done < "$TMP/items"
  finish "$CANON" 0
  exit 0
fi

[ "$TOTAL" -gt 0 ] || { finish "" 0; exit 0; }

# --- Create ONE issue with a checklist for every item ---------------------------------------------------------
{
  printf '## Problem\n\n'
  printf 'Deferred from #%s: the items below were declared out of scope in its contract and are tracked here, in one issue, instead of surfacing later as review findings.\n\n' "$PARENT"
  printf '## Affected Files\n\n'
  while IFS="$SEP" read -r p w k; do printf -- '- `%s`\n' "$p"; done < "$TMP/items"
  printf '\n## Acceptance Criteria\n\n'
  while IFS="$SEP" read -r p w k; do entry "$p" "$w" "$k"; done < "$TMP/items"
  printf '\n%s\n' "$MARKER"
} > "$TMP/newissue"

if [ -n "${DRY_RUN:-}" ]; then
  echo "DRY_RUN: gh issue create (follow-up: ${TOTAL} deferred item(s) from #${PARENT})" >&2
  NUM=0
else
  URL=$(gh issue create -R "$REPO" --title "follow-up: ${TOTAL} deferred item(s) (deferred from #${PARENT})" \
    --body-file "$TMP/newissue" 2>/dev/null) || URL=""
  NUM=$(printf '%s' "$URL" | grep -oE '[0-9]+$' | tail -n 1)
  [ -n "$NUM" ] || { echo "DEFERRED_FILE=FAILED"; exit 4; }
fi
if [ -z "${DRY_RUN:-}" ]; then
  # Claim the follow-up on the parent (REST comments are read-after-write consistent; best effort, the search still finds it).
  gh issue comment "$PARENT" -R "$REPO" --body "<!-- FORGE:DEFERRED_ISSUE: #${NUM} -->" >/dev/null 2>&1 \
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
while IFS="$SEP" read -r p w k; do printf '%s\t%s\n' "$p" "$NUM"; done < "$TMP/items"
finish "$NUM" 1
exit 0
