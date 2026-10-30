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

### Merge note (origin/staging)
Staging landed its own fix for the same issue (1163f2c5: per-stream cap `capStream`, rc 125 fallback on any rejected answer). Merged: staging's behaviour is kept as the base (rc 125 fallback, no 4xx special-casing), and `capAnswer` is applied on top so the serialized answer is byte-exact under 512 KiB even when two escape-heavy streams pass the char cap. The 4xx-only fallback and its test were dropped as superseded.

## Conformance fix
servicePending's catch now posts the small rc 1 fallback only for a 4xx other than 429 (status integer); 429/5xx/statusless failures are swallowed and retried next poll. The earlier any-error rc 125 fallback is removed. Tests cover 413 (second rc 1 answer, returns 1) and 502 (nothing else posted, returns 0). Doc comment and dossier now match.
