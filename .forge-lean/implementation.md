### Approach
`scheddPaths` picks the socket by platform: on win32 a named pipe `\\.\pipe\forgedock-schedd-<sha1(resolved dir)[0:12]>`, elsewhere `<dir>/schedd.sock`. `listen` and `createConnection` already take `sock` from it, so both use the pipe. Filesystem-only socket handling is skipped on win32.

### Changes
- bin/lean/schedd.mjs: platform-aware `scheddPaths`; skip stale-socket unlink (startup, close) and the existsSync lost-socket watchdog on win32; `scheddExists` checks the lock on win32; new `SCHEDD_SCRIPT` (fileURLToPath) as `defaultSpawn` default.
- bin/lean/schedd.test.mjs: win32 path-selection test and spawn-script test.

### Acceptance Criteria Status
- R1 ✅ bin/lean/schedd.mjs:49 (pipe used for listen; not runnable on Windows in-lane)
- R2 ✅ bin/lean/schedd.mjs:351 (connectDaemon uses same pipe)
- R3 ✅ bin/lean/schedd.test.mjs (describe "#4762 win32 socket path")
- R4 ✅ bin/lean/schedd.mjs:49
- R5 post-deploy (npm release)
- R6 ✅ bin/lean/schedd.mjs SCHEDD_SCRIPT
- R7 ✅ listen/connect share `sock`; unlink skipped on win32

### Verification
- V1 `node --test --test-concurrency=1 bin/lean/schedd.test.mjs bin/lean/batch.test.mjs`: 89 pass, 0 fail. New tests fail without the fix (scheddPaths ignores platform; SCHEDD_SCRIPT undefined).
- `forgedock check`: PASS. devdocs freshness: not required.

### Notes
No env vars. POSIX behaviour unchanged. No formatter is configured in the repo.

## Docs freshness fix
Added entry "schedd listens on a named pipe on Windows (#4762)" to devdocs/modules/lean.md (dossier for bin/lean/*). V1 re-run: 89 pass, 0 fail.
