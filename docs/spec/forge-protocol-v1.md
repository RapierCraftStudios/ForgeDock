# FORGE Annotation Protocol

**Version**: 1.0
**Status**: Published
**License**: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)

> This specification is licensed under the Creative Commons Attribution 4.0
> International License (CC-BY-4.0). You are free to share and adapt it,
> including in commercial products, provided you give appropriate credit.
> The license applies to **this specification document only** — it does not
> govern any particular software implementation of the protocol.

---

## 1. Introduction

The FORGE Annotation Protocol is an open, machine-readable convention for AI
development agents to pass structured context to one another through the
artifacts of a code-hosting platform — issues and pull requests.

Modern AI coding agents are stateless. When a session ends, the next agent
starts with no memory of what previous agents investigated, decided, or built.
Teams that chain agents together (an investigator, then a builder, then a
reviewer) need a durable place to record each agent's output so the next agent
can resume without re-deriving everything.

FORGE solves this by defining a small set of **annotations**: structured blocks
of text, wrapped in HTML comment tags, posted as ordinary issue or pull-request
comments. Each agent writes the annotations for the work it completes; each
downstream agent reads the annotations that came before. Because the host
platform stores comments permanently and exposes them through a standard API,
the context survives session restarts, context-window compaction, and tooling
changes.

This document specifies version 1.0 of the protocol. It is self-contained: a
conforming producer or consumer can be built from this document alone, with no
dependency on any specific agent framework, language model, editor, or vendor.

### 1.1 Goals

- **Interoperability** — any agent that can read and write platform comments can
  participate, regardless of which language model or tool drives it.
- **Durability** — context is stored in append-only platform artifacts, not in
  conversation history or ephemeral memory.
- **Queryability** — annotations can be located with simple text-contains
  filters over comment bodies; no database or semantic index is required.
- **Human-readability** — annotations are Markdown that a person can read
  directly in the issue thread.

### 1.2 Terminology

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
in this document are to be interpreted as described in RFC 2119.

- **Annotation** — a structured block of text identified by a FORGE tag.
- **Producer** — an agent (or any process) that writes annotations.
- **Consumer** — an agent, automation, or human that reads annotations.
- **Host platform** — the code-hosting service whose issue/PR comments transport
  annotations (e.g., a Git hosting service exposing a comments API).
- **Completion sentinel** — a tag that marks an annotation as fully written.

---

## 2. Transport and Encoding

| Property | Definition |
|----------|------------|
| Transport | The host platform's issue/PR comment API |
| Container | One annotation lives inside one platform comment; a comment MAY contain more than one annotation |
| Encoding | An opening HTML comment tag followed by a Markdown body |
| Persistence | Comments are append-only and permanent; annotations survive restarts and compaction |
| Query interface | Text-contains filtering on comment bodies (e.g., `body` contains `FORGE:INVESTIGATOR`) |

HTML comment tags are chosen because they render invisibly in Markdown views,
so annotations do not clutter the human reading experience, yet remain trivially
machine-parseable.

---

## 3. Syntax

### 3.1 Opening tag

Every annotation begins with an opening tag on its own line:

```
<!-- FORGE:{TYPE} -->
```

`{TYPE}` is an uppercase identifier naming the annotation type (see Section 4).
The Markdown body of the annotation follows on subsequent lines.

An annotation ends at the next `<!-- FORGE:` tag within the same comment, or at
the end of the comment body, whichever comes first.

### 3.2 Completion sentinels

A producer signals that an annotation is fully written by emitting a completion
sentinel as the final line of the annotation:

```
<!-- {TYPE}:COMPLETE -->
```

Some annotation types use a domain-specific sentinel rather than the type name;
each type in Section 4 states its sentinel explicitly. A consumer **MUST NOT**
treat an annotation as complete unless its completion sentinel is present.

### 3.3 Partial sentinels

When a producer is interrupted (session ends, error, time budget exceeded) after
beginning an annotation but before finishing it, the producer **MAY** mark the
annotation partial:

