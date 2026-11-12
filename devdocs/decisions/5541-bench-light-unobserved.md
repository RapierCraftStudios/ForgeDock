# 5541: bench flags lanes with no `light` field

- **Cause.** `light` was null on the valid bench lanes because the sandbox ran at the default `lean.light.mode: shadow` (or no result file was read), so the fast path never engaged. Not an eligibility verdict.
- **Change.** `bench-lightlane.mjs` marks `light_unobserved`; `bench-adversarial.mjs` counts it per arm in the scorecard. Engine and the duplicate rule are unchanged.
- **Corpus.** `adv-int-take-until` aliased the existing `takewhile_inclusive`, so closing it was correct; replaced by `adv-int-argmax`.
- **Deferred.** The ≤ 1.3× cost re-run on legion with `lean.light.mode: on`.
