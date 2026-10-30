**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: high (every schedd-backed batch fails on Windows; workaround `--foreground`)
**Task Type**: bug

### What Was Claimed
On Windows `forgedock schedd` cannot listen on `~/.forge/sched/schedd.sock` (EACCES); Node `net` IPC on win32 requires a named pipe. Secondary: `defaultSpawn` uses `URL.pathname` (`/C:/...`), breaking the script path.

### What We Found
- bin/lean/schedd.mjs:48-49 `scheddPaths` returns `sock: join(dir,"schedd.sock")` on every platform.
- bin/lean/schedd.mjs:261 `server.listen(p.sock)`; :139 and :281 `rmSync(p.sock)`; :296 lost-socket watchdog `existsSync(p.sock)`; :404 `scheddExists` uses `existsSync(sock)`.
- bin/lean/schedd.mjs:350-352 `connectDaemon` uses `createConnection(sock)` from the same path (orchestrate and `--resume` both go through it).
- bin/lean/schedd.mjs:366 `defaultSpawn` still uses `new URL("../forgedock.mjs", import.meta.url).pathname` at this base (not yet fixed here, despite the issue saying main has it).
- bin/lean/schedd.test.mjs:72,327,368,457,462,610 assert `existsSync(...sock)` on POSIX; these stay valid on non-win32.

### Root Cause
The socket path is a filesystem path on all platforms; win32 only accepts `\\.\pipe\<name>`. The spawn script path is built from a URL pathname rather than `fileURLToPath`.

### Affected Files
- bin/lean/schedd.mjs (scheddPaths, startDaemon unlink/watchdog, scheddExists, defaultSpawn)
- bin/lean/schedd.test.mjs (win32 path-selection tests)
- Enumerating tests: none of the listed bin/lean sibling-name tests enumerate schedd.mjs exports; no new file is added to bin/lean, so none need changes.

### Sibling Sweep
- bin/lean/retry.mjs:54 has the same `new URL(...).pathname` defect for a `.sh` script (not Windows-runnable anyway; out of scope, note only).
- Test files using `.pathname` (bin/tests/*) are test-only; leave.
- No other module opens the schedd socket (grep of engine-cli, execution, heavy, sched, seqlease, pool/router finds no `.sock` use via scheddPaths).

### History
- schedd introduced in 11b653a28 (#4192) with the `schedd.sock` path; later edits (#4503 watchdog, #4787) kept it. No prior Windows fix.

### Recommendation
Give `scheddPaths(dir, platform = process.platform)` a win32 branch: `sock = \\.\pipe\forgedock-schedd-<sha1(resolved dir) first 12 hex>`. Add small `isPipe` handling: skip `rmSync` of sock (lines 139, 281) and skip the `existsSync(p.sock)` watchdog and make `scheddExists` fall back to the lock file on win32 (named pipes vanish with the process). Use `fileURLToPath` in defaultSpawn. Add tests: scheddPaths with platform "win32" yields a stable per-dir pipe name, differs across dirs, and linux keeps `schedd.sock`. Publishing an npm release is out of repo scope (post-deploy). Real Windows listen/connect cannot be exercised in-lane.

### Related Issues
None found beyond #4192 (origin) and #4503 (watchdog).
