**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (a large read-only relay answer is never delivered: the host re-runs the prod query on every lane status poll, the lane gets a misleading rc 125 timeout, and the stuck entry eats one of 8 pending slots)
**Task Type**: bug

### What Was Claimed
`servicePending` (bin/lean/relay.mjs:138) posts the full relay answer; when its JSON body exceeds the router's 1 MiB body limit the router answers 413, `relayAnswer` throws, the catch swallows it as "retried on the next poll", the request stays pending, the host re-runs the command every poll and the sandbox times out with rc 125.

### What We Found
Verified on origin/staging (e8df65dd, the merge base of this branch):
- bin/lean/relay.mjs:60 `runRelayed` caps each stream at `maxBytes = 1 << 20` (stdout and stderr separately), so an answer can carry ~2 MiB of text before JSON escaping.
- bin/lean/relay.mjs:137 builds `{rc, stdout, stderr}` with no size bound; :138 `try { await transport.relayAnswer(...) } catch { /* retried on the next poll */ }` swallows every failure, including non-retryable 4xx.
- bin/lean/sandbox-remote.mjs:85 `relayAnswer` throws `fail("relay answer", r)` on any non-ok status; `fail` (:62-68) sets `e.status`, `transient` only for 502/503/504, `retryable` for 429/503.
- bin/pool/router.mjs:315 parses every POST body with `readJson(req)`; bin/pool/http.mjs:5-10 default limit `1 << 20` throws `{status: 413}`; router.mjs:320-322 sends it as `413 body too large`. `relayAnswer` (router.mjs:61-66) is never reached, so the entry stays `!done`.
- bin/pool/router.mjs:263 lists every `!done` entry on `GET /sandboxes/:id/relay`, so the next status poll (sandbox-remote.mjs:146-148) re-runs the command; router.mjs:47 counts the stuck entry toward `RELAY_MAX_PENDING = 8` (:38), later requests get 429.
- JSON escaping (`\n` -> 2 bytes, `"` -> 2 bytes, control chars -> 6 bytes) means stdout well under 1 MiB (e.g. ~600 KB of newline/quote-heavy text) already crosses the limit.
- bin/lean/relay.test.mjs:87-99 covers the answer path only with tiny outputs and a generic throw; no size or 4xx case.

### Root Cause
The host never bounds the serialized answer to what the router accepts, and treats every answer failure as retryable, so a deterministic 413 becomes an infinite re-run loop.

### Affected Files
- bin/lean/relay.mjs (cap the answer, post a small fallback on a non-retryable 4xx)
- bin/lean/relay.test.mjs (regression tests)
- bin/tests/relay.e2e.test.mjs (optional: large-output case through the real router)
- Enumerating tests (bin/lean listed by name): bin/engine/telemetry-seam.test.mjs:24, bin/lean/batch.test.mjs:29, bin/lean/checks.test.mjs:156, bin/lean/conformance.e2e.test.mjs:74, bin/lean/conformance.test.mjs:404, bin/lean/context.test.mjs:138, bin/lean/drift.test.mjs:14, bin/lean/execution.e2e.test.mjs:28, bin/lean/execution.test.mjs:43, bin/lean/fixround.test.mjs:10. No new file is added under bin/lean, so none of their lists change; they are run as a guard (V3).

### Sibling Sweep
- Pre-fetch at dispatch (bin/lean/sandbox-remote.mjs:151-165) runs the same commands but already caps its payload at `PREFETCH_MAX_B64` and skips oversized results: not affected.
- Agent -> router relay request body is capped (bin/pool/agent.mjs:255 `readJson(req, 32 * 1024)`, router.mjs:45 `RELAY_MAX_BYTES`): not affected.
- Router -> agent -> sandbox answer delivery is a GET response (router.mjs:53-59, agent.mjs:254), not subject to `readJson`: not affected once the answer is bounded.
- Transient answer failures (502/503/504) still re-run the command on the next poll by design (relay.mjs:126 doc); not this issue's defect, left unchanged.

### History
Introduced by 56c0b93e "feat(execution): read-only capability relay for sandbox lanes (#4778)" (PR #4821); found in the staging review of release PR #4820. No prior fix.

### Recommendation
In bin/lean/relay.mjs: add `export const RELAY_ANSWER_MAX_BYTES = 512 * 1024` and a pure `capAnswer(out, max = RELAY_ANSWER_MAX_BYTES)` that, when `Buffer.byteLength(JSON.stringify(out)) > max`, trims stdout then stderr (UTF-8 safe) until the serialized answer fits, appends `relay: output over N bytes, truncated` to stderr and sets rc 1 (same convention as relay.mjs:66). Apply it at :137. At :138, when the error has a 4xx `status` other than 429 (non-retryable), post a small `{rc: 1, stdout: "", stderr: "relay: answer rejected by the router (HTTP <status>)"}` for the same rid and count it; keep swallowing transient/429 errors and a failed fallback. Keep the router's generic 1 MiB limit (bin/pool/http.mjs:5) unchanged.

### Related Issues
#4778 / PR #4821 (relay introduced), PR #4820 (release review that found it).
