# Phase: Close

Finalize a successfully merged issue. The host cleans the local worktree after
this session returns; do not remove the current directory yourself.

1. Resolve the merged PR for the builder branch and verify its merged base/head,
   merge commit, checks, and issue linkage. If no merged PR exists, add
   `needs-human` and stop without a success label.
2. If absent, post one concise trajectory annotation summarizing the durable
   run rather than replaying all prior comments:

```markdown
<!-- FORGE:TRAJECTORY -->
**Issue**: #<number>
**PR**: #<number>
**Outcome**: MERGED

## Problem and Root Cause
...

## Implementation
...

## Verification and Review
...

## Decisions and Follow-ups
...
```

3. Update any parent issue's child checkbox when the relationship is explicit.
   Do not infer a parent from unrelated references.
4. Add `workflow:merged`; remove `workflow:investigating`,
   `workflow:ready-to-build`, `workflow:building`, `workflow:in-review`,
   `workflow:invalid`, `workflow:decomposed`, `workflow:awaiting-merge`, and
   `needs-human`.
5. Close the issue and re-read it. The phase is complete only when the issue is
   closed and `workflow:merged` is present.
