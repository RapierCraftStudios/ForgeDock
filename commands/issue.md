---
description: Create a well-structured GitHub issue that the pipeline can consume reliably
argument-hint: "[description of the problem or feature] [--dry-run] | --title \"...\" --body-file <path> --label \"...\" [--milestone \"...\"] [--dry-run]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /issue — Deterministic Issue Creator

> **Skill names**: `{FORGE_SKILL_PREFIX}` is `forgedock:` (plugin install) or empty (`install.sh`), resolved once per run by `commands/work-on.md` § Skill Name Resolution. If the skill is not found under either name, STOP and report "skill not found" — never run the phase inline.

**Input**: $ARGUMENTS

You create GitHub issues with the structure the `/work-on` pipeline expects. Every deterministic step (argument parsing, body-file integrity, dedup, mandatory sections, REST create with token read-back, milestone, project board) runs in `scripts/issue-create.sh`. This spec holds only routing and the drafting judgment. Issues are created by default once the checks pass; `--dry-run` prints the draft instead.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet". Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

## Arguments

| Flag | Effect |
|------|--------|
| (none) | Interactive: read code, draft, then create through the script (below). |
| `--dry-run` | Validate and print the draft; create nothing. Never bypasses the dedup STOP. |
| `--greenfield` | Affected Files may be *planned* paths, validated against the spike doc's declared repo layout (Validate, below). Also on automatically when the spike doc has a `Repo layout` heading. <!-- Added: forge#4172 --> |
| `--spike <path>` | Spike doc for greenfield mode (implies `--greenfield`). Default `docs/engineering/technical-spike.md`, repo-relative. |
| `--title "..."` | **The sole programmatic-mode trigger.** Final title; skips drafting. |
| `--body "..."` / `--body-file <path>` | Final body; exactly one is required with `--title`. |
| `--label "..."` | One label; repeatable. |
| `--milestone "..."` | Milestone title (optional). |
| `--exclude "N,N,..."` | Issue numbers removed from the dedup candidate set (a deliberate supersede, e.g. a P3 batch issue restating its members). Narrows the set; NOT a `--force` equivalent. |

## Programmatic Mode (`--title` present)

Run exactly one call and relay its result. Do not read code, draft, or re-run any check yourself.

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
ISSUE_CREATE_SCRIPT=$(forge_resolve issue-create.sh)
[ -n "$ISSUE_CREATE_SCRIPT" ] || { echo "ERROR: issue-create.sh not found in a trusted ForgeDock install" >&2; echo "ISSUE_CREATE_RESULT:ERROR"; exit 3; }
bash "$ISSUE_CREATE_SCRIPT" --args "$ARGUMENTS"
```

The script prints exactly one result line; report it verbatim and exit with its code:

| Exit | Line | Meaning |
|------|------|---------|
| 0 | `ISSUE_CREATE_RESULT:CREATED number=N url=U` | Created; the create-token read-back (and, for `--body-file`, the integrity marker read-back) passed |
| 0 | `ISSUE_CREATE_RESULT:DRY_RUN` | `--dry-run`: draft printed, nothing created |
| 1 | `ISSUE_CREATE_RESULT:DEDUP number=N` | Open near-duplicate #N; nothing created. STOP |
| 2 | `ISSUE_CREATE_RESULT:USAGE` | Bad flags, body, integrity marker or dedup invocation; fix the call |
| 3 | `ISSUE_CREATE_RESULT:ERROR` | GitHub rejected the create or a read-back failed; never report success |

The repo comes from `forge.yaml` (`project.owner/project.repo`); pass `--repo OWNER/NAME` outside `--args` for a satellite repo. Missing `## Problem`, `## Affected Files` or `## Acceptance Criteria` sections get placeholders, never a failure.

### `--body-file` integrity contract (MANDATORY for the caller)

Do not use a generic name under shared `/tmp`, even with `mktemp`. Prefer the session scratchpad (or a repo-relative scratch directory): a Windows-native `gh` may not resolve Git Bash `/tmp`. Never hand-roll a temporary path or use a single-segment root path such as `/tmp_invbody_31076.txt`, which can require interactive deletion approval and hang unattended runs. Make the filename include the target issue or PR number and an agent-unique token, and let `mktemp` add the random suffix:

```bash
SCRATCHPAD="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}"
AGENT_TOKEN="${AGENT_ID:-${HOSTNAME:-agent}-$$}"
mkdir -p "$SCRATCHPAD"
BODY_MARKER="FORGE:BODY-INTEGRITY:${PR_NUMBER}_review_${AGENT_TOKEN}"
BODY_FILE=$(mktemp "$SCRATCHPAD/${PR_NUMBER}_review_${AGENT_TOKEN}.XXXXXX.md")
printf '%s\n<!-- %s -->\n' "$BODY" "$BODY_MARKER" > "$BODY_FILE"
```

The body MUST contain exactly one marker `<!-- FORGE:BODY-INTEGRITY:<entity>_<role>_<agent-token> -->` on its own line. The script refuses a body with zero or several markers, and after creation re-reads the issue and requires that exact line: a path collision can substitute another agent's plausible-looking body (forge#2843).

## Interactive Mode (free text)

### 1. Parse the request

- **Repo**: default from `forge.yaml`; a `{satellite_prefix}:` prefix routes to `repos.satellites[].repo` (pass it as `--repo`).
- **Type → title prefix**: bug `fix:` (crash, broken, error, regression) · feature `feat:` · refactor `refactor:` · investigation `investigate:` · infra `fix:`/`feat:` · docs `docs:`.
- **Priority**: P0 prod down, data loss, security · P1 significant user impact, deploy blocked · P2 minor bug or improvement (default) · P3 cosmetic. Never guess P0/P1; ask.
- **Category** (one): `bug`, `feature`, `enhancement`, `refactor`, `dead-code`, `infra`, `docs`, `performance`, `seo`, `ux`, `frontend`, `audit-finding`.

### 2. Gather context (MANDATORY)

