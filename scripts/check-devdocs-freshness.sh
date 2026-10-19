#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-devdocs-freshness.sh — docs must move with runtime behaviour (forge#4185).
# A PR that changes non-test files under bin/lean/ or scripts/ must, for every such file, also:
#   (a) touch a dossier whose devdocs/index.yaml `modules:` glob matches the file, or
#   (b) change lines inside the `## Runtime map` section of NORTHSTAR.md, or
#   (c) add a new devdocs/decisions/*.md.
# Exempt: a `docs-not-needed: <reason>` line (non-empty reason) in the PR body.
# Deterministic, no LLM. bash 3.2 portable (no bash-4 builtins, no PCRE grep).
#
# Usage: bash scripts/check-devdocs-freshness.sh [<base-ref>] [--body-file <file>]
#   <base-ref> defaults to the current branch's upstream (@{upstream}); CI always passes it explicitly.
#   PR body: --body-file, else env PR_BODY (empty when unset). Diff: <base-ref>...HEAD, run from the repo root.
# Exit: 0 fresh / exempt / nothing to check | 1 docs missing | 2 bad usage or unknown base ref

set -u
BASE=""
case "${1:-}" in
  ""|--*) BASE=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true) ;;
  *) BASE="$1"; shift ;;
esac
[ -n "$BASE" ] || { echo "usage: check-devdocs-freshness.sh [<base-ref>] [--body-file <file>] (no upstream to default to)" >&2; exit 2; }
BODY="${PR_BODY:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --body-file)
      [ -f "${2:-}" ] || { echo "check-devdocs-freshness: body file not found: ${2:-}" >&2; exit 2; }
      BODY=$(cat "$2"); shift 2 ;;
    *) echo "check-devdocs-freshness: unknown argument: $1" >&2; exit 2 ;;
  esac
done
git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null || { echo "check-devdocs-freshness: unknown base ref: $BASE" >&2; exit 2; }

CHANGES=$(git diff --no-renames --name-status "${BASE}...HEAD") || { echo "check-devdocs-freshness: git diff failed" >&2; exit 2; }
CHANGED=$(printf '%s\n' "$CHANGES" | awk -F'\t' 'NF>=2 {print $2}')

# Behaviour files: non-test files under bin/lean/ or scripts/.
BEHAVIOUR=$(printf '%s\n' "$CHANGED" | grep -E '^(bin/lean|scripts)/' \
  | grep -vE '\.test\.[^/]*$|(^|/)fixtures/|^scripts/tests/' || true)
if [ -z "$BEHAVIOUR" ]; then
  echo "OK: no behaviour change under bin/lean/ or scripts/ — devdocs freshness not required."
  exit 0
fi

if printf '%s\n' "$BODY" | tr -d '\r' | grep -Eq '^[[:space:]]*docs-not-needed:[[:space:]]*[^[:space:]]'; then
  echo "OK: exempt via 'docs-not-needed:' line in the PR body."
  exit 0
fi

# (c) a new decision record.
DECISION=$(printf '%s\n' "$CHANGES" | awk -F'\t' '$1=="A" && $2 ~ /^devdocs\/decisions\/[^\/]+\.md$/ {print $2}' | head -1)

# (b) changed lines inside NORTHSTAR.md § Runtime map (line range in HEAD vs the -U0 hunks' new-side lines).
RUNTIME_MAP=0
if printf '%s\n' "$CHANGED" | grep -qx 'NORTHSTAR.md' && [ -f NORTHSTAR.md ]; then
  RANGE=$(awk '/^## /{ if (s && !e) e = NR - 1; if ($0 ~ /^## Runtime map[[:space:]]*$/) s = NR } END { if (s) { if (!e) e = NR; print s, e } }' NORTHSTAR.md)
  if [ -n "$RANGE" ]; then
    RS=${RANGE% *}; RE=${RANGE#* }
    RUNTIME_MAP=$(git diff -U0 "${BASE}...HEAD" -- NORTHSTAR.md | awk -v s="$RS" -v e="$RE" '
      /^@@/ {
        match($0, /\+[0-9]+(,[0-9]+)?/)
        spec = substr($0, RSTART + 1, RLENGTH - 1)
        n = split(spec, p, ",")
        start = p[1] + 0; cnt = (n > 1) ? p[2] + 0 : 1
        if (cnt == 0) { lo = start; hi = start + 1 } else { lo = start; hi = start + cnt - 1 }
        if (lo <= e && hi >= s) hit = 1
      }
      END { print hit ? 1 : 0 }')
  fi
fi

# (a) dossiers: glob/path pairs from devdocs/index.yaml `modules:`.
MODULES=""
if [ -f devdocs/index.yaml ]; then
  MODULES=$(awk '
    /^modules:/ { m = 1; next }
    m && /^[^[:space:]#]/ { m = 0 }
    m && /^[[:space:]]*-[[:space:]]/ { if (g != "" && p != "") print g "\t" p; g = ""; p = "" }
    m && /^[[:space:]]*(-[[:space:]]+)?glob:/ { v = $0; sub(/^[^:]*:[[:space:]]*/, "", v); gsub(/["\047]/, "", v); g = v }
    m && /^[[:space:]]*(-[[:space:]]+)?path:/ { v = $0; sub(/^[^:]*:[[:space:]]*/, "", v); gsub(/["\047]/, "", v); p = v }
    END { if (g != "" && p != "") print g "\t" p }' devdocs/index.yaml)
fi

MISSING=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -n "$DECISION" ] && continue
  [ "$RUNTIME_MAP" = "1" ] && continue
  ok=0
  if [ -n "$MODULES" ]; then
    while IFS="$(printf '\t')" read -r glob dpath; do
      [ -n "$glob" ] || continue
      # shellcheck disable=SC2254
      case "$f" in
        $glob) printf '%s\n' "$CHANGED" | grep -qxF "devdocs/$dpath" && ok=1 ;;
      esac
    done <<EOF_MODULES
$MODULES
EOF_MODULES
  fi
  [ "$ok" = "1" ] || MISSING="${MISSING}${f}
"
done <<EOF_BEHAVIOUR
$BEHAVIOUR
EOF_BEHAVIOUR

if [ -z "$MISSING" ]; then
  if [ -n "$DECISION" ]; then echo "OK: new decision record $DECISION covers the behaviour change."
  elif [ "$RUNTIME_MAP" = "1" ]; then echo "OK: NORTHSTAR.md § Runtime map updated."
  else echo "OK: every behaviour change has its module dossier updated."; fi
  exit 0
fi

echo "ERROR: behaviour changed under bin/lean/ or scripts/ without a docs update:"
printf '%s' "$MISSING" | sed 's/^/  - /'
echo ""
echo "Fix with one of:"
echo "  - edit the matching dossier (devdocs/index.yaml modules: glob -> devdocs/modules/*.md)"
echo "  - update NORTHSTAR.md § Runtime map"
echo "  - add devdocs/decisions/<issue>-<slug>.md"
echo "  - or add a line 'docs-not-needed: <reason>' to the PR body"
exit 1
