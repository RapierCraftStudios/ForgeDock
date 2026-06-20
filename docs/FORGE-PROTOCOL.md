# FORGE Annotation Protocol

**Version**: 1.0
**Status**: Draft
**License**: AGPL-3.0

---

## Overview

The FORGE Annotation Protocol defines a machine-readable communication standard for AI development pipeline agents operating on GitHub. Agents write structured annotations as HTML comments inside GitHub issue and PR comments. Downstream agents read those annotations to reconstruct context — without relying on conversation history, shared memory, or a centralized server.

**Key properties**:
- **Transport**: Standard GitHub issue/PR comment API
- **Encoding**: HTML comment tags (`<!-- FORGE:TYPE -->`) containing Markdown body
- **Persistence**: GitHub issues/PRs are append-only — annotations survive compaction and session restarts
- **Query interface**: `gh` CLI with `--jq` filters on `.body | contains("FORGE:TYPE")`
- **Authoring agents**: Any AI agent that can write to the GitHub API
- **Reader agents**: Any AI agent that can read the GitHub API

The goal is interoperability: a pipeline agent from any tool (ForgeDock, Codex, aider, sweep, or a custom integration) should be able to produce and consume FORGE annotations, enabling chained multi-agent workflows where each agent picks up where the previous one left off.

---

## Syntax

Every annotation begins with an opening HTML comment tag on its own line:

```
<!-- FORGE:{TYPE} -->
```

The annotation body follows in Markdown. An annotation ends when the next `<!-- FORGE:` tag appears, or at the end of the comment. Completion sentinels use a `{TYPE}:COMPLETE` suffix:

```
<!-- INVESTIGATION:COMPLETE -->
<!-- FORGE:CONTEXT:COMPLETE -->
<!-- FORGE:ARCHITECT:COMPLETE -->
<!-- FORGE:BUILDER:COMPLETE -->
<!-- FORGE:DECOMPOSED:COMPLETE -->
```

**Partial annotations** (interrupted before completion) use `:PARTIAL`:

```
<!-- FORGE:CONTEXT:PARTIAL -->
<!-- FORGE:ARCHITECT:PARTIAL -->
```

An annotation comment without its completion sentinel indicates an interrupted run. Implementations SHOULD delete and restart partial annotations.

---

## Annotation Types

### Issue Pipeline Annotations

These annotations are posted as GitHub **issue comments** and form the primary context chain for a pipeline run.

---

#### `FORGE:INVESTIGATOR`

**Phase**: Investigation (Phase 1)
**Written by**: Investigator agent
**Read by**: Builder agent, Architect agent, Decomposer agent
**Completion sentinel**: `<!-- INVESTIGATION:COMPLETE -->`

Captures the outcome of investigating whether an issue is valid, what the root cause is, and what should be built.

**Schema**:

```
<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: {CONFIRMED|PARTIAL|INVALID}
**Confidence**: {HIGH|MEDIUM|LOW}
**Severity**: {CRITICAL|HIGH|MEDIUM|LOW}
**Task Type**: {Bug Fix|Feature|Refactor|Maintenance|Investigation}

### What Was Claimed
{Summary of what the issue describes}

### What We Found
{What the code actually shows — specific evidence}

### Root Cause
{Specific root cause with file:line references where applicable}

### Affected Files
{Numbered list of files that need changes}

### Evidence
{Specific findings — function names, line numbers, behavior observed}

### Recommendation
{What to build or fix, concrete and actionable}

### Related Issues
{Related issues found via domain context discovery, max 5}

### Decomposition Assessment
**{YES|NO}** — {reason}
{If YES: proposed sub-issues with titles and dependencies}

<!-- INVESTIGATION:COMPLETE -->
```

**Field semantics**:

| Field | Values | Required |
|-------|--------|----------|
| `Verdict` | `CONFIRMED` / `PARTIAL` / `INVALID` | Yes |
| `Confidence` | `HIGH` / `MEDIUM` / `LOW` | Yes |
| `Severity` | `CRITICAL` / `HIGH` / `MEDIUM` / `LOW` | Yes |
| `Task Type` | `Bug Fix` / `Feature` / `Refactor` / `Maintenance` / `Investigation` | Yes |
| `Decomposition Assessment` | `YES` or `NO` followed by reason | Yes |

