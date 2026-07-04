---
description: Trace a production issue or pipeline failure end-to-end through GitHub artifacts, then file a detailed improvement issue to the Forge repo
argument-hint: <description of what went wrong> [--issue N] [--pr N] [--repo prefix]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /audit — Pipeline Failure Trace & Self-Healing Issue

**Input**: $ARGUMENTS

You are Forge's post-mortem auditor. When something reaches production that shouldn't have, or an implementation didn't happen correctly, you trace the FULL chain of GitHub artifacts — from the original issue through every pipeline comment, PR, review, and merge — to find exactly where the pipeline broke down. You then file a detailed, evidence-backed improvement issue to the **Forge repository** so the pipeline can heal itself.

**This command ALWAYS files issues to `{FORGE_REPO}`.** The target project is read-only — you only read its GitHub artifacts as evidence.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.

**NEVER use plan mode (EnterPlanMode).**

---

## Config Preamble

Before executing any phase, read `forge.yaml` to resolve project references:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ -f "$CONFIG_FILE" ]; then
  GH_OWNER=$(yq '.project.owner' "$CONFIG_FILE")
  GH_REPO_NAME=$(yq '.project.repo' "$CONFIG_FILE")
  GH_REPO="${GH_OWNER}/${GH_REPO_NAME}"
  GH_FLAG="-R $GH_REPO"
  REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
  # FORGE_REPO: the self-pipeline repo where audit improvement issues are filed.
  # Set project.forge_repo in forge.yaml if your pipeline repo differs from GH_REPO.
  # Example: project:
  #            forge_repo: "my-org/my-forge"
  FORGE_REPO=$(yq '.project.forge_repo // ""' "$CONFIG_FILE")
  [ -z "$FORGE_REPO" ] && FORGE_REPO="$GH_REPO"
else
  echo "WARNING: forge.yaml not found — commands will use placeholder values"
  echo "Run: cp forge.yaml.example forge.yaml  and fill in your project details"
  GH_REPO="your-org/your-repo"
  GH_FLAG="-R $GH_REPO"
  REPO_PATH="./"
  FORGE_REPO="$GH_REPO"
fi
```

---

## Multi-Repo Support

If your project spans multiple repositories, define them in the `repos.satellites` section of `forge.yaml`. The `--repo <prefix>` argument selects a satellite by its `prefix` field.

Parse `$ARGUMENTS` for:
- **Problem description**: free-text explanation of what went wrong
- **`--issue N`**: specific issue number(s) to trace (comma-separated)
- **`--pr N`**: specific PR number(s) to trace (comma-separated)
- **`--repo prefix`**: target repo prefix (default: primary repo from `project.owner/project.repo`)

Set context variables from config:

```bash
REPO_PREFIX=$(echo "$ARGUMENTS" | grep -oP '(?<=--repo )\S+' || true)

if [ -n "$REPO_PREFIX" ]; then
  # Look up satellite repo by prefix in forge.yaml
  SATELLITE_REPO=$(yq ".repos.satellites[] | select(.prefix == \"$REPO_PREFIX\") | .repo" "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$SATELLITE_REPO" ] && [ "$SATELLITE_REPO" != "null" ]; then
    GH_REPO="$SATELLITE_REPO"
    GH_FLAG="-R $GH_REPO"
    REPO_PATH=$(yq ".repos.satellites[] | select(.prefix == \"$REPO_PREFIX\") | .local_path" "$CONFIG_FILE" 2>/dev/null || echo "$REPO_PATH")
  else
    echo "WARNING: --repo prefix '$REPO_PREFIX' not found in forge.yaml repos.satellites — using default repo"
  fi
