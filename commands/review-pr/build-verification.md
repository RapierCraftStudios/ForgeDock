---
description: review-pr fragment — Phase 2I build verification (TypeScript and Python) (read by /review-pr when its trigger holds; not a user entrypoint)
user-invocable: false
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<!-- Fragment of commands/review-pr.md (forge#3405): read on demand, run exactly as if inline. -->

### 2I: Build Verification (MANDATORY for staging→main AND milestone→staging)

```bash
CHANGED_FILES=$(gh pr diff "$PR_NUMBER" -R "$REPO" --name-only)
HAS_TS=$(echo "$CHANGED_FILES" | grep -E '\.(tsx?|jsx?)$' | head -1)
HAS_PY=$(echo "$CHANGED_FILES" | grep -E '\.py$' | head -1)
# Use POSIX-portable if/else (avoid bash-only [[ ]])
IS_STAGING_TO_MAIN="false"
if [ "$HEAD" = "staging" ] && [ "$BASE" = "main" ]; then IS_STAGING_TO_MAIN="true"; fi
IS_MILESTONE_TO_STAGING="false"
case "$HEAD" in milestone/*) if [ "$BASE" = "staging" ]; then IS_MILESTONE_TO_STAGING="true"; fi ;; esac
REQUIRES_FULL_BUILD="false"
if [ "$IS_STAGING_TO_MAIN" = "true" ] || [ "$IS_MILESTONE_TO_STAGING" = "true" ]; then REQUIRES_FULL_BUILD="true"; fi
```

**Trust boundary (forge#3434, forge#3435)**: `verification.commands.*` are executed with `eval`, so they are read from the trusted **base branch** (`origin/$BASE`), never from the checked-out PR head, where a fork PR could rewrite `forge.yaml`. Returning from the PR checkout fails closed: if the original ref cannot be restored, stop the review rather than continue (later steps and fragment Reads must not run against a PR-controlled tree).

```bash
git fetch origin "$BASE" -q 2>/dev/null || true
TRUSTED_CFG=$(git show "origin/$BASE:forge.yaml" 2>/dev/null || true)
trusted_cmd() { local q="${*}"; [ -n "$TRUSTED_CFG" ] && printf '%s\n' "$TRUSTED_CFG" | yq "$q // \"\"" 2>/dev/null || echo ''; }
ORIG_REF=$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)
checkout_pr()   { gh pr checkout "$PR_NUMBER" -R "$REPO" --detach 2>/dev/null || { echo "BLOCKED: gh pr checkout failed — build verification not run"; return 1; }; }
restore_ref()   { git checkout "$ORIG_REF" 2>/dev/null || { echo "BLOCKED: could not restore $ORIG_REF after PR checkout — stop the review (fail closed)"; return 1; }; }
```

**TypeScript files changed:**

Read (from the base branch) `forge.yaml → verification.commands.typescript.typecheck` and `.build`:

```bash
TS_TYPECHECK=$(trusted_cmd '.verification.commands.typescript.typecheck')
TS_BUILD=$(trusted_cmd '.verification.commands.typescript.build')
checkout_pr || exit 1

if [ -n "$TS_TYPECHECK" ]; then
    eval "$TS_TYPECHECK" 2>&1
    TSC_EXIT=$?
else
    echo "SKIPPED — typescript.typecheck not configured in verification.commands"
    TSC_EXIT=0
fi

if [ -n "$TS_BUILD" ] && { [ "$REQUIRES_FULL_BUILD" = "true" ] || [ "$TSC_EXIT" -eq 0 ]; }; then
    eval "$TS_BUILD" 2>&1 | tail -30
    BUILD_EXIT=$?
elif [ -z "$TS_BUILD" ]; then
    echo "SKIPPED — typescript.build not configured in verification.commands"
fi

restore_ref || exit 1
```

If `TSC_EXIT != 0`: **CONFIRMED blocking** — type errors.
If `BUILD_EXIT != 0`: **CONFIRMED blocking** — build/prerender failure.

**CRITICAL**: typecheck alone is NOT sufficient for staging→main or milestone→staging — configure `typescript.build` in `verification.commands` to catch SSG/prerender failures that typecheck misses.

**Python files changed:**

Read (from the base branch) `forge.yaml → verification.commands.python.format` and `.build`:

```bash
PYTHON_FORMAT=$(trusted_cmd '.verification.commands.python.format')
checkout_pr || exit 1

# Compile-check all changed Python files (language-universal — no config needed)
echo "$CHANGED_FILES" | grep '\.py$' | while IFS= read -r f; do python3 -m py_compile "$f" 2>&1; done

if [ "$REQUIRES_FULL_BUILD" = "true" ]; then
    if [ -n "$PYTHON_FORMAT" ]; then
        eval "$PYTHON_FORMAT" 2>&1
    else
        echo "SKIPPED — python.format not configured in verification.commands (full-build format check skipped)"
    fi
fi

restore_ref || exit 1
```

**BLOCKING if any check fails.** Fix before merge — do not approve with known build/format failures.
