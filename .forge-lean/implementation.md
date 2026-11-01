### Approach
`rate_limited` is handled in `deferPolicy` before the `maxDeferrals` cap and never increments the deferral counter. `deferred` is added to `REQUEUABLE`. The previous run's docs.stale failure came from putting the dossier entry in a module whose glob does not match `bin/lean/*`; the entry now also lives in `devdocs/modules/lean.md`.

### Changes
- bin/lean/orchestrate.mjs: deferPolicy handles rate_limited before the cap; no counter increment on hold; comments.
- bin/lean/batch.mjs: REQUEUABLE accepts `deferred`.
- bin/lean/batch.test.mjs: #4784 regression tests; capped-codes list and gap sequence updated.
- commands/orchestrate.md: spec wording.
- devdocs/modules/lean.md: #4784 entry (D5). devdocs/modules/orchestrate.md: existing entry kept.

### Acceptance Criteria Status
- R1 ✅ bin/lean/orchestrate.mjs deferPolicy (rate_limited before the cap), batch.test.mjs "#4784" describe
- R2 ✅ bin/lean/batch.mjs:79

### Verification
- `node --test bin/lean/batch.test.mjs`: pass (59/0); the #4784 test fails without the fix.
- `node --test --test-name-pattern='orchestrate spec' bin/lean/lean.test.mjs`: pass (2/0).
- `bash scripts/check-devdocs-freshness.sh origin/staging`: OK.
- `forgedock check`: PASS.

### Notes
No env vars. A usage limit is never capped; hold and reset delay are unchanged. No formatter is configured for the changed file types.

### Guard amendments
Superseded guards #4908, #4837, #4834, #4831, #4920: the base batch.test.mjs asserts rate_limited is capped (2 subtests, verified against merge base 14f3a633c); updated here by design. Other failures against the staging tip come from newer features, not this change. No code change.