fi
# GH_REPO, GH_FLAG, REPO_PATH are now set for the target repo
```

---

## Phase 1: Locate the Trail

### 1A: Parse the user's problem statement

Read `$ARGUMENTS` carefully. The user is describing a failure — extract:
- **What went wrong**: the symptom (production bug, incomplete implementation, missed edge case, wrong behavior)
- **Severity**: did it reach production? Was it caught in staging? Is it a near-miss?
- **Affected area**: which part of the codebase / feature / service

### 1B: Find related GitHub artifacts

Start from whatever the user provides (issue number, PR number, or description) and expand outward:

```bash
# If issue number(s) provided — load full issue context
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,comments,milestone,assignees,createdAt,closedAt

# If PR number(s) provided — load full PR context
gh pr view {PR_NUMBER} {GH_FLAG} --json number,title,body,state,author,baseRefName,headRefName,mergedAt,mergeCommit,files,comments,reviews,reviewRequests,additions,deletions,labels

# If only a description — search for related issues and PRs
gh issue list {GH_FLAG} --state all --limit 50 --json number,title,labels,state,createdAt \
  --jq '[.[] | select(.title | test("{KEYWORDS}"; "i"))]'

gh pr list {GH_FLAG} --state all --limit 50 --json number,title,state,mergedAt,headRefName \
  --jq '[.[] | select(.title | test("{KEYWORDS}"; "i"))]'
```

### 1C: Build the artifact chain

From the initial artifacts, trace connections:
- Issue → linked PRs (from issue body, `Closes #N`, branch names)
- PR → linked issues (from PR body, commit messages)
- Issue → child issues (from `<!-- FORGE:DECOMPOSED -->` comments or parent tracker mentions)
- PR → review-finding issues created from this PR's review

```bash
# Get all comments on the issue to find FORGE structured comments
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
  --jq '.[] | {id, author: .user.login, created_at: .created_at, markers: [.body | scan("FORGE:[A-Z]+")], body_preview: (.body | .[0:200])}'

# Get PR comments and reviews
gh api repos/{GH_REPO}/pulls/{PR_NUMBER}/comments --paginate \
  --jq '.[] | {id, author: .user.login, path: .path, body_preview: (.body | .[0:200])}'

gh api repos/{GH_REPO}/pulls/{PR_NUMBER}/reviews --paginate \
  --jq '.[] | {id, author: .user.login, state: .state, body_preview: (.body | .[0:200])}'

# Find review-finding issues created from this PR
gh issue list {GH_FLAG} --state all --label "review-finding" --limit 100 --json number,title,body \
  --jq "[.[] | select(.body | contains(\"PR #${PR_NUMBER}\"))]"
```

---

## Phase 2: Read Every Artifact in Full

**CRITICAL: Read EVERY artifact completely. Do not skim. The devil is in the details.**

### 2A: Read the full issue thread

For each issue in the chain, read the complete body and ALL comments:

```bash
gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body'

# Read ALL comments — these contain the pipeline's work product
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
  --jq '.[] | "---\n**\(.user.login)** at \(.created_at):\n\(.body)\n"'
```

Extract and catalog every structured comment:
- `<!-- FORGE:INVESTIGATOR -->` — Investigation report (verdict, confidence, affected files)
- `<!-- FORGE:CONTRACT -->` — Build contract (deliverables, acceptance criteria)
- `<!-- FORGE:CONTEXT -->` — Pre-build context (historical findings, related code paths)
- `<!-- FORGE:ARCHITECT -->` — Architecture plan (ordered implementation steps)
- `<!-- FORGE:BUILDER -->` — Build report (what was done, files changed, commits)
- `<!-- FORGE:TRAJECTORY -->` — Phase-by-phase results table
- `<!-- FORGE:DECOMPOSED -->` — Decomposition into sub-issues

### 2B: Read the full PR thread

For each PR in the chain:

```bash
# Full PR diff
gh pr diff {PR_NUMBER} {GH_FLAG}

# All review comments (inline code review)
gh api repos/{GH_REPO}/pulls/{PR_NUMBER}/comments --paginate \
  --jq '.[] | "**\(.user.login)** on \(.path):\(.line // .original_line):\n\(.body)\n---"'

# All PR reviews (approve/request changes/comment)
gh api repos/{GH_REPO}/pulls/{PR_NUMBER}/reviews --paginate \
  --jq '.[] | "\(.user.login) — \(.state):\n\(.body)\n---"'

# PR timeline events (label changes, assignments, etc.)
gh api repos/{GH_REPO}/issues/{PR_NUMBER}/timeline --paginate \
  --jq '.[] | select(.event == "labeled" or .event == "merged" or .event == "closed" or .event == "referenced") | {event: .event, label: .label.name, created_at: .created_at}'
```

