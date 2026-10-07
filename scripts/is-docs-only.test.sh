#!/usr/bin/env bash
# is-docs-only.test.sh — cases for scripts/is-docs-only.sh (forge#3134).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/is-docs-only.sh"
PASS=0; FAILN=0
t() { # name want files...
  local name="$1" want="$2"; shift 2
  printf '%s\n' "$@" | bash "$S"; local rc=$?
  if [ "$rc" = "$want" ]; then PASS=$((PASS+1)); else FAILN=$((FAILN+1)); echo "FAIL: $name (rc=$rc want $want)"; fi
}
t "docs md" 0 docs/a.md README.md docs/sub/b.md
t "root AGENTS.md" 1 AGENTS.md
t "root CLAUDE.md" 1 docs/a.md CLAUDE.md
t "nested AGENTS.md" 1 sub/AGENTS.md
t "nested CLAUDE.md" 1 pkg/x/CLAUDE.md
t ".codex md" 1 .codex/x.md
t "SKILL.md" 1 skills/a/SKILL.md
t ".github md" 1 .github/x.md
t ".agents md" 1 .agents/skills/x.md
t ".claude md" 1 .claude/x.md
t "commands md" 1 commands/work-on.md
t "nested commands md" 1 pkg/commands/x.md
t "docs non-md" 1 docs/diagram.png
t "docs yml" 1 docs/a.md docs/site/mkdocs.yml
t "code file" 1 docs/a.md bin/x.mjs
t "empty" 1
echo "is-docs-only: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
