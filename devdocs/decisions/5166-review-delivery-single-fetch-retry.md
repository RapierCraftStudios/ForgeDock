---
issue: 5166
status: fresh
anchor: scripts/review-staging-post.sh
created: 2026-11-06
---

# 5166 — Review delivery lists comments once, retries, and separates an API error from an absence

**Context:** `review-staging-post.sh delivery` listed every PR comment once for the panel guard and once per launched reviewer. That is 1 + N paginated listings, which spend the shared GitHub budget. Any API error was swallowed into a count of 0. A transient 5xx, or listing lag after a burst of panel comments, made a reviewer that had posted look missing. The panel guard then labelled the PR `review-degraded` + `needs-human` and posted a review-panel-integrity gate failure, and the operator was told to re-dispatch. This was seen on AlterLab release reviews. A rerun a minute later passed.

**Decision:**
- Each attempt lists the comments once into `$SD/<PR>_delivery_comments.json`. Both the panel-guard domain count and the per-domain findings-block count read that file.
- An attempt counts as an API error unless gh exits 0 and every page is a JSON array.
- When a launched domain is missing, or the attempt errored, the script re-lists after each `FORGE_REVIEW_DELIVERY_RETRY_DELAYS` wait (seconds, default `5 15 45`, so at most 4 attempts). A found domain stays found, and each is printed with the attempt it was found on.
- The outcome follows the last attempt:
  - Every domain found: OK.
  - A successful listing that still lacks a domain: missing, with the existing gate failure, labels and exit 1.
  - An API error: `REVIEW DELIVERY UNVERIFIED`, exit 2, with no label and no post. `forgedock review-staging --finalize` tells the operator to rerun, not re-dispatch.

**Rejected:**
- Retrying each per-domain call on its own: that multiplies the listings.
- Treating any earlier lacking listing as proof of absence: that is the lag case itself. Only an up-to-date successful listing can justify the irreversible label and gate-failure post.

**Unchanged:** an empty or invalid launched list, `DISPATCH_FAILED` and an unresolvable head still fail closed with exit 1 and no retry loop.
