### Approach
`deferPolicy` now handles `rate_limited` before the `maxDeferrals` cap (still returns `hold:true`) and the deferral counter skips hold results. `REQUEUABLE` accepts `deferred`.

### Changes
- bin/lean/orchestrate.mjs: rate_limited never capped; counter not incremented for holds; comments.
- bin/lean/batch.mjs: REQUEUABLE includes `deferred`.
- bin/lean/batch.test.mjs: new #4784 test; existing deferral-sequence test and capped-codes list adjusted.
- commands/orchestrate.md: spec wording.

### Acceptance Criteria Status
- R1 ✅ bin/lean/orchestrate.mjs deferPolicy (rate_limited branch before the cap)
- R2 ✅ bin/lean/batch.mjs:79

### Verification
- node --test bin/lean/batch.test.mjs: 59 pass. The new #4784 test fails without the fix.
- node --test --test-name-pattern='orchestrate spec' bin/lean/lean.test.mjs: 2 pass.
- forgedock check: PASS. Devdocs freshness: dossier devdocs/modules/orchestrate.md updated (Entry 2026-10-30).

### Notes
A usage-limit deferral no longer counts toward max_deferrals. Earlier `deferred` rows can now be requeued with `--requeue`. No repo formatter is configured.

### Precheck timeout
scripts/verify-phase-trail.test.sh hit the 300s cap under host load; rerun alone passes (160/0, ~170s). It is unrelated to this diff, so no code change.

- `bash scripts/verify-phase-trail.test.sh` timed out (exit 124) in the precheck at 300s under host load. Rerun: passed=160 failed=0 in 166s. The script and its inputs are untouched by this change, so no code fix applies.