```
<!-- {TYPE}:PARTIAL -->
```

An annotation that has neither a completion nor a partial sentinel is treated as
interrupted. A consumer **SHOULD** delete an interrupted or partial annotation
and request that the producing phase be re-run, so that downstream consumers
never read incomplete context.

### 3.4 Inline value form

Some annotations carry a single value (such as a URL) directly in the tag rather
than in a Markdown body:

```
<!-- FORGE:{TYPE}: {value} -->
```

The value is everything between the colon-space after `{TYPE}` and the closing
` -->`. Consumers extract it with a simple capture over that span.

---

## 4. Annotation Types

This section defines the annotation types reserved by version 1.0. Producers
**MAY** emit any subset relevant to their workflow; a minimal pipeline can use
as few as two types (for example, an investigator annotation and a builder
annotation).

### 4.1 Lifecycle annotations

Lifecycle annotations are posted as issue comments and form the primary context
chain for working an issue from triage to completion.

#### `FORGE:INVESTIGATOR`

- **Written by**: an investigation agent
- **Read by**: builder, architect, and decomposition agents
- **Completion sentinel**: `<!-- INVESTIGATION:COMPLETE -->`

Records the outcome of determining whether an issue is valid, its root cause,
and what should be done.

```
<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: {CONFIRMED|PARTIAL|INVALID}
**Confidence**: {HIGH|MEDIUM|LOW}
**Severity**: {CRITICAL|HIGH|MEDIUM|LOW}
**Task Type**: {Bug Fix|Feature|Refactor|Maintenance|Investigation}

### What Was Claimed
{summary of what the issue describes}

### What We Found
{what the code actually shows — specific evidence}

### Root Cause
{specific root cause, with file:line references where applicable}

### Affected Files
{numbered list of files that need changes}

### Evidence
{specific findings — function names, line numbers, observed behavior}

### Recommendation
{what to build or fix, concrete and actionable}

### Decomposition Assessment
**{YES|NO}** — {reason}

<!-- INVESTIGATION:COMPLETE -->
```

| Field | Values | Required |
|-------|--------|----------|
| Verdict | `CONFIRMED` / `PARTIAL` / `INVALID` | Yes |
| Confidence | `HIGH` / `MEDIUM` / `LOW` | Yes |
| Severity | `CRITICAL` / `HIGH` / `MEDIUM` / `LOW` | Yes |
| Task Type | one of the listed task types | Yes |
| Decomposition Assessment | `YES` or `NO` with a reason | Yes |

A consumer routes on the verdict: `CONFIRMED`/`PARTIAL` proceeds to build (or to
decomposition if the assessment is `YES`); `INVALID` closes the issue.

#### `FORGE:DECOMPOSED`

- **Written by**: a decomposition agent
- **Read by**: orchestration agents and the parent-issue tracker
- **Completion sentinel**: `<!-- FORGE:DECOMPOSED:COMPLETE -->`

Posted on a parent issue after it has been split into sub-issues, each of which
runs its own pipeline.

```
<!-- FORGE:DECOMPOSED -->
## Decomposition Complete

### Sub-Issues Created
- #{NUMBER}: {TITLE}

### Decomposition Rationale
{why decomposition was needed}

<!-- FORGE:DECOMPOSED:COMPLETE -->
```

#### `FORGE:CONTRACT`

- **Written by**: a builder agent, before writing code
- **Read by**: the builder (implementation step) and review agents

Defines the scope of a build task — a binding agreement between investigation
findings and what will actually be built.

```
<!-- FORGE:CONTRACT -->
## Builder Contract

**Task type**: {TASK_TYPE}

### Proposed Approach
{brief description of the implementation approach}

### Deliverables
| File | Change | Why |
|------|--------|-----|
| {filepath} | {what changes} | {why this change is needed} |

### Acceptance Criteria
- [ ] {specific, testable criterion}

### Quality Considerations
{auth model, new configuration, data-safety, security surface, migration risk}

### Out of Scope
{items explicitly excluded}
```

