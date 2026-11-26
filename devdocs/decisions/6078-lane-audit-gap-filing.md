# 6078: opt-in engine-gap filing from the lane audit

`bin/lean/lane-audit-gap.mjs` now implements the gap seam of `runLaneAudit` (#6076). `lean.mjs` passes `makeGapAuditor({gh, cfg, repo})` at the terminal audit; cfg comes from `parseGapConfig` on forge.yaml and a missing or unreadable file means off.

- Off by default: only the string `true` for `orchestrate.lane_audit.file_gaps` enables it. Optional `repo` (default engine repo) and `label` (default `engine-gap`).
- One open issue per signature, found by the `<!-- forge-gap: SIG -->` marker. Another lane updates the count and the affected-lane list; a lane is counted once.
- Skipped: inactive, `fixed_in_later`, and classes other than pipeline/env/pool.
- Redaction (as #6020): the body holds only signature, class, owner, action, engine version, count and lane numbers; `redact()` removes the lane repo name, `owner/name` patterns and absolute paths.
- Best effort: gh failures return null and never change how the lane ends.
