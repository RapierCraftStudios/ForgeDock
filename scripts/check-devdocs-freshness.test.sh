#!/usr/bin/env bash
# check-devdocs-freshness.test.sh — fixture PRs for scripts/check-devdocs-freshness.sh (forge#4185).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-devdocs-freshness.sh"
PASS=0; FAILN=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }

git init -q --bare "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/w" 2>/dev/null
cd "$TMP/w" || exit 1
git config user.email t@example.com; git config user.name t
mkdir -p bin/lean scripts/fixtures devdocs/modules devdocs/decisions
printf 'export const x = 1;\n' > bin/lean/lean.mjs
printf 'test\n' > bin/lean/lean.test.mjs
printf '#!/bin/sh\necho foo\n' > scripts/foo.sh
printf 'fixture\n' > scripts/fixtures/f.txt
printf '# lean\n' > devdocs/modules/lean.md
printf '# runner\n' > devdocs/modules/runner.md
: > devdocs/decisions/.gitkeep
cat > devdocs/index.yaml <<'EOF'
version: 2
domains:
  lean:
    docs:
      - path: modules/lean.md
modules:
  - name: runner
    glob: "bin/runner*"
    path: modules/runner.md
    authority: required

  - name: lean
    glob: "bin/lean/*"
    path: modules/lean.md
    authority: required

always_load: []
EOF
cat > NORTHSTAR.md <<'EOF'
# North Star

## Non-negotiables

1. Deterministic first.

## Runtime map

| Path | Role |
|---|---|
| `bin/lean/*` | lean engine |

## Anti-goals

- More agents.
EOF
git add -A; git commit -qm base; git branch -M staging; git push -q origin staging 2>/dev/null
git checkout -q -b feat

reset() { git reset -q --hard origin/staging; git clean -qfd; }
commit() { git add -A; git commit -qm change; }
run() { # name want_rc [env...]
  local name="$1" want="$2"; shift 2
  env PR_BODY="" "$@" bash "$S" origin/staging >"$TMP/out" 2>&1
  local rc=$?
  if [ "$rc" = "$want" ]; then PASS=$((PASS+1)); else bad "$name: rc=$rc want=$want"; cat "$TMP/out"; fi
}

reset; printf 'export const x = 2;\n' > bin/lean/lean.mjs; commit
run "bin/lean/lean.mjs without docs fails" 1
grep -q 'bin/lean/lean.mjs' "$TMP/out" || bad "failure output names bin/lean/lean.mjs"

reset; printf 'export const x = 2;\n' > bin/lean/lean.mjs; printf '# lean\nnew entry\n' > devdocs/modules/lean.md; commit
run "bin/lean/lean.mjs + dossier passes" 0

reset; printf 'export const x = 2;\n' > bin/lean/lean.mjs; printf '# runner\nedit\n' > devdocs/modules/runner.md; commit
run "bin/lean/lean.mjs + unrelated dossier fails" 1

reset; printf 'export const x = 2;\n' > bin/lean/lean.mjs; commit
run "exemption line passes" 0 PR_BODY="Summary
docs-not-needed: refactor only, no behaviour change"
run "CRLF exemption line passes" 0 PR_BODY="$(printf 'Summary\r\ndocs-not-needed: typo fix\r\n')"
run "empty exemption reason fails" 1 PR_BODY="docs-not-needed:   "
run "inline mention is not an exemption" 1 PR_BODY="we said docs-not-needed: no"
printf 'docs-not-needed: via file\n' > "$TMP/body"
env PR_BODY="" bash "$S" origin/staging --body-file "$TMP/body" >"$TMP/out" 2>&1 && PASS=$((PASS+1)) || bad "--body-file exemption passes"

reset; printf 'test2\n' > bin/lean/lean.test.mjs; printf 'fixture2\n' > scripts/fixtures/f.txt; printf 'x\n' > scripts/new.test.sh; commit
run "test-only and fixture changes pass" 0

reset; printf '#!/bin/sh\necho bar\n' > scripts/foo.sh; commit
run "scripts/foo.sh without docs fails" 1

reset; printf '#!/bin/sh\necho bar\n' > scripts/foo.sh; printf '# ADR\n' > devdocs/decisions/4185-x.md; commit
run "scripts/foo.sh + new decision passes" 0

reset; printf '# ADR\n' > devdocs/decisions/4185-x.md; git add -A; git commit -qm adr; git push -q origin HEAD:staging 2>/dev/null
git fetch -q origin; reset; printf '#!/bin/sh\necho bar\n' > scripts/foo.sh; printf '# ADR\nedited\n' > devdocs/decisions/4185-x.md; commit
run "editing an existing decision does not count" 1

reset; printf '#!/bin/sh\necho bar\n' > scripts/foo.sh; sed -i.bak 's/Deterministic first./Deterministic first, always./' NORTHSTAR.md; rm -f NORTHSTAR.md.bak; commit
run "NORTHSTAR edit outside Runtime map fails" 1

reset; printf '#!/bin/sh\necho bar\n' > scripts/foo.sh; sed -i.bak 's/| lean engine |/| lean engine (canonical) |/' NORTHSTAR.md; rm -f NORTHSTAR.md.bak; commit
run "NORTHSTAR edit inside Runtime map passes" 0

reset; printf '#!/bin/sh\necho bar\n' > scripts/foo.sh; sed -i.bak '/| `bin\/lean\/\*` | lean engine |/d' NORTHSTAR.md; rm -f NORTHSTAR.md.bak; commit
run "NORTHSTAR row deleted inside Runtime map passes" 0

reset; printf 'readme\n' > README.md; commit
run "no relevant changes pass" 0

reset
env PR_BODY="" bash "$S" no/such-ref >"$TMP/out" 2>&1; [ $? = 2 ] && PASS=$((PASS+1)) || bad "unknown base ref exits 2"
env bash "$S" >"$TMP/out" 2>&1; [ $? = 2 ] && PASS=$((PASS+1)) || bad "missing base ref and no upstream exits 2"

# #4220: without a base ref the branch's upstream is the base (CI always passes it explicitly).
git branch -q --set-upstream-to=origin/staging
printf '#!/bin/sh\necho bar\n' > scripts/foo.sh; commit
env PR_BODY="" bash "$S" >"$TMP/out" 2>&1; [ $? = 1 ] && PASS=$((PASS+1)) || bad "no base ref: upstream diff, docs missing fails"
printf 'docs-not-needed: fixture\n' > "$TMP/body"
env PR_BODY="" bash "$S" --body-file "$TMP/body" >"$TMP/out" 2>&1; [ $? = 0 ] && PASS=$((PASS+1)) || bad "no base ref + --body-file uses the upstream"
printf '# ADR\n' > devdocs/decisions/4220-x.md; commit
env PR_BODY="" bash "$S" >"$TMP/out" 2>&1; [ $? = 0 ] && PASS=$((PASS+1)) || bad "no base ref: upstream diff with a new decision passes"
git branch -q --unset-upstream

echo "check-devdocs-freshness.test.sh: $PASS passed, $FAILN failed"
[ "$FAILN" = 0 ]
