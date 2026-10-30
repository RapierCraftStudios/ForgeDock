### Approach
Filter secrets at the single persistence choke point (`writePlan`), scrub pre-existing plans on daemon start and on `--resume`, and refuse `--set-env` for secret names. The in-memory pin still carries the token for the running batch; resumes re-read it from the daemon env/keychain via `mergeEnv`.

### Changes
- bin/lean/batch.mjs: `SECRET_ENV` (now also `*_KEY`), `scrubEnv`, `writePlan` drops secret env values and records names in `envSecrets`, new `scrubPlan()` (rewrites 0600, no-op if clean).
- bin/lean/schedd.mjs: re-exports `SECRET_ENV` from batch.mjs; scrubs every batch plan at daemon start.
- bin/engine-cli.mjs: `--set-env` rejects secret names; `--resume` scrubs the plan first.
- bin/lean/batch.test.mjs, bin/lean/schedd.test.mjs: regression tests; the #4691 test now expects `--set-env GH_TOKEN=...` to be refused.

### Acceptance Criteria Status
- R1 ✅ bin/lean/batch.mjs (writePlan/scrubEnv)
- R2 ✅ bin/lean/batch.mjs (envSecrets names), bin/engine-cli.mjs resume uses mergeEnv (schedd.mjs mergeEnv)
- R3 ✅ bin/lean/batch.mjs put (private) + test asserts 0600
- R4 ✅ bin/lean/batch.mjs scrubPlan, called from schedd.mjs start and engine-cli.mjs resume

### Verification
- V1 `node --test bin/lean/batch.test.mjs bin/lean/schedd.test.mjs`: 83 pass, 0 fail. The new batch tests call `scrubPlan` and assert the token is absent, so they fail without the fix.
- checks.mjs widened to the full suite (fan-out cap); not run per host rules.
- scripts/check-devdocs-freshness.sh: OK, no dossier required.

### Notes
- `--set-env` with a secret-named key now errors instead of storing it.
- plan.json gains `envSecrets` (names only).
- SECRET_ENV now also matches names ending in `_KEY`, so `--show-env` redacts those too.
- Docs: devdocs/modules/lean.md entry for #4787 (fixes the devdocs freshness check).