#### `FORGE:CONTEXT`

- **Written by**: a context-gathering agent
- **Read by**: the builder (before touching code)
- **Completion sentinels**: `<!-- FORGE:CONTEXT:COMPLETE -->` (full),
  `<!-- FORGE:CONTEXT:PARTIAL -->` (time-limited)

Surfaces institutional memory before implementation: past review findings,
historical bugs, related code paths, and proven patterns.

```
<!-- FORGE:CONTEXT -->
## Implementation Context for #{NUMBER}

### Known Pitfalls for This Area
{prevention rules from past findings on these files}

### Historical Findings on These Files
{past findings, with pattern and prevention details}

### Past Bugs in This Module
{closed bug issues found via history mining}

### Related Code Paths (must stay consistent)
{files that import or call the functions being changed}

### Patterns That Cause Bugs Here
{recurring bug types synthesized from history}

### Successful Similar Implementations
{positive patterns from prior merged changes}

<!-- FORGE:CONTEXT:COMPLETE -->
```

#### `FORGE:ARCHITECT`

- **Written by**: an architecture agent
- **Read by**: the builder (primary implementation guide)
- **Completion sentinels**: `<!-- FORGE:ARCHITECT:COMPLETE -->` (full),
  `<!-- FORGE:ARCHITECT:PARTIAL -->` (time-limited)

Contains an ordered implementation plan tracing all affected code paths,
consistency rules, sequencing, and risks. When present, a builder follows it.

```
<!-- FORGE:ARCHITECT -->
## Implementation Plan for #{NUMBER}

### Affected Paths (ALL must be updated)
| # | File | Function/Class | Change Required | Why |
|---|------|----------------|-----------------|-----|
| 1 | {filepath} | {function or class} | {what to change} | {reason} |

### Implementation Order
1. {first change} — {why first}

### Consistency Checks
- [ ] {invariant all paths must satisfy}

### Risk Assessment
| Risk | Severity | Mitigation |
|------|----------|------------|
| {risk} | HIGH/MEDIUM/LOW | {mitigation} |

### Files to Read Before Coding
- `{filepath}` — {why to read it}

<!-- FORGE:ARCHITECT:COMPLETE -->
```

#### `FORGE:BUILDER`

- **Written by**: an implementation agent, after committing work
- **Read by**: review agents and the close phase
- **Completion sentinel**: `<!-- FORGE:BUILDER:COMPLETE -->`

The primary handoff annotation to review. Captures branch, commits, files
changed, and a testing checklist.

```
<!-- FORGE:BUILDER -->
## Implementation Complete

**Branch**: `{branch-name}`
**Commits**: {commit SHA(s)}
**Files changed**: {count}

### Approach
{what was built, key decisions}

### Changes
- `{filepath}` — {what changed}

### Acceptance Criteria Status
- [x] {criterion} — PASS
- [ ] {criterion} — FAIL (reason)

### Testing Checklist
- [ ] {test scenario}

<!-- FORGE:BUILDER:COMPLETE -->
```

#### `FORGE:REVIEWER`

- **Written by**: domain review agents, on the pull request
- **Read by**: the review orchestrator (determines merge eligibility) and
  future context agents

```
<!-- FORGE:REVIEWER -->
## Review — {AGENT_TYPE}

**Verdict**: {APPROVED|CHANGES_REQUESTED|COMMENTED}

### Findings
- **Severity**: {CRITICAL|HIGH|MEDIUM|LOW}
  **Location**: `{filepath}:{line}`
  **Issue**: {description}
  **Suggested fix**: {fix}
  **Prevention**: {rule that would prevent recurrence}
```

`{AGENT_TYPE}` names the review domain (for example `SECURITY`, `LOGIC`,
`FRONTEND`, `DATABASE`).

#### `FORGE:TRAJECTORY`

- **Written by**: the orchestrator, once per issue lifecycle
- **Read by**: reporting/automation consumers and future context agents

