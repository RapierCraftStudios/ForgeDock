#!/usr/bin/env bash
# is-docs-only.sh — the single docs-only predicate shared by review-pr.md Phase 8,
# work-on/review.md R1.5 and orchestrate/phase-4-execution.md (forge#3134, forge#3145).
# Reads a newline-separated changed-file list on stdin. Callers MUST feed BOTH sides of every rename
# (git diff --no-renames, or filename + previous_filename from the PR files API): a rename-collapsed
# list hides the source path of a file moved into docs/.
# Exit 0 iff the list is non-empty and EVERY path is a Markdown file that is positively allowlisted AND
# is not executable pipeline/agent instruction content:
#   - only *.md counts (docs/** non-markdown assets do NOT); matching is case-insensitive, leading ./ ignored
#   - allowlist (unknown paths fail closed): docs/**/*.md, or a root-level README*/CHANGELOG*/CONTRIBUTING/SECURITY/GOVERNANCE *.md
#   - any ".." path segment is rejected
#   - excluded at ANY depth (even under docs/): commands/, devdocs/, templates/, skills/, agents/, hooks/,
#     .claude/, .claude-plugin/, .agents/, .codex/, .cursor/, .github/, .opencode/, .gemini/, .kiro/ directories
#   - excluded at ANY depth by exact basename: agents.md, claude.md, claude.local.md, skill.md, gemini.md
#     (and dotted variants such as AGENTS.override.md); docs like skillset.md or agents-guide.md are fine
# Exit 1 otherwise (including empty input: fail closed).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
awk '
  NF==0 {next}
  { n++; p=tolower($0); sub(/^\.\//, "", p) }
  !(p ~ /\.md$/) {bad=1; next}
  p ~ /(^|\/)\.\.(\/|$)/ {bad=1; next}
  p ~ /(^|\/)(commands|devdocs|templates|skills|agents|hooks|\.claude|\.claude-plugin|\.agents|\.codex|\.cursor|\.github|\.opencode|\.gemini|\.kiro)\// {bad=1; next}
  p ~ /(^|\/)(agents|claude|skill|gemini)(\.[^\/]*)?\.md$/ {bad=1; next}
  p ~ /^docs\/.+\.md$/ {next}
  p ~ /^(readme|changelog)[^\/]*\.md$/ {next}
  p ~ /^(contributing|security|governance)\.md$/ {next}
  {bad=1}
  END{exit (bad || n==0)}
'
