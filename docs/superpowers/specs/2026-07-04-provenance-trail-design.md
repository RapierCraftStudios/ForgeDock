# Signed, Replayable Provenance Trail — Design Spec

**Date:** 2026-07-04
**Status:** Design — ready to build
**Tracking:** #1318 (provenance layer), epic #1320 (five foundations of autonomy)
**Depends on:** #1256 (durable engine run-log — replayability requires a committed step log)
**Scope:** Integrity guarantee + replayability layer on top of the existing FORGE annotation protocol (#1291–1294). Every autonomous PR carries a signed attestation linking decisions → verification evidence → alternatives rejected.

---

## 1. Motivation

For an organization to allow autonomous merges to production, every change needs a complete, verifiable record of *why it was made, what was verified, and what alternatives were considered and rejected* — reproducibly.

Today provenance is scattered `FORGE:*` comments with no integrity guarantee:

| Gap | Current state | Problem |
|-----|--------------|---------|
| Integrity | Comments are plain Markdown, mutable | Any party can edit or delete them after the fact |
| Completeness | Each annotation covers one phase | No single artifact links decision → evidence → alternatives |
| Replayability | State is prose — humans can read it but tools cannot deterministically replay it | Resume re-parses prose heuristically |
| Attestation | No signed artifact exists | Human reviewers have no cryptographic basis to trust "the agent said it was safe" |

**Trust, not capability, is the blocker to auto-merge.** This spec adds integrity + replayability + a signed attestation on top of the existing FORGE protocol, without replacing it.

---

## 2. Goals / Non-goals

**Goals**
- Each autonomous PR carries a `FORGE:PROVENANCE` attestation that links: investigation decision → build decisions → verification evidence → rejected alternatives.
- A run is replayable from its provenance record + durable engine run-log (#1256).
- The provenance record validates against the FORGE protocol conformance suite (#1291).
- Integrity is achieved via a content hash over the structured annotation chain — no external PKI required for v1.

**Non-goals**
- Hardware-rooted signing (TPM, HSM) — out of scope for v1; the content hash gives tamper-evidence without it.
- Retroactive provenance for runs completed before this spec ships.
- Per-turn provenance (this spec is per-run / per-PR granularity, matching the durable engine's per-phase checkpoint).
- Provenance for interactive `/work-on` runs (headless/orchestrated first, interactive later).

---

## 3. Locked Decisions

1. **Attestation format: structured HTML comment (`FORGE:PROVENANCE`) on the PR.** Consistent with the existing annotation protocol. Readable by humans in the PR thread and queryable by the same text-contains filters used today.
2. **Integrity mechanism: SHA-256 content hash over a canonical serialization of the annotation chain.** The hash is computed over the ordered sequence of `FORGE:*` annotation bodies (canonically serialized as JSON). Anyone with the run-log can recompute it.
3. **Replayability: the durable engine run-log is the replay substrate.** The `FORGE:PROVENANCE` record carries a pointer to the run-log location (issue comment ID sequence). A conformant replayer reads those comments in order and reconstructs the pipeline state.
4. **Chain of custody: each annotation carries a `seq` (sequence number) and `prev_hash` (hash of the prior annotation).** This forms a tamper-evident linked list. Adding, removing, or reordering annotations breaks the hash chain.
5. **The attestation is written by the durable engine, not by individual phase agents.** Agents write their phase annotations as today; the engine writes the final `FORGE:PROVENANCE` after the merge gate passes.

---

## 4. Architecture

### 4.1 Annotation Chain Extension

Existing FORGE annotations gain two new fields (backward-compatible — consumers that do not understand them ignore them):

```
<!-- FORGE:INVESTIGATOR
seq: 1
prev_hash: "genesis"
...existing fields...
body_hash: "sha256:a1b2c3..."
-->
```

| New field | Type | Description |
|-----------|------|-------------|
| `seq` | integer | Position in the annotation chain for this run (1-indexed) |
| `prev_hash` | string | SHA-256 of the prior annotation's canonical body, or `"genesis"` for the first |
| `body_hash` | string | SHA-256 of this annotation's canonical body (self-hash, written last) |

**Canonical body**: the annotation content between the `<!-- FORGE:TAG` opening and the `-->` closing, with leading/trailing whitespace stripped and line endings normalized to `\n`, serialized as a UTF-8 JSON string.

### 4.2 FORGE:PROVENANCE Annotation

Written to the PR by the durable engine after the merge gate passes, before the merge commit:

```html
<!-- FORGE:PROVENANCE
run_id: "run-abc123"
issue: 1317
pr: 1460
pipeline_version: "1.0.21"
agent_model: "claude-sonnet-4-6"

chain:
  - seq: 1  tag: INVESTIGATOR  comment_id: 2345678901  body_hash: "sha256:a1b2..."
  - seq: 2  tag: ARCHITECT      comment_id: 2345678910  body_hash: "sha256:b2c3..."
  - seq: 3  tag: BUILDER        comment_id: 2345678920  body_hash: "sha256:c3d4..."
  - seq: 4  tag: REVIEWER       comment_id: 2345678930  body_hash: "sha256:d4e5..."
  - seq: 5  tag: QUALITY_GATE   comment_id: 2345678940  body_hash: "sha256:e5f6..."
  - seq: 6  tag: ECONOMICS      comment_id: 2345678950  body_hash: "sha256:f6a7..."

chain_hash: "sha256:0123456789abcdef..."
verification_passed: true
alternatives_considered:
  - "Inline fix without issue — rejected: no traceability"
  - "Defer to manual review — rejected: low-risk score 0.82"
merge_authorized_by: "economic-self-governance"
timestamp: 2026-07-04T18:00:00Z
forge_protocol_version: "1.0"
-->
<!-- FORGE:PROVENANCE:COMPLETE -->
```

**`chain_hash`**: SHA-256 of the concatenated `body_hash` values in `seq` order, joined with `\n`. Recomputable from the listed comment IDs alone.

### 4.3 Replayability Contract

A conformant replayer MUST be able to reconstruct the pipeline state for a given `run_id` by:

1. Reading the `FORGE:PROVENANCE` annotation from the PR to get the `chain` (comment ID list).
2. Fetching each comment in `seq` order from the GitHub API.
3. Parsing each `FORGE:*` annotation body.
4. Recomputing the `chain_hash` and asserting it matches the recorded value.
5. Replaying the durable engine run-log (from `#1256`) for per-phase step details.

Step 4 is the integrity check. A mismatch means the annotation chain was tampered with after the run.

### 4.4 Conformance Suite Integration (#1291)

The FORGE protocol conformance suite gains a new test category: **Provenance Conformance**.

| Test | Pass condition |
|------|---------------|
| `P-01` | PR has exactly one `FORGE:PROVENANCE` annotation followed by `FORGE:PROVENANCE:COMPLETE` |
| `P-02` | All `seq` values in the chain are contiguous starting from 1 |
| `P-03` | Each `prev_hash` matches the `body_hash` of the prior annotation (or `"genesis"` for seq=1) |
| `P-04` | `chain_hash` recomputes correctly from the listed `body_hash` values |
| `P-05` | All annotations referenced in the chain are fetchable and parse as valid FORGE annotations |
| `P-06` | `timestamp` is an ISO 8601 UTC datetime |
| `P-07` | `forge_protocol_version` is present and a known value |

### 4.5 Integration Points

**Durable engine (`#1256`)**: After merge gate passes, the engine invokes `write_provenance()`:
- Collects all annotation comment IDs from the run-log.
- Fetches each annotation body and computes `body_hash` values.
- Computes `chain_hash`.
- Posts `FORGE:PROVENANCE` to the PR.

**Quality gate (`/quality-gate`)**: Gains a new check: `PROVENANCE` — verifies `P-01` through `P-07`. Fails the gate if any check fails on an autonomous run. Human-initiated runs emit a warning (not a hard failure) if provenance is absent.

**`/replay` command**: Uses the `chain` from `FORGE:PROVENANCE` as the replay index instead of scanning all comments for `FORGE:*` annotations. This is faster and guaranteed-ordered.

---

## 5. Implementation Plan

### Increment 1: Chain fields on existing annotations (non-breaking)
- Modify durable engine to write `seq`, `prev_hash`, and `body_hash` on each annotation it posts.
- No consumer changes required — fields are additive.
- Validate that existing annotations without these fields are still parseable.

### Increment 2: FORGE:PROVENANCE annotation
- Engine writes `FORGE:PROVENANCE` to the PR after merge gate passes.
- Includes `chain`, `chain_hash`, `verification_passed`, `timestamp`.
- `/replay` updated to use the chain index when present.

### Increment 3: Conformance tests + quality gate check
- Add `P-01` through `P-07` tests to the conformance suite (#1291).
- Add `PROVENANCE` check to `/quality-gate` (warning on human runs, hard failure on autonomous runs).

### Increment 4: Replayability validation
- Add a `verify_provenance(run_id)` script to `scripts/`.
- Script fetches the PR, reads `FORGE:PROVENANCE`, fetches all chained comments, recomputes `chain_hash`, and reports pass/fail.

---

## 6. Open Questions

- **Comment mutability**: GitHub allows editing comments. The hash chain detects tampering but does not prevent it. For v2, consider posting annotations to an immutable artifact (e.g., a GitHub Release asset or a signed commit note) as an optional hardened mode.
- **`body_hash` for legacy annotations**: If an annotation was written before this spec (no `body_hash` field), the chain is broken. Acceptable for v1: the `FORGE:PROVENANCE` chain only covers annotations written by the durable engine (which will be updated atomically). Legacy runs have no provenance claim.
- **`alternatives_considered` source**: In v1 this is written by the engine based on the economics decision (#1317) and the quality-gate outcome. A richer alternatives record (e.g., architect alternatives from `FORGE:ARCHITECT`) can be pulled in a later increment.

---

## 7. References

- #1318 — this issue
- #1291–1294 — FORGE protocol conformance suite (seed schema)
- #1256 — durable engine (run-log substrate; required for replayability)
- #1315 — outcome-based acceptance gate (supplies "what was verified" evidence)
- #1317 — economic self-governance (supplies `merge_authorized_by` and `alternatives_considered`)
- #1320 — five foundations epic (provenance layer)
- `docs/spec/forge-protocol-v1.md` — FORGE annotation protocol v1.0