A permanent audit trail of a completed pipeline run.

```
<!-- FORGE:TRAJECTORY -->
## Pipeline Trajectory — #{NUMBER}

| Phase | Result | Notes |
|-------|--------|-------|
| Context Load | done | {lane} → `{base-branch}` |
| Investigation | {VERDICT} ({CONFIDENCE}) | Task type: {TASK_TYPE} |
| Decomposition | skipped | {reason} |
| Build | done | Branch: `{branch}` |
| Quality Gate | passed | {N} iterations |
| Review + Merge | merged | PR #{PR_NUMBER} → `{base-branch}` |
| Close | done | Issue closed |

**Decisions**: {key decisions}
**Anomalies**: {anomalies or None}
**Completed**: {ISO 8601 timestamp}
```

### 4.2 Cross-artifact annotations

These annotations move context between issues — useful when a parent issue is
decomposed into sub-issues, or when many issues share a milestone.

#### `FORGE:KNOWLEDGE_GIST`

- **Form**: inline value (Section 3.4)
- **Location**: issue comment

Points to an external, linkable artifact (such as a hosted snippet) holding the
full investigation findings, so downstream issues can fetch prior context.

```
<!-- FORGE:KNOWLEDGE_GIST: {https://example.com/artifact} -->
```

#### `FORGE:MILESTONE_INDEX`

- **Form**: inline value
- **Location**: the milestone description field

Points to an index artifact aggregating the `FORGE:KNOWLEDGE_GIST` links for a
milestone, giving any agent working any milestone issue one-fetch access to all
prior investigations.

```
<!-- FORGE:MILESTONE_INDEX: {https://example.com/index} -->
```

#### `FORGE:PRIOR_GIST`

- **Form**: inline value
- **Location**: a sub-issue body

Embedded by a decomposition agent; points to the parent issue's knowledge
artifact so a sub-issue builder can fetch upstream context directly.

```
<!-- FORGE:PRIOR_GIST: {https://example.com/artifact} -->
```

### 4.3 Control and error markers

These markers carry no Markdown body; their presence is the signal.

| Marker | Meaning |
|--------|---------|
| `<!-- FORGE:REVIEW_STARTED -->` | The review phase has been invoked for this issue |
| `<!-- FORGE:ANCESTRY_FAILED -->` | A branch ancestry check failed (unexpected merge commits) |
| `<!-- FORGE:GATE_FAILED -->` | A quality gate failed after its retry budget |
| `<!-- FORGE:PUSH_BLOCKED -->` | A branch push was blocked by platform policy |
| `<!-- FORGE:PUSH_FAILED -->` | A branch push failed after retry |

Error markers signal that automated processing stopped and human attention is
needed.

---

## 5. The Context Chain

Lifecycle annotations form an ordered chain. Each stage reads the outputs of all
preceding stages, so context accumulates on the issue rather than in any agent's
memory:

```
Issue body
    ↓
FORGE:INVESTIGATOR
    ↓
FORGE:DECOMPOSED        (only if the issue is decomposed)
    ↓
FORGE:CONTRACT
    ↓
FORGE:CONTEXT
    ↓
FORGE:ARCHITECT
    ↓
FORGE:BUILDER
    ↓
FORGE:REVIEWER          (on the pull request)
    ↓
FORGE:TRAJECTORY
```

Cross-artifact context for decomposed or milestone workflows:

```
Parent issue:  FORGE:INVESTIGATOR → FORGE:KNOWLEDGE_GIST (artifact link)
                                            ↓
Milestone description:  FORGE:MILESTONE_INDEX (index link)
                                            ↓
Sub-issue body:  FORGE:PRIOR_GIST (link from the parent's artifact)
                                            ↓
Sub-issue:  FORGE:CONTEXT reads FORGE:PRIOR_GIST to fetch upstream context
```

---

## 6. Label State Machine

Annotations record *what happened*; labels record *where a unit of work is* so a
consumer can determine the current stage without reading every comment. The
protocol reserves the `workflow:` label namespace:

