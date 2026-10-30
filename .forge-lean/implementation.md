### Approach
Bound the relay answer on the host to what the router accepts, and stop treating a deterministic 4xx answer failure as retryable.

### Changes
- bin/lean/relay.mjs: `RELAY_ANSWER_MAX_BYTES` (512 KiB), pure `capAnswer` (trim stdout then stderr, UTF-8 safe, rc 1 + truncation notice), applied in `servicePending`; a 4xx (not 429) answer failure posts a small rc 1 answer for the same rid.
- bin/lean/relay.test.mjs: regression tests (small answer unchanged, ~1 MB quote/newline/multibyte answer capped and run once, 413 fallback, 502/429/statusless still retried).

### Acceptance Criteria Status
- R1 ✅ bin/lean/relay.mjs:130,161
- R2 ✅ bin/lean/relay.mjs:21,130-148,161-165
- R3 ✅ finding validated (investigation.md)
- R4 ✅ bin/lean/relay.test.mjs (#4831 describe)

### Verification
- V1 relay.test.mjs + relay.e2e.test.mjs + V2 sandbox-provider.contract/computeshare: 73 pass, 0 fail.
- V3 (10 enumerating bin/lean tests): 327 pass, 0 fail.
- New tests fail without the fix (2 of 14 fail against the old relay.mjs).
- forgedock check: PASS. checks.mjs widened to the full suite (fan-out-cap), not run per host rules.
- No formatter is configured in the repo. D3 (optional e2e case) not done.

### Notes
No behaviour change for answers that fit; router limit unchanged; no env vars.

### Docs
Updated devdocs/modules/lean.md (relay section: answer cap and 4xx fallback) for the docs freshness check.
