### Approach
`guardChain` now applies the loop logic to a repeated name:cmd only when cmd is a pass-through wrapper (`isPassThroughWrapper(read(cmd), name)`); a repeated real binary passes through unchanged and unrecorded.

### Changes
- bin/lean/heavy.mjs: guardChain gains injectable `read` (default `head`) and the wrapper check; doc comment updated.
- bin/lean/heavy.test.mjs: new nested-real-binary regression test; the wrapper-chain test's fixture scripts now contain a `command -v` lookup so they count as wrappers.

### Acceptance Criteria Status
- R1 ✅ bin/lean/heavy.mjs:311-313, test in heavy.test.mjs
- R2 ✅ wrapper cutoff test still passes; runWrapped untouched

### Verification
- V1 `node --test bin/lean/heavy.test.mjs bin/lean/lean.test.mjs`: 527 pass, 0 fail. The suite fails without the fix (heavy.mjs reverted, tests kept).
- `forgedock check`: PASS.

### Notes
No env vars changed. Legit nested calls are no longer counted toward SHIM_LOOP_MAX. An undetectable (non-text) wrapper is no longer cut off on repeat. No formatter config in the repo, so none was run. I briefly used a pathspec `git stash` to test without the fix, applied it back and dropped it.

### Docs
- devdocs/modules/lean.md: re-entry guard paragraph now states a repeated real binary passes through unrecorded (#4735); only wrappers get the next-match / env.shim_loop cutoff.

Follow-up: the repeated-real-binary check now runs before the SHIM_LOOP_MAX cap, so a 4-entry chain containing the real entry passes through. The regression test uses that 4-entry chain.
