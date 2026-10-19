#!/usr/bin/env bash
# northstar-docs.test.sh — NORTHSTAR.md is present, small, pointed at, and devdocs selective loading still works (forge#4185).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
PASS=0; FAILN=0
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
check() { if eval "$2"; then ok; else bad "$1"; fi; }

# NORTHSTAR.md: exists, under 8 KB, no unresolved ⟨confirm⟩ markers.
check "NORTHSTAR.md exists" '[ -f NORTHSTAR.md ]'
check "NORTHSTAR.md is under 8 KB" '[ "$(wc -c < NORTHSTAR.md | tr -d " ")" -lt 8192 ]'
check "NORTHSTAR.md has no ⟨confirm⟩ markers" '! grep -q "⟨confirm⟩" NORTHSTAR.md'
for s in "## Where a fix belongs" "## Runtime map" "## Non-negotiables" "## Anti-goals"; do
  check "NORTHSTAR.md has section '$s'" 'grep -q "^$s" NORTHSTAR.md'
done

# CLAUDE.md and AGENTS.md point at it in their first line; CLAUDE.md is tracked (not gitignored).
check "CLAUDE.md first line points at NORTHSTAR.md" 'head -1 CLAUDE.md | grep -q "NORTHSTAR\.md"'
check "AGENTS.md first line points at NORTHSTAR.md" 'head -1 AGENTS.md | grep -q "NORTHSTAR\.md"'
check "AGENTS.md keeps its Codex section" 'grep -q "^# ForgeDock for Codex" AGENTS.md'
check "root CLAUDE.md is not gitignored" '! git check-ignore -q CLAUDE.md'
check "nested CLAUDE.md stays gitignored" 'git check-ignore -q sub/CLAUDE.md'

# "Pipeline Hardening Principles" resolves to NORTHSTAR.md only; audit.md points there, not at CLAUDE.md.
HITS=$(grep -rl "Pipeline Hardening Principles" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.forge-lean \
  --exclude=northstar-docs.test.sh . | sed 's|^\./||')
check "'Pipeline Hardening Principles' resolves to NORTHSTAR.md only (got: $HITS)" '[ "$HITS" = "NORTHSTAR.md" ]'
check "commands/audit.md references NORTHSTAR.md" 'grep -q "NORTHSTAR\.md" commands/audit.md'
check "commands/audit.md has no CLAUDE.md reference" '! grep -q "CLAUDE\.md" commands/audit.md'

# lean dossier is indexed.
check "devdocs/modules/lean.md exists" '[ -f devdocs/modules/lean.md ]'
check "index.yaml modules has modules/lean.md" 'awk "/^modules:/{m=1;next} m&&/^[^[:space:]#]/{m=0} m" devdocs/index.yaml | grep -q "path: modules/lean.md"'
check "index.yaml has a lean domain" 'awk "/^domains:/{m=1;next} m&&/^[^[:space:]#]/{m=0} m" devdocs/index.yaml | grep -q "^  lean:"'

# Selective-loading regression: replay commands/work-on/build/context.md's always_load extraction (quote strip written portably).
INDEX_CONTENT=$(cat devdocs/index.yaml)
ALWAYS_LOAD_PATHS=$(echo "$INDEX_CONTENT" \
  | awk '/^always_load:/,/^[a-z]/' \
  | grep '^\s*-\s*path:' \
  | sed 's/.*path:\s*//' \
  | tr -d "\"'" \
  | tr -d '[:space:]')
check "always_load set is empty (NORTHSTAR.md loads via CLAUDE.md/AGENTS.md)" '[ -z "$ALWAYS_LOAD_PATHS" ]'
check "always_load is still the empty list" 'grep -qx "always_load: \[\]" devdocs/index.yaml'
PARSE_LINE="awk '/^always_load:/,/^[a-z]/'"
check "context.md still parses always_load this way" 'grep -qF "$PARSE_LINE" commands/work-on/build/context.md'
for d in pipeline github architecture devdocs scripts bin infra decisions lean; do
  check "domain '$d' present" 'grep -q "^  $d:" devdocs/index.yaml'
done
for m in runner orchestrate lean; do
  check "module '$m' present" 'grep -q "^  - name: $m$" devdocs/index.yaml'
done
# Every concrete (non-glob) doc path the index names exists under devdocs/.
PATHS=$(grep -E '^[[:space:]]*-?[[:space:]]*path:' devdocs/index.yaml | sed 's/.*path:[[:space:]]*//' | tr -d "\"'" | grep -v '\*' | sort -u)
while IFS= read -r p; do
  [ -n "$p" ] || continue
  check "indexed doc exists: devdocs/$p" '[ -f "devdocs/$p" ]'
done <<EOF_PATHS
$PATHS
EOF_PATHS

echo "northstar-docs.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" = 0 ]