### 2C: Read review-finding issues

For each review-finding issue spawned from the PR:

```bash
gh issue view {FINDING_NUMBER} {GH_FLAG} --json number,title,body,labels,state,comments
```

Note whether each finding was:
- VALIDATED and fixed
- Closed as FALSE_POSITIVE
- Still open (unfixed)

### 2D: Check agent output logs (if available)

Look for trajectory logs or agent JSONL output from the session that worked on this issue:

```bash
# Check for FORGE:TRAJECTORY comment (machine-readable phase results)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments --paginate \
  --jq '.[] | select(.body | contains("FORGE:TRAJECTORY")) | .body'

# Check for local agent outputs (if recent)
find /tmp/claude-1000/ -name "*.output" -newer /tmp/audit-marker -type l 2>/dev/null | head -20
```

---

## Phase 3: Root Cause Analysis

Now that you have the full evidence trail, analyze where the pipeline broke down.

### 3A: Map the pipeline path this issue took

Reconstruct the exact sequence:

```
Issue #{N} created
  → Phase 1: Investigation — {verdict} ({confidence})
  → Phase 2: Decomposition — {skipped / N sub-issues}
  → Phase 3: Build
    → 3C: Contract — {posted / missing}
    → 3C.5: Context — {posted / missing}
    → 3C.6: Architect — {posted / missing}
    → 3F: Implementation — {commits}
    → 3G: Quality Gate — {pass / fail, iterations}
  → Phase 4: PR #{PR} created → base: {branch}
  → Phase 5: Review — {agents triggered: SEC, AUTH, ...}
    → Review findings: {N} created, {N} validated
  → Phase 6: Close — {merged / still open}
```

### 3B: Identify the failure point

Classify where the breakdown occurred. Use these categories:

| Failure Point | Description | Fix Target |
|---------------|-------------|------------|
| **INVESTIGATION** | Wrong verdict, missed scope, insufficient analysis | `commands/work-on.md` Phase 1 |
| **DECOMPOSITION** | Should have decomposed but didn't, or decomposed wrong | `commands/work-on.md` Phase 2 |
| **CONTRACT** | Wrong deliverables, missing acceptance criteria | `commands/work-on.md` Phase 3C |
| **CONTEXT** | Missed relevant prior work, bug patterns, or related code | `commands/work-on.md` Phase 3C.5 |
| **ARCHITECT** | Missed code paths, wrong implementation plan | `commands/work-on.md` Phase 3C.6 |
| **IMPLEMENTATION** | Code written incorrectly, incomplete, wrong approach | `commands/work-on.md` Phase 3F, builder rules |
| **QUALITY_GATE** | Should have caught this defect class but didn't | `commands/quality-gate.md` |
| **REVIEW** | Review agents missed the issue, or wrong agents were triggered | `commands/review-pr.md`, `commands/review-pr-agents.md` |
| **REVIEW_FALSE_NEG** | Review agent looked at the right area but didn't flag the problem | `commands/review-pr-agents.md` (agent template) |
| **MERGE_POLICY** | Merged despite signals that should have blocked | `commands/work-on.md` Phase 5 |
| **DEPLOY_GATE** | Deploy-info should have flagged risk but didn't | `commands/deploy-info.md` |
| **ORCHESTRATION** | Wave ordering wrong, dependency missed, stall | `commands/orchestrate.md` |
| **ISSUE_SPEC** | Original issue was ambiguous/incomplete — pipeline followed it correctly but the spec was wrong | Not a pipeline fix — note for process improvement |

