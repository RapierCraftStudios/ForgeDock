---
description: Create a well-structured GitHub issue that the pipeline can consume reliably
argument-hint: [description of the problem or feature]
---

# /issue — Deterministic Issue Creator

**Input**: $ARGUMENTS

You create GitHub issues with the exact structure the `/work-on` pipeline expects. Every issue you create must give the investigation agent enough context to find the right files on the first pass — no vague descriptions, no missing domains, no ambiguous scope.

**Agent model policy**: Default `model: "sonnet"`. Fallback: `model: "opus"` if Sonnet is rate-limited.
**NEVER use plan mode (EnterPlanMode).**

---

## Why This Exists

Bad issues cause cascading pipeline failures. When an issue says "fix the docker mount" without specifying WHICH compose file, the investigator checks one file, misses the override, the builder writes an incomplete fix, the deploy fails, and a new audit issue gets filed about the original issue. One vague sentence costs 3+ agent runs. This command prevents that by enforcing structure at creation time.

---

## Phase 1: Parse the Request

The user's input (`$ARGUMENTS`) can be:

| Input Form | Example |
|-----------|---------|
| Free-text description | "the billing page crashes when credits hit zero" |
| URL to error/log | "https://sentry.io/..." or a pasted stack trace |
| Reference to code | "the scraper queue leaks memory in unified_consumer.py" |
| Feature request | "add a dark mode toggle to the dashboard settings page" |
| Multi-repo prefix | "mcp: add list_schemas tool" or "n8n: fix credential refresh" |
| Audit/investigation | "investigate why deploy times doubled this week" |

### 1A: Resolve target repository

| Prefix | Repository | GH_REPO | GH_FLAG |
|--------|-----------|---------|---------|
| (none) / `alterlab:` | AlterLab | `RapierCraft/AlterLab` | (none) |
| `forge:` | Forge | `RapierCraftStudios/forge` | `-R RapierCraftStudios/forge` |
| `mcp:` | MCP Server | `RapierCraft/alterlab-mcp-server` | `-R RapierCraft/alterlab-mcp-server` |
| `n8n:` | n8n Node | `RapierCraft/n8n-nodes-alterlab` | `-R RapierCraft/n8n-nodes-alterlab` |

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

### 2A: Identify the domain

For AlterLab issues, map to domains and their key files:

| Domain | Key Entry Points |
|--------|-----------------|
| BILLING | `routers/billing.py`, `core/pricing.py`, `services/credit_service.py` |
| SCRAPING | `unified_consumer.py`, `queues.py`, `domain_playbooks.json` |
| AUTH | `core/auth.py`, `routers/auth.py`, `dependencies.py` |
| DATABASE | `infra/migrations/`, `models/`, `db/` |
| FRONTEND | `web/src/app/`, `web/src/components/`, `web/src/lib/` |
| CORTEX | `cortex_client.py`, `routers/cortex.py` |
| INFRA | `.github/workflows/`, `docker-compose.yml`, `docker-compose.prod.yml`, `infra/traefik/` |

For Forge issues: `commands/*.md`, `CLAUDE.md`, `install.sh`
For MCP issues: read the repo's `src/` directory
For n8n issues: read the repo's `nodes/` and `credentials/` directories

### 2B: Read the affected files

**CRITICAL RULE**: Read the ACTUAL code that the issue is about. Not just the file the user mentioned — also:

1. **Override/companion files**: If the issue mentions `docker-compose.yml`, ALSO check `docker-compose.prod.yml`. If it mentions a router, ALSO check the model it imports from.
2. **Config layers**: If the issue is about environment variables, check `.env.example`, `docker-compose.yml`, AND `docker-compose.prod.yml`.
3. **Import chains**: If the issue is about a function, check what imports it and what it imports.

```bash
# For AlterLab — resolve the right branch to read from
# Check staging first (most recent deployable state), then main
git fetch origin staging main 2>/dev/null

# Read the files relevant to the issue
# Use git show origin/staging:{filepath} for AlterLab files
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

```bash
# Search for existing issues with similar scope
gh issue list {GH_FLAG} --state open --limit 20 --search "{key_terms}" --json number,title,labels --jq '.[] | "#\(.number) [\(.labels | map(.name) | join(","))] \(.title)"'

