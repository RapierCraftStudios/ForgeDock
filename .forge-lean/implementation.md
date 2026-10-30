### Approach
New pure, io-injected module `bin/lean/prodwatch-triage.mjs` on top of prodwatch-sources (#4833). Fingerprint strips every digit-bearing token and timestamps; clusters group by fingerprint and dedup against `FORGE:SIGNAL_REF fp=` markers; rules come from an optional `Alert rules:` list in the loadPolicy text plus defaults; validation goes only through `runAdapter`.

### Changes
- bin/lean/prodwatch-triage.mjs: fingerprint, signalRef, cluster, parseAlertRules, classify, validate, tally, CLASSES, DEFAULT_RULES.
- bin/lean/prodwatch-triage.test.mjs: 10 tests (new regression suite).
- bin/lean/fixtures/prodwatch/{memos,expected}.json: synthetic anonymised 70 memos (8 issue clusters, 4 transient, 4 expected-class, pg cluster of 15).
- devdocs/modules/lean.md: one paragraph sentence.

### Acceptance Criteria Status
- R1 ✅ prodwatch-triage.mjs:23
- R2 ✅ prodwatch-triage.mjs:41-62
- R3 ✅ prodwatch-triage.mjs:66-92
- R4 ✅ prodwatch-triage.mjs:101-125
- R5 ✅ prodwatch-triage.test.mjs:27
- R6 ✅ prodwatch-triage.mjs:101-125
- R7 ✅ bin/lean/fixtures/prodwatch/
- R8 deferred (owner action, in contract)
- R9 ✅ module header, no fs/LLM, example hosts only

### Verification
- V1 pass (33 tests). V2 pass (314). V3 pass (check + freshness).
- Scoped checks.mjs run: 890 pass, 3 fail (preflight platform/WSL rows, writeInstallReceipt copyFile, forge Act II) in bin/tests, unrelated to the changed files (environment/WSL); not in the contract validates.
- `forgedock check`: PASS. New tests fail without the module (import error).

### Notes
No formatter config in the repo; none run. No env vars. Fixture is synthetic (R8).

### Sibling-list check
The ten flagged tests do not enumerate bin/lean modules at the flagged lines (stub-lane comments, git args, MECHANICAL_KINDS, etc.); recorded as not_members in result.json, no test list changed.
