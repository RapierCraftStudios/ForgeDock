#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Guards the review-pr roster-label to marker-domain mapping: every roster spelling collapses to one marker
# domain, the helper is identical wherever it is inlined, the roster dedups across spellings, and every
# persona file is covered by the table and the catalog. Run: bash scripts/review-pr-domain-map.test.sh
# (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
SPEC="$ROOT/commands/review-pr.md"
CATALOG="$ROOT/commands/review-pr-agents.md"
PERSONAS="$ROOT/commands/review-pr-agents"
pass=0; fail=0
ok() { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/review-pr-domain-map.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# Test 1: helper copies. Every inline definition must be byte-identical (each Bash call is a fresh shell).
awk -v dir="$WORK" '
  /^# BEGIN review-pr-agent-domain/ {n++; out=dir "/helper." n; on=1}
  on {print > out}
  /^# END review-pr-agent-domain/ {on=0; close(out)}
' "$SPEC"
copies=$(ls "$WORK"/helper.* 2>/dev/null | wc -l | tr -d ' ')
if [ "$copies" -ge 2 ]; then ok; else bad "expected >=2 inline agent_domain copies (the 3C pre-dispatch fence and Phase 4), found $copies"; fi
# The roster and prepare scripts carry their own copy of the helper; both must match the inline copies (forge#3599, forge#3841).
ROSTER="$ROOT/scripts/review-roster.sh"; PREPARE="$ROOT/scripts/review-prepare.sh"
want_fn=$(grep '^agent_domain()' "$WORK/helper.1")
got_fn=$(grep '^agent_domain()' "$ROSTER")
if [ -n "$want_fn" ] && [ "$want_fn" = "$got_fn" ]; then ok; else bad "scripts/review-roster.sh agent_domain differs from the inline copies"; fi
got_fn=$(grep '^agent_domain()' "$PREPARE")
if [ -n "$want_fn" ] && [ "$want_fn" = "$got_fn" ]; then ok; else bad "scripts/review-prepare.sh agent_domain differs from the inline copies"; fi
for f in "$WORK"/helper.*; do
  [ -f "$f" ] || continue
  if cmp -s "$f" "$WORK/helper.1"; then ok; else bad "$(basename "$f") differs from helper.1"; fi
done

# Test 2: no site derives the marker by lowercasing the roster label directly
if grep -nE "AGENT_DOMAIN=.*tr '\[:upper:\]' '\[:lower:\]'" "$SPEC" >/dev/null; then bad "direct lowercase marker derivation remains"; else ok; fi
sites=$(grep -c 'AGENT_DOMAIN=$(agent_domain "$AGENT")' "$SPEC")
if [ "$sites" -ge 2 ]; then ok; else bad "expected >=2 agent_domain derivation sites, found $sites"; fi

# Test 3: spelling collapse
# shellcheck disable=SC1090
. "$WORK/helper.1"
check() { got=$(agent_domain "$1"); if [ "$got" = "$2" ]; then ok; else bad "agent_domain '$1' = '$got', want '$2'"; fi; }
for l in INFRA Infrastructure infra infrastructure; do check "$l" infra; done
for l in SCRAPING Scraping scraper Scraper scraping; do check "$l" scraper; done
for l in FRONTEND Frontend frontend Web; do check "$l" frontend; done
for l in Security SECURITY; do check "$l" security; done
for l in AUTH Auth; do check "$l" auth; done
for l in BILLING Billing; do check "$l" billing; done
for l in CONCURRENCY Concurrency; do check "$l" concurrency; done
for l in DATABASE Database; do check "$l" database; done
for l in API Api; do check "$l" api; done
check "CustomDomain" customdomain

# Test 4: add_agent dedups across spellings; canonicalization block yields one entry per persona
ADD=$(awk '/^add_agent\(\) \{/{on=1} on{print} on && /^\}/{exit}' "$ROSTER")
if [ -n "$ADD" ]; then ok; else bad "add_agent not found in scripts/review-roster.sh"; fi
eval "$ADD"
SELECTED_AGENTS="Security INFRA SCRAPING"
add_agent "Infrastructure"; add_agent "Scraping"; add_agent "Auth"; add_agent "AUTH"; add_agent "security"
want=$(printf '%s' "Security INFRA SCRAPING auth")
if [ "$SELECTED_AGENTS" = "$want" ]; then ok; else bad "add_agent roster '$SELECTED_AGENTS', want '$want'"; fi

# The canonicalization (one entry per persona) is scripts/review-prepare.sh canonical_roster, which review-roster.sh output flows through.
CANON=$(grep '^canonical_roster()' "$PREPARE")
if [ -n "$CANON" ]; then ok; else bad "canonical_roster not found in scripts/review-prepare.sh"; fi
eval "$CANON"
SELECTED_AGENTS=$(canonical_roster "Security AUTH INFRA Infrastructure SCRAPING Scraping Frontend API api")
want="security auth infra scraper frontend api"
if [ "$SELECTED_AGENTS" = "$want" ]; then ok; else bad "canonical roster '$SELECTED_AGENTS', want '$want'"; fi
cnt=$(printf '%s' "$SELECTED_AGENTS" | tr ' ' '\n' | grep -c '.')
if [ "$cnt" -eq 6 ]; then ok; else bad "roster count $cnt, want 6"; fi

# Test 5: every persona file (minus protocols and spec-cli) has a table row in the spec and a catalog row
for pf in "$PERSONAS"/*.md; do
  name=$(basename "$pf" .md)
  case "$name" in protocols|spec-cli) continue ;; esac
  if grep -qE "(→|->)\`$name\`" "$SPEC"; then ok; else bad "spec roster label mapping has no entry for persona $name"; fi
  if grep -qE "^\| .*\| \`$name\` \| \`review-pr-agents/$name\.md\` \|" "$CATALOG"; then ok; else bad "catalog has no marker-domain row for persona $name"; fi
  got=$(agent_domain "$name")
  if [ "$got" = "$name" ]; then ok; else bad "persona $name maps to $got"; fi
done

# Test 6: the protocol defines the marker domain through the mapping
if grep -qF 'marker domain' "$PERSONAS/protocols.md"; then ok; else bad "protocols.md does not define the marker domain"; fi

# Test 7: the roster regexes in delta_roster must equal the per-domain file regexes of the diff slices (both in scripts/review-prepare.sh since #3841),
# and the slice function must fall back to the full file list and full diff for a domain with no hit
for pair in auth:auth billing:billing concurrency:concurrency database:database infra:infra scraper:scraper frontend:frontend api:api; do
  var=${pair%%:*}; dom=${pair#*:}
  a=$(grep -E "^    slice $var " "$PREPARE" | head -n 1 | sed -n 's/.* "\([^"]*\)"$/\1/p')
  b=$(grep -F "&& out=\"\$out $dom\"" "$PREPARE" | grep 'grep -qiE' | head -n 1 | sed -n 's/.*grep -qiE "\([^"]*\)".*/\1/p')
  if [ -z "$a" ] || [ -z "$b" ]; then bad "could not extract $var pattern (slice='$a' delta_roster='$b')"
  elif [ "$a" = "$b" ]; then ok; else bad "$var regex drifted: slice='$a' delta_roster='$b'"; fi
done
if grep -qF '[ -n "$paths" ] || paths="$SLICE_FILES_SRC"' "$PREPARE" && grep -qF '[ -n "$body" ] || body="$FULL_DIFF"' "$PREPARE"; then ok; else bad "prepare slice() lacks the empty-slice fallback"; fi

echo "review-pr-domain-map: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
