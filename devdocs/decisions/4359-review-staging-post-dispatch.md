---
issue: 4359
status: fresh
anchor: scripts/review-staging-post.sh
created: 2026-10-21
---

# ADR: the staging->main review post-dispatch is a script plus two CLI modes; the spec only dispatches

## Context

#4358 moved the staging review's pre-dispatch into `forgedock review-staging`. Everything after the reviewers posted was still run by hand from `commands/review-pr-staging.md`:
- the 6.5 verdict handling;
- the incomplete-panel guard;
- 6.75 delivery;
- 7A-7C;
- the Phase 8 summary.

Phase 8 posted no gate marker of its own. A SKIP test gate therefore left the PR marker-less, and `gate-marker-check.yml` then fell back to its 30-minute no-marker window.

## Decision

- **`scripts/review-staging-post.sh`** has two subcommands. They are the spec's former fences, copied as `# BEGIN`/`# END` blocks without their locator stubs:
  - `delivery`: the panel guard plus 6.75.
  - `test-gate`: reads the saved `/test-gate` output. A missing marker stays empty and fails closed as BLOCK. It then applies the verdict handling: trusted override, posture, test-gate `GATE_PASS`/`GATE_FAILURE`, and the persisted verdict.
- **`forgedock review-staging [<PR>] --finalize --test-gate-output FILE [--notes-dropped N]`** runs:
  1. delivery;
  2. test-gate;
  3. `review-finalize.sh extract`, `classify --dry-run`, `classify`, `file-prepare`. Scope and prior-PR args are built from the 0B.1 state.

  It prints `FILE <item>` lines and persists `<PR>_finalize.json`.
- **`--summary [--filed N]...`** recomputes the head and refuses if it moved. It reads CI exactly as Phase 1E does and computes the verdict:
  - CI failing → BLOCK DEPLOY;
  - invalid persisted test-gate verdict → BLOCK DEPLOY;
  - a CONFIRMED CRITICAL → BLOCK DEPLOY;
  - a CONFIRMED HIGH → NEEDS FIXES FIRST;
  - otherwise → APPROVE FOR DEPLOY.

  It posts one summary comment with exactly one marker kind: `FORGE:GATE_PASS` on approve, `FORGE:GATE_FAILURE` otherwise. Each carries `TYPE=staging-review|BUNDLE=...`. The marker formats themselves are unchanged.
- **Boundary.** A process cannot invoke a skill, so these stay agent steps in the spec:
  - `/test-gate`;
  - reviewer dispatch;
  - the `/issue` filing call with `file-verify`;
  - 7D;
  - the Phase 1 checks: they eval repo-configured commands, and the 1F autofix is an agent action.
- **The spec's fences now run only `forgedock` from the install root** (`forge_resolve` → `bin/forgedock.mjs`). The spec-extraction tests now read the scripts and the CLI that own the logic.

## Alternatives

- Re-implementing the fences in Node was rejected. It would be a second, untested copy of fail-closed logic; the same reasoning as #4358.
- Leaving Phase 8 marker-less on a SKIP test gate was rejected. The Gate Marker Contract requires one marker per completed review.

## Notes

- `gate-marker-check.yml` passes on any trusted `GATE_PASS`. A test-gate PASS followed by a blocking summary `GATE_FAILURE` therefore still reads as passed. This is pre-existing and out of scope here.
- "CONFIRMED HIGH blocking (crashes, data loss)" is applied to every CONFIRMED HIGH, since the CLI cannot judge impact. It errs toward NEEDS FIXES FIRST.
