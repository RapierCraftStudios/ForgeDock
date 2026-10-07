#!/usr/bin/env bash
# checkbox-sections.test.sh — Regression tests for the close-path classifier.
#
# Usage: bash scripts/checkbox-sections.test.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

extract_block() {
  awk '/^FENCE_COUNT=/{printing=1} printing{print} /^SUBISSUE_ITEMS=/{exit}' "$1"
}

extract_classifier() {
  awk '
    /^CHECKBOX_SECTIONS=.*awk .$/ { printing=1; next }
    printing && /^\047\)$/ { exit }
    printing { print }
  ' "$1"
}

CLOSE_BLOCK=$(extract_block "$ROOT/commands/work-on/close.md")
[ -n "$CLOSE_BLOCK" ] || { printf 'FAIL: close.md structural computation block not found\n' >&2; exit 1; }
CLOSE_CLASSIFIER=$(extract_classifier "$ROOT/commands/work-on/close.md")
[ -n "$CLOSE_CLASSIFIER" ] || { printf 'FAIL: close.md classifier not found\n' >&2; exit 1; }
# close.md is the single owner of the classifier; the work-on.md router must not carry a copy.
if grep -q '^FENCE_COUNT=' "$ROOT/commands/work-on.md"; then
  printf 'FAIL: work-on.md (router) must not contain a copy of the close-path classifier\n' >&2
  exit 1
fi
if grep -q 'echo "\$BODY\|echo "\$BODY_STRIPPED' "$ROOT/commands/work-on/close.md"; then
  printf 'FAIL: arbitrary issue bodies must be piped with printf, not echo\n' >&2
  exit 1
fi
grep -Fq 'if [ "${CHECKBOX_SECTIONS:-0}" -ge 2 ] || [ "${SUBISSUE_ITEMS:-0}" -gt 0 ]; then' "$ROOT/commands/work-on/close.md" || {
  printf 'FAIL: Phase C1 multi-phase guard changed unexpectedly\n' >&2
  exit 1
}

SETEXT_BODY=$'Phase One\n=========\n- [x] complete\n\nPhase Two\n---------\n- [ ] remaining'
[[ "$(printf '%s\n' "$SETEXT_BODY" | awk "$CLOSE_CLASSIFIER")" == "2" ]] || {
  printf 'FAIL: setext phases must count as two sections\n' >&2
  exit 1
}

SINGLE_BODY=$'## Acceptance Criteria\n- [ ] complete this work'
[[ "$(printf '%s\n' "$SINGLE_BODY" | awk "$CLOSE_CLASSIFIER")" == "1" ]] || {
  printf 'FAIL: one checkbox-bearing section must remain single-phase\n' >&2
  exit 1
}

printf 'PASS: close-path classifier supports setext section boundaries\n'
