---
status: fresh
anchor: bin/lean/issuewatch-verify.mjs
created: 2026-11-26
---

# #6055: issue-watch verification stops blaming PRs for base-red CI

- `verifyMerge` (bin/lean/issuewatch-verify.mjs): a check red on the merge commit is blamed on the PR only if it was green or absent on the first parent. Red on both is base-red: noted in the evidence, the merge verifies. An unreadable parent keeps the failure.
- With no trusted FORGE:REVIEW on the issue, it falls back to the PR's own comments (best effort), including the `review.trigger` skip note. An enforced NONCONFORMING/BLOCK still fails.
- `verifyClosed` (bin/lean/issuewatch.mjs): the pending window is p90 of recent Actions run minutes x 3, floored at 60 min, capped at 6 h (`io.ciDurations`). Unreadable history keeps 60 min. The failure evidence states the window.

Full rationale: `issue-watch-merge-verification.md` (Amendment #6055).
