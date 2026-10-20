#!/usr/bin/env bash
# affected-files-check.test.sh — tests for scripts/affected-files-check.sh (forge#4172)
#
# Builds a throwaway git repo under $TMPDIR; no network or GitHub access.
# Usage: bash scripts/affected-files-check.test.sh
# Exit code: 0 if all assertions pass, 1 if any fail.
#
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/affected-files-check.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/afc-test.XXXXXX")
trap 'rm -rf "$T"' EXIT

PASS=0; FAIL=0
expect() { # label expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3"; fi
}
run() { # args... -> "<exit>|<stdout lines joined by ;>"
  local out rc
  out=$(cd "$T/repo" && bash "$CHECK" "$@" 2>/dev/null); rc=$?
  printf '%s|%s' "$rc" "$(printf '%s' "$out" | tr '\n' ';')"
}
body() { # name lines... -> body file path
  local f="$T/$1.md"; shift
  { printf '## Problem\n\nx `not/listed.ts`\n\n## Affected Files\n\n'; printf '%s\n' "$@"; printf '\n## Acceptance Criteria\n\n- [ ] y\n'; } > "$f"
  printf '%s' "$f"
}

mkdir -p "$T/repo/src"
git -C "$T/repo" init -q -b main
printf 'x\n' > "$T/repo/src/existing.ts"
git -C "$T/repo" add -A && git -C "$T/repo" -c user.name=t -c user.email=t@t commit -qm init

cat > "$T/spike.md" <<'EOF'
# Technical spike

## Repo layout

Apps live in `apps/web/` and the shared schema is `packages/db/schema.sql`.

```
apps/api/            # backend
├── apps/api/src/main.ts
└── docs/README.md
```

## Data model

`packages/billing/` is mentioned outside the layout section.
EOF
printf '# Spike\n\n## Stack\n\n`apps/web/`\n' > "$T/nolayout.md"

R="--ref main"

# Brownfield (no --spike): unchanged semantics — existing OK, missing MISSING.
expect "brownfield existing path" "0|OK src/existing.ts" "$(run "$(body b1 '1. `src/existing.ts`: the file')" $R)"
expect "brownfield missing path" "1|MISSING apps/web/page.tsx" "$(run "$(body b2 '1. `apps/web/page.tsx`: planned')" $R)"
expect "brownfield ignores paths outside the section" "0|OK src/existing.ts" "$(run "$(body b3 '- `src/existing.ts`')" $R)"
expect "brownfield unresolvable default refs -> MISSING" "1|MISSING src/existing.ts" "$(run "$(body b4 '- `src/existing.ts`')")"

# Greenfield (--spike): planned paths validated against the declared layout.
expect "greenfield path under declared dir" "0|PLANNED apps/web/app/page.tsx" "$(run "$(body g1 '- `apps/web/app/page.tsx`')" $R --spike "$T/spike.md")"
expect "greenfield path equal to declared file" "0|PLANNED packages/db/schema.sql" "$(run "$(body g2 '- `packages/db/schema.sql`')" $R --spike "$T/spike.md")"
expect "greenfield path from fenced tree" "0|PLANNED apps/api/src/main.ts;PLANNED apps/api/routes.ts" "$(run "$(body g3 '- `apps/api/src/main.ts`' '- `apps/api/routes.ts`')" $R --spike "$T/spike.md")"
expect "greenfield path outside layout" "1|PLANNED apps/web/x.ts;MISSING packages/billing/x.ts" "$(run "$(body g4 '- `apps/web/x.ts`' '- `packages/billing/x.ts`')" $R --spike "$T/spike.md")"
expect "greenfield existing path still OK" "0|OK src/existing.ts" "$(run "$(body g5 '- `src/existing.ts`')" $R --spike "$T/spike.md")"
expect "greenfield file prefix is not a directory" "1|MISSING packages/db/schema.sql.bak" "$(run "$(body g6 '- `packages/db/schema.sql.bak`')" $R --spike "$T/spike.md")"

# Usage errors.
expect "spike doc missing" "2|" "$(run "$(body u1 '- `apps/web/x.ts`')" $R --spike "$T/absent.md")"
expect "spike doc without repo layout" "2|" "$(run "$(body u2 '- `apps/web/x.ts`')" $R --spike "$T/nolayout.md")"
expect "no body file" "2|" "$(run)"
expect "body without Affected Files paths" "1|MISSING (no backticked paths in ## Affected Files)" "$(run "$(body e1 'Files to be identified during investigation.')" $R)"

echo "affected-files-check.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