### 3C: Determine root cause vs contributing factors

- **Root cause**: The single most impactful failure point. If THIS had worked, the problem wouldn't have reached production.
- **Contributing factors**: Other pipeline links that could have caught it as a safety net but didn't.

### 3D: Cross-reference with Pipeline Hardening Principles

Before proposing a fix, check which layer it belongs to (from CLAUDE.md):

- **Quality gate** → static analysis, grep-catchable patterns
- **Review agents** → semantic reasoning, library API contracts, cross-service interactions
- **Domain detection** → broad category matching, not per-bug-instance
- **Builder rules** → prevention at write time, simple memorable rules

**Do NOT propose a quality-gate grep check for a reasoning failure. Do NOT propose a review-agent prompt change for a pattern grep could catch.**

---

## Phase 4: File the Forge Issue

Create a detailed, actionable issue in the **Forge repository**.

### 4A: Determine issue type and labels

| Root Cause Category | Label | Priority |
|---------------------|-------|----------|
| Reached production, caused user impact | `P1,audit-finding,bug` | High |
| Reached production, no/minimal user impact | `P2,audit-finding,bug` | Medium |
| Caught in staging/review but pipeline should have prevented earlier | `P2,audit-finding,improvement` | Medium |
| Near-miss, caught before merge | `P3,audit-finding,improvement` | Low |

### 4B: Create the issue

**Before creating, run the deterministic dedup check:** <!-- Added: forge#1335 -->

```bash
AUDIT_TITLE="fix(pipeline): {one-line description of what the pipeline missed}"
DEDUP_RESULT=$(scripts/issue-dedup.sh "$AUDIT_TITLE" -R {FORGE_REPO} 2>/dev/null)
DEDUP_EXIT=$?
if [ "$DEDUP_EXIT" -eq 1 ]; then
  echo "DEDUP: Audit finding near-duplicate — $DEDUP_RESULT"
  echo "Skipping creation. Comment on the existing issue with new evidence instead."
  # Do NOT call gh issue create for this audit finding
fi
```

Only call `gh issue create` when the dedup script exits 0:

```bash
gh issue create -R {FORGE_REPO} \
  --title "fix(pipeline): {one-line description of what the pipeline missed}" \
  --label "{LABELS}" \
  --body "$(cat <<'EOF'
## Problem

{2-3 sentences: what production issue or implementation failure occurred and what pipeline phase failed to prevent it.}

## Root Cause

**Failure point**: {FAILURE_POINT category from 3B}
**Root cause**: {FAILURE_POINT} — {detailed explanation of why this pipeline link failed}

{Specific evidence: quote the relevant comment/diff/review that shows the gap}

**Contributing factors**:
- **{PIPELINE_LINK}**: {what it could have caught but didn't, and why}

## Affected Files

Files that need changes:
1. `commands/{FILE}.md` — {Phase/Step reference} — {Fix type: New check | Tightened prompt | New builder rule | New review agent logic | New domain detection}

## Acceptance Criteria

- [ ] {Specific change implemented in target file}
- [ ] Regression guard: {what existing behavior must be preserved}
- [ ] No regression in {related pipeline phase}

## Context

**Audited at**: {DATE}
**Target repo**: {GH_REPO}
**Severity**: {P1/P2/P3}

### Evidence Trail

| Artifact | Link | Key Finding |
|----------|------|-------------|
| Issue | {GH_REPO}#{ISSUE_NUMBER} | {1-line summary of issue} |
| Investigation | Comment on #{ISSUE_NUMBER} | Verdict: {verdict} — {was it correct?} |
| Contract | Comment on #{ISSUE_NUMBER} | {was it complete?} |
| Context | Comment on #{ISSUE_NUMBER} | {did it surface relevant prior work?} |
| Architect | Comment on #{ISSUE_NUMBER} | {did it trace all code paths?} |
| Builder | Comment on #{ISSUE_NUMBER} | {did it implement correctly?} |
| PR | {GH_REPO}#{PR_NUMBER} | {files changed, what was the diff} |
| Quality Gate | PR #{PR_NUMBER} | {did it run? what did it check?} |
| Review | PR #{PR_NUMBER} | Agents: {which ran}. Findings: {N} |
| Review Findings | #{FINDING_NUMBERS} | {validated/false-positive/open} |
| Trajectory | Comment on #{ISSUE_NUMBER} | {phase-by-phase results} |

{Include only rows for artifacts that exist. Mark missing artifacts explicitly as "MISSING — not posted by pipeline"}

### Pipeline Path Reconstruction

```
{Full pipeline path from 3A — show what happened at each phase}
```

### What Should Have Happened

{Describe what the pipeline SHOULD have done differently at the failure point. Be specific — reference the exact phase, step, and what check/reasoning was missing.}

### Proposed Fix

**Target file**: `commands/{FILE}.md`
**Target section**: {Phase/Step reference}
**Fix type**: {New check | Tightened prompt | New builder rule | New review agent logic | New domain detection}

**Specific change**:
{Describe the exact change to the command file. Be as concrete as possible:
- If adding a builder rule: write the rule text
- If adding a quality-gate check: describe the grep pattern
- If tightening a review agent: describe the reasoning step to add
- If adding context/architect guidance: describe the lookup or trace step}

**Hardening layer justification** (per CLAUDE.md Pipeline Hardening Principles):
{Explain why this fix belongs in the proposed layer and not another}

### Related Prior Work

{List any related forge issues, PRs, or CHANGELOG entries that address similar pipeline gaps}

```bash
# Search forge for related issues
gh issue list -R {FORGE_REPO} --state all --limit 30 --json number,title \
  --jq '[.[] | select(.title | test("{KEYWORDS}"; "i"))]'
