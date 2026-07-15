---
description: Create a well-structured GitHub issue that the pipeline can consume reliably
argument-hint: "[description of the problem or feature] [--dry-run] | --title \"...\" --body-file <path> --label \"...\" [--milestone \"...\"] [--dry-run]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /issue — Deterministic Issue Creator

**Input**: $ARGUMENTS

You create GitHub issues with the exact structure the `/work-on` pipeline expects. Every issue you create must give the investigation agent enough context to find the right files on the first pass — no vague descriptions, no missing domains, no ambiguous scope.

`/issue` is the structured create-hook for issue creation across the pipeline — it enforces the canonical template, reads code before drafting, runs dedup, and validates mandatory sections. Because those checks are deterministic, `/issue` **creates the issue by default once they pass** — it does not wait for a human to approve the draft. Pass `--dry-run` to review the draft without creating anything (see Argument Parsing below).

`/issue` also accepts a **programmatic invocation form** for callers that have already composed a title, body, labels, and (optionally) a milestone — e.g. `Skill(skill="issue", args="--title \"fix: ...\" --body-file /tmp/body.md --label bug --label P2")`. This form skips the free-text parsing (Phase 1) and LLM drafting (Phase 3) entirely, but still runs the same dedup and body-validation correctness gates as the interactive path. See **Programmatic Invocation Contract** below.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Default — read code, dedup, draft, validate, then create the issue immediately. No pre-create confirmation prompt. |
| `--dry-run` | Draft and validate as normal, but STOP before `gh issue create` — print the draft (or batch draft table) for human review instead of creating it |
| `--title "..."` | **Activates programmatic mode.** Supplies the final issue title directly — skips Phase 1 (parse) and Phase 3 (draft) entirely. See Programmatic Invocation Contract below. |
| `--body "..."` | Supplies the final issue body directly (programmatic mode only). Mutually exclusive with `--body-file`. |
| `--body-file <path>` | Supplies the final issue body by reading it from a file (programmatic mode only). Mutually exclusive with `--body`. |
| `--label "..."` | Adds one label. Repeatable (`--label bug --label P2`) — labels accumulate. Programmatic mode only. |
| `--milestone "..."` | Supplies the milestone title directly, skipping the Phase 2E milestone lookup. Programmatic mode only, optional. |

```bash
DRY_RUN=false
PROGRAMMATIC_TITLE=""
PROGRAMMATIC_BODY=""
PROGRAMMATIC_BODY_FILE=""
PROGRAMMATIC_LABELS=()
PROGRAMMATIC_MILESTONE=""

# Positional/flag parsing. $ARGUMENTS is a single opaque string (the invoking
# agent's raw args, e.g. from `Skill(skill="issue", args="--title \"fix: ...\" ...")`)
# — it is NOT pre-tokenized by any harness, and a naive `ARGS=($ARGUMENTS)` would
# word-split on whitespace without honoring embedded quote characters (a literal
# `"` inside the string is not shell syntax at this point), fragmenting any
# multi-word `--title`/`--body` value (forge#2094).
#
# Do NOT tokenize via `eval "set -- $ARGUMENTS"`. An earlier fix for #2094 used
# exactly that — it is quote-aware, but `eval` re-parses and EXECUTES the full
# substituted string as shell code: any unescaped `$(...)`, backtick, `;`, `|`,
# or `&&` embedded in a caller-supplied title/body value runs as a command
# during parsing, not just as text. `/issue` is invoked programmatically by
# other automation (audit tools, /work-on decomposition, review-finding
# creation — see commands/work-on.md, commands/review-pr.md,
# commands/review-pr-staging.md, commands/test-gate.md) with less-trusted
# strings, so this is a real call-site injection surface, not a theoretical one.
#
# Use `xargs` instead: it applies the same quote/backslash-aware word-splitting
# a shell command line would (so `--title "fix: billing crash"` still yields
# ONE token), but — unlike `eval` — it never expands `$(...)`, never expands
# backticks, and never executes anything. NUL-delimit the output (`printf
# '%s\0'` / `xargs -n1 ... -0`) so tokens containing embedded newlines still
# round-trip correctly through `mapfile -d ''`.
mapfile -d '' -t ARGS < <(printf '%s' "$ARGUMENTS" | xargs -n1 printf '%s\0' 2>/dev/null)

# Flag-mode gate: only run the flag-parsing loop (and its hard-error on
# unrecognized --flags below) when at least one token EXACTLY matches a
# recognized flag. Free-text invocations (the "(none)" row above) are plain
# English descriptions and may legitimately contain a "--something" substring
# as part of the prose (e.g. "fix: crash when using --verbose flag") — those
# must fall through untouched to Phase 1's free-text parser, not be treated
# as a caller typo. Without this gate, the --*) error arm below would abort
# on any free-text description that happens to mention a flag name. See
# forge#2096 (loop content) for why unrecognized flags must fail loudly once
# we ARE in flag mode.
LOOKS_LIKE_FLAG_MODE=false
for arg in "${ARGS[@]}"; do
  case "$arg" in
    --dry-run|--title|--body|--body-file|--label|--milestone)
      LOOKS_LIKE_FLAG_MODE=true
      break
      ;;
  esac