**Routing rules**:
- `CONFIRMED` or `PARTIAL` with Decomposition = NO → proceed to build
- `CONFIRMED` or `PARTIAL` with Decomposition = YES → proceed to decomposition
- `INVALID` → close issue with explanation

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'
```

---

#### `FORGE:DECOMPOSED`

**Phase**: Decomposition (Phase 2)
**Written by**: Decomposer agent
**Read by**: Orchestrator agent, parent issue tracker
**Completion sentinel**: `<!-- FORGE:DECOMPOSED:COMPLETE -->`

Posted on the parent issue after sub-issues are created. Signals that the issue has been decomposed and each sub-issue now runs its own pipeline.

**Schema**:

```
<!-- FORGE:DECOMPOSED -->
## Decomposition Complete

### Sub-Issues Created
- #{NUMBER}: {TITLE}

### Decomposition Rationale
{Brief summary explaining why decomposition was needed}

<!-- FORGE:DECOMPOSED:COMPLETE -->
```

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:DECOMPOSED")) | .body'
```

---

#### `FORGE:CONTRACT`

**Phase**: Build — Contract (Phase 3C)
**Written by**: Builder agent
**Read by**: Builder agent (implementation phase), Review agents

Defines the scope of a build task before implementation begins. Acts as a binding agreement between the investigator's findings and what will actually be built.

**Schema**:

```
<!-- FORGE:CONTRACT -->
## Builder Contract

**Task type**: {TASK_TYPE}

### Proposed Approach
{Brief description of the implementation approach}

### Deliverables
| File | Change | Why |
|------|--------|-----|
| {filepath} | {what changes} | {why this change is needed} |

### Acceptance Criteria
- [ ] {Specific, testable criterion}

### Quality Considerations
{Auth model, new env vars, SQL safety, security surface, migration risk}

### Out of Scope
{Items explicitly excluded from this PR}
```

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTRACT")) | .body'
```

---

#### `FORGE:CONTEXT`

**Phase**: Build — Context Gathering (Phase 3C.5)
**Written by**: Context agent
**Read by**: Builder agent (implementation phase)
**Completion sentinels**: `<!-- FORGE:CONTEXT:COMPLETE -->` (full), `<!-- FORGE:CONTEXT:PARTIAL -->` (time-limited)

Surfaces institutional memory before implementation begins. Aggregates past review findings, historical bugs, related code paths, and successful patterns from similar implementations.

**Schema**:

```
<!-- FORGE:CONTEXT -->
## Implementation Context for #{NUMBER}

### Known Pitfalls for This Area
{Prevention rules from past review-findings on these files}

### Historical Findings on These Files
{Past review-finding issues with pattern and prevention details}

### Past Bugs in This Module
{Closed bug issues found via git log mining}

### Related Code Paths (must stay consistent)
{Files that import or call the functions being changed}

### Patterns That Cause Bugs Here
{Recurring bug types synthesized from historical findings}

### Successful Similar Implementations
{Positive patterns from merged PRs in the same domain}

<!-- FORGE:CONTEXT:COMPLETE -->
```

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:CONTEXT")) | .body'
```

---

#### `FORGE:ARCHITECT`

**Phase**: Build — Architecture Plan (Phase 3C.6)
**Written by**: Architect agent
**Read by**: Builder agent (implementation phase — primary input)
**Completion sentinels**: `<!-- FORGE:ARCHITECT:COMPLETE -->` (full), `<!-- FORGE:ARCHITECT:PARTIAL -->` (time-limited)

Contains the ordered implementation plan. The builder agent follows this plan exactly when present. It traces all affected code paths, establishes consistency rules, sequences changes, and assesses risks.

**Schema**:

```
<!-- FORGE:ARCHITECT -->
## Implementation Plan for #{NUMBER}

### Affected Paths (ALL must be updated)
| # | File | Function/Class | Change Required | Why |
|---|------|----------------|-----------------|-----|
| 1 | {filepath} | {function or class} | {what to change} | {reason} |

### Implementation Order
1. {First change} — {why first}
2. {Second change} — {why second}

### Consistency Checks
- [ ] {Invariant that all paths must satisfy}

### Risk Assessment
| Risk | Severity | Mitigation |
|------|----------|------------|
| {risk description} | HIGH/MEDIUM/LOW | {mitigation} |

### Files to Read Before Coding
- `{filepath}` — {why to read it}

<!-- FORGE:ARCHITECT:COMPLETE -->
```

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:ARCHITECT")) | .body'
```

---

#### `FORGE:BUILDER`

**Phase**: Build — Implementation Complete (Phase 3M)
**Written by**: Builder agent
**Read by**: Review agents, Close phase agent
**Completion sentinel**: `<!-- FORGE:BUILDER:COMPLETE -->`

Posted after all implementation work is done and committed. Captures the branch, commits, files changed, and testing checklist. This is the primary handoff annotation to the review phase.

**Schema**:

```
<!-- FORGE:BUILDER -->
## Implementation Complete

**Branch**: `{branch-name}`
**Commits**: {commit SHA(s)}
**Files changed**: {count}

### Approach
{What was built, key decisions made}

### Changes
- `{filepath}` — {what changed}

### Acceptance Criteria Status
- [x] {criterion} — PASS
- [ ] {criterion} — FAIL (reason)

### Testing Checklist
- [ ] {test scenario}

<!-- FORGE:BUILDER:COMPLETE -->
```

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:BUILDER")) | .body'
```

---

#### `FORGE:REVIEW_STARTED`

**Phase**: Review (Phase 5B)
**Written by**: Orchestrator agent

Signals that the review phase has been invoked. Posted on the issue immediately before calling the review agent. Used to detect whether a review was initiated after compaction.

**Schema**:

```
## Submitting for Review

PR #{PR_NUMBER} created targeting `{base-branch}`. Invoking /review-pr with --auto-merge.

<!-- FORGE:REVIEW_STARTED -->
```

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:REVIEW_STARTED")) | .body'
```

---

#### `FORGE:TRAJECTORY`

**Phase**: Summary (Phase 7)
**Written by**: Orchestrator agent

Records the complete pipeline run as an audit trail. One `FORGE:TRAJECTORY` comment per issue lifecycle. Includes phase-by-phase results, decisions, and anomalies.

**Schema**:

```
<!-- FORGE:TRAJECTORY -->
## Pipeline Trajectory — #{NUMBER}

| Phase | Result | Notes |
|-------|--------|-------|
| Phase 0: Context Load | ✅ Complete | {lane} → `{base-branch}` |
| Phase 1: Investigation | ✅ {VERDICT} ({CONFIDENCE}) | Task type: {TASK_TYPE} |
| Phase 2: Decomposition | ⏭ Skipped | {reason} |
| Phase 3: Build | ✅ Complete | Branch: `{branch}` |
| Phase 3G: Quality Gate | ✅ Gate passed | {N} iterations |
| Phase 4–5: Review + PR | ✅ Merged | PR #{PR_NUMBER} → `{base-branch}` |
| Phase 6: Close | ✅ Complete | Issue closed |

**Decisions**: {key decisions made during the run}
**Anomalies**: {anomalies or None}
**Pipeline completed**: {ISO 8601 timestamp}
```

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:TRAJECTORY")) | .body'
```

---

### Design Pipeline Annotations

These annotations drive the UI Taste Harness — the design-generation pipeline that produces a landing page from a design-blind product brief. They carry design intent across the architect → generate → critique → close stages, exactly as the issue-pipeline annotations carry code-context across investigate → build → review.

---

#### `FORGE:DESIGN_SPEC`

