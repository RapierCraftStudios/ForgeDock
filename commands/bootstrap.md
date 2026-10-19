---
description: Guided idea-to-backlog setup for a brand-new project — interview, defaults, doubts, spike doc, validated orchestrate-ready backlog
argument-hint: "<free text idea | path to existing docs> [--dry-run]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /bootstrap — idea to orchestrate-ready backlog

**Input**: $ARGUMENTS

This spec holds only judgment. All GitHub writes run in `scripts/bootstrap-create.mjs`. Templates live in `$(forge_root)/templates/bootstrap/`.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
BOOT_TPL="$(forge_root)/templates/bootstrap"; VALIDATE=$(forge_resolve bootstrap-validate.mjs); CREATE=$(forge_resolve bootstrap-create.mjs)
[ -n "$VALIDATE" ] && [ -n "$CREATE" ] || { echo "ERROR: bootstrap scripts not found in a trusted ForgeDock install" >&2; exit 3; }
```

1. **Read the input.** Use the free text, or read each doc at the given path(s).
2. **Interview** from `interview.md`. Cover every aspect it lists, briefly and conversationally. Skip what the input already answers.
3. **Fill the blanks.** Give every unanswered aspect a sensible default with a one-line rationale tied to what the user said, using the closest `stack-profiles.md` preset. Show them all in ONE editable "Here's what I assumed" list and apply the user's edits.
4. **Ask only genuine doubts** (they change architecture or cost: native vs PWA, data residency, self-host vs managed DB, product name, repo owner). Ask with AskUserQuestion, at most 4 multiple-choice questions per batch, each with a recommended option. Everything else stays a default.
5. **Spike doc.** Write `technical-spike.md` to `docs/engineering/technical-spike.md` (or the user's path). Fill every section and give each decision an ADR-style `**Rationale**:` line.
6. **Plan JSON** in `$TMPDIR` (shape: header of `bootstrap-validate.mjs` and `bootstrap-create.mjs`):
   - Milestones in build order, foundation first.
   - A `SPIKE` parent issue.
   - Sub-issues from `issue-body.md` with planned paths, `[type:*]` tags, `priority` and `component`.
   - `"ui": true` issues carry the full design spec. `"hero": true` issues route to `/design`.
   - One `needs-human-issue.md` issue per credential, account or external input. Code issues reference it as `#{{KEY}}` but never depend on it, and name the mock that keeps dev and CI green.
   - Sub-issues point at the spike via `**Parent**` only, never `Depends on`.
   - `guardrails` and `domainRules` from the interview.
7. **Validate.** Run `node "$VALIDATE" <plan>`. Fix the plan until it exits 0. Never create from an invalid plan.
8. **Create.** Run `node "$CREATE" <plan>`, adding `--dry-run` when the input has it (preview only, GitHub untouched). The script reuses existing issues by title and parent, so on an error re-run the same command to resume.
9. **Hand off.** Print the script's hand-off verbatim: what was created (links), what needs a human (links), and the `/orchestrate` command per milestone, in order.