done

i=0
while [ "$LOOKS_LIKE_FLAG_MODE" = "true" ] && [ $i -lt ${#ARGS[@]} ]; do
  arg="${ARGS[$i]}"
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --title|--body|--body-file|--label|--milestone)
      # Each of these flags requires a value token immediately after it. A flag
      # with no following token (e.g. --title as the last argument) is a usage
      # error, not an empty value — fail loudly instead of silently proceeding
      # with PROGRAMMATIC_TITLE="" (which would otherwise mis-detect as
      # non-programmatic mode and mask the caller's mistake).
      if [ $((i+1)) -ge ${#ARGS[@]} ]; then
        echo "ERROR: $arg requires a value"
        exit 1
      fi
      i=$((i+1))
      case "$arg" in
        --title) PROGRAMMATIC_TITLE="${ARGS[$i]}" ;;
        --body) PROGRAMMATIC_BODY="${ARGS[$i]}" ;;
        --body-file) PROGRAMMATIC_BODY_FILE="${ARGS[$i]}" ;;
        --label) PROGRAMMATIC_LABELS+=("${ARGS[$i]}") ;;
        --milestone) PROGRAMMATIC_MILESTONE="${ARGS[$i]}" ;;
      esac
      ;;
    --*)
      # Unrecognized flag (e.g. a mistyped --titel instead of --title). Fail
      # loudly instead of silently discarding it — a silently-ignored flag
      # can fail open into the interactive/free-text path (PROGRAMMATIC_MODE
      # stays false because PROGRAMMATIC_TITLE never gets set) with no
      # diagnostic pointing at the caller's typo. See forge#2096.
      #
      # Deliberately NOT a bare `*)` catch-all: free-text invocations (the
      # "(none)" row in the Argument Parsing table above, e.g. "the billing
      # page crashes when credits hit zero") tokenize into plain words with
      # no leading `--`, and those words are intentionally NOT flags — they
      # are consumed later via $ARGUMENTS as a whole by Phase 1's free-text
      # parser. Only tokens that look like a flag (start with `--`) but
      # don't match a known one are a caller mistake worth failing loudly on.
      echo "ERROR: unrecognized flag: $arg" >&2
      exit 1
      ;;
  esac
  i=$((i+1))
done

# PROGRAMMATIC_MODE is true iff --title was supplied. Every other structured flag
# (--body/--body-file/--label/--milestone) is meaningless without a title and does
# NOT, on its own, activate programmatic mode — this avoids a caller accidentally
# triggering the skip-Phase-1/3 path with a partial/malformed flag set.
if [ -n "$PROGRAMMATIC_TITLE" ]; then
  PROGRAMMATIC_MODE=true
else
  PROGRAMMATIC_MODE=false
fi
```

`--dry-run` never bypasses a correctness gate — the Phase 2D dedup STOP and the `--force` human-override rule (see Phase 2D) apply identically whether or not `--dry-run` is set, and identically in both interactive and programmatic mode.

### Programmatic Invocation Contract

For callers that have already composed a title, body, labels, and (optionally) a milestone — audit tools, `/work-on` decomposition, pipeline-health proposals, review-finding creation, and similar automation — pass `--title` to activate programmatic mode. This bypasses Phase 1 (free-text parsing) and Phase 3 (LLM drafting) entirely; Phase 2D (dedup) and body validation still run.

**Required**: `--title "TEXT"` and exactly one of `--body "TEXT"` / `--body-file <path>`.
**Optional**: `--label "NAME"` (repeatable, zero or more), `--milestone "TITLE"`, `--dry-run`.

If `--title` is present but neither `--body` nor `--body-file` is supplied, or both are supplied, this is a usage error: print `ERROR: programmatic mode requires exactly one of --body or --body-file` and STOP — do not fall through to Phase 2D or Phase 4B.

```bash
if [ "$PROGRAMMATIC_MODE" = "true" ]; then
  if [ -n "$PROGRAMMATIC_BODY" ] && [ -n "$PROGRAMMATIC_BODY_FILE" ]; then
    echo "ERROR: programmatic mode requires exactly one of --body or --body-file (both given)"
    exit 1
  elif [ -z "$PROGRAMMATIC_BODY" ] && [ -z "$PROGRAMMATIC_BODY_FILE" ]; then
    echo "ERROR: programmatic mode requires exactly one of --body or --body-file (neither given)"
    exit 1
  elif [ -n "$PROGRAMMATIC_BODY_FILE" ]; then
    # Fail loudly on a missing/unreadable file — do NOT let a failed `cat` fall
    # through as an empty $PROGRAMMATIC_BODY. An empty body would otherwise look
    # like "no body given" to Phase 3F below, which would silently repair it
    # with placeholder-only stub sections instead of surfacing the caller's
    # file-path mistake as an error, same fail-loudly convention as the
    # both/neither check directly above.
    if [ ! -r "$PROGRAMMATIC_BODY_FILE" ]; then
      echo "ERROR: --body-file '$PROGRAMMATIC_BODY_FILE' is missing or unreadable"
      exit 1
    fi
    PROGRAMMATIC_BODY=$(cat "$PROGRAMMATIC_BODY_FILE")
  fi