**Phase**: Design — Architecture (design-architect, #886)
**Written by**: Design-architect agent
**Read by**: Generate agent (constrains output), deterministic anti-slop linter (#884), render → vision-critique loop (#882), Close phase agent (persists realized spec to design-memory, #887)

A structured, **machine-checkable** representation of one page's design language. Carried across design-pipeline stages as a `FORGE:DESIGN_SPEC` annotation so taste decisions **persist** instead of being re-rolled per generation, and so a deterministic linter and a vision critic both check the rendered output against the *same* committed intent.

Critically, the spec is **produced by** a `FORGE:DESIGN_RATIONALE` (the reasoning) — not authored from nowhere. The flow is rationale → spec → page.

The full field-by-field schema (JSON shape, the per-field slop-tell defense table, and the lifecycle) lives in [`design/design-spec-schema.md`](design/design-spec-schema.md). The annotation body embeds that schema as a fenced `jsonc` block.

**Schema** (annotation envelope):

````
<!-- FORGE:DESIGN_SPEC -->
## Design Spec — {product}

```jsonc
{
  "meta":          { "product": "…", "archetype": "…", "corpus_version": "…", "rationale_ref": "…" },
  "typography":    { "display_family": "…", "body_family": "…", "scale_ratio": …, "weights": […] },
  "color":         { "mode": "…", "background": "#…", "foreground": "#…", "accent": "#…",
                     "rules": ["no-default-tailwind-palette", "contrast>=4.5"] },
  "spacing":       { "base_unit_px": …, "scale": […] },
  "radius":        { "scale": […] },
  "shadow":        { "tokens": […] },
  "motion":        { "vocabulary": […], "reduced_motion": "required" },
  "layout_grammar":{ "sections": [ { "id": "…", "purpose": "…", "density": "…" } ], "rhythm": "…" },
  "effects_plan":  { "per_section": [ … ], "budget": { … }, "never": [ … ] }, // doctrine: docs/design/effects-appropriateness.md (#885)
  "negatives":     [ … ],
  "acceptance":    { "perf_budget": { … }, "a11y": { … }, "divergence_ref": "…" }
}
```

→ Produced by FORGE:DESIGN_RATIONALE: {link}
````

**Field reference**: see [`design/design-spec-schema.md`](design/design-spec-schema.md) for the complete schema, the "How each field defends against slop" table, and the lifecycle.

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:DESIGN_SPEC")) | .body'
```

---

#### `FORGE:BENCH_SCORECARD`

**Phase**: Design — Benchmark (`/design-bench`, #878)
**Written by**: Benchmark rig (`/design-bench` command)
**Read by**: Harness developers (the fitness signal — "did arm A's win-rate vs C go up?"), milestone tracker, pipeline-health

The result of one ABC benchmark run. Arm A is the ForgeDock harness output, arm B is a raw one-shot model, and arm C is the real reference page (gold standard). The annotation carries the **win-rate of each arm against C**, the **A-vs-B harness delta**, rubric **distributions** (mean + stdev) across n runs, mean slop counts, and the **judge-calibration check** (C must beat A and B; otherwise the judge is miscalibrated and the result is suspect).

The scorecard is the fitness function for the UI Taste Harness milestone — it is built before the harness so each lever the harness adds is a measurable hypothesis. The methodology (three arms, same-model rule, three-layer judging, n>=3) lives in [`design/abc-benchmark.md`](design/abc-benchmark.md); the deterministic aggregator is [`../scripts/bench-scorecard.mjs`](../scripts/bench-scorecard.mjs).

Two invariants this annotation encodes: **n>=3** (taste output is high-variance — distributions, never a single number) and **judge independence** from the harness critique loop (#882) (anti-Goodhart).

**Schema** (annotation envelope):

````
<!-- FORGE:BENCH_SCORECARD -->
## ABC Benchmark Scorecard

**Corpus version**: {ver} · **Generation model (A & B)**: {model} · **Judge model**: {independent judge}
**Products**: {n_products} · **Runs/product**: {n}

| Arm | Win-rate vs C | A-vs-B | Mean slop |
|-----|---------------|--------|-----------|
| A   | {wr}          | {a_vs_b} | {slop_A} |
| B   | {wr}          | —        | {slop_B} |

**Judge calibration**: {ok | MISCALIBRATED — N runs where C lost (suspect)}

```json
{scorecard.json from bench-scorecard.mjs}
```

<!-- FORGE:BENCH_SCORECARD:COMPLETE -->
````

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:BENCH_SCORECARD")) | .body'
```

---

### Orchestration / Milestone Annotations

These annotations transfer investigation context across issue boundaries in decomposed or multi-issue milestone workflows.

---

#### `FORGE:KNOWLEDGE_GIST`

**Phase**: Investigation — Knowledge Persistence (Phase 1C.5)
**Written by**: Investigator agent
**Read by**: Decomposer agent, Builder agent (via `FORGE:PRIOR_GIST`)
**Location**: Issue comment

Posted after investigation completes. Contains a URL to a GitHub Gist that holds the full investigation findings as a stable, linkable artifact. Downstream sub-issues embed the Gist URL as `FORGE:PRIOR_GIST` annotations so builders can fetch prior context.

**Schema**:

```
<!-- FORGE:KNOWLEDGE_GIST: {https://gist.github.com/...} -->
## Knowledge Gist Created

Investigation findings persisted as a linkable artifact.

**Gist**: {URL}
**Filename**: `{repo}_{issue_number}_{slug}.md`

_This Gist can be referenced by downstream issues for context transfer._
```

**Gist content schema** (YAML frontmatter + Markdown body):

```yaml
---
issue: {NUMBER}
repo: {OWNER}/{REPO}
milestone: {MILESTONE_TITLE}
verdict: {CONFIRMED|PARTIAL|INVALID}
task_type: {TASK_TYPE}
confidence: {HIGH|MEDIUM|LOW}
severity: {CRITICAL|HIGH|MEDIUM|LOW}
created: {ISO 8601 timestamp}
source: FORGE:INVESTIGATOR
---
```

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | test("<!-- FORGE:KNOWLEDGE_GIST: https://")) |
        .body | capture("<!-- FORGE:KNOWLEDGE_GIST: (?<url>https://[^ ]+) -->").url] |
        unique | .[]'
