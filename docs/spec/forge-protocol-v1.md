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

**Phase boundary markers** (appear in pipeline command specs):

| Marker | Meaning |
|--------|---------|
| `<!-- FORGE:DISPATCHER — {desc} -->` | Marks the Universal Phase Dispatcher — the single source of truth for phase transitions and routing logic |
| `<!-- FORGE:PHASE_COMPLETE — {desc} -->` | Inter-phase boundary; documents that a phase completed and names the next phase so agents do not treat an intermediate result as terminal |

**Issue-comment control markers** (posted to issue comments):

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

### 4.4 Design pipeline annotations

These annotations drive the UI Taste Harness — the design-generation pipeline
that produces a landing page from a design-blind product brief. They carry
design intent across the investigate → architect → generate → critique → close
stages, exactly as the lifecycle annotations carry code context across
investigate → build → review.

#### `FORGE:DESIGN_CONTEXT`

- **Written by**: the `/design` design-investigate stage
- **Read by**: design-architect stage (grounds the rationale), close phase (audit trail)
- **Completion sentinel**: `<!-- FORGE:DESIGN_CONTEXT:COMPLETE -->`

The design analog of `FORGE:CONTEXT`: the parsed brief (message / audience /
single objection), the grammar pulled from the reference corpus, and the recent
signature moves / archetypes / palettes from design-memory that this design must
diverge from. Opens the `FORGE:DESIGN_*` chain.

```
<!-- FORGE:DESIGN_CONTEXT -->
## Design Context — {product}

**Message:** {one thing the page must say}
**Audience / objection:** {who} — must overcome: {objection}
**Corpus grammar:** {relevant traits / archetype priors}
**Diverge from (memory):** {recent signature moves / archetypes / palettes to avoid}
<!-- FORGE:DESIGN_CONTEXT:COMPLETE -->
```

#### `FORGE:DESIGN_RATIONALE`

- **Written by**: the design-architect agent
- **Read by**: the generate agent (the spec it produces), the render → vision-critique loop, and reviewers
- **Emitted**: before `FORGE:DESIGN_SPEC`

The designer's diary — the reasoning-before-generation step. Captures a
seven-element chain of thought (intent/feeling, audience/objection,
communication hierarchy, direction + rejected alternatives, signature move,
what's being tried this time, non-goals). MUST carry at least one explicitly
rejected alternative, a named signature move, and a `→ Produces DESIGN_SPEC`
link.

```
<!-- FORGE:DESIGN_RATIONALE -->
## Design Rationale — {product}

**Intent / feeling:** {one message} · {one feeling}
**Audience / objection:** {who} — must overcome: {objection}
**Communication hierarchy:** 1) {…} 2) {…} 3) {…}
**Direction:** {archetype} — because {reasoning}
  - Considered & rejected: {alt A} (because {…}); {alt B} (because {…})
**Signature move:** {the one non-obvious idea}
**Trying this time:** {technique/learning} (from memory: avoiding {prior move})
**Non-goals:** {what this won't do}

→ Produces DESIGN_SPEC: {link}
```

#### `FORGE:DESIGN_CANDIDATES`

- **Written by**: the generate agent (divergent-generation step)
- **Read by**: the taste-judge (selects the winner), close phase (audit trail), design-memory (to diverge from past winners)
- **Emitted**: after `FORGE:DESIGN_RATIONALE`, before `FORGE:DESIGN_SPEC`

The variance lever's audit record: the one committed archetype (never blended),
the N distinct directions generated within it, and the independent taste-judge's
scores and selection. The selection judge is distinct from the critique loop —
anti-Goodhart.

```
<!-- FORGE:DESIGN_CANDIDATES -->
## Design Candidates — {product}

**Archetype (committed):** {one of the corpus ids}
**Directions:**
1. {concept} — signature: {move} — {distinguishing grammar/tokens}
2. {concept} — signature: {move} — {…}
**Judge scores:** 1) {score} 2) {score} …
**Selected:** #{n} — because {reason}

→ Winner produces DESIGN_SPEC: {link}
```

#### `FORGE:DESIGN_SPEC`

- **Written by**: the design-architect agent
- **Read by**: the generate agent (constrains output), the deterministic anti-slop linter, the render → vision-critique loop, and the close phase agent

A structured, machine-checkable representation of one page's design language.
Produced by `FORGE:DESIGN_RATIONALE` — not authored from nowhere. The flow is
rationale → spec → page. Full field-by-field schema lives in
`docs/design/design-spec-schema.md`.

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
  "effects_plan":  { "per_section": [ … ], "budget": { … }, "never": [ … ] },
  "negatives":     [ … ],
  "acceptance":    { "perf_budget": { … }, "a11y": { … }, "divergence_ref": "…" }
}
```

→ Produced by FORGE:DESIGN_RATIONALE: {link}
````

#### `FORGE:CRITIQUE`

- **Written by**: the vision-critique loop (one annotation per iteration)
- **Read by**: the iterate step (consumes its findings), close phase (improvement trajectory audit)
- **Completion sentinel**: `<!-- FORGE:CRITIQUE:COMPLETE -->`

One annotation per render → critique iteration — the page's improvement
trajectory as an auditable trail. Records the deterministic lint floor result,
the desktop+mobile render, the perceptual findings, and the verdict. The critic
is strictly independent from the benchmark judge — anti-Goodhart.

```
<!-- FORGE:CRITIQUE -->
## Critique — {product} · iteration {i}/{max}