fi
```

**Routing** (see also Phase 1's routing guard below): when `PROGRAMMATIC_MODE=true`, skip directly from here to **Phase 2D** using `{PROPOSED_TITLE}` = `$PROGRAMMATIC_TITLE` — Phase 1 (parse) and Phase 3 (draft) do not run. After Phase 2D passes, run **Phase 3F: Programmatic Pre-Create Validation** (below), then proceed to the unmodified Phase 4 (create). `{PRIORITY_LABEL},{CATEGORY_LABEL}` in Phase 4B is the comma-join of `PROGRAMMATIC_LABELS[@]`; the milestone flag is included iff `PROGRAMMATIC_MILESTONE` is non-empty.

The free-text/interactive path (`PROGRAMMATIC_MODE=false`) is completely unaffected — it always proceeds through Phase 1 → Phase 2 → Phase 3 → Phase 4 exactly as before this contract was added.

---

## Why This Exists

Bad issues cause cascading pipeline failures. When an issue says "fix the docker mount" without specifying WHICH compose file, the investigator checks one file, misses the override, the builder writes an incomplete fix, the deploy fails, and a new audit issue gets filed about the original issue. One vague sentence costs 3+ agent runs. This command prevents that by enforcing structure at creation time.

---

## Phase 1: Parse the Request

**If `PROGRAMMATIC_MODE=true`** (see Programmatic Invocation Contract above): run **1A only** (repository resolution — `GH_REPO`/`GH_FLAG`/`REPO_PATH`/`STAGING_BRANCH` still come from `forge.yaml` and the multi-repo prefix table, never from a caller flag), then skip 1B/1C/1D (type/priority/category classification — the caller already supplied final `--label` values) and skip Phase 3 (drafting) entirely. Jump directly to Phase 2D using `{PROPOSED_TITLE}` = `$PROGRAMMATIC_TITLE`, then continue to Phase 3F (Programmatic Pre-Create Validation) and Phase 4 (create). Do not apply the free-text classification/drafting rules below — they apply only when `PROGRAMMATIC_MODE=false`.

The user's input (`$ARGUMENTS`) can be:

| Input Form | Example |
|-----------|---------|
| Free-text description | "the billing page crashes when credits hit zero" |
| URL to error/log | "https://sentry.io/..." or a pasted stack trace |
| Reference to code | "the background worker leaks memory in task_processor.py" |
| Feature request | "add a dark mode toggle to the dashboard settings page" |
| Multi-repo prefix | "mcp: add list_schemas tool" or "n8n: fix credential refresh" |
| Audit/investigation | "investigate why deploy times doubled this week" |

### 1A: Resolve target repository

Read `forge.yaml` to build the routing table dynamically:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")
# Satellite repos from forge.yaml → repos.satellites (each has: prefix, repo, staging_branch)
```

| Prefix | Repository | GH_REPO | GH_FLAG |
|--------|-----------|---------|---------|
| (none) | Default project | `{GH_REPO}` from `forge.yaml → project.owner/repo` | (none / use `{GH_FLAG}`) |
| `{satellite_prefix}:` | Satellite repo | `{satellite.repo}` from `forge.yaml → repos.satellites` | `-R {satellite.repo}` |

### 1B: Classify issue type

| Type | Signals | Title Prefix |
|------|---------|-------------|
| **Bug** | "crash", "broken", "fails", "error", stack trace, regression | `fix:` |
| **Feature** | "add", "enable", "support", "new", "implement" | `feat:` |
| **Refactor** | "clean up", "simplify", "extract", "rename", "dead code" | `refactor:` |
| **Investigation** | "investigate", "audit", "research", "evaluate", "why does" | `investigate:` |
| **Infra** | "deploy", "CI", "docker", "workflow", "pipeline" | `fix:` or `feat:` |
| **Docs** | "document", "README", "guide" | `docs:` |

### 1C: Classify priority

| Priority | Signals |
|----------|---------|
| **P0** | Production down, data loss, security vulnerability, user-facing crash |
| **P1** | Significant bug affecting users, broken feature, deploy blocked |
| **P2** | Minor bug, improvement, non-critical enhancement |
| **P3** | Cosmetic, nice-to-have, low-impact cleanup |

Default to **P2** if unclear. Never guess P0/P1 — ask the user if it seems critical but they didn't say so.

### 1D: Determine category label

Pick ONE primary category label:
- `bug` — something is broken
- `feature` — new capability
- `enhancement` — improvement to existing feature
- `refactor` — code restructuring, no behavior change
- `dead-code` — removing unused code
- `infra` — CI/CD, Docker, deployment
- `docs` — documentation
- `performance` — speed/resource optimization
- `seo` — search engine optimization
- `ux` — user experience improvement
- `frontend` — frontend-specific change
- `audit-finding` — discovered during pipeline audit

---

## Phase 2: Gather Context (MANDATORY)

**You MUST read code before writing the issue.** This is the critical difference between a good issue and a bad one. The investigation agent inherits YOUR file references — if you point to the wrong file, the entire pipeline goes sideways.

