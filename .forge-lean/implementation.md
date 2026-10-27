### Approach
Create the dynamic parked:<code> label lazily (label create --force) before the relabel edit, and make orchestrate honour the relabel result.
### Changes
- bin/engine-cli.mjs: best-effort `gh label create parked:<code> --force` before the park edit.
- bin/lean/orchestrate.mjs: parkedQueued set only if result is not false/"failed"/"skipped".
- bin/lean/batch.test.mjs: two regression tests.
### Acceptance Criteria Status
- R1 ✅ engine-cli.mjs:1908, orchestrate.mjs:668, batch.test.mjs tests tagged #4736
- R2 ✅ non-parked paths untouched
### Verification
- V1 node --test batch/gatewatch/lean tests: 569 pass, 0 fail. The orchestrate test fails without the orchestrate fix.
- forgedock check: PASS. checks.mjs widened to the full suite, which I did not run per host rules.
### Notes
No behaviour change beyond the described fix; no formatter configured.

Docs: added devdocs/modules/lean.md entry for #4736 (docs freshness check).
