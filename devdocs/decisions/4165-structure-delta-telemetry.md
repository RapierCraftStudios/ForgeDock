---
issue: 4165
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-10-20
---

# Decision: one merge-time structure record, verdicts on RUN_TERMINAL, queries in `forgedock stats`

## Context

To answer "which PRs added A→B, and why did the plan allow it?" for #4159, an audit made about 40 `gh` calls and read 30–80 KB comment threads per issue. The engine already had the facts: `structure-delta.sh` ran at implement, the contract was frozen, and the shadow gate computed a verdict. But telemetry carried only counts (no edge names, no PR, no milestone). The seam dropped `CONFORMANCE_SHADOW`, and the contract had nowhere to put provenance.

## Choice

- **Delta:** the `STRUCTURE_DELTA` telemetry write moves from implement to the merged path, one per merged run. It covers repos without workspaces too, with empty lists. The implement-time event stays in the run log and still gates undeclared package edges.
- **Delta computation:** `scripts/structure-delta.sh` is still the only place the edge delta is computed. It now also lists the files behind each import pair. `top_growth` comes from one local `git diff --numstat`. Growth is not part of the edge delta, and the script prints `{}` for repos without workspaces, which consumers rely on.
- **Verdict mix:** the shadow verdict, PR, milestone and conformance mode ride on the existing `RUN_TERMINAL` write. Telemetry writes per merged run: +0 for workspace repos and +1 for others, within the issue's "one telemetry write" budget. Overhead is one local script run plus one `git diff`.
- **Provenance:** `contract.decisions[]` (source `doc|lint|precedent|spec`) is optional and validated only when present, so contracts frozen before it stay valid on reruns.
- **Queries:** `forgedock stats --edge FROM:TO` and `--milestone M` (`bin/stats/query.mjs`) read the records the stats crawler already fetches. `/audit` Phase 1B tries them first.
- **Encoding:** telemetry values are sanitised scalars (max 200 chars), so lists are encoded as `from:to,...`, `file+N,...` and `K1:lint,...`. A very long list is truncated. The trajectory table keeps the first 10 entries.

## Rejected

- **Mapping `CONFORMANCE_SHADOW` as its own telemetry event.** That is one more GET+PATCH per review round; `RUN_TERMINAL` already gets written.
- **Aggregating in `scripts/calibration.mjs`.** It reads the ledger, not telemetry. `/forge-stats` is the spec-size tool, and `forgedock query` has no subcommand. `forgedock stats` already crawls telemetry.
- **Computing growth inside `structure-delta.sh`.** That would change its `{}` contract for repos without workspaces (`lean.mjs` structureOf, `maintenance-scan.sh`).
- **Required `decisions[]`.** That would invalidate recovered frozen contracts and force filler on trivial issues.
