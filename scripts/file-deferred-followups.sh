#!/usr/bin/env bash
# file-deferred-followups.sh — file ALL deferred out-of-scope items of one build as ONE follow-up issue.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The builder decides fold-vs-defer (judgment, build.md B2.0); this script does the mechanics for the items
# that stay deferred: trusted lookup of an open follow-up carrying <!-- FORGE:DEFERRED_FROM: #N -->, append the
# missing items to it as checklist entries (exact path match), or create ONE issue with a checklist.
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
do_lookup() {
  gh api -X GET search/issues -f per_page=50 \
    -f q="\"FORGE:DEFERRED_FROM: #${PARENT}\" in:body repo:${REPO} is:issue is:open" 2>/dev/null \
  | jq -c --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg m "$MARKER" '
      ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
      | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
      | [.items[]
          | select(((.author_association // "") as $x | $A | index($x) != null)
                   or ((.user.type // "") == "Bot")
                   or ((.user.login // "") as $x | $L | index($x) != null))
          | select((.body // "") | contains($m))
          | {number, body: (.body // "")}]
      | sort_by(.number)' 2>/dev/null
}
LOOKUP=""
for attempt in 1 2; do
  LOOKUP=$(do_lookup) && [ -n "$LOOKUP" ] && break
  LOOKUP=""
  [ "$attempt" = 1 ] && sleep "${FORGE_DEFERRED_RETRY_SLEEP:-2}"
done
if [ -z "$LOOKUP" ]; then
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

NUM=$(printf '%s' "$LOOKUP" | jq -r 'first | .number // empty' 2>/dev/null)

if [ -n "$NUM" ]; then
  # Re-read the body immediately before editing (parallel builds of the same parent), then append what is missing.
  if ! gh api "repos/${REPO}/issues/${NUM}" --jq '.body // ""' > "$TMP/body" 2>/dev/null; then
    echo "DEFERRED_FILE=FAILED"; exit 4
  fi
  : > "$TMP/add"
  while IFS="$SEP" read -r p w k; do
    has_entry "$TMP/body" "$p" || entry "$p" "$w" "$k" >> "$TMP/add"
  done < "$TMP/items"
  if [ -s "$TMP/add" ]; then
    { cat "$TMP/body"; printf '\n### Added by a later build of #%s\n\n' "$PARENT"; cat "$TMP/add"; } > "$TMP/newbody"
    if [ -n "${DRY_RUN:-}" ]; then
      echo "DRY_RUN: gh issue edit $NUM (append $(wc -l < "$TMP/add" | tr -d ' ') item(s))" >&2
    elif ! gh issue edit "$NUM" -R "$REPO" --body-file "$TMP/newbody" >/dev/null 2>&1; then
      echo "DEFERRED_FILE=FAILED"; exit 4
    fi
  fi
  while IFS="$SEP" read -r p w k; do printf '%s\t%s\n' "$p" "$NUM"; done < "$TMP/items"
  finish "$NUM" 0
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
while IFS="$SEP" read -r p w k; do printf '%s\t%s\n' "$p" "$NUM"; done < "$TMP/items"
finish "$NUM" 1
exit 0