```

{Include results here with links}
EOF
)"
```

---

## Phase 5: Cross-Reference and Enrich

### 5A: Search for pattern recurrence

Check if this same failure pattern has occurred before:

```bash
# Similar audit findings in forge
gh issue list -R {FORGE_REPO} --state all --label "audit-finding" --limit 50 \
  --json number,title,state --jq '.[] | "\(.number) | \(.title) | \(.state)"'

# Same failure point in existing issues
gh issue list -R {FORGE_REPO} --state all --limit 100 --json number,title,body \
  --jq "[.[] | select(.body | contains(\"{FAILURE_POINT}\"))] | .[] | \"\(.number) | \(.title)\""
```

If this is a **recurring pattern** (same failure point, same defect class, happened 2+ times):
- Elevate priority by one level (P3→P2, P2→P1)
- Add label `recurring`
- Reference all prior occurrences in the issue body
- Note in the issue that single-instance fixes haven't worked — a structural change may be needed

### 5B: Link back to target repo

Comment on the original target repo issue (if it exists and is still open) noting the audit:

```bash
gh issue comment {NUMBER} {GH_FLAG} --body "$(cat <<'EOF'
<!-- FORGE:AUDIT -->
## Pipeline Audit

This issue was audited by Forge. A pipeline improvement issue has been filed:
- **Forge issue**: {FORGE_REPO}#{FORGE_ISSUE_NUMBER}
- **Failure point**: {FAILURE_POINT}
- **Root cause**: {1-line summary}

The pipeline will be improved to prevent this class of issue in the future.
EOF
)"
```

---

## Phase 6: Summary

Print to the user:

```
## Audit Complete

**Problem**: {1-line description}
**Target repo**: {GH_REPO}
**Artifacts traced**: {N} issues, {N} PRs, {N} comments, {N} review findings

### Failure Point: {CATEGORY}
**Root cause**: {1-line}
**Fix target**: commands/{FILE}.md — {section}

### Forge Issue Filed
{FORGE_ISSUE_URL}

### Evidence Chain
{Issue} → {Investigation} → {Contract} → {Build} → {PR} → {Review} → {Merge}
{Mark each link as ✅ (worked correctly) or ❌ (broke here) or ⚠️ (contributing factor)}
```
