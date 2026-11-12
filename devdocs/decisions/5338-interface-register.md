---
issue: 5338
status: fresh
anchor: bin/lean/interfaces.mjs
created: 2026-11-10
---

# ADR: architecture and interface contracts seed the anchored decision register

## Context

The bootstrap spike was prose nothing parsed, so lanes inferred the interfaces between slices (wrong refund signature, cookie auth on API-key routes, dropped fields). The register of #4695 already turns anchored decisions into preserve rows, but only lane decisions reached it.

## Decision

- A spike or feature epic has an `## Interfaces` table (boundary, signature or schema, auth mode, owner issue, anchors, optional consumers). `checkInterfaces` (`bin/lean/interfaces.mjs`) requires the section, a rationale line and, for an epic, one real row once there are two or more slices. A spike's slices are its numbered Milestone plan; an epic's are the list items of its Slices/Children/Issues section. The spike is checked by `checkSpikeDoc`; an epic by `forgedock interfaces check`, which `/issue` and `/milestone` run before creating an `epic` (the same hook as the #5336 acceptance gate, the only epic-creation attach point: epics are created by the specs, not a script).
- `interfaceDecisions` (`bin/lean/decisions.mjs`) turns each row, and any section with `**Rationale**:` plus `**Anchors**:` lines, into a decision record. `createBacklog` (spike) and `forgedock interfaces register` (epic) post them once per id on the spike/epic issue and update the index. Pure and deterministic: no agent, no LLM call. Posting is synchronous in bootstrap (`createBacklog` is), so `recordDecisions` (async) is not used.
- Lanes get them through the existing `withDecisionRows` preserve rows. Changing one needs the existing `supersedes` decision amendment.
- R7: `interfaceDecisionFailures` (`bin/lean/conformance.mjs`) fails precheck (`decision_unsuperseded`) when a changed file sits under the anchors of an active decision row and the builder neither reports the preserve row `intact` nor supersedes it.
- R3: a decision record carries `consumers` (`#N` issues or names; inherited by the record that supersedes it). After the merge, `notifyConsumers` reopens closed `#N` consumers (dropping `workflow:merged` so the watcher treats it as work, not a merge to verify), comments once per consumer, and files one issue per named consumer, idempotent by a `FORGE:INTERFACE_CHANGED decision=<id> consumer=<x>` marker.
- R4: a row whose signature is a route, a function signature or a typed payload/queue message, with `provider:`/`consumer:` anchors, carries a `seam` (`bin/lean/seam.mjs`). `forgedock interfaces contract` generates one `contracts/<id>.contract.test.mjs` per such row plus the self-contained `templates/contracts/seam-check.mjs`; both sides run it with `node --test` and it reads the real source (no mocks). The check is static and stack-neutral text analysis, not per-stack codegen: definitions and call-site arity, route handler plus declared auth versus a forwarded session cookie/JWT, and payload fields present on both sides.
- R8: `seamFailures` runs the same checker in the lane precheck for every seamed decision a changed file touches, so the refund-signature, cookie-versus-API-key and dropped-field mismatches are lane-review failures; `interfaces.test.mjs` replays each against a spike modelled on the audit.

## Rejected

- A new agent or reviewer prompt for interfaces: the register, preserve rows and precheck are deterministic (NORTHSTAR non-negotiable 1).
- `apishape` wiring: it diffs public symbols between base and head, but cannot say which signature a boundary promised; the contract does.
- Per-stack codegen (pytest, vitest, OpenAPI client): one text-level checker covers the three machine forms without a toolchain in the target repo, at the cost of heuristics (it can miss an indirect call and flags nothing it cannot see); a side with no files is reported `unchecked`, never a pass.
- Requiring a real row in a spike: the spike template ships a placeholder row and its own test validates it.
