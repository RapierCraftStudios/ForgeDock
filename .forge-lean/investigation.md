**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (Windows lanes with 32-64 KB prompts fail deterministically with cli.spawn_failed on every rerun)
**Task Type**: bug

### What Was Claimed
On win32 a prompt between ~32 KB and 64 KB is passed as an argv element (limit `CLI_ARGV_PROMPT_MAX_BYTES = 64 KiB`, chosen for Linux MAX_ARG_STRLEN) and `spawn` fails with ENAMETOOLONG, because CreateProcess caps the whole command line at 32,767 UTF-16 chars (8,191 via cmd.exe shims).

### What We Found
- bin/runner.mjs:1538 `CLI_ARGV_PROMPT_MAX_BYTES = 64 * 1024`, platform independent.
- bin/runner.mjs:1597 `promptViaStdin = byteLength(userMessage) > CLI_ARGV_PROMPT_MAX_BYTES`; only the prompt is counted, not the system-prompt path or flags (:1599-1620 build cliArgs).
- bin/runner.mjs:1653 stdin is delivered via `input:` when promptViaStdin; `claude --print` reads stdin when no prompt arg is given.
- bin/runner.mjs:1541 ENAMETOOLONG is already in DETERMINISTIC_SPAWN_ERRNOS (so reruns fail identically, matching the report).
- bin/lean/lean.test.mjs:4238-4251 existing argv/stdin test has no win32 case.
- The earlier FORGE:INVESTIGATION comment and the prior .forge-lean/result.json ("already-fixed", #4788 offline pool) describe a different issue and do not match this issue's body; the claim here is not fixed on origin/staging (checked: line 1597 unchanged).

### Root Cause
The argv/stdin threshold is a single Linux-derived constant, with no win32 awareness and no accounting for the rest of the command line.

### Affected Files
- bin/runner.mjs (hotspot, 3250 lines: wiring plus a small pure helper, well under +150 lines)
- bin/lean/lean.test.mjs (existing test at :4238; add win32 case)
- Enumerating tests: bin/tests/runner.test.mjs:7 lists 22 export names; add no export beyond what is needed, and if a new export is added, join that list. No new file under bin/, so bin/lean/lean.test.mjs:66 file list is unaffected.

### Sibling Sweep
`grep CLI_ARGV_PROMPT_MAX_BYTES bin`: only runner.mjs and lean.test.mjs. runCliBackendAsync (runner.mjs) shares the decision, verify it goes through the same helper or the same constant lines (line 1597 is the only decision site found).

### History
Introduced by 01e2591d2 "fix(lean): large reviewer prompts go over stdin ... (#4129)", which targeted Linux E2BIG only.

### Recommendation
Add `export const CLI_ARGV_PROMPT_MAX_BYTES_WIN32 = 16 * 1024` and a pure `promptGoesViaStdin(prompt, otherArgs, platform = process.platform)` in bin/runner.mjs: limit = win32 ? 16 KiB : 64 KiB, and the compared size is prompt bytes plus the byte length of otherArgs (system-prompt path, flags) so the whole command line is counted. Use it at :1597 (build the non-prompt args first). Keep the stdin delivery at :1653. Add unit tests for win32 (40 KB prompt -> stdin, 10 KB -> argv, args counted) and keep the linux case.

### Related Issues
#4129 (original stdin switch), #4690/#4518 (spawn-failure classification, unrelated).
