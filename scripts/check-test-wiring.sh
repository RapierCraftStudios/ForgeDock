#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Lint: every scripts/*.test.sh must be referenced by a workflow in .github/workflows/*.yml.
# An unreferenced test never runs in CI, so regressions in the script under test merge silently.
# Lists EVERY unwired test before exiting non-zero. bash 3.2 portable (no bash-4 builtins, no PCRE grep).
#
# Usage: bash scripts/check-test-wiring.sh [<scripts_dir> [<workflows_dir>]]
#   defaults: scripts  .github/workflows   (relative to the current directory)
# Exit: 0 all wired | 1 one or more unwired, or workflows dir missing/empty | 2 bad scripts dir

set -u
SCRIPTS_DIR="${1:-scripts}"
WORKFLOWS_DIR="${2:-.github/workflows}"

[ -d "$SCRIPTS_DIR" ] || { echo "check-test-wiring: scripts dir not found: $SCRIPTS_DIR" >&2; exit 2; }
[ -d "$WORKFLOWS_DIR" ] || { echo "check-test-wiring: workflows dir not found: $WORKFLOWS_DIR" >&2; exit 1; }

wf_files=""
for w in "$WORKFLOWS_DIR"/*.yml "$WORKFLOWS_DIR"/*.yaml; do
  [ -f "$w" ] && wf_files="$wf_files
$w"
done
if [ -z "$wf_files" ]; then
  echo "check-test-wiring: no workflow files in $WORKFLOWS_DIR" >&2
  exit 1
fi

total=0
unwired=0
for t in "$SCRIPTS_DIR"/*.test.sh; do
  [ -f "$t" ] || continue
  total=$((total+1))
  base=$(basename "$t")
  # Escape '.' for ERE; names are [A-Za-z0-9._-]. Delimiter-aware: the name must not be a
  # fragment of a longer filename (foo.test.sh must not be satisfied by barfoo.test.sh).
  esc=$(printf '%s' "$base" | sed 's/\./\\./g')
  found=0
  while IFS= read -r w; do
    [ -n "$w" ] || continue
    if grep -Eq "(^|[^A-Za-z0-9._-])${esc}([^A-Za-z0-9._-]|\$)" "$w" 2>/dev/null; then found=1; break; fi
  done <<EOF2
$wf_files
EOF2
  if [ "$found" -eq 0 ]; then
    echo "UNWIRED: $base is not referenced by any workflow in $WORKFLOWS_DIR"
    unwired=$((unwired+1))
  fi
done

if [ "$unwired" -gt 0 ]; then
  echo "check-test-wiring: $unwired of $total test script(s) unwired — add each to a workflow (e.g. shell-compat.yml)" >&2
  exit 1
fi
echo "check-test-wiring: all $total test script(s) wired"
exit 0
