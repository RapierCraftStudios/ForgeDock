### Approach
New pure module with injected `io` (exec/audit/now), mirroring bin/lean/issuewatch.mjs. Read-only is structural: `runAdapter` only builds commands from `list`/`read`/`run`; `closeSignal` is the sole function that touches `close`.

### Changes
- bin/lean/prodwatch-sources.mjs: normalizeSignal, parseSources, per-kind normalisers (memo, alertmanager, sql, prometheus), runAdapter, closeSignal; ids/reasons/queries validated against shell-active characters.
- bin/lean/prodwatch-sources.test.mjs: 12 tests with injected exec fixtures (synthetic data), including an exec-spy read-only test and closeSignal audit tests.
- devdocs/modules/lean.md: one sentence describing the module (freshness check).

### Acceptance Criteria Status
- R1 ✅ bin/lean/prodwatch-sources.mjs:75-125
- R2 ✅ bin/lean/prodwatch-sources.mjs:28,45,80-125
- R3 ✅ bin/lean/prodwatch-sources.mjs:127; test "runAdapter never executes close"
- R4 ✅ bin/lean/prodwatch-sources.mjs:154
- R5 ✅ closeSignal is the only close path; tests use injected exec
- R6 ✅ fixtures synthetic (prodwatch-sources.test.mjs)
- R7 ✅ no fs/network/LLM; io injected

### Verification
- V1 `node --test bin/lean/prodwatch-sources.test.mjs`: pass 12/12; fails without the fix (module missing).
- V2 `node --check ... && node --test issuewatch*.test.mjs`: pass 34/34.
- V3 `bash scripts/check-devdocs-freshness.sh origin/staging`: exit 0.
- checks.mjs scoped tests: 892 pass, 3 fail, all in bin/tests/journey.test.mjs (WSL platform/receipt tests); unrelated to this diff and environmental. `forgedock check`: PASS.

### Notes
No formatter is configured in the repo. No env vars. No enumerating test lists reference sibling files (grep), recorded as not_members.

### Fix round: enumerating-sibling check
Inspected the ten cited lines; none is an enumeration of bin/lean modules (fixtures, comments, unrelated domain lists). Recorded all as not_members in result.json. No source change.
