---
issue: 5081
status: fresh
anchor: bin/review-staging.mjs
created: 2026-11-04
---

# 5081 — Staging review: moved head refuses to --delta, delta fixes are not re-filed

**Context:** When the PR head moved between dispatch and `--finalize`, the run was treated as a degraded panel. It got a GATE_FAILURE and a label instead of being sent to a delta pass. Other problems came up in the same runs:
- the delta proof rejected reviewer comments whose `FORGE:REVIEW-AGENT` marker was not on line 1;
- a delta finalize re-filed earlier findings that the delta had already fixed;
- the open-finding gate was blocked by P2/P3 follow-ups;
- one transient `gh pr comment` failure dropped a gate or route marker.

**Decision:**
- `bin/review-staging.mjs` `finalize` compares `review-ctx` `pr.review_sha` with the live head. If they differ, it stops with `run forgedock review-staging <pr> --delta <sha>` and makes no gh writes. The REVIEW_ROUTE post goes through `retryGh`.
- `scripts/review-prepare.sh` delta proof accepts the marker within the first 5 lines. A no-proof blocker names the launched domains that have no valid delivery and any malformed reviewer comments.
- `scripts/review-finalize.sh` (DELTA mode):
  - extract marks a finding `earlier_only` when only the earlier head raised it;
  - file-prepare gives such a finding `skip-fixed-in-delta` when its cited line is in an old-side hunk of `from..head`. Finalize treats it like `skip-resolved`: it does not block and is listed as "fixed in delta".
- `scripts/review-staging-pre.sh`: the gate counts only blocking findings. A finding is blocking when it is labelled `blocking`, has `priority:P0`/`P1`, or has no `priority:*` label (fails closed). Every `gh pr comment` goes through `gh_retry`.

**Why safe:** marker bodies are unchanged. A finding the delta reviewers raised again is still filed. Unknown priority still blocks.
