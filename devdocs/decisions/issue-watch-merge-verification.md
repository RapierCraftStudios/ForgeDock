---
status: fresh
anchor: bin/lean/issuewatch-verify.mjs
created: 2026-10-31
---

# ADR: issue-watch verifies a merge instead of counting a closed issue

## Context

`issue-watch` (#4765) counted an issue as merged and verified once it was closed. A close is not a merge: the already-fixed pre-filter, `workflow:invalid` and decomposition close issues too. A merge is not a verified result either: in shadow conformance mode a review that says `would BLOCK` still merges. In the last 17 lane merges into staging before this change, 8 had a latest review of `would BLOCK`.

## Choice

- On close, `issuewatch-verify.mjs` `verifyMerge` checks the result. It looks for a merged `feat/issue-<n>-lean` PR into the issue's lane and checks:
  - the PR has no `review-degraded` label;
  - the latest trusted FORGE:REVIEW passed;
  - the lane's required checks are green on the merged head;
  - the merge commit is on the lane;
  - no check on the merge commit is red.
- The checks are the same as the standalone watcher prototype's. Trust uses the engine's `isTrustedIssueComment`, and required checks come from `requiredChecksFor`.
- **Outcomes:**
  - `verified`: a FORGE:WATCH_VERIFY record with the evidence.
  - `unverified`: reopen, `needs-human`, and a "merge NOT verified" comment with the evidence.
  - `closed`: no merged lane PR; not counted as merged.
  - `pending`: a read failed or merge-commit CI is still running. It is retried each pass and fails after 60 minutes.
- A draining watch is not done while a merge is mid-verification.

## Rejected

- **Auto-revert on a failed verification.** Revert, fix forward or accept is a product decision.
- **Accepting a shadow `would BLOCK` as verified because the gate is in shadow mode.** The watch reports what the reviewer found. Making the gate itself block is the enforce-mode decision, which belongs to the operator.
- **Verifying in release mode here.** `issuewatch-release.mjs` tracks its releases separately; its per-issue merges are left for a follow-up.