**In programmatic mode, skip 2A/2B/2C (domain identification, code reading, affected-file enumeration)** — the caller already did its own domain-specific reading and drafting before invoking `/issue` with `--title`/`--body`/`--body-file`; re-deriving that here would duplicate work the caller has already done and risks second-guessing a caller with more direct context (e.g. an audit agent that already read the offending file). Continue to **2D** (dedup — still mandatory) and **2E** (skip — see below).

### 2A: Identify the domain

Map the issue to its domain and key files. Domain structure comes from the project — check `forge.yaml → review.context` and the project's `CLAUDE.md` for project-specific domain maps.

For ForgeDock issues (this repo): `commands/*.md`, `CLAUDE.md`, `install.sh`, `bin/`
For satellite repo issues: read the satellite repo's source directory (from `forge.yaml → repos.satellites`)

### 2B: Read the affected files

**CRITICAL RULE**: Read the ACTUAL code that the issue is about. Not just the file the user mentioned — also:

1. **Override/companion files**: If the issue mentions `docker-compose.yml`, ALSO check `docker-compose.prod.yml`. If it mentions a router, ALSO check the model it imports from.
2. **Config layers**: If the issue is about environment variables, check `.env.example`, `docker-compose.yml`, AND `docker-compose.prod.yml`.
3. **Import chains**: If the issue is about a function, check what imports it and what it imports.

```bash
# Resolve the right branch to read from
# Check the staging branch first (most recent deployable state), then the default branch
git fetch origin {STAGING_BRANCH} {DEFAULT_BRANCH} 2>/dev/null

# Read the files relevant to the issue
# Use git show origin/{STAGING_BRANCH}:{filepath} for project files
```

### 2C: Identify ALL affected files

List every file that the fix/feature will need to touch. Be thorough:
- The primary file with the bug/feature location
- Test files that cover the affected code
- Config files that need updating
- Migration files if schema changes are needed
- Frontend files if the change has UI implications
- **Override files** (e.g., `docker-compose.prod.yml` if `docker-compose.yml` is affected)

### 2D: Check for duplicates

Run the deterministic dedup script first (authoritative check), then fall back to an LLM pass if the script produces no result:

```bash
# Authoritative deterministic check — uses token overlap algorithm (see scripts/issue-dedup.sh)
DEDUP_RESULT=$(scripts/issue-dedup.sh "{PROPOSED_TITLE}" {GH_FLAG} 2>&1)
DEDUP_EXIT=$?

if [ "$DEDUP_EXIT" -eq 1 ]; then
  echo "Near-duplicate detected: $DEDUP_RESULT"
  echo "Existing issue found — do NOT create a new one."
  # STOP here and report to user (see handling rules below)
elif [ "$DEDUP_EXIT" -eq 2 ]; then
  echo "Dedup check usage error: $DEDUP_RESULT"
  echo "Do NOT proceed to issue creation — fix the invocation and retry."
  # STOP here — do not fall through to gh issue create
fi
```

If the script exits 0 (no match found), also run an LLM-side search as a fallback:

```bash
# LLM fallback — broader semantic search for issues the token algorithm may miss
gh issue list {GH_FLAG} --state open --limit 20 --search "{key_terms}" --json number,title,labels --jq '.[] | "#\(.number) [\(.labels | map(.name) | join(","))] \(.title)"'

# Also check recently closed issues (might be a regression)
gh issue list {GH_FLAG} --state closed --limit 10 --search "{key_terms}" --json number,title,state --jq '.[] | "#\(.number) [closed] \(.title)"'
```

If a duplicate exists:
- **Open duplicate found**: Tell the user. Do NOT create the issue. Show the existing issue number.
- **Closed duplicate found (regression)**: Create the issue but reference the prior issue in the body: "Regression of #{N}."
- **User wants to override**: Pass `--force` to the dedup script — this is an explicit human override path. Agents MUST NOT pass `--force` without user authorization. <!-- Added: forge#1335 -->

### 2E: Check for milestone context

```bash
# If user mentioned a milestone or the issue clearly belongs to one:
gh api repos/{GH_REPO}/milestones --jq '.[] | select(.state == "open") | "#\(.number) \(.title) (\(.open_issues) open)"'
```

**Skip in programmatic mode** — `$PROGRAMMATIC_MILESTONE` (if supplied) is used directly by Phase 4B; there is nothing to look up.

---

## Phase 3: Draft the Issue

### 3A: Compose the title

Format: `{prefix}: {concise description}`

Rules:
- **Max 80 characters**
- Use conventional commit prefixes: `fix:`, `feat:`, `refactor:`, `investigate:`, `docs:`
- Be specific — "fix: billing page crash" is bad, "fix: payment_processor.charge() raises ZeroDivisionError when amount == 0" is good
- Include the component/domain if it helps: `fix(worker): queue leak in task_processor heartbeat loop`
- Never use vague words: "improve", "update", "change", "handle" without specifics

### 3B: Compose the body

Use this exact template. Every section is MANDATORY for bugs and features. Investigation issues use a simplified template (see 3C).

