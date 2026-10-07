#!/usr/bin/env bash
# is-docs-only.sh — the single docs-only predicate shared by review-pr.md Phase 8,
# work-on/review.md R1.5 and orchestrate/phase-4-execution.md (forge#3134).
# Reads a newline-separated changed-file list on stdin. Exit 0 iff the list is non-empty and EVERY
# path is a Markdown file that is not executable pipeline/agent instruction content:
#   - only *.md counts (docs/** non-markdown assets do NOT)
#   - matching is case-insensitive and ignores a leading ./
#   - excluded at ANY depth: commands/, .claude/, .claude-plugin/, .agents/, .codex/, .cursor/, .github/, hooks/, agents/ directories
#   - excluded at ANY depth by basename prefix: agents*.md, claude*.md, skill*.md, gemini*.md (AGENTS.md, CLAUDE.md, CLAUDE.local.md, SKILL.md, GEMINI.md, ...)
# Exit 1 otherwise (including empty input: fail closed).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
awk '
  NF==0 {next}
  { n++; p=tolower($0); sub(/^\.\//, "", p) }
  !(p ~ /\.md$/) {bad=1; next}
  p ~ /(^|\/)(commands|\.claude|\.claude-plugin|\.agents|\.codex|\.cursor|\.github|hooks|agents)\// {bad=1; next}
  p ~ /(^|\/)(agents|claude|skill|gemini)[^\/]*\.md$/ {bad=1; next}
  END{exit (bad || n==0)}
'
