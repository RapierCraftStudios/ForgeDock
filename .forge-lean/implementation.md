### Approach
`writeAtomic` gets an opt-in `{private}` option (file 0600, dir 0700, chmod of an existing dir); `openBatch` uses it for every batch-dir write. The npm exclusion of the refresh script is removed.

### Changes
- bin/lean/batch.mjs: private writeAtomic option; openBatch `put` helper; log.jsonl and lanes/N.log created 0600; lanes dir 0700.
- package.json: removed `!scripts/refresh-bot-token.sh`.
- bin/lean/batch.test.mjs: "batch state files are private" test (umask 022, pre-existing 0755 dir).
- bin/tests/package-files.test.mjs: new packaging test.

### Acceptance Criteria Status
- R1 ✅ bin/lean/batch.mjs:58-68, bin/lean/batch.test.mjs (new test)
- R2 ✅ package.json files, bin/tests/package-files.test.mjs
- R3 ✅ bin/lean/batch.mjs:58-68
- R4 ✅ package.json:46

### Verification
- V1 (batch, package-files, bot-token-timer tests): 68 pass, 0 fail.
- V2 (sched, limits, retry tests): 35 pass, 0 fail.
- New test fails on the base batch.mjs (1 fail), passes with the fix.
- `forgedock check`: PASS. No formatter config in the repo. devdocs freshness: OK.

### Notes
Other writeAtomic callers keep default modes. Existing files in an old batch dir keep their modes until rewritten; the dir becomes 0700 on the next write. The script still hardcodes RapierCraft IDs; without a PEM it fails and lanes defer as gh.auth, as before.
- Docs: devdocs/modules/lean.md entry for #4751 (freshness check).
