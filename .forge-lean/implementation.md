forge-stamp: issue=5988 contract=9f2b97ae862c
### Approach
Verified the branch against the contract; all seven requirements are delivered. The only gap was two changed files that no deliverable names, bin/engine-cli.mjs and devdocs/modules/lean.md. Both are recorded as add-deliverable amendments.
### Changes
- bin/lean/orchestrate.mjs: backend.auth probe, rotate and 30 min escalation (`authPass`); per-(signature, agent) quarantine with a single cache reseed; T-30 hold alert; paced hold release.
- bin/lean/rotator.mjs: `nextAccountAfterAuthFailure`.
- bin/lean/limits.mjs: `holdExpiryWarnings`.
- bin/lean/batch-health.mjs: `stallCause`; a second restart for the same cause is refused; cause and gates recorded.
- bin/engine.mjs: `holdTtlRefusal` and `holdResumePlan`.
- bin/engine-cli.mjs (amended in): `--hold` TTL refusal, resume plan, auth probe and escalation wiring.
- devdocs/modules/lean.md (amended in): dossier entry.
- Tests in the five deliverable test files.
### Acceptance Criteria Status
- R1 ✅ orchestrate.mjs authPass
- R2 ✅ engine.mjs holdTtlRefusal; orchestrate.mjs refreshHeld
- R3 ✅ orchestrate.mjs scopedEngineError
- R4 ✅ batch-health.mjs decideStallAction
- R5 ✅ orchestrate-pause.test.mjs
- R6 ✅ orchestrate-pause.test.mjs
- R7 ✅ orchestrate-envhold.test.mjs
### Verification
- V1: exit 0, 117 pass.
- V2: exit 0, 42 pass.
- G1: exit 0, 18 pass.
- `forgedock check`: PASS.
- The new tests fail without the fix because they depend on the new exports and behaviour. I did not run them against the base.
### Notes
`--hold` on more than 10 issues now requires `--ttl` or `--for`. Auth outage escalation is posted once, after 30 min.
### Recovery pass 2
- R3: no narrowing. The engine quarantines per (signature, agent) without placement callbacks. `quarantineAgent` and `reseedCache` are optional hooks. Quarantine requeues are bounded, after which the batch breaker counts the errors.
- R8 ✅ (added): a regression test where 3 sandboxes destroyed for max lifetime within 30 s do not trip the breaker, are requeued, and produce one `agent.restarted` event (bin/lean/orchestrate-envhold.test.mjs). The existing #5859 `sandbox.lost` path already covers this; the new test pins it.
### Recovery pass 3
- R2: `--ttl` is now parsed as an alias of `--for`, in `ORCH_VALUED` and `holdMeta` (bin/engine-cli.mjs). A hold on more than 10 issues without it is refused. A test in bin/lean/batch.test.mjs covers the refusal, the `--ttl 4h` path and the resume plan.
- Hold expiry now re-admits on a ramp: `holdRamp` in `K()` (orchestrate.mjs) lifts the cap by one lane per `HOLD_RAMP_STEP_MS` (30 s) after a release of more than one issue. This replaces the event-only change.
- R6: the 100-hold test asserts that only one lane runs in the first step after expiry. It fails when the ramp is disabled; I checked by temporarily disabling it.
### Recovery pass 4
- R2: `holdWarned` and `holdRamp` are now declared at the top of `orchestrate()` (orchestrate.mjs:398). The hoisted `refreshHeld` can run from finish/recovery callbacks before the old declaration lines, and would have thrown a TDZ ReferenceError there. I did not add a test that calls it early; the fix is the declaration move.
- R3: an `amend-requirement` restores the full issue wording. The engine quarantines per (signature, agent) regardless of whether the placement layer has hooks.
- R8: the 3-sandbox max-lifetime test stays. `execution.mjs:779` flags a sandbox that ends without a result as `lostWithoutResult`, which is the path the test exercises.

## CI fix
batch.test.mjs "#5168 a backend.auth lane stays pending" asserted the old 15 min hold; per R1 the auth hold is now capped at the 5 min probe interval, so the assertion now expects >= 5 min. All batch.test.mjs, V1, V2 pass.
