#!/usr/bin/env bash
# pr-issue-number.sh: sourced helper — the ONE numeric-validated "Closes #N" extractor for a PR body.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Source it, never exec it (resolve with `forge_resolve lib/pr-issue-number.sh`).
#   pr_issue_number            reads the PR body on stdin
#   pr_issue_number_of <body>  same, body as an argument
# Prints the number of the FIRST `Closes|Fixes|Resolves #N` reference (any keyword form, any case), or NOTHING when the body
# has none. The output is always ^[0-9]+$ or empty, so it is safe to place in an API path. A hand-rolled jq `gsub` returns the
# whole input when the pattern does not match, which is why every extraction goes through this helper instead.
pr_issue_number() {
    local n
    n=$(grep -oiE '(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+#[0-9]+' 2>/dev/null | head -n 1 | grep -oE '[0-9]+$' | head -n 1)
    case "$n" in ''|*[!0-9]*) return 0 ;; esac
    printf '%s\n' "$n"
}
pr_issue_number_of() { printf '%s\n' "${1:-}" | pr_issue_number; }
