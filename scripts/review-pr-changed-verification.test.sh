#!/usr/bin/env bash
# review-pr-changed-verification.test.sh — guards for the changed-file scoped Phase 2 steps (forge#4772): the spec exports
# FORGE_CHANGED_FILES, runs *_changed steps with printed exit codes, and prints SKIPPED for tests only when neither form is configured.
# The Phase 2 fence is extracted from the spec and run against a stub forge.yaml.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT/commands/review-pr.md"
PASS=0; FAILN=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ok() { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
command -v jq >/dev/null 2>&1 || { echo "review-pr-changed-verification.test.sh: jq missing, skipped"; exit 0; }
# Stub yq (config is written as JSON, valid YAML): the fence only calls `yq '<jq-style path> // ""' file`.
mkdir -p "$TMP/bin"; printf '#!/usr/bin/env bash\njq -r "$1" "$2"\n' > "$TMP/bin/yq"; chmod +x "$TMP/bin/yq"

# Spec wording.
for k in typescript.typecheck_changed typescript.test_changed python.test_changed FORGE_CHANGED_FILES; do
  if grep -qF "$k" "$SPEC"; then ok; else bad "review-pr.md lacks $k"; fi
  if grep -qF "$k" "$ROOT/docs/CONFIG.md"; then ok; else bad "CONFIG.md lacks $k"; fi
done

# Extract the Phase 2 fence (the one that creates the per-PR worktree) and run its test/typecheck logic in a scratch repo.
awk '/^## Phase 2: Automated Checks/{p=1} p&&/^```bash/{f=1;next} f&&/^```/{exit} f{print}' "$SPEC" > "$TMP/phase2.sh"
[ -s "$TMP/phase2.sh" ] && ok || bad "could not extract the Phase 2 fence"

git init -q "$TMP/repo"; cd "$TMP/repo" || exit 1
git config user.email t@example.com; git config user.name t
mkdir -p src node_modules; echo 'export {}' > src/a.ts; echo 'x=1' > b.py; git add -A; git commit -qm c
SHA=$(git rev-parse HEAD)
printf '%s\n' src/a.ts b.py gone.ts > "$TMP/files"
jq -n --rawfile f "$TMP/files" '{full_files: ($f | split("\n") | map(select(length>0)))}' > "$TMP/ctx.json"
run() { # name cfg-body ; prints output into $TMP/out
  printf '%s' "$2" > "$TMP/forge.yaml"
  sed -e "s|{PR_NUMBER}|1|" -e "s|{GH_REPO}|o/r|" -e "s|{REVIEW_SHA}|$SHA|" -e "s|{REQUIRES_FULL_BUILD}|false|" -e "s|{CONTEXT_FILE}|$TMP/ctx.json|" "$TMP/phase2.sh" > "$TMP/run.sh"
  PATH="$TMP/bin:$PATH" FORGE_CONFIG="$TMP/forge.yaml" TMPDIR="$TMP" bash "$TMP/run.sh" > "$TMP/out" 2>&1
}
have() { if grep -qF -- "$2" "$TMP/out"; then ok; else bad "$1: output lacks '$2'"; fi; }
lack() { if grep -qF -- "$2" "$TMP/out"; then bad "$1: output has '$2'"; else ok; fi; }

run changed '{"verification":{"commands":{"typescript":{"test_changed":"echo CF=$(echo $FORGE_CHANGED_FILES | tr \" \" \",\")","typecheck_changed":"true"},"python":{"test_changed":"exit 1"}}}}'
have changed "EXIT typescript.test_changed=0"
have changed "EXIT typescript.typecheck_changed=0"
have changed "EXIT python.test_changed=1"
have changed "BLOCKING: python tests (test_changed) failed"
have changed "CF=src/a.ts,b.py"      # deleted file dropped
lack changed "gone.ts"
lack changed "SKIPPED — no test commands configured"

run none '{"verification":{"commands":{"typescript":{"build":"true"}}}}'
have none "SKIPPED — no test commands configured"

echo "review-pr-changed-verification.test.sh: $PASS passed, $FAILN failed"; [ "$FAILN" -eq 0 ]
