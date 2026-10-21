#!/usr/bin/env bash
# review-pr-gate2.test.sh — static guards for the review-pr §6B.4 gate-2 rule family (forge#3597, #3598): the wording mirrored across the spec
# family, the deterministic slice path in the persona fences, and the staging slice-path binding. The executable route table lives in
# scripts/review-finalize.test.sh since the gate moved into scripts/review-finalize.sh (forge#3841).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT/commands/review-pr.md"
PASS=0; FAILN=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
command -v jq >/dev/null 2>&1 || { echo "review-pr-gate2.test.sh: jq missing, skipped"; exit 0; }

# The gate-2 route table (severity normalisation, deleted/renamed/patch-less files, files absent from the diff) is exercised against the real
# implementation in scripts/review-finalize.test.sh ("gate2 table"); the spec no longer carries a bash sketch of it (forge#3841).
FIN="$ROOT/scripts/review-finalize.sh"
if grep -qF 'select(.patch == null' "$FIN"; then ok; else bad "review-finalize.sh lacks the null-patch selector"; fi
if grep -qF 'CRITICAL/HIGH and unknown severities never are' "$FIN"; then ok; else bad "review-finalize.sh lacks the inverted severity rule comment"; fi

# Mirrored wording must stay in sync across the spec family.
for f in commands/review-pr.md commands/review-pr-staging.md commands/review-pr-agents/protocols.md docs/spec/review-protocol.md; do
  if grep -qiE 'CRITICAL/HIGH.*never routed as pre-existing' "$ROOT/$f"; then ok; else bad "$f lacks the CRITICAL/HIGH never-pre-existing rule"; fi
done

# SLICE_FILE must be a deterministic path re-declared and guarded in every persona fence (random mktemp is lost between Bash calls).
for f in commands/review-pr-agents/protocols.md docs/spec/review-protocol.md; do
  if grep -qF 'SLICE_FILE=$(mktemp)' "$ROOT/$f"; then bad "$f still uses a random mktemp SLICE_FILE"; else ok; fi
  if grep -qF 'forge-slice-' "$ROOT/$f"; then ok; else bad "$f lacks the deterministic forge-slice- path"; fi
done
for p in infra security scraper; do
  f="$ROOT/commands/review-pr-agents/$p.md"
  if grep -qF 'SLICE_FILE missing' "$f"; then ok; else bad "$p.md lacks the SLICE_FILE missing guard"; fi
  reads=$(awk '/^[ \t]*```(bash|sh)[ \t]*$/{inb=1;d=0;r=0;next} /^[ \t]*```[ \t]*$/{if(inb&&r)n++;inb=0;next} inb&&/forge-slice-/{d=1} inb&&/\$SLICE_FILE/{r=1} END{print n+0}' "$f")
  decls=$(awk '/^[ \t]*```(bash|sh)[ \t]*$/{inb=1;d=0;r=0;next} /^[ \t]*```[ \t]*$/{if(inb&&r&&d)n++;inb=0;next} inb&&/^[ \t]*SLICE_FILE="[^"]*forge-slice-/{d=1} inb&&/\$SLICE_FILE/{r=1} END{print n+0}' "$f")
  if [ "$reads" -ge 1 ] && [ "$reads" = "$decls" ]; then ok; else bad "$p.md: $reads fences read SLICE_FILE, $decls re-declare it"; fi
done

# Staging slice path (#4359): `forgedock review-staging` renders [REVIEW_SHA_SHORT] into the briefs. It derives it only from a validated
# full head SHA and stops before any brief when none resolves, so the slice path can never carry a / or an unresolved sentinel.
STAGING_CLI="$ROOT/bin/review-staging.mjs"
if grep -qF 'const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;' "$STAGING_CLI" && grep -qF 'if (!SHA_RE.test(head)) throw new Stop(1' "$STAGING_CLI"; then ok; else bad "staging CLI does not refuse an unvalidated head SHA"; fi
if grep -qF 'const sha7 = head.slice(0, 7);' "$STAGING_CLI" && grep -qF 'REVIEW_SHA_SHORT: sha7' "$STAGING_CLI"; then ok; else bad "staging CLI does not bind [REVIEW_SHA_SHORT] to the validated head's first 7 hex"; fi
if grep -q 'REVIEW_SHA_SHORT' "$ROOT/commands/review-pr-staging.md"; then bad "staging spec still binds [REVIEW_SHA_SHORT] by hand (the CLI renders the briefs)"; else ok; fi

echo "review-pr-gate2.test.sh: passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