```markdown
## Problem

{1-3 sentences describing what's wrong or what's missing. Be specific.}

{If bug: Include the error message, stack trace snippet, or observable symptom.}
{If regression: "Regression of #{N} — {brief description of original fix}."}

## Root Cause (if known)

{Point to the specific code path. Use `file:line` references.}
{If the cause spans multiple files, list the chain:}
1. `{file1}:{line}` — {what happens here}
2. `{file2}:{line}` — {what happens here}
3. Result: {the failure}

{If root cause is unknown, say: "Root cause unknown — investigation needed." and list hypotheses.}

## Affected Files

Files that need changes (ordered by dependency — change these in this order):

1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}
3. `{filepath}` — {what needs to change}

{CRITICAL: Include ALL files. If docker-compose.yml needs a change, docker-compose.prod.yml almost certainly does too. If a model changes, the migration file and any routers importing it need updating.}

## Expected Behavior

{What should happen after the fix/feature is implemented.}

## Acceptance Criteria

- [ ] {Specific, testable criterion} [type:api]
- [ ] {Specific, testable criterion}
- [ ] {No regressions in {related_feature}}

> **Test-type annotation** (optional): Append `[type:api]`, `[type:unit]`, `[type:e2e]`, or `[type:manual]` to each criterion. The test gate reads this annotation directly and skips regex inference. Omit it to rely on regex classification fallback.

## Dependencies

{If this issue depends on other issues:}
Depends on #{N} — {brief reason}

{If other issues should be done first:}
Should be done after #{N} — {brief reason}

{If no dependencies: omit this section entirely.}

## Additional Context

{Optional: screenshots, logs, links to Sentry/Grafana, user reports}
{Optional: "**Code branch**: `{branch}`" if the code only exists on a specific branch}
```

### 3C: Investigation issue template

For investigation/audit issues, use this simplified template:

```markdown
## Scope

{What needs to be investigated and why.}

## Questions to Answer

- [ ] {Specific question 1}
- [ ] {Specific question 2}
- [ ] {Specific question 3}

## Starting Points

Files/areas to examine:
1. `{filepath}` — {why start here}
2. `{filepath}` — {why start here}

## Deliverable

{What the investigation should produce:}
- Execution plan with specific sub-issues, OR
- Root cause analysis with fix recommendation, OR
- Decision document with trade-offs

## Context

{Background information the investigator needs.}
```

### 3D: Pipeline Issue Template (machine-callable reference)

> **Canonical Standard**: This template is the single source of truth for all automated issue creation in the ForgeDock pipeline. `milestone.md`, `orchestrate.md`, and `work-on/decompose.md` MUST use this template structure when creating issues programmatically. A shared convention is only useful if all create-paths enforce it — divergent inline templates in each command file cause acceptance-criteria drift and coverage gaps. See `work-on/decompose.md` Phase D0 for the investigation-gate pattern that enforces this standard at decomposition time. <!-- Added: forge#293 -->

When pipeline agents create issues programmatically (not via user input), use this canonical template. All automated `gh issue create` calls across Forge commands MUST include these mandatory sections. Domain-specific sections are additive — preserve them, but wrap them with this structure.

```markdown
## Problem

{1-3 sentences: what's wrong or what's missing. Specific and concrete.}

## Root Cause (if known)

{Point to the specific code path. Use `file:line` references. If unknown, say "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes (ordered by dependency):
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific, testable criterion} [type:api]
- [ ] {Specific, testable criterion}

> **Test-type annotation** (optional): Append `[type:api]`, `[type:unit]`, `[type:e2e]`, or `[type:manual]` to each criterion. The test gate reads this annotation directly and skips regex inference. Omit it to rely on regex classification fallback.

## Context

{Domain-specific context — logs, metrics, source report, linked issue, etc.}

## Dependencies

{If this depends on other issues: "Depends on #{N} — {reason}". If none, omit this section.}

## Prior Investigation

{Optional — include when this issue was spawned from or relates to a prior investigation that produced Knowledge Gists.}

{For each Gist URL from the parent/sibling investigation:}
<!-- FORGE:PRIOR_GIST: {gist_url} -->
- {gist_url}

{If no prior investigation Gists exist, omit this section entirely.}
```

**Rules for automated issue creation**:
- Title MUST use conventional commit prefix: `fix:`, `feat:`, `refactor:`, `investigate:`, `docs:`
- `## Problem` is MANDATORY — every issue must state what's wrong or what's needed
- `## Affected Files` is MANDATORY — list actual file paths the investigator should read first
- `## Acceptance Criteria` is MANDATORY — at least one testable `- [ ]` criterion; each item MAY carry an optional `[type:api|unit|e2e|manual]` annotation for deterministic test-gate classification (omit to fall back to regex inference)
- Domain-specific sections (Evidence Trail, Pattern Metadata, Validation Checklist, etc.) SHOULD be preserved — they add pipeline value. Add mandatory sections around them, not instead of them.
- `## Prior Investigation` is OPTIONAL — include only when parent/sibling investigation Gist URLs are available. Each Gist URL must be wrapped in a `<!-- FORGE:PRIOR_GIST: {url} -->` annotation for machine-readable parsing by downstream agents. <!-- Added: forge#339 -->