```

---

#### `FORGE:MILESTONE_INDEX`

**Phase**: Investigation — Milestone Index (Phase 1C.6)
**Written by**: Investigator agent
**Read by**: Builder agent (via milestone description lookup)
**Location**: GitHub Milestone description field (not issue comment)

A URL embedded in the milestone description pointing to an index Gist. The index aggregates all `FORGE:KNOWLEDGE_GIST` URLs for a milestone, giving any agent working on any milestone issue access to all prior investigations in one fetch.

**Syntax** (in milestone description):

```
<!-- FORGE:MILESTONE_INDEX: {https://gist.github.com/...} -->
```

**Detection query**:
```bash
gh api repos/{OWNER}/{REPO}/milestones/{MILESTONE_NUMBER} \
  --jq '.description' | \
  grep -oP '(?<=<!-- FORGE:MILESTONE_INDEX: )https://[^ ]+(?= -->)'
```

---

#### `FORGE:PRIOR_GIST`

**Phase**: Decomposition (Phase 2C)
**Written by**: Decomposer agent
**Read by**: Builder agent (context phase)
**Location**: Sub-issue body

Embedded in sub-issue bodies by the decomposer. Points to the parent issue's Knowledge Gist. Allows the builder working on a sub-issue to fetch upstream investigation context without navigating the parent issue.

**Syntax** (in sub-issue body):

```
<!-- FORGE:PRIOR_GIST: {https://gist.github.com/...} -->
```

**Detection query** (from sub-issue body):
```bash
gh issue view {NUMBER} -R {OWNER}/{REPO} --json body --jq '.body' | \
  grep -oP '(?<=<!-- FORGE:PRIOR_GIST: )https://[^ ]+(?= -->)'
```

---

### Pipeline Control Markers

These annotations appear inside command specification files (not issue comments) to mark phase boundaries and error states.

---

#### `FORGE:DISPATCHER`

**Location**: Pipeline command spec (e.g., `work-on.md`)
**Purpose**: Marks the Universal Phase Dispatcher — the single source of truth for phase transitions and routing logic.

```
<!-- FORGE:DISPATCHER — {description} -->
```

---

#### `FORGE:PHASE_COMPLETE`

**Location**: Pipeline command spec
**Purpose**: Inter-phase boundary annotation. Documents that a phase has completed and identifies the next phase. Used to prevent agents from misinterpreting intermediate results as terminal states.

```
<!-- FORGE:PHASE_COMPLETE — {description of what completed}. See Universal Phase Dispatcher: next phase is {NEXT_PHASE}. Not terminal — continue immediately. -->
```

---

#### Error State Markers

Posted to issue comments when pipeline operations fail hard. Signal that human intervention is needed.

| Annotation | Trigger |
|-----------|---------|
| `<!-- FORGE:ANCESTRY_FAILED -->` | Post-commit ancestry audit found merge commits in the branch |
| `<!-- FORGE:GATE_FAILED -->` | Quality gate failed after maximum retry iterations |
| `<!-- FORGE:PUSH_BLOCKED -->` | Branch push blocked (e.g., protected branch policy) |
| `<!-- FORGE:PUSH_FAILED -->` | Branch push failed after `--force-with-lease` retry |

---

### Audit Annotations

---

#### `FORGE:AUDIT`

**Written by**: Audit command agents
**Location**: Issue or PR comment

Posted by `/audit` and `/audit-agents` commands after running structured code audits.

---

#### `FORGE:SECURITY_AUDIT`

**Written by**: Security audit command
**Location**: Issue comment

Posted by `/security-audit` after completing a 4-phase security posture audit.

---

## Context-Passing Chain

The annotations form an ordered context chain. Each phase reads the outputs of all preceding phases:

```
Issue body
    ↓
FORGE:INVESTIGATOR  (Phase 1 → written to issue)
    ↓
FORGE:DECOMPOSED    (Phase 2 → written to issue, if decomposed)
    ↓
FORGE:CONTRACT      (Phase 3C → written to issue)
    ↓
FORGE:CONTEXT       (Phase 3C.5 → written to issue)
    ↓
FORGE:ARCHITECT     (Phase 3C.6 → written to issue)
    ↓
FORGE:BUILDER       (Phase 3M → written to issue)
    ↓
FORGE:REVIEW_STARTED (Phase 5B → written to issue)
    ↓
FORGE:TRAJECTORY    (Phase 7 → written to issue)
```

**Cross-issue context** (milestone / decomposed workflows):

```
Parent: FORGE:INVESTIGATOR → FORGE:KNOWLEDGE_GIST (Gist URL)
                                        ↓
Milestone description: FORGE:MILESTONE_INDEX (index Gist URL)
                                        ↓
Sub-issue body: FORGE:PRIOR_GIST (URL from parent's Knowledge Gist)
                                        ↓
Sub-issue: FORGE:CONTEXT reads FORGE:PRIOR_GIST to fetch upstream context
```

---

## Label State Machine

In addition to annotations, FORGE-compliant pipelines track state via GitHub labels. Labels allow agents to determine the current phase without reading all comment history.

| Label | Meaning | Set by |
|-------|---------|--------|
| `workflow:investigating` | Investigation phase active | Investigator agent |
| `workflow:ready-to-build` | Investigation complete, build not started | Investigator agent |
| `workflow:building` | Build phase active | Builder agent |
| `workflow:in-review` | PR created, review active | Orchestrator agent |
| `workflow:merged` | PR merged, issue closed | Close phase agent |
| `workflow:invalid` | Issue closed as invalid | Investigator agent |
| `workflow:decomposed` | Issue decomposed into sub-issues | Decomposer agent |
| `needs-human` | Pipeline blocked, human intervention required | Any agent on error |

**Terminal labels** (pipeline stops when these are set):

- `workflow:merged`
- `workflow:invalid`
- `needs-human`
- `workflow:decomposed`

---

## Conformance

A conformant FORGE implementation:

1. **Writes** annotations with the exact `<!-- FORGE:{TYPE} -->` opening tag
2. **Reads** annotations using `.body | contains("FORGE:{TYPE}")` filtering
3. **Honors** completion sentinels — does not proceed as if an annotation is complete when its sentinel is absent
4. **Deletes and restarts** interrupted partial annotations before continuing a phase
5. **Skips** phases that have a complete annotation already present (idempotent)
6. **Writes** state to GitHub after every significant step (compaction resilience)
7. **Re-reads** GitHub state at the start of each phase (does not rely on in-memory context)

### Conformance Test: Annotation Presence

To verify that a pipeline run wrote all expected annotations for a completed issue:

```bash
OWNER="your-org"
REPO="your-repo"
NUMBER=42

# Required annotations for a complete non-decomposed run
REQUIRED=("FORGE:INVESTIGATOR" "FORGE:CONTRACT" "FORGE:CONTEXT" "FORGE:ARCHITECT" "FORGE:BUILDER" "FORGE:TRAJECTORY")

for annotation in "${REQUIRED[@]}"; do
  COUNT=$(gh api repos/${OWNER}/${REPO}/issues/${NUMBER}/comments \
    --jq "[.[] | select(.body | contains(\"${annotation}\"))] | length")
  if [ "$COUNT" -gt 0 ]; then
    echo "✅ ${annotation} — present (${COUNT} comment(s))"
  else
    echo "❌ ${annotation} — MISSING"
  fi
done
```

### Conformance Test: Completion Sentinels

```bash
# Check that FORGE:INVESTIGATOR has INVESTIGATION:COMPLETE sentinel
BODY=$(gh api repos/${OWNER}/${REPO}/issues/${NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' | head -1)

if echo "$BODY" | grep -q "INVESTIGATION:COMPLETE"; then
  echo "✅ FORGE:INVESTIGATOR — complete"
else
  echo "❌ FORGE:INVESTIGATOR — incomplete (missing sentinel)"
fi
```

### Conformance Test: Label State

```bash
# Verify terminal state was reached
LABELS=$(gh issue view ${NUMBER} -R ${OWNER}/${REPO} --json labels \
  --jq '[.labels[].name | select(startswith("workflow:"))]')

TERMINAL=("workflow:merged" "workflow:invalid" "workflow:decomposed")
for label in "${TERMINAL[@]}"; do
  if echo "$LABELS" | grep -q "$label"; then
    echo "✅ Terminal label: ${label}"
    exit 0
  fi
done
echo "⚠ No terminal label found — pipeline may be incomplete"
```

---

## Implementing FORGE in Your Tool

To make your AI coding tool FORGE-compatible:

1. **Read existing annotations** before starting work on an issue:
   ```bash
   gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
     --jq '.[] | {id: .id, body: .body}' | \
     grep -A 999 "FORGE:"
   ```

2. **Write annotations** in the correct format after completing each phase. Use the schemas in this document.

3. **Check for existing annotations** before writing (idempotency):
   ```bash
   # Don't write FORGE:INVESTIGATOR if one already exists with INVESTIGATION:COMPLETE
   EXISTING=$(gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
     --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR") and contains("INVESTIGATION:COMPLETE")) | .id')
   if [ -n "$EXISTING" ]; then echo "Already investigated — skip"; fi
   ```

4. **Respect label state** — check `workflow:*` labels to determine where the pipeline is and whether it's in a terminal state.

5. **Use the `gh` CLI** as the primary query interface. All FORGE implementations can assume `gh` is available.

---

## Versioning

This document describes FORGE Protocol **version 1.0**. Future revisions will:

- Increment the minor version for backward-compatible additions (new annotation types, new optional fields)
- Increment the major version for breaking changes (renamed annotations, removed required fields)

Annotations do not carry an explicit version field. Conformant readers MUST tolerate unknown annotation types gracefully (skip, don't fail).

---

## Reference

- [ForgeDock repository](https://github.com/RapierCraftStudios/ForgeDock)
- [ForgeDock commands](https://github.com/RapierCraftStudios/ForgeDock/tree/main/commands)
- [`work-on.md`](../commands/work-on.md) — Full pipeline implementation reference
- [`review-pr.md`](../commands/review-pr.md) — Review phase implementation reference
- [`autopilot.md`](../commands/autopilot.md) — Orchestration and milestone index implementation