| Label | Meaning |
|-------|---------|
| `workflow:investigating` | Investigation in progress |
| `workflow:ready-to-build` | Investigation complete, build not started |
| `workflow:building` | Build in progress |
| `workflow:in-review` | Pull request open, review active |
| `workflow:merged` | Pull request merged, work item closed |
| `workflow:invalid` | Closed as invalid |
| `workflow:decomposed` | Split into sub-issues |
| `needs-human` | Blocked; human intervention required |

**Terminal labels** (processing stops when any is set): `workflow:merged`,
`workflow:invalid`, `workflow:decomposed`, `needs-human`.

Labels and annotations are complementary: labels give a fast state lookup,
annotations give the full context behind that state.

---

## 7. Conformance

### 7.1 Conforming producer

A conforming producer:

1. Writes annotations using the exact opening tag `<!-- FORGE:{TYPE} -->`.
2. Emits the correct completion sentinel as the final line of each annotation it
   finishes.
3. Marks interrupted annotations with the partial sentinel where it can.
4. Writes state to the host platform after each significant step, so progress
   survives interruption.

### 7.2 Conforming consumer

A conforming consumer:

1. Locates annotations by text-contains filtering on comment bodies for
   `FORGE:{TYPE}`.
2. Treats an annotation as complete only when its completion sentinel is present.
3. Re-reads platform state at the start of each stage rather than relying on
   in-memory context.
4. Tolerates unknown annotation types gracefully — it skips types it does not
   recognize and **MUST NOT** fail on them. This is what makes the extension
   mechanism (Section 8) safe.
5. Honors terminal labels (Section 6) — it stops processing a work item in a
   terminal state.

### 7.3 Conformance checks

A producer's output for a completed work item can be verified by confirming the
expected annotations are present and complete. The following examples use a
generic `gh`-style comments query; substitute your platform's equivalent.

Annotation presence:

```bash
OWNER="your-org"; REPO="your-repo"; NUMBER=42
REQUIRED=("FORGE:INVESTIGATOR" "FORGE:CONTRACT" "FORGE:CONTEXT" \
          "FORGE:ARCHITECT" "FORGE:BUILDER" "FORGE:TRAJECTORY")
for a in "${REQUIRED[@]}"; do
  COUNT=$(gh api repos/$OWNER/$REPO/issues/$NUMBER/comments \
    --jq "[.[] | select(.body | contains(\"$a\"))] | length")
  [ "$COUNT" -gt 0 ] && echo "ok   $a ($COUNT)" || echo "MISS $a"
done
```

Completion sentinel:

```bash
BODY=$(gh api repos/$OWNER/$REPO/issues/$NUMBER/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' | head -1)
echo "$BODY" | grep -q "INVESTIGATION:COMPLETE" \
  && echo "investigator complete" || echo "investigator INCOMPLETE"
```

Terminal label:

```bash
gh issue view $NUMBER -R $OWNER/$REPO --json labels \
  --jq '[.labels[].name | select(startswith("workflow:"))]'
```

---

## 8. Extension Mechanism

The protocol is intentionally minimal. A producer **MAY** define new annotation
types by following the naming convention:

```
<!-- FORGE:YOUR_CUSTOM_TYPE -->
```

To avoid collisions, custom types **SHOULD** use a name that is unlikely to
clash with reserved types — for example, a vendor or project prefix
(`FORGE:ACME_SECURITY_SCAN`). Because every conforming consumer ignores types it
does not recognize (Section 7.2), custom annotations are safe to add: they are
visible to producers and consumers that understand them and invisible to those
that do not.

New **reserved** types and new optional fields are added in backward-compatible
minor revisions; renaming or removing a reserved type, or removing a required
field, is a major-version change (Section 10).

---

## 9. Worked Example: Producer and Consumer

This example shows a conforming producer recording context on an issue, and a
conforming consumer — a continuous-integration job — reading that context.

### 9.1 Conforming producer