---

### 3E: Validate the draft

Before creating, verify:

1. **Title follows convention**: `{prefix}({scope}): {description}` or `{prefix}: {description}`
2. **Affected files are real**: Every file path in the body exists in the repo (check with `git show origin/staging:{path}` or `git show origin/main:{path}`)
3. **No vague sections**: Every section has concrete content, not placeholders
4. **Acceptance criteria are testable**: Each criterion can be verified with a specific action
5. **Override files included**: If `docker-compose.yml` is listed, `docker-compose.prod.yml` is too (if it exists). If a model is listed, its migration is too.
6. **Priority matches severity**: P0 = prod down, P1 = significant user impact, P2 = minor, P3 = cosmetic

**Skip this step entirely in programmatic mode** — the caller already composed and is responsible for the draft. Programmatic mode has its own validation gate instead: Phase 3F below.

### 3F: Programmatic Pre-Create Validation (programmatic mode only, MANDATORY)

**Skip if `PROGRAMMATIC_MODE=false`** — this step only runs for the `--title`-driven path; the free-text/interactive path uses 3E above instead.

Runs after Phase 2D (dedup) passes and before Phase 4B (create). This reuses the exact same three mandatory-section check Phase 4C.5 performs post-creation — but applied here, pre-create, against the caller-supplied body, so a programmatic caller's issue is validated *before* it exists rather than repaired after the fact. Phase 4C.5 still runs afterward too (unchanged, for both modes) as an idempotent safety net — after this step it will find nothing to repair.

```bash
MISSING_SECTIONS=""
echo "$PROGRAMMATIC_BODY" | grep -q "^## Problem" || MISSING_SECTIONS="$MISSING_SECTIONS PROBLEM"
echo "$PROGRAMMATIC_BODY" | grep -q "^## Affected Files" || MISSING_SECTIONS="$MISSING_SECTIONS AFFECTED_FILES"
echo "$PROGRAMMATIC_BODY" | grep -q "^## Acceptance Criteria" || MISSING_SECTIONS="$MISSING_SECTIONS ACCEPTANCE_CRITERIA"

if [ -n "$MISSING_SECTIONS" ]; then
  echo "WARNING: supplied --body is missing sections:$MISSING_SECTIONS — adding placeholders before creation"

  APPEND_TEXT=""
  echo "$MISSING_SECTIONS" | grep -q "PROBLEM" && APPEND_TEXT="$APPEND_TEXT
## Problem

Root cause unknown — investigation needed."

  echo "$MISSING_SECTIONS" | grep -q "AFFECTED_FILES" && APPEND_TEXT="$APPEND_TEXT
## Affected Files

Files to be identified during investigation."

  echo "$MISSING_SECTIONS" | grep -q "ACCEPTANCE_CRITERIA" && APPEND_TEXT="$APPEND_TEXT
## Acceptance Criteria

- [ ] Fix confirmed during investigation."

  # Append missing sections to the supplied body (never replace — only extend),
  # same non-blocking "repair, don't fail" semantics as Phase 4C.5.
  PROGRAMMATIC_BODY="${PROGRAMMATIC_BODY}${APPEND_TEXT}"
  echo "Body repaired in-memory before creation — added:$MISSING_SECTIONS"
else
  echo "Pre-create validation passed — all mandatory sections present"
fi
```

**This step never fails or blocks** — identical to Phase 4C.5's contract. Missing sections cause an in-memory repair, not an error; `$PROGRAMMATIC_BODY` (now guaranteed to contain all three mandatory sections) is what Phase 4B creates the issue with, and what a `--dry-run` preview (Phase 4A) prints.

---

## Phase 4: Create the Issue

### 4A: Create by default, or stop for review with `--dry-run`

Once Phase 2D (dedup) has passed with no blocking duplicate, and either Phase 3E (interactive draft validation) or Phase 3F (programmatic pre-create validation) has passed, proceed directly to Phase 4B and create the issue. **No pre-create confirmation prompt.** This is the default for both interactive and programmatic invocations — dedup and validation are the correctness gates, not a human approval step.

In programmatic mode, `{title}` = `$PROGRAMMATIC_TITLE`, `{full issue body}` = `$PROGRAMMATIC_BODY` (post-3F, i.e. already section-repaired), `{priority}, {category}` = the joined `PROGRAMMATIC_LABELS[@]`, and `{milestone}` = `$PROGRAMMATIC_MILESTONE` (or "none" if empty) — no interactive drafting occurred, so the dry-run preview below simply echoes back what the caller supplied (plus any 3F repairs).

**If `--dry-run` was passed** (see Argument Parsing): print the draft below and STOP. Do NOT run Phase 4B.

```
## Issue Draft (--dry-run — not created)

**Repo**: {GH_REPO}
**Title**: {title}
**Labels**: {priority}, {category}
**Milestone**: {milestone or "none"}

---

{full issue body}

---

Re-run without --dry-run to create this issue.
```

### 4B: Create the issue

