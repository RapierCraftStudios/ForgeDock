#!/usr/bin/env bash
# review-pr-gate2.test.sh — cases for the review-pr §6B.4 gate-2 sketch (forge#3597, #3598).
# Extracts the fenced bash block from commands/review-pr.md, runs its set-up against a stubbed
# `gh`, then applies the per-finding rules the block documents (gone, no patch, introduced, severity).
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

# Extract the sketch: the fenced block that declares NOPATCH_FILES_FILE, minus comment-only lines.
awk '/^```bash$/{b="";in_b=1;next} /^```$/{if(in_b&&b~/NOPATCH_FILES_FILE=/)printf "%s",b; in_b=0;next} in_b{b=b $0 "\n"}' "$SPEC" \
  | grep -v '^#' > "$TMP/sketch.sh"
if [ -s "$TMP/sketch.sh" ]; then ok; else bad "sketch block not found in review-pr.md"; echo "review-pr-gate2.test.sh: failed=$FAILN"; exit 1; fi

# Fixture files API: a.sh patch adds line 10; big.txt has no patch; gone.txt removed.
cat > "$TMP/files.json" <<'JSON'
[{"filename":"a.sh","status":"modified","patch":"@@ -9,2 +9,3 @@\n ctx\n+added\n ctx"},
 {"filename":"big.txt","status":"modified"},
 {"filename":"gone.txt","status":"removed"},
 {"filename":"new.sh","status":"renamed","previous_filename":"old.sh","patch":"@@ -1,1 +1,1 @@\n+x"}]
JSON
mkdir "$TMP/bin"
printf '#!/bin/sh\ncat "%s/files.json"\n' "$TMP" > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"

# Spec's executable severity rule: the SEV= line and the case line from the sketch comments, comment marker stripped.
grep -E '^#[[:space:]]+(SEV=|case "\$SEV" in)' "$SPEC" | sed -e 's/^#[[:space:]]*//' -e 's/[[:space:]]*#.*$//' > "$TMP/rule.sh"
if [ "$(wc -l < "$TMP/rule.sh")" -eq 2 ]; then ok; else bad "severity rule lines not found in review-pr.md"; fi

{
  printf 'export PATH="%s/bin:$PATH" FORGE_SCRATCHPAD="%s"\n' "$TMP" "$TMP"
  printf 'SEVERITY_RULE=%q\n' "$(cat "$TMP/rule.sh")"
  sed -e 's/{GH_REPO}/o\/r/; s/{PR_NUMBER}/1/; s/{REVIEW_SHA}/0123456789abcdef0123456789abcdef01234567/' "$TMP/sketch.sh"
  cat <<'CLASSIFY'
# classify FILE LINE SEVERITY -> KEEP | pre-existing (mirrors the per-finding rules in the sketch comments)
classify() {
  FILE="$1"; LINE="$2"; SEVERITY="$3"; INTRODUCED=0
  grep -qxF -- "$FILE" "$GONE_FILES_FILE" && { echo KEEP; return; }
  grep -qxF -- "$FILE" "$NOPATCH_FILES_FILE" && { echo KEEP; return; }
  LO=$((LINE>5?LINE-5:1))
  for L in $(seq "$LO" $((LINE+5))); do grep -qxF -- "${FILE}:${L}" "$ADDED_LINES_FILE" && INTRODUCED=1; done
  SCOPE=changed
  # The severity rule is the spec's own line (extracted below), not a re-implementation.
  eval "$SEVERITY_RULE"
  if [ "$SCOPE" = pre-existing ]; then echo pre-existing; else echo KEEP; fi
}
classify "$@"
CLASSIFY
} > "$TMP/run.sh"

check() { # name want file line severity
  local got; got="$(bash "$TMP/run.sh" "$3" "$4" "$5" 2>&1 | tail -n1)"
  if [ "$got" = "$2" ]; then ok; else bad "$1 (got '$got' want '$2')"; fi
}
check "added line intersects"            KEEP         a.sh    10  MEDIUM
check "MEDIUM far from added -> pre"     pre-existing a.sh    100 MEDIUM
check "HIGH far from added kept"         KEEP         a.sh    100 HIGH
check "CRITICAL far from added kept"     KEEP         a.sh    100 CRITICAL
check "null-patch file MEDIUM kept"      KEEP         big.txt 3   MEDIUM
check "lowercase high kept"              KEEP         a.sh    100 high
check "padded HIGH kept"                 KEEP         a.sh    100 "HIGH "
check "empty severity kept"              KEEP         a.sh    100 ""
check "unparseable severity kept"        KEEP         a.sh    100 "SEVERE"
check "lowercase medium -> pre"          pre-existing a.sh    100 medium
check "INFO far from added -> pre"       pre-existing a.sh    100 INFO
check "renamed file kept"                KEEP         old.sh  3   MEDIUM
check "patched file still pre w/ nopatch sibling" pre-existing a.sh 100 LOW
check "removed file kept"                KEEP         gone.txt 3  LOW
check "file absent from diff MEDIUM pre" pre-existing other.sh 5  MEDIUM
if grep -qF 'select(.patch == null' "$SPEC"; then ok; else bad "spec lacks null-patch selector"; fi

# Mirrored wording must stay in sync across the spec family.
for f in commands/review-pr-staging.md commands/review-pr-agents/protocols.md docs/spec/review-protocol.md; do
  if grep -qiE 'CRITICAL/HIGH.*never routed as pre-existing' "$ROOT/$f"; then ok; else bad "$f lacks the CRITICAL/HIGH never-pre-existing rule"; fi
done
if grep -qF 'only known low severities' "$SPEC"; then ok; else bad "spec lacks inverted severity rule comment"; fi

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

echo "review-pr-gate2.test.sh: passed=$PASS failed=$FAILN"
[ "$FAILN" -eq 0 ]
