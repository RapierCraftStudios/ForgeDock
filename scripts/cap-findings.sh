#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# cap-findings.sh — PR-level cap on filed review findings (review-pr §6B.5, review-pr-staging §7B).
#                   classify-finding.sh decides one finding at a time; this is the aggregation
#                   step after it: at most N ISSUE dispositions per review run are kept, the rest
#                   become `NOTE capped` (listed in FORGE:NOTE_DISPOSITION, never dropped).
#
# Usage:
#   cap-findings.sh [--cap N] [--lineage none|review-finding] [--input FILE]
#
# Input (stdin, or --input FILE): TSV rows
#   ID<TAB>SEVERITY<TAB>CONFIDENCE<TAB>DISPOSITION[<TAB>AGENT]
# DISPOSITION is the classifier output (`ISSUE <reason>`, `NOTE <reason>`, `INPR_FIX <reason>`).
#
# Output (stdout): one `ID<TAB>DISPOSITION` row per input row, in input order, then a final
# `CAPPED=<N>` line (no tab) counting the rows rewritten to `NOTE capped`. Callers read the rows
# with `awk -F'\t' 'NF >= 2'`.
#
# Rules:
#   - Only ISSUE rows are considered. NOTE and INPR_FIX rows pass through untouched and never
#     consume the cap.
#   - HIGH/CRITICAL ISSUE rows are NEVER capped (they always file and still block via the review's
#     severity gate).
#   - `ISSUE fix-efficacy-*` rows (the classifier's never-damped "the linked issue is not fixed / the
#     PR re-introduces its defect" exemption, #3857) are NEVER capped either: capping one would merge
#     a known-broken fix and close its issue as fixed. They are treated like HIGH rows (under
#     --lineage review-finding they consume the budget).
#   - Remaining ISSUE rows are ranked by severity (MEDIUM > LOW), then confidence (CONFIRMED >
#     LIKELY > POSSIBLE), then safety domain (Security/Auth/Billing/Concurrency/Database agent
#     first), then input order. Unparseable severity or confidence ranks as MEDIUM / LIKELY, so the
#     cap still applies to it (it is not an automatic ISSUE).
#   - Cap default: 2. Under --lineage review-finding the default is 1 and every filed HIGH/CRITICAL
#     consumes that budget (a fix for a finding must not mint a new generation of findings).
#     An explicit --cap overrides the default in both lineages. 0 is valid (cap everything
#     cappable). A non-numeric or negative --cap falls back to the default with a warning on stderr.
#
# Exit codes: 0 ok, 2 usage error. Bash 3.2 compatible (no mapfile, no associative arrays).

set -u

CAP=""; LINEAGE="none"; INPUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cap) [ $# -ge 2 ] || { echo "cap-findings.sh: --cap needs a value" >&2; exit 2; }; CAP="$2"; shift 2 ;;
    --lineage) [ $# -ge 2 ] || { echo "cap-findings.sh: --lineage needs a value" >&2; exit 2; }; LINEAGE="$2"; shift 2 ;;
    --input) [ $# -ge 2 ] || { echo "cap-findings.sh: --input needs a value" >&2; exit 2; }; INPUT="$2"; shift 2 ;;
    *) echo "cap-findings.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$LINEAGE" in
  none|review-finding) ;;
  *) echo "cap-findings.sh: --lineage must be none or review-finding (got '$LINEAGE')" >&2; exit 2 ;;
esac

if [ "$LINEAGE" = "review-finding" ]; then DEFAULT_CAP=1; else DEFAULT_CAP=2; fi
case "$CAP" in
  "") CAP="$DEFAULT_CAP" ;;
  *[!0-9]*) echo "cap-findings.sh: invalid cap '$CAP', using default $DEFAULT_CAP" >&2; CAP="$DEFAULT_CAP" ;;
esac

if [ -n "$INPUT" ] && [ ! -r "$INPUT" ]; then
  echo "cap-findings.sh: cannot read --input $INPUT" >&2; exit 2
fi

awk -F'\t' -v cap="$CAP" -v lineage="$LINEAGE" '
function up(s) { return toupper(s) }
function sevclass(s) { s = up(s); gsub(/[^A-Z]/, "", s); if (s == "CRITICAL" || s == "HIGH") return 3; if (s == "LOW") return 1; return 2 }
function confrank(c) { c = up(c); if (c == "CONFIRMED") return 3; if (c == "POSSIBLE") return 1; return 2 }
function domain(a) { a = tolower(a); return (a ~ /(security|auth|billing|concurrency|database)/) ? 1 : 0 }
/^[ \t\r]*$/ { next }
{
  n++
  sub(/\r$/, "")
  id[n] = $1; disp[n] = $4; agent[n] = $5
  if (NF < 4 || $4 == "") disp[n] = "ISSUE malformed-row"
  split(disp[n], w, " ")
  isissue[n] = (w[1] == "ISSUE")
  sc = sevclass($2)
  # the classifier already decided HIGH/CRITICAL: never cap those, whatever the raw severity text looked like
  if (w[2] ~ /^severity-(HIGH|CRITICAL)$/) sc = 3
  # fix-efficacy is never damped (classify-finding.sh): the per-review cap must not re-damp it
  if (w[2] ~ /^fix-efficacy-/) sc = 3
  if (isissue[n] && sc == 3) { high++ ; capable[n] = 0 }
  else if (isissue[n]) { capable[n] = 1; score[n] = sc * 1000 + confrank($3) * 100 + domain($5) * 10 }
  else capable[n] = 0
}
END {
  budget = cap + 0
  if (lineage == "review-finding") budget -= high
  if (budget < 0) budget = 0
  kept = 0
  while (kept < budget) {
    best = 0
    for (i = 1; i <= n; i++) {
      if (!capable[i] || keep[i]) continue
      if (best == 0 || score[i] > score[best]) best = i
    }
    if (best == 0) break
    keep[best] = 1; kept++
  }
  capped = 0
  for (i = 1; i <= n; i++) {
    if (capable[i] && !keep[i]) { printf "%s\tNOTE capped\n", id[i]; capped++ }
    else printf "%s\t%s\n", id[i], disp[i]
  }
  printf "CAPPED=%d\n", capped
}' ${INPUT:+"$INPUT"}