**Lint floor:** {PASS | fixed N hard findings}
**Render:** desktop + mobile captured
**Perceptual findings:**
- N{n}: {what was observed in the render} → {correction}
**Verdict:** {PASS | ITERATE | BUDGET-EXHAUSTED}
<!-- FORGE:CRITIQUE:COMPLETE -->
```

#### `FORGE:USER_FEEDBACK`

- **Written by**: the `/design` user-feedback stage
- **Read by**: the surgical re-generation step, close phase (audit trail)
- **Completion sentinel**: `<!-- FORGE:USER_FEEDBACK:COMPLETE -->`
- **Not produced** in automated (benchmark) runs

The structured record of one user-feedback round. There MAY be multiple
`FORGE:USER_FEEDBACK` annotations on a single issue if the user iterates.
`FORGE:USER_FEEDBACK` MAY modify a section's visual execution but MUST NOT
change the committed `meta.archetype` or the signature move from
`FORGE:DESIGN_RATIONALE` — those choices are locked once the spec is committed.

```
<!-- FORGE:USER_FEEDBACK -->
## User Feedback — {product} · round {n}

**Section target:** {section ID from layout_grammar.sections, or "all" for page-wide feedback}
**Feedback type:** {asset | emotion | direction | freeform}
**Asset URL:** {URL or "none"}
**Modification:** {structured description of what to change}
**Emotion target:** {trust | speed | power | craft | play | unchanged}
**Satisfied:** {yes | no — "no" loops back after re-generation}
**Freeform notes:** {verbatim user input not captured in the structured fields}
<!-- FORGE:USER_FEEDBACK:COMPLETE -->
```

#### `FORGE:BENCH_SCORECARD`

- **Written by**: the `/design-bench` benchmark rig
- **Read by**: harness developers (fitness signal), milestone tracker, pipeline-health
- **Completion sentinel**: `<!-- FORGE:BENCH_SCORECARD:COMPLETE -->`

The result of one ABC benchmark run. Arm A is the harness output, arm B is a
raw one-shot model, arm C is the real reference page (gold standard). The
annotation carries win-rates, the A-vs-B harness delta, rubric distributions
(mean + stdev) across n≥3 runs, mean slop counts, and a judge-calibration check
(C must beat A and B — otherwise the judge is miscalibrated).

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

#### `FORGE:DESIGN_SHIPPED`

- **Written by**: the `/design` design-close stage
- **Read by**: design-memory (persists the realized outcome), milestone tracker, pipeline-health
- **Completion sentinel**: `<!-- FORGE:DESIGN_SHIPPED:COMPLETE -->`
- **Terminal annotation** for the design pipeline (analogous to `workflow:merged` for code)

Closes the design pipeline. Posted only when the design passes the full
definition of done — critique-rubric threshold, perf budget, a11y check, and
the divergence check. Records the final realized outcome written to design-memory
so the next design can diverge from it.

```
<!-- FORGE:DESIGN_SHIPPED -->
## Design Shipped — {product}

