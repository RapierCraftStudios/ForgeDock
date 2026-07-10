---
description: Coordinate P0 incident response — hotfix validation, timeline reconstruction, and post-incident analysis
argument-hint: [issue number | "active" | "postmortem {issue}"]
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /incident-response — P0 Incident Coordination

**Input**: $ARGUMENTS

**Config variables used by this command** (set in `forge.yaml`):
- `{REPO_PATH}` ← `paths.root` — project repository root
- `{DEPLOY_WORKFLOW}` ← `deploy.workflow` (optional) — GitHub Actions workflow filename for hotfix deploys (e.g., `hotfix-deploy.yml`). When absent or empty, workflow-trigger and workflow-monitor steps are omitted.

You are the pipeline's incident response coordinator. When production goes down or a critical bug surfaces, this command orchestrates the response: validates the hotfix before deploy, reconstructs the incident timeline, and produces a post-incident analysis.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. User can override with `--model <name>`. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

---

## Command Router

| Input | Mode | Description |
|-------|------|-------------|
| Issue number (e.g., `55`) | **Active Response** | Coordinate hotfix for this P0 issue |
| `active` or empty | **Active Response** | Find the most recent P0 issue and coordinate |
| `postmortem {issue}` | **Post-Incident** | Generate postmortem for a resolved incident |

---

## Mode 1: Active Incident Response

### Phase 1: Identify the Incident

#### Step 1A: Find the P0 issue

```bash
# If issue number provided
gh issue view {NUMBER} --json number,title,body,labels,state,comments,assignees,createdAt

# If "active" — find most recent open P0
gh issue list --state open --label "priority:P0" --limit 5 --json number,title,createdAt,labels \
  --jq 'sort_by(.createdAt) | reverse | .[0]'
```

#### Step 1B: Establish incident context

Parse the issue to understand:
- **What's broken**: Which service, which endpoint, what user-facing impact
- **When it started**: Issue creation time, or mentioned timestamp
- **Suspected cause**: Recent deploy? Code change? External dependency?

```bash
# Check recent deploys (merges to main in last 24h)
gh pr list --state merged --base main --json number,title,mergedAt \
  --jq '[.[] | select(.mergedAt > (now - 86400 | todate))] | .[] | "\(.number) | \(.title) | \(.mergedAt)"'

# Check recent hotfix deploys (requires deploy.workflow set in forge.yaml)
# Skip this check if deploy.workflow is not configured.
gh run list --workflow={deploy.workflow} --limit 5 --json databaseId,status,conclusion,createdAt,displayTitle
```

#### Step 1C: Post incident acknowledgment

```bash
gh issue comment {NUMBER} --body "$(cat <<'EOF'
## 🚨 Incident Response Activated

**Coordinator**: Forge pipeline (automated)
**Time**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

**Status**: Investigating
**Next action**: Validating fix approach and preparing hotfix deploy

---
### Timeline
| Time | Event |
|------|-------|
| {issue_created} | Incident reported |
| $(date -u +%H:%M) UTC | Response activated |
EOF
)"
```

---

### Phase 2: Validate the Fix

If a fix branch already exists (check issue comments for PR references):

#### Step 2A: Find the fix

```bash
# Check if there's already a PR or branch
FIX_PR=$(gh pr list --state open --search "#{NUMBER}" --json number,headRefName --jq '.[0]')
FIX_BRANCH=$(echo $FIX_PR | jq -r '.headRefName // empty')

# Or check if issue comments mention a branch
gh api repos/{owner}/{repo}/issues/{NUMBER}/comments \
  --jq '.[].body | select(contains("fix/") or contains("hotfix/"))' | grep -oP '(fix|hotfix)/[\w-]+'
```

#### Step 2B: Validate the fix won't make things worse

Spawn a validation agent to check the proposed fix:

```
Agent(model="{SUBAGENT_MODEL}", prompt="
You are validating a hotfix for a P0 production incident.

Issue: #{NUMBER} — {TITLE}
Fix branch: {FIX_BRANCH}
Repo: {REPO_PATH}

Your job:
1. Read the fix diff: git diff origin/main..origin/{FIX_BRANCH}
2. Verify it addresses the reported problem (read the issue body)
3. Check for obvious regressions:
   - Does it break any imports?
   - Does it remove functionality other code depends on?
   - Are there syntax errors?
   - Does it change DB schema without a migration?
4. Run compile checks (read forge.yaml → verification.commands for tool commands):
   - Python: always run python -m py_compile on changed .py files (no config needed)
   - Python format/lint: run verification.commands.python.format and .lint if configured; log "SKIPPED — not configured in verification.commands" if absent
   - TypeScript: run verification.commands.typescript.typecheck if configured; log "SKIPPED — not configured in verification.commands" if absent
5. Check if the fix is scoped tightly (minimal changes for the incident)

Output:
- SAFE TO DEPLOY: {yes/no}
- Concerns: {list any non-blocking concerns}
- Confidence: {high/medium/low}
- Recommendation: {deploy immediately / needs adjustment / needs more investigation}
")
```

#### Step 2C: Report validation result

```bash
gh issue comment {NUMBER} --body "$(cat <<'EOF'
### Hotfix Validation

**Branch**: `{FIX_BRANCH}`
**Validation**: {SAFE TO DEPLOY / NEEDS ADJUSTMENT}
**Confidence**: {level}

{If safe}:
**Ready for deploy.** Run (requires `deploy.workflow` set in `forge.yaml`):
```
gh workflow run {deploy.workflow} --ref {FIX_BRANCH} -f {deploy.workflow_inputs.services}={affected_services} -f {deploy.workflow_inputs.reason}="P0: {TITLE}"
```
*(If `deploy.workflow` is not configured, merge the fix branch via the GitHub web UI or your CI/CD provider.)*

{If not safe}:
**Concerns found:**
{list of concerns}

**Recommendation**: {what to fix before deploying}
EOF
)"
```

---

### Phase 3: Monitor Deploy (if hotfix triggered)

#### Step 3A: Watch the deploy workflow

```bash
# Find the most recent deploy run (requires deploy.workflow set in forge.yaml)
# Skip if deploy.workflow is not configured.
RUN_ID=$(gh run list --workflow={deploy.workflow} --limit 1 --json databaseId --jq '.[0].databaseId')

# Check status
gh run view $RUN_ID --json status,conclusion,jobs
```

#### Step 3B: Post deploy status

```bash
CONCLUSION=$(gh run view $RUN_ID --json conclusion --jq '.conclusion')

gh issue comment {NUMBER} --body "$(cat <<'EOF'
### Deploy Status

**Workflow run**: $RUN_ID
**Status**: $CONCLUSION
**Time**: $(date -u +%H:%M) UTC

{If success}: ✅ Hotfix deployed. Monitor production for resolution.
{If failure}: ❌ Deploy failed. Check workflow logs: `gh run view $RUN_ID --log`
EOF
)"
```

#### Step 3C: Update timeline

```bash
gh issue comment {NUMBER} --body "$(cat <<'EOF'
### Updated Timeline

| Time | Event |
|------|-------|
| {issue_created} | Incident reported |
| {response_time} | Response activated |
| {validation_time} | Fix validated |
| {deploy_time} | Hotfix deployed |
| {now} | Monitoring for resolution |

**Next**: Verify production health in 5-10 minutes. If resolved, proceed to postmortem.
EOF
)"
```

---

## Mode 2: Post-Incident Analysis

### Phase 4: Reconstruct the Incident

#### Step 4A: Gather all context

```bash
# Read the full issue thread
gh issue view {NUMBER} --json number,title,body,labels,comments,closedAt,createdAt

# Find the fix PR
gh pr list --state merged --search "#{NUMBER}" --json number,title,mergeCommit,mergedAt,body,files

# Find the deploy that caused the incident (most recent before issue creation)
ISSUE_CREATED=$(gh issue view {NUMBER} --json createdAt --jq '.createdAt')
gh pr list --state merged --base main --json number,title,mergedAt \
  --jq "[.[] | select(.mergedAt < \"$ISSUE_CREATED\")] | sort_by(.mergedAt) | reverse | .[0:5]"
```

#### Step 4B: Identify root cause

Spawn an investigation agent:

```
Agent(model="{SUBAGENT_MODEL}", prompt="
You are conducting a post-incident root cause analysis.

Incident: #{NUMBER} — {TITLE}
Issue body: {BODY}
Fix PR: #{FIX_PR}
Comments: {RELEVANT_COMMENTS}

Investigate:
1. What was the direct cause? (specific code change, config error, external failure)
2. What was the root cause? (why did the direct cause happen — process gap, missing test, etc.)
3. What deploy introduced the problem? (specific PR merged to main)
4. Why wasn't it caught before deploy? (review gap, missing test, untested path)
5. How long was the incident? (reported → fix deployed)
6. What was the blast radius? (all users, specific tier, specific feature)

Read the fix diff and the introducing PR to understand what went wrong and how it was resolved.
")
```

#### Step 4C: Generate the postmortem

```bash
gh issue comment {NUMBER} --body "$(cat <<'POSTMORTEM_EOF'
## Post-Incident Analysis

### Summary
| Field | Value |
|-------|-------|
| Incident | #{NUMBER} — {TITLE} |
| Severity | P0 |
| Duration | {start} → {resolved} ({duration}) |
| Blast radius | {description} |
| Root cause | {1 sentence} |
| Fix | PR #{FIX_PR} |

### Timeline
| Time (UTC) | Event |
|------------|-------|
| {time} | Introducing change merged (PR #{CAUSE_PR}) |
| {time} | Deploy triggered (CI/CD on push to main) |
| {time} | First user impact |
| {time} | Incident reported (issue created) |
| {time} | Response activated |
| {time} | Root cause identified |
| {time} | Fix validated |
| {time} | Hotfix deployed |
| {time} | Incident resolved |

### Root Cause Analysis

**Direct cause**: {what specifically broke — code path, missing check, wrong config}

**Contributing factors**:
- {Why the direct cause wasn't caught in review}
- {Why it wasn't caught in testing}
- {Any process gaps}

### What Went Well
- {Things that worked during response}

### What Went Wrong
- {Things that made the incident worse or slower to resolve}

### Action Items

| # | Action | Type | Priority | Owner |
|---|--------|------|----------|-------|
| 1 | {preventive action} | Prevention | P1 | Pipeline |
| 2 | {detection improvement} | Detection | P2 | Pipeline |
| 3 | {process improvement} | Process | P2 | Team |

### Pipeline Improvement Opportunities

{Specific suggestions for how the Forge pipeline could have prevented or shortened this incident:
- Could /review-pr have caught this? (add to review-pr-agents.md)
- Could /quality-gate have caught this? (add a new check)
- Could /deploy-info have flagged the risk? (add a risk signal)
- Should /rollback be faster? (streamline the process)}
POSTMORTEM_EOF
)"
```

#### Step 4D: Create follow-up issues

For each action item identified in the postmortem:

```bash
gh issue create --title "{fix|feat|refactor}: {action item title}" \
  --label "{type_label},P{priority}" \
  --body "$(cat <<'BODY_EOF'
## Problem

{What gap or vulnerability this action item addresses. What failure mode it prevents.}

## Root Cause (if known)

{The specific system gap identified in the postmortem that this action item closes. If unknown: "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific, testable criterion}
- [ ] Verified in next incident drill or deployment

## Context

Action item from post-incident analysis of #{INCIDENT_NUMBER}.
See postmortem: #{INCIDENT_NUMBER} (comment)

## Proposed Fix

{Concrete next step}
BODY_EOF
)"
```

---

## Phase 5: Summary

### Active Response Summary
```
## Incident Response: #{NUMBER}

- **Status**: {Active / Resolved / Monitoring}
- **Fix**: {branch} → validated → {deployed / pending}
- **Duration so far**: {time since issue creation}
- **Next action**: {what needs to happen next}

{If deployed}: Monitor production. Run `/incident-response postmortem {NUMBER}` after confirming resolution.
{If pending}: Fix needs {adjustment / deploy trigger}. See validation comment above.
```

### Postmortem Summary
```
## Postmortem Complete: #{NUMBER}

- **Duration**: {total incident time}
- **Root cause**: {1 sentence}
- **Fix**: PR #{FIX_PR}
- **Action items created**: {N} issues
- **Pipeline improvements**: {list of Forge changes recommended}

Action items: {list of created issue numbers}
```
