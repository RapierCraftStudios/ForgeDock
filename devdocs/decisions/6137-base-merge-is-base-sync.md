# 6137: merging the base into the lane branch is base-sync, not a human gate

Decision: the builder prompt states that merging the base into the lane's own branch is the engine's base-sync. A `builder.blocked` (product-decision) whose only reason is such a merge (`baseMergeOnlyBlock` in `bin/lean/envgap.mjs`) ends `base.conflict`, which is recoverable and mechanical, so the recovery path base-syncs and resumes. Any other human signal (spend, credentials, PR merge, promotion, product choice) keeps the block human.

Why: a repo rule against agents merging (meant for PRs and protected branches) was read as forbidding the lane's own base-sync.
