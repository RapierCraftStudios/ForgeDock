#!/usr/bin/env bash
# spec-no-worktree-script.test.sh — guard/gate scripts named in specs must resolve from ForgeDock's
# install root only. A candidate under {WORKTREE_PATH}/scripts, {REPO_PATH}/scripts or a cwd-relative
# scripts/ is author-controlled (the PR branch under audit) and would let a branch supply the script
# that gates it. Read-only data uses (grep of a file's contents, JSON manifest reads) are not matched.
# Usage: bash scripts/spec-no-worktree-script.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$HERE/.."
PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }

# Execution-resolution patterns: a fallback assignment or candidate list pointing at a repo-controlled scripts dir.
PATTERNS=(
  '\|\| [A-Za-z_]+="\{(WORKTREE_PATH|REPO_PATH)\}/scripts/[A-Za-z0-9_.-]+\.sh"'
  'for _d in [^;]*\{(WORKTREE_PATH|REPO_PATH)\}/scripts'
  '\$\{FORGEDOCK_SCRIPTS:-scripts\}'
  '\|\| [A-Za-z_]+="scripts/[A-Za-z0-9_.-]+\.sh"'
)
FILES=$(cd "$ROOT" && find commands -name '*.md' | sort)
for p in "${PATTERNS[@]}"; do
  hits=$(cd "$ROOT" && grep -nE "$p" $FILES 2>/dev/null || true)
  [ -z "$hits" ] && ok || bad "repo-controlled script resolution matches /$p/: $hits"
done

# Representative swept instances must each carry the install-root-only resolution.
chk() { grep -qF "$2" "$ROOT/$1" && ok || bad "$1 lacks: $2"; }
chk commands/work-on/build/validate.md 'ANCESTRY_SCRIPT="${FORGE_ROOT:+$FORGE_ROOT/scripts/check-branch-ancestry.sh}"'
chk commands/quality-gate.md 'VALIDATOR="${FORGE_ROOT:+$FORGE_ROOT/scripts/validate-spec-graph.sh}"'
chk commands/quality-gate.md 'CONFLICT_CHECKER="${FORGE_ROOT:+$FORGE_ROOT/scripts/check-native-conflicts.sh}"'
chk commands/quality-gate.md 'SPEC_BASH_CHECKER="${FORGE_ROOT:+$FORGE_ROOT/scripts/check-spec-bash.sh}"'
chk commands/quality-gate.md 'CLASSIFIER="${FORGE_ROOT:+$FORGE_ROOT/scripts/flaky-quarantine.sh}"'
chk commands/review-pr.md 'CLASSIFIER="${FORGE_ROOT:+$FORGE_ROOT/scripts/flaky-quarantine.sh}"'
# validate.md must not name the worktree scripts dir at all (ac-1)
grep -qF '{WORKTREE_PATH}/scripts' "$ROOT/commands/work-on/build/validate.md" && bad "validate.md references {WORKTREE_PATH}/scripts" || ok

# Behavioral: the validate.md ancestry resolver with FORGE_ROOT unset/empty must resolve to nothing (never /scripts or ./scripts).
for fr in "" "/nonexistent-root"; do
  out=$(FORGE_ROOT="$fr" bash -c 'ANCESTRY_SCRIPT="${FORGE_ROOT:+$FORGE_ROOT/scripts/check-branch-ancestry.sh}"; [ -f "$ANCESTRY_SCRIPT" ] || ANCESTRY_SCRIPT=""; printf %s "$ANCESTRY_SCRIPT"')
  [ -z "$out" ] && ok || bad "resolver yielded '$out' for FORGE_ROOT='$fr'"
done

echo "spec-no-worktree-script tests: pass=$PASS fail=$FAILN"
[ "$FAILN" -eq 0 ]
