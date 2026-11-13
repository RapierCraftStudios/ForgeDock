forge-stamp: issue=5647 contract=734b8cc067e3
### Approach
When the batch settle step queues a recovery lane, an injected `markRecovering` swaps `needs-human` for `workflow:recovering` and upserts one "attempt n/N" comment. The recovery lane end and the final needs-human relabel clear `workflow:recovering`.
### Changes
- bin/lean/orchestrate.mjs: `markRecovering` dep, called best-effort at the recovery requeue.
- bin/engine-cli.mjs: `makeMarkRecovering` (label create, add, read-back, then remove needs-human; failure keeps needs-human), wired in; the final needs-human relabel also removes `workflow:recovering` in the same edit.
- bin/lean/lean.mjs: a recover lane strips `workflow:recovering` at finish.
- bin/labels.json: `workflow:recovering`.
- Tests: bin/lean/orchestrate-recovering.test.mjs (new), batch.test.mjs, lean.test.mjs.
### Acceptance Criteria Status
- R1 ✅ engine-cli.mjs makeMarkRecovering, orchestrate.mjs recovery requeue
- R2 ✅ engine-cli.mjs relabel path (final failure keeps needs-human)
- R3 ✅ orchestrate.mjs markRecovering call; lean.mjs recover cleanup
- R4, R5 not-applicable (moved to #5648)
### Verification
- V1 (orchestrate-recovering, batch, lean, orchestrate-owned, orchestrate-blocked): exit 0, 822 pass, 0 fail.
- V2 (parked-relabel, issuewatch-reconcile): exit 0, 9 pass, 0 fail.
- G1 (batch, orchestrate-cancel, orchestrate-children): exit 0, 133 pass, 0 fail.
- forgedock check: PASS. The new tests call the new hook, so they fail without the fix (not run against the base).
### Notes
No formatter configured. The parked relabel path does not remove workflow:recovering itself; the recover lane finish does.
- Docs: added a #5647 entry to devdocs/modules/lean.md for the freshness check (bin/lean/lean.mjs, orchestrate.mjs).

## CI fix (Unit tests)
Adding `workflow:recovering` to `bin/labels.json` broke two parity tests: `workflow-state-parity` (labels.json workflow:* must equal transition-label.sh VALID_STATES) and `label-bootstrap` (ensure table must match labels.json). The label is engine-managed via gh, not a transition-label.sh state (K3), so both tests now exempt it (`ENGINE_ONLY` in the first, an explicit filter in the second). Validate commands pass (834 tests).

## CI fix
router.test.mjs doctor --fix stub label list mirrors workflow:* in labels.json; added workflow:recovering (#5647).
