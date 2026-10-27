### Approach
Escape every `<` and `>` in the embedded JSON (as `<`/`>`), the pattern already used in drift.mjs, lifecycle.mjs and integration.mjs. No comment terminator variant can then appear.

### Changes
- bin/lean/guards.mjs:84: renderGuard escapes all `>` instead of only `-->`.
- bin/lean/guards.test.mjs:48: round-trip test with `-->`, `--!>`, `<x>` in why and test fields; asserts no `>` before the closing ` -->` via slice/includes (no regex).

### Acceptance Criteria Status
- R1 ✅ guards.mjs:84, guards.test.mjs:48
- R2 ✅ (in lane) no `-->` regex left in guards*.mjs; CodeQL itself is out-of-band
- R3 ✅ guards.test.mjs:48

### Verification
- V1 `node --test bin/lean/guards.test.mjs`: pass 15/0; the new test fails without the fix (14 pass, 1 fail).
- V2 `node --test bin/lean/lean.test.mjs bin/lean/train.test.mjs`: pass 516/0.
- forgedock check: PASS. devdocs freshness: OK.

### Notes
Old posted guards (`-->` escapes) still parse. checks.mjs widened to the full suite, so it was not run.

### Docs follow-up
Freshness check failed on guards.mjs; added a dated entry to `devdocs/modules/lean.md` (#4741). V1/V2 re-run: pass.
