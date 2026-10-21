---
issue: 4360
status: fresh
anchor: scripts/review-prepare.sh
created: 2026-10-21
---

# ADR: `forgedock review-staging --delta <sha>` uses an explicit delta base and credits the earlier pass

## Context

When a fix lands on staging during a staging->main review, the operator re-reviewed only the fix by hand, as a 2-reviewer delta pass. `/review-pr` resolves its delta automatically through `scripts/review-delta.sh`. That resolver only accepts a checkpoint with a post-panel-guard proof: a synthesized block, or a `# PR Review Summary` with an **Agents** count. The staging summary posts `## Staging Review:`, so the resolver would always answer FULL for a staging PR.

## Choice

- `review-prepare.sh --delta-from <sha>` takes the delta base from the caller. It skips the resolver, including under `--no-delta`, which the staging CLI still passes. It fails closed (BLOCKED) in four cases:
  - the SHA is not a full commit id in the checkout;
  - the SHA equals the head;
  - the SHA is not an ancestor of the head (force-push or rebase);
  - no trusted `FORGE:REVIEW-AGENT` body carries `Reviewed-SHA: <sha>`, so there is no earlier pass to credit.

  An empty file delta widens to FULL, the same as the resolver path.
- Roster: `delta_roster` over the delta files, without the "two full rounds first" gate, so the roster is the domains the delta touches. Diff and slices narrow to `<sha>..head` through the existing DELTA branches.
- Credit: the context carries `delta {mode: DELTA, from}`. `review-finalize.sh extract` already reads the earlier head's trusted findings in DELTA mode, so the earlier pass's findings still reach triage and the verdict. `--finalize` adds the delta files to the 7B scope set, so a finding on the fix is never demoted to `NOTE out_of_scope`. `--summary` names the credited pass.
- The spec-owned panel (material-change, bug hunters, code-quality, regression-risk) is credited from the earlier pass and not re-dispatched. This matches the operator's 2-reviewer delta pass.
- `--delta` takes a full 40/64-hex SHA only, the same form as `Reviewed-SHA`.
- Marker text (`FORGE:REVIEW_ROUTE`, `FORGE:REVIEW-AGENT`, `Reviewed-SHA`, `FORGE:GATE_PASS` / `FORGE:GATE_FAILURE`) is unchanged.

## Rejected

- Teaching `review-delta.sh` to recognise the staging summary. That would change the trust proof shared with `/review-pr`, and the operator already knows which head was reviewed.
- Re-running the spec-owned panel on the delta. It costs the full panel again for a small fix and does not match the observed delta pass.
- Blocking on an empty file delta. A wider review is always safe.