# Also check recently closed issues (might be a regression)
gh issue list {GH_FLAG} --state closed --limit 10 --search "{key_terms}" --json number,title,state --jq '.[] | "#\(.number) [closed] \(.title)"'
```

If a duplicate exists:
- **Open duplicate found**: Tell the user. Do NOT create the issue. Show the existing issue number.
- **Closed duplicate found (regression)**: Create the issue but reference the prior issue in the body: "Regression of #{N}."

### 2E: Check for milestone context

```bash
# If user mentioned a milestone or the issue clearly belongs to one:
gh api repos/{GH_REPO}/milestones --jq '.[] | select(.state == "open") | "#\(.number) \(.title) (\(.open_issues) open)"'
```

---

## Phase 3: Draft the Issue

### 3A: Compose the title

Format: `{prefix}: {concise description}`

Rules:
- **Max 80 characters**
- Use conventional commit prefixes: `fix:`, `feat:`, `refactor:`, `investigate:`, `docs:`
- Be specific — "fix: billing page crash" is bad, "fix: credit_service division by zero when user credits reach 0" is good
- Include the component/domain if it helps: `fix(scraper): queue leak in unified_consumer heartbeat loop`
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

- [ ] {Specific, testable criterion}
- [ ] {Specific, testable criterion}
- [ ] {No regressions in {related_feature}}

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

- [ ] {Specific, testable criterion}
- [ ] {Specific, testable criterion}

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
- `## Acceptance Criteria` is MANDATORY — at least one testable `- [ ]` criterion
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

---

## Phase 4: Create the Issue

### 4A: Present draft to user

```
## Issue Draft

**Repo**: {GH_REPO}
**Title**: {title}
**Labels**: {priority}, {category}
**Milestone**: {milestone or "none"}

---

{full issue body}

---

Create this issue? (yes / adjust / cancel)
```

**Wait for user confirmation.** Do NOT create the issue without approval.

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

### 4D: Add to Project board (AlterLab only)

```bash
# For AlterLab issues, add to the project board
gh project item-add {PROJECT_NUMBER} --owner RapierCraft --url "${ISSUE_URL}" 2>/dev/null || true
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

1. Draft ALL issues first
2. Present them as a numbered list for review
3. Create all after confirmation
4. Report all created issue numbers

```
## Batch Issue Draft

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

Create all {N} issues? (yes / adjust #N / cancel)
```

---

## Anti-Patterns — What NOT to Do

| Bad Issue | Why It Fails | Good Version |
|-----------|-------------|-------------|
| "Fix docker mount" | Which compose file? Which mount? | "fix: `.gemini` volume mount in docker-compose.prod.yml missing rw flag" |
| "Update billing" | What about billing? What's broken? | "fix: credit_service.deduct() raises DivisionByZero when user.credits == 0" |
| "Investigate performance" | Investigate what? Where? | "investigate: API p95 latency doubled since last deploy — trace hot paths in scraping routers" |
| No affected files listed | Investigator guesses wrong files | List every file with what needs to change |
| "Handle edge case" | Which edge case? In what function? | "fix: unified_consumer.process_job() silently drops jobs when queue.length > MAX_BATCH" |
| Missing override files | Fix is incomplete, deploy fails | Include docker-compose.prod.yml, .env.example, etc. |
| P0 for a typo fix | Wastes priority signaling | Use P3 for cosmetic issues |

---

## Safety Rules

1. **Always read code before creating an issue.** Never create an issue based solely on user description without verifying the files exist and the problem is plausible.
2. **Always check for duplicates.** Creating duplicate issues wastes agent runs.
3. **Always wait for user confirmation.** Never create issues without showing the draft first.
4. **Never fabricate file paths.** Every path in the issue body must be verified against the actual repo.
5. **Never omit override/companion files.** If one compose file is affected, check the other. If one model is affected, check its migration.
6. **Use conventional commit prefixes in titles.** The pipeline and changelog depend on them.
7. **Default to P2.** Only use P0/P1 when the user explicitly indicates severity or the evidence clearly shows production impact.
