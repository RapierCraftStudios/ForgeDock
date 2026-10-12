#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# with-run-tmpdir.sh — run a command with a per-run TMPDIR that is removed when it exits.
#
# Usage: bash scripts/with-run-tmpdir.sh <command> [args...]
# Children inherit the exported TMPDIR (os.tmpdir() honours it), so temp dirs a test
# forgets to remove cannot outlive the run. The command's exit code is preserved.
# Bash 3.2 portable.

set -u

[ "$#" -gt 0 ] || { echo "with-run-tmpdir: no command given" >&2; exit 2; }

RUN_TMP=$(mktemp -d) || { echo "with-run-tmpdir: cannot create per-run TMPDIR" >&2; exit 1; }
trap 'rm -rf "$RUN_TMP"' EXIT
export TMPDIR="$RUN_TMP"

"$@"
