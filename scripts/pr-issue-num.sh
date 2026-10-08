#!/usr/bin/env bash
# pr-issue-num.sh — print the issue number a PR body links (`Closes #N`, else the first `#N`).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One shared copy of the extraction duplicated across /review-pr phases (forge#3405).
# Usage: pr-issue-num.sh <pr-number> <owner/repo>
# Output: the issue number on stdout, or nothing when the body links none.
# Exit:  0 always for a well-formed call (a gh failure prints nothing), 2 usage error.
set -u
if [ $# -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then echo "usage: pr-issue-num.sh <pr-number> <owner/repo>" >&2; exit 2; fi
gh pr view "$1" -R "$2" --json body --jq '.body | gsub("(?s).*?(?:Closes #|#)(?<n>[0-9]+).*"; "\(.n)") // empty' 2>/dev/null | head -1
exit 0