An investigation agent finishes triaging issue #128 and posts:

```
<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: CONFIRMED
**Confidence**: HIGH
**Severity**: HIGH
**Task Type**: Bug Fix

### Root Cause
`payments/validator.py:142` — the billing-profile lookup does not guard
against a null profile for free-tier users, raising on every checkout.

### Affected Files
1. `payments/validator.py`

### Recommendation
Return an empty profile when the lookup is null; add a regression test.

### Decomposition Assessment
**NO** — single-file fix.

<!-- INVESTIGATION:COMPLETE -->
```

After implementing and merging the fix, the builder and orchestrator post the
handoff and trajectory annotations:

```
<!-- FORGE:BUILDER -->
## Implementation Complete

**Branch**: `fix/null-billing-profile-128`
**Commits**: a1b2c3d
**Files changed**: 2

### Changes
- `payments/validator.py` — guard null profile, return empty profile
- `tests/test_validator.py` — add free-tier regression test

<!-- FORGE:BUILDER:COMPLETE -->
```

```
<!-- FORGE:TRAJECTORY -->
## Pipeline Trajectory — #128

| Phase | Result | Notes |
|-------|--------|-------|
| Investigation | CONFIRMED (HIGH) | Task type: Bug Fix |
| Build | done | Branch: `fix/null-billing-profile-128` |
| Review + Merge | merged | PR #131 |
| Close | done | Issue closed |

**Decisions**: Guard at the lookup site rather than each caller.
**Anomalies**: None
**Completed**: 2026-01-15T09:30:00Z
```

### 9.2 Conforming consumer

A continuous-integration job consumes `FORGE:TRAJECTORY` to publish a release
note whenever an issue is closed. This consumer is fully generic: it depends
only on the protocol, not on the agent that produced the annotations. The
example uses GitHub Actions, but any automation platform with API access works
identically.

```yaml
# .github/workflows/forge-trajectory-report.yml
name: FORGE Trajectory Report

on:
  issues:
    types: [closed]

permissions:
  issues: read

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - name: Extract and print the FORGE:TRAJECTORY annotation
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          NUMBER: ${{ github.event.issue.number }}
        run: |
          # A conforming consumer locates an annotation by text-contains
          # filtering on comment bodies, then checks for its presence.
          TRAJECTORY=$(gh api "repos/$REPO/issues/$NUMBER/comments" \
            --jq '.[] | select(.body | contains("FORGE:TRAJECTORY")) | .body' \
            | head -1)

          if [ -z "$TRAJECTORY" ]; then
            echo "No FORGE:TRAJECTORY annotation found — skipping (tolerant)."
            exit 0
          fi

          echo "Found trajectory for issue #$NUMBER:"
          echo "$TRAJECTORY"
          # A real consumer would forward this to a changelog, dashboard,
          # or release-notes pipeline.
```

The job is tolerant by design (Section 7.2): if an issue carries no
`FORGE:TRAJECTORY` annotation, it exits cleanly rather than failing. Any
producer that emits a conforming `FORGE:TRAJECTORY` annotation — regardless of
which tool or model produced it — interoperates with this consumer unchanged.

---

## 10. Versioning

This document specifies **version 1.0**.

- **Minor** revisions add backward-compatible changes: new reserved annotation
  types, new optional fields. Conforming consumers continue to work because they
  ignore unknown types and fields (Section 7.2).
- **Major** revisions introduce breaking changes: renamed or removed reserved
  types, or removed required fields.

Annotations do not carry an explicit version field. Conforming consumers
**MUST** tolerate unknown annotation types gracefully.

---

## 11. Acknowledgements

The FORGE Annotation Protocol was first developed and proven in a production
autonomous-development pipeline, where it coordinated investigator, builder,
and reviewer agents across tens of thousands of issues. This specification
generalizes that wire format into a tool-neutral, openly licensed standard so
that any agent pipeline can adopt and interoperate with it.

---

*FORGE Annotation Protocol v1.0 — released under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).*
