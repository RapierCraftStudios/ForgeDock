---
title: "The FORGE Annotation Protocol"
description: "Technical specification for FORGE annotations — the open machine-readable comment protocol for AI agent context passing. Adopt it in your own agent pipelines."
keywords: ["ai agent context protocol", "ai agent communication", "forge annotations", "llm agent memory protocol", "ai pipeline protocol", "structured agent context"]
---

# The FORGE Annotation Protocol

FORGE annotations are machine-readable HTML comment blocks embedded in GitHub issue and PR comments. They form a **lightweight, open protocol** for AI agents to pass structured context to each other across sessions.

Any AI pipeline can adopt FORGE annotations. The format is GitHub-native, human-readable, and requires no infrastructure beyond the `gh` CLI.

---

## The Problem FORGE Solves

AI agents are stateless. When a session ends, every agent starts fresh — with no knowledge of what previous agents found, decided, or built.

The naive solution is to re-derive everything from scratch every time. This is:

- **Slow** — repeating investigation work already done
- **Inconsistent** — different agents may reach different conclusions about the same code
- **Lossy** — nuance from investigation doesn't always survive into implementation

FORGE solves this by making agent outputs **persistent**, **structured**, and **queryable** — written to GitHub where they stay forever and can be read by any downstream agent or human.

---

## Protocol Overview

A FORGE annotation is a GitHub comment that begins with an HTML comment tag identifying the agent that wrote it:

```html
<!-- FORGE:{AGENT_TYPE} -->
```

The comment may also contain a completion marker:

```html
<!-- {AGENT_TYPE}:COMPLETE -->
```

The completion marker is checked by downstream pipeline phases to determine whether the annotation represents a fully-written result or a partial/interrupted one.

---

## Defined Annotation Types

### `FORGE:INVESTIGATOR`

Posted by the investigation agent after analyzing an issue.

**Contents**:
- Verdict: CONFIRMED | PARTIAL | INVALID
- Confidence: HIGH | MEDIUM | LOW
- Severity: CRITICAL | HIGH | MEDIUM | LOW
- Root Cause with file:line references
- Complete Affected Files list
- Evidence (function names, behavior observed)
- Decomposition Assessment (YES/NO with rationale)

**Completion marker**: `<!-- INVESTIGATION:COMPLETE -->`

**Read by**: Builder, Architect, Context Gatherer

```
<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: CONFIRMED
**Confidence**: HIGH
**Root Cause**: `services/payments/validator.py:142` — billing profile lookup
  does not guard against None for free-tier users.

...

<!-- INVESTIGATION:COMPLETE -->
```

---

### `FORGE:CONTRACT`

Posted by the contract agent, establishing the build scope.

**Contents**:
- Task Type (Bug Fix | Feature | Refactor | Maintenance)
- Proposed Approach
- Deliverables table: file | change description | why
- Acceptance Criteria (checkboxes)
- Quality Considerations
- Out of Scope

**Read by**: Builder, Reviewer

---

### `FORGE:ARCHITECT`

Posted by the architecture agent with an implementation plan.

**Contents**:
- Affected Paths table: file | function | change required | why
- Implementation Order (numbered, with rationale)
- Consistency Checks (invariants all paths must satisfy)
- Risk Assessment table: risk | severity | mitigation
- Files to Read Before Coding

**Completion marker**: `<!-- FORGE:ARCHITECT:COMPLETE -->`

**Read by**: Builder (follows the implementation order exactly)

---

### `FORGE:CONTEXT`

Posted by the context gathering agent with institutional memory.

**Contents**:
- Known Pitfalls for This Area (from past review findings)
- Historical Findings on These Files
- Past Bugs in This Module
- Related Code Paths (callers/importers of changed functions)
- Patterns That Cause Bugs Here
- Successful Similar Implementations

**Completion marker**: `<!-- FORGE:CONTEXT:COMPLETE -->`

**Read by**: Builder (read before touching any code)

---

### `FORGE:BUILDER`

Posted by the implementation agent after completing a build.

**Contents**:
- Branch name
- Commit SHAs
- Files changed count
- Approach summary (key decisions)
- Changes (bulleted file-by-file list)
- Acceptance Criteria Status (from CONTRACT, marked pass/fail)
- Testing Checklist

