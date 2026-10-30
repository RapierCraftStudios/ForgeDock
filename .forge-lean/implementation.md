### Approach
Platform-aware pure helper in bin/runner.mjs deciding argv vs stdin; win32 bound 16 KiB counting the whole argv.

### Changes
- bin/runner.mjs: add CLI_ARGV_PROMPT_MAX_BYTES_WIN32, promptGoesViaStdin(); runCliBackend uses it with the other args counted.
- bin/lean/lean.test.mjs: #4763 test (win32 40 KB -> stdin, small -> argv, args counted, linux unchanged, runCliBackend under win32).

### Acceptance Criteria Status
- R1 ✅ bin/runner.mjs:1611 (40 KB on win32 goes via stdin)
- R2 ✅ bin/lean/lean.test.mjs (#4763 test)
- R3 ✅ bin/runner.mjs:1544-1547
- R4 ✅ bin/runner.mjs:1611-1614

### Verification
- V1 node --test ... --test-name-pattern='4129|argv|stdin|4763' bin/lean/lean.test.mjs: pass (6); new test fails without the fix (helper undefined, win32 40 KB stays in argv).
- V2 bin/tests/runner.test.mjs: pass (252).
- V3 node --check bin/runner.mjs: ok. forgedock check: PASS.

### Notes
No env vars. Linux/macOS behaviour unchanged. No formatter configured in repo.