Read the actual code before drafting: the investigator inherits your file references. Map the domain (`forge.yaml → review.context`, the project's `CLAUDE.md`), read files from `origin/{STAGING_BRANCH}` via `git show`, and list every file the change touches: the primary file, its tests, config layers (`.env.example`, every compose override), migrations for schema changes, importers of a changed function.

Duplicates: the script's token-overlap dedup is authoritative. Before drafting, also run a semantic search (`gh issue list --state open --search "{key_terms}"`, and `--state closed` for regressions). An open duplicate: tell the user and do not create. A closed one: create, and write "Regression of #N." in the body. If the user explicitly overrides a dedup STOP, re-run with `--exclude <that number>`; agents never do this without the user's authorization.

### 3. Draft

**Title**: `{prefix}({scope}): {specific description}`, max 80 characters, no vague verbs ("improve", "update", "handle") without specifics.

**Body** (pipeline template; `## Problem`, `## Affected Files` and `## Acceptance Criteria` are mandatory, the rest optional; in greenfield mode Affected Files may list *planned* paths inside the spike's declared repo layout):

```markdown
## Problem
{1-3 specific sentences; error message or symptom; "Regression of #N" if applicable}

## Root Cause (if known)
1. `{file}:{line}` — {what happens here}
{or "Root cause unknown — investigation needed." plus hypotheses}

## Affected Files
1. `{filepath}` — {what needs to change}   (dependency order; include override/companion files)

## Expected Behavior
{what happens after the change}

## Acceptance Criteria
- [ ] {specific, testable criterion} [type:api|unit|e2e|manual]

## Dependencies
Depends on #{N} — {reason}   (omit when none)

## Prior Investigation
<!-- FORGE:PRIOR_GIST: {gist_url} -->   (only when parent investigation Gists exist)
```

Investigation issues use `## Scope`, `## Questions to Answer` (checkboxes), `## Starting Points`, `## Deliverable`, `## Context`. Keep domain-specific sections (Evidence Trail, Validation Checklist, ...) and wrap the mandatory ones around them; `milestone.md`, `orchestrate.md` and `work-on/decompose.md` use this same template.

**Validate**: conventional prefix; no placeholder sections; each criterion is testable; override files included; priority matches severity. **Affected files are real**: every backticked path in `## Affected Files` exists at `origin/staging` or `origin/main`; in greenfield mode a missing path passes as `PLANNED` when it is declared in, or sits under a directory declared in, the spike doc's `Repo layout` section. Write the draft to an entity-scoped `mktemp` body file, then run from the target repo (`{GREENFIELD}`/`{SPIKE_DOC}` are the parsed values). Exit 1 (`MISSING <path>`): fix the path, or in greenfield mode add it to the spike layout. Exit 2: the spike doc is missing or declares no layout; fix it or drop `--greenfield`. If the helper does not resolve, check each path with `git show origin/staging:{path}` / `git show origin/main:{path}`.

```bash
cd "{REPO_PATH}" || exit 1
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
AF_CHECK_SCRIPT=$(forge_resolve affected-files-check.sh)
GREENFIELD="{GREENFIELD}"; SPIKE_DOC="{SPIKE_DOC}"
# Declared spike layout auto-enables greenfield mode; without one, brownfield (existence only) applies.
[ -f "$SPIKE_DOC" ] && grep -qiE '^#+[[:space:]].*repo layout' "$SPIKE_DOC" && GREENFIELD=true
SPIKE_ARGS=()
[ "$GREENFIELD" = "true" ] && SPIKE_ARGS=(--spike "$SPIKE_DOC")
git fetch -q origin {STAGING_BRANCH} {DEFAULT_BRANCH} 2>/dev/null || true
if [ -n "$AF_CHECK_SCRIPT" ]; then
  bash "$AF_CHECK_SCRIPT" "{DRAFT_BODY_FILE}" --ref "origin/{STAGING_BRANCH}" --ref "origin/{DEFAULT_BRANCH}" "${SPIKE_ARGS[@]}"
  echo "AF_CHECK_EXIT=$?"
else
  echo "affected-files-check.sh unresolved: check each path with git show (brownfield rule)"
fi
```

### 4. Create

Write the draft to a body file per the integrity contract above (role `issue`), then make one call with the same exit-code contract:

```bash
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; FORGE_SOURCED_ROOT='${CLAUDE_PLUGIN_ROOT}'; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" '${CLAUDE_PLUGIN_ROOT}' "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/*; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }
ISSUE_CREATE_SCRIPT=$(forge_resolve issue-create.sh)
[ -n "$ISSUE_CREATE_SCRIPT" ] || { echo "ERROR: issue-create.sh not found in a trusted ForgeDock install" >&2; exit 3; }
bash "$ISSUE_CREATE_SCRIPT" --title "{TITLE}" --body-file "$BODY_FILE" --label "{PRIORITY_LABEL}" --label "{CATEGORY_LABEL}" {--milestone "M"} {--repo OWNER/NAME} {--dry-run}
```

Report `**#{N}**: {title}`, URL, labels, milestone, and "Run `/work-on {N}` to start the pipeline."

**Batch**: draft every issue, create each in order (no confirmation prompt), and report a table `| # | Issue | Priority | Category | Deps |`. With `--dry-run`, print the draft table plus each body and create nothing.

## Anti-Patterns

| Bad | Why it fails | Good |
|-----|-------------|------|
| "Fix docker mount" | Which file? Which mount? | "fix: `logs` volume in docker-compose.yml missing `rw` — container writes fail" |
| "Update billing" | What is broken? | "fix: payment_processor.charge() raises ZeroDivisionError when amount == 0" |
| "Investigate performance" | Where? | "investigate: API p95 doubled since last deploy — trace job routers" |
| No affected files | Investigator guesses wrong | List every file with its change |
| Missing override files | Incomplete fix, deploy fails | Include docker-compose.prod.yml, .env.example |
| P0 for a typo | Dilutes priority | P3 for cosmetic |

## Safety Rules

1. Read code before an interactive issue; never fabricate file paths. (Programmatic callers own this.)
2. Dedup runs for every create, interactive or programmatic; no flag disables it. Agents never bypass a dedup STOP without user authorization.
3. Create by default; pause only for `--dry-run`.
4. Never create issues with `gh issue create` (it can report success on a swallowed 403): always go through the script, which creates through `gh api --method POST` and succeeds only after the create-token read-back. Apply the same pattern to `gh issue comment`, `gh pr comment` and `gh pr create`: POST with a caller-generated token, GET the returned object, require the token.
5. Conventional-commit prefixes in titles; default to P2.