**Completion marker**: `<!-- FORGE:BUILDER:COMPLETE -->`

**Read by**: Review orchestrator, Phase 6 close agent

---

### `FORGE:REVIEWER`

Posted by domain review agents on the PR.

**Contents**:
- Agent type (e.g., SECURITY, LOGIC, FRONTEND, DATABASE)
- Verdict: APPROVED | CHANGES_REQUESTED | COMMENTED
- Findings (severity: CRITICAL | HIGH | MEDIUM | LOW)
- Each finding: description, affected line, suggested fix, prevention rule

**Read by**: Review orchestrator (determines merge eligibility), future context agents

---

### `FORGE:TRAJECTORY`

Posted as the final annotation on a closed issue. Serves as a permanent audit trail.

**Contents**:
- Phase-by-phase results table
- Key decisions made during the pipeline
- Anomalies detected
- Pipeline completion timestamp

**Read by**: `pipeline-health` command for performance analysis, future context agents for pattern mining

---

## Partial Annotation Detection

If a pipeline phase is interrupted mid-run (session ends, compaction, error), the annotation may be present but incomplete — missing its completion marker.

The canonical detection pattern:

```bash
# Check for FORGE:INVESTIGATOR without INVESTIGATION:COMPLETE
gh api repos/{owner}/{repo}/issues/{number}/comments \
  --jq '.[] | select(
    .body | contains("FORGE:INVESTIGATOR") and
    (contains("INVESTIGATION:COMPLETE") | not)
  ) | .id'
```

If a partial annotation is found, the pipeline deletes it and re-runs the phase from scratch. This ensures downstream agents never read incomplete context.

---

## Querying FORGE State with the `gh` CLI

FORGE annotations are queryable using standard `gh` CLI JSON filtering:

```bash
# Get the investigation report for issue #42
gh api repos/{owner}/{repo}/issues/42/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'

# Check current workflow phase
gh issue view 42 -R {owner}/{repo} --json labels \
  --jq '[.labels[].name | select(startswith("workflow:"))]'

# Find all issues currently in-review
gh issue list -R {owner}/{repo} \
  --label "workflow:in-review" \
  --json number,title

# Check if build is complete (FORGE:BUILDER exists)
gh api repos/{owner}/{repo}/issues/42/comments \
  --jq '.[] | select(.body | contains("FORGE:BUILDER:COMPLETE")) | .id'
```

---

## Adopting FORGE in Your Own Pipeline

FORGE is an open format. You don't need ForgeDock to use it.

**Minimum viable adoption**:

1. Pick annotation types relevant to your pipeline (INVESTIGATOR + BUILDER is a good start)
2. Write your agent prompts to post annotated comments after each phase
3. Write your downstream agent prompts to read those comments before starting

The protocol is intentionally minimal — it's just structured text in GitHub comments. Any agent that can run `gh issue comment` and `gh api` can participate.

**Extending the protocol**:

You can define your own annotation types by following the naming convention:

```html
<!-- FORGE:YOUR_CUSTOM_AGENT -->
```

The only constraint: use a unique name that won't conflict with existing types. Custom types are invisible to ForgeDock agents, which only read the types they know about.

---

## Why GitHub Comments (Not a Database)

FORGE deliberately uses GitHub comments rather than a dedicated database or vector store because:

1. **Zero infrastructure** — no service to deploy, no schema to maintain
2. **Human-readable** — engineers can read the full context without tooling
3. **Durable** — GitHub issues are permanent; comments survive repo migrations
4. **Queryable** — the `gh` CLI provides a complete query interface
5. **Universal** — any agent that can use `gh` can participate in the pipeline

The tradeoff is that querying is text-based (not semantic). For most pipeline coordination use cases, exact-match on annotation type markers is sufficient.

---

## Next Steps

- [How ForgeDock's Knowledge Graph Works](./how-it-works.md) — see FORGE annotations in the full pipeline context
- [Complete Command Reference](./command-reference.md) — commands that read and write FORGE annotations
- [Getting Started with ForgeDock in 5 Minutes](./getting-started.md) — see FORGE annotations appear live on your issues
