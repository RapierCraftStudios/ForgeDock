#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Lint: every work-on:build:validate Skill( invocation in build.md must carry --files,
# and the B6.5 repair section must contain an explicit one (forge#3254).
# Usage: bash scripts/lint-build-validate-files.sh [path/to/build.md]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SPEC="${1:-$HERE/../commands/work-on/build.md}"
[ -f "$SPEC" ] || { echo "lint-build-validate-files: spec not found: $SPEC" >&2; exit 2; }
rc=0
calls=$(grep -n 'Skill(skill=.*work-on:build:validate' "$SPEC" || true)
if [ -z "$calls" ]; then
  echo "FAIL: no work-on:build:validate Skill( invocation found in $SPEC" >&2
  exit 1
fi
bad=$(printf '%s\n' "$calls" | grep -vF -- '--files' || true)
if [ -n "$bad" ]; then
  printf '%s\n' "$bad" | while IFS= read -r l; do
    echo "FAIL: $SPEC:${l%%:*}: validate invocation lacks --files" >&2
  done
  rc=1
fi
if ! awk '/Phase B6\.5/{f=1} f' "$SPEC" | grep 'Skill(skill=.*work-on:build:validate' | grep -qF -- '--files'; then
  echo "FAIL: $SPEC: B6.5 repair section has no explicit validate invocation carrying --files" >&2
  rc=1
fi
[ "$rc" -eq 0 ] && echo "OK: all validate invocations carry --files"
exit "$rc"
