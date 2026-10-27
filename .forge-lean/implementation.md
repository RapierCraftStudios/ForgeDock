### Approach
Reuse `isTrustedIssueComment` (prefilter.mjs) to gate FORGE:GUARD comments in the two readers.

### Changes
- bin/lean/guards.mjs: `guardIssue` finds an existing guard only among trusted comments; `collectGuards` skips untrusted comments (so the index, guardgate and compounding are covered).
- bin/lean/guards.test.mjs: fixtures gain `authorAssociation: "OWNER"`; two new tests (trusted and untrusted, for guardIssue, collectGuards and the index).

### Acceptance Criteria Status
- R1 ✅ bin/lean/guards.mjs:98,129
- R2 ✅ bin/lean/guards.test.mjs (two new tests)
- R3 ✅ lands in this change, before the gate goes to enforce

### Verification
- V1 `node --test bin/lean/guards.test.mjs`: 17 pass. The 2 new tests fail without the fix.
- V2 `node --test bin/lean/guardgate.test.mjs bin/lean/lean.test.mjs`: 516 pass.
- `forgedock check`: PASS. The checks.mjs full-suite widening was skipped per host rules.

### Notes
No env vars. The FORGE:CONTRACT lookup is unchanged (out of scope).
- Docs: added devdocs/modules/lean.md entry (#4750) for the docs freshness check.