**Archetype:** {committed id} · **Signature move:** {the hook}
**Gates:** rubric {pass} · perf {pass} · a11y {pass} · divergence {distinct from prior}
**Critique iterations:** {n}
**Written to memory:** {palette/type/effects/learnings summary}
<!-- FORGE:DESIGN_SHIPPED:COMPLETE -->
```

---

### 4.5 Audit annotations

These annotations are posted to issue or PR comments by audit commands
(`/audit`, `/audit-agents`, `/security-audit`) after running structured code
audits.

#### `FORGE:AUDIT`

- **Written by**: audit command agents (`/audit`, `/audit-agents`)
- **Location**: issue or PR comment

Posted after running a structured code or agent audit. Body content varies by
audit type.

#### `FORGE:SECURITY_AUDIT`

- **Written by**: the `/security-audit` command
- **Location**: issue comment

Posted after completing a 4-phase security posture audit.

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

> **Canonical reference**: [`docs/spec/label-state-machine.md`](label-state-machine.md)
>
> The full state table, transition diagram, terminal labels, and label-exclusivity
> pattern are defined there. Labels and annotations are complementary: labels give
> a fast state lookup, annotations give the full context behind that state.

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

## 10. Adopting FORGE in Your Own Pipeline

FORGE is an open format. Any tool that can read and write platform comments can
participate — no dependency on a specific framework, model, or vendor.

**Minimum viable adoption**:

1. Pick the annotation types relevant to your pipeline (`FORGE:INVESTIGATOR` +
   `FORGE:BUILDER` is a good starting point).
2. Write your agent prompts to post annotated comments after each phase.
3. Write downstream agent prompts to read those comments before starting.

**Implementation checklist**:

1. **Read existing annotations** before starting work on an issue:

   ```bash
   gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
     --jq '.[] | select(.body | contains("FORGE:")) | {id: .id, body: .body}'
   ```

2. **Write annotations** using the schemas in Section 4 after completing each phase.

3. **Check for existing annotations** before writing (idempotency):

   ```bash
   EXISTING=$(gh api repos/{OWNER}/{REPO}/issues/{NUMBER}/comments \
     --jq '.[] | select(
       .body | (contains("FORGE:INVESTIGATOR") and contains("INVESTIGATION:COMPLETE"))
     ) | .id')
   if [ -n "$EXISTING" ]; then echo "Already investigated — skip"; fi
   ```

4. **Respect label state** — check `workflow:*` labels (Section 6) to determine
   the current phase and whether the work item is in a terminal state.

5. **Use text-contains filtering** as the primary query interface. All FORGE
   implementations can assume `gh api` or equivalent is available.

---

## 11. Versioning

This document specifies **version 1.0**.

- **Minor** revisions add backward-compatible changes: new reserved annotation
  types, new optional fields. Conforming consumers continue to work because they
  ignore unknown types and fields (Section 7.2).
- **Major** revisions introduce breaking changes: renamed or removed reserved
  types, or removed required fields.

Annotations do not carry an explicit version field. Conforming consumers
**MUST** tolerate unknown annotation types gracefully.

---

## 12. Reference Implementation

The canonical reference implementation of this specification is published as a
separate, MIT-licensed npm package:

**`@forgedock/protocol`** — available at `packages/protocol/` in the ForgeDock
repository.

It provides:

- `parse(commentBody)` — extracts all annotations from a comment body string
- `validate(annotation)` — checks conformance per §3–4; returns `{ valid, errors, warnings }`
- `emit(type, fields)` — produces well-formed annotation strings
- `emitPartial(type)` — produces the partial sentinel for a type (§3.3)

A conformance suite in `packages/protocol/fixtures/` covers all 13 reserved
types with valid and invalid examples. The CLI runner can be invoked against any
fixtures directory:

```bash
npx @forgedock/protocol fixtures/
```

**Library version and spec version move together**: a library at version `1.x`
implements spec version 1.0. Breaking spec changes (§11, major revisions)
require a library major version bump.

---

## 13. Acknowledgements

The FORGE Annotation Protocol was first developed and proven in a production
autonomous-development pipeline, where it coordinated investigator, builder,
and reviewer agents across tens of thousands of issues. This specification
generalizes that wire format into a tool-neutral, openly licensed standard so
that any agent pipeline can adopt and interoperate with it.

---

*FORGE Annotation Protocol v1.0 — released under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).*