```bash
gh issue create {GH_FLAG} \
  --title "{TITLE}" \
  --label "{PRIORITY_LABEL},{CATEGORY_LABEL}" \
  --body "$(cat <<'ISSUE_EOF'
{FULL_BODY}
ISSUE_EOF
)"
```

If milestone was identified:
```bash
gh issue create {GH_FLAG} \
  --title "{TITLE}" \
  --label "{PRIORITY_LABEL},{CATEGORY_LABEL}" \
  --milestone "{MILESTONE_TITLE}" \
  --body "$(cat <<'ISSUE_EOF'
{FULL_BODY}
ISSUE_EOF
)"
```

**Programmatic mode variable mapping**: `{TITLE}` = `$PROGRAMMATIC_TITLE`; `{FULL_BODY}` = `$PROGRAMMATIC_BODY` (post-Phase-3F); the milestone branch is used iff `$PROGRAMMATIC_MILESTONE` is non-empty, with `{MILESTONE_TITLE}` = `$PROGRAMMATIC_MILESTONE`. This is the same `gh issue create` call the interactive path uses — no new command surface, only a new source for the variables.

`{PRIORITY_LABEL},{CATEGORY_LABEL}` in the interactive-mode template above stands for `PROGRAMMATIC_LABELS[@]`, but the actual `--label` flag(s) passed to `gh issue create` are built as one repeatable `--label` per array element — NOT a single comma-joined string. `gh issue create --label` itself comma-splits its argument, so joining `PROGRAMMATIC_LABELS[@]` with `,` and passing it as one value would incorrectly fragment any individual label that contains a literal comma (see forge#2097). `--label` is a repeatable flag — passing it multiple times accumulates labels without any join/split ambiguity. Zero labels is valid and must omit `--label` entirely (an empty `--label ""` would fail):

```bash
LABEL_FLAG=()
for label in "${PROGRAMMATIC_LABELS[@]}"; do
  LABEL_FLAG+=(--label "$label")
done

if [ -n "$PROGRAMMATIC_MILESTONE" ]; then
  gh issue create {GH_FLAG} --title "$PROGRAMMATIC_TITLE" "${LABEL_FLAG[@]}" \
    --milestone "$PROGRAMMATIC_MILESTONE" --body "$PROGRAMMATIC_BODY"
else
  gh issue create {GH_FLAG} --title "$PROGRAMMATIC_TITLE" "${LABEL_FLAG[@]}" \
    --body "$PROGRAMMATIC_BODY"
fi
```

### 4C: Post-creation verification

```bash
# Verify the issue was created correctly
ISSUE_URL=$(gh issue view {NEW_NUMBER} {GH_FLAG} --json url --jq '.url')
LABELS=$(gh issue view {NEW_NUMBER} {GH_FLAG} --json labels --jq '[.labels[].name] | join(", ")')
echo "Created: ${ISSUE_URL}"
echo "Labels: ${LABELS}"
```

### 4C.5: Body Validation (MANDATORY)

After creation, verify the issue body contains the three mandatory pipeline sections. If any are missing, add placeholder content so downstream pipeline agents have the correct scaffolding.

**Runs for both interactive and programmatic invocations, unconditionally — do not skip this step for programmatic mode.** For programmatic callers this is expected to be a no-op: Phase 3F already validated and repaired `$PROGRAMMATIC_BODY` before creation, so `$CREATED_BODY` here should already contain all three sections. This step still runs as an idempotent safety net (e.g. if GitHub or an intermediate transform altered the body between 3F and creation).

**This step never fails or blocks.** Missing sections cause a repair, not an error. Issues created with full structure pass through immediately.

```bash
CREATED_BODY=$(gh issue view {NEW_NUMBER} {GH_FLAG} --json body --jq '.body')

MISSING_SECTIONS=""
echo "$CREATED_BODY" | grep -q "^## Problem" || MISSING_SECTIONS="$MISSING_SECTIONS PROBLEM"
echo "$CREATED_BODY" | grep -q "^## Affected Files" || MISSING_SECTIONS="$MISSING_SECTIONS AFFECTED_FILES"
echo "$CREATED_BODY" | grep -q "^## Acceptance Criteria" || MISSING_SECTIONS="$MISSING_SECTIONS ACCEPTANCE_CRITERIA"

if [ -n "$MISSING_SECTIONS" ]; then
  echo "WARNING: Issue body is missing sections:$MISSING_SECTIONS — adding placeholders to preserve pipeline compatibility"

  APPEND_TEXT=""
  echo "$MISSING_SECTIONS" | grep -q "PROBLEM" && APPEND_TEXT="$APPEND_TEXT
## Problem

Root cause unknown — investigation needed."

  echo "$MISSING_SECTIONS" | grep -q "AFFECTED_FILES" && APPEND_TEXT="$APPEND_TEXT
## Affected Files

Files to be identified during investigation."

  echo "$MISSING_SECTIONS" | grep -q "ACCEPTANCE_CRITERIA" && APPEND_TEXT="$APPEND_TEXT
## Acceptance Criteria

- [ ] Fix confirmed during investigation."

  # Append missing sections to the existing body (never replace — only extend)
  REPAIRED_BODY="${CREATED_BODY}${APPEND_TEXT}"
  gh issue edit {NEW_NUMBER} {GH_FLAG} --body "$REPAIRED_BODY"
  echo "Body repaired — added:$MISSING_SECTIONS"
else
  echo "Body validation passed — all mandatory sections present"
fi
```

### 4D: Add to Project board (if configured)

```bash
# Add to project board if forge.yaml → project_board is configured
PROJECT_NUMBER=$(yq '.project_board.project_number // ""' "$CONFIG_FILE")
PROJECT_BOARD_OWNER=$(yq '.project_board.owner // .project.owner' "$CONFIG_FILE")
if [ -n "$PROJECT_NUMBER" ] && [ "$PROJECT_NUMBER" != "null" ]; then
  gh project item-add "$PROJECT_NUMBER" --owner "$PROJECT_BOARD_OWNER" --url "${ISSUE_URL}" 2>/dev/null || true
fi
```

### 4E: Report to user

```
## Issue Created

**#{NUMBER}**: {title}
**URL**: {url}
**Labels**: {labels}
**Milestone**: {milestone or "none"}

{If ready to work on it: "Run `/work-on {NUMBER}` to start the pipeline."}
{If part of a milestone: "This issue will be picked up in the next `/orchestrate milestone {slug}` run."}
```

---

## Batch Mode

If the user provides multiple issues to create (e.g., from an audit, analytics session, or decomposition):

1. Draft ALL issues first (each running its own dedup + validation pass, Phase 2D/3E)
2. Create all of them by default — consistent with the single-issue default in Phase 4A. No pre-create confirmation prompt.
3. If `--dry-run` was passed, present them as a numbered list instead of creating them (see table below) and STOP
4. Report all created (or, under `--dry-run`, all drafted) issue numbers

**Default (no `--dry-run`)**: create each drafted issue in order, then report:
```
## Batch Issues Created

| # | Issue | Priority | Category | Deps |
|---|-------|----------|----------|------|
| 1 | #{N1} {title} | P2 | bug | — |
| 2 | #{N2} {title} | P1 | feature | After #{N1} |
| 3 | #{N3} {title} | P2 | refactor | — |
```

**With `--dry-run`**: print the batch draft table and stop before any `gh issue create` call:
```
## Batch Issue Draft (--dry-run — not created)

| # | Title | Priority | Category | Deps |
|---|-------|----------|----------|------|
| 1 | {title} | P2 | bug | — |
| 2 | {title} | P1 | feature | After #1 |
| 3 | {title} | P2 | refactor | — |

<details><summary>Issue 1: {title}</summary>

{full body}

</details>

<details><summary>Issue 2: {title}</summary>

{full body}

</details>

Re-run without --dry-run to create these {N} issues.
```

---

## Anti-Patterns — What NOT to Do

| Bad Issue | Why It Fails | Good Version |
|-----------|-------------|-------------|
| "Fix docker mount" | Which compose file? Which mount? | "fix: `logs` volume in docker-compose.yml missing `rw` flag — container writes fail at runtime" |
| "Update billing" | What about billing? What's broken? | "fix: payment_processor.charge() raises ZeroDivisionError when amount == 0" |
| "Investigate performance" | Investigate what? Where? | "investigate: API p95 latency doubled since last deploy — trace hot paths in job processing routers" |
| No affected files listed | Investigator guesses wrong files | List every file with what needs to change |
| "Handle edge case" | Which edge case? In what function? | "fix: task_processor.process_job() silently drops jobs when queue.length > MAX_BATCH" |
| Missing override files | Fix is incomplete, deploy fails | Include docker-compose.prod.yml, .env.example, etc. |
| P0 for a typo fix | Wastes priority signaling | Use P3 for cosmetic issues |

---

## Safety Rules

1. **Always read code before creating an issue.** Never create an issue based solely on user description without verifying the files exist and the problem is plausible. (Programmatic mode: this responsibility shifts to the caller — the caller already read code before composing `--title`/`--body`; `/issue` does not re-verify file paths for programmatic invocations.)
2. **Always check for duplicates.** Creating duplicate issues wastes agent runs — dedup (Phase 2D) runs identically for interactive and programmatic invocations; no flag bypasses it.
3. **Default to non-interactive creation.** Once dedup (Phase 2D) and draft validation (Phase 3E, or Phase 3F for programmatic mode) pass, create the issue — do not wait for a human to approve the draft. Only pause for human review when `--dry-run` is explicitly passed.
4. **Never fabricate file paths.** Every path in the issue body must be verified against the actual repo.
5. **Never omit override/companion files.** If one compose file is affected, check the other. If one model is affected, check its migration.
6. **Use conventional commit prefixes in titles.** The pipeline and changelog depend on them.
7. **Default to P2.** Only use P0/P1 when the user explicitly indicates severity or the evidence clearly shows production impact.
8. **`--title` is the sole programmatic-mode trigger.** `--body`/`--body-file`/`--label`/`--milestone` are meaningless without it and never activate programmatic mode on their own — this prevents an accidental partial flag set from silently skipping Phase 1/3.
