#!/usr/bin/env bash
# is-docs-only.sh — the single docs-only predicate shared by review-pr.md Phase 8,
# work-on/review.md R1.5 and orchestrate/phase-4-execution.md (forge#3134).
# Reads a newline-separated changed-file list on stdin. Exit 0 iff the list is non-empty and EVERY
# path is a Markdown file that is not executable pipeline/agent instruction content:
#   - only *.md counts (docs/** non-markdown assets do NOT)
#   - excluded at ANY depth: commands/, .claude/, .agents/, .codex/, .github/ directories
#   - excluded at ANY depth by basename: AGENTS.md, CLAUDE.md, SKILL.md
# Exit 1 otherwise (including empty input: fail closed).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
awk '
  NF==0 {next}
  { n++; p=$0 }
  !(p ~ /\.md$/) {bad=1; next}
  p ~ /(^|\/)(commands|\.claude|\.agents|\.codex|\.github)\// {bad=1; next}
  p ~ /(^|\/)(AGENTS|CLAUDE|SKILL)\.md$/ {bad=1; next}
  END{exit (bad || n==0)}
'
