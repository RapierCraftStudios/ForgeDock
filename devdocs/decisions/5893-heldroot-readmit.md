# 5893: held needs-human root readmit

A batch root that ended `needs-human` was readmitted ~1 min after the block while the label was still on (AlterLab #40762: 31 cycles).

Behaviour now (`watchHeldRoots` in `bin/lean/orchestrate.mjs`):
- The label is read fresh (`issueLabels(root, {fresh:true})`), never from the memoized placement cache.
- The root is released only if the label is absent AND the latest `unlabeled needs-human` event post-dates the latest FORGE:NEEDS_HUMAN comment (`heldFacts` dep in `bin/engine-cli.mjs`). Unreadable events fail closed.
- The block signature (outcome code + FORGE:ASK key) and removal time are stored per root in batch state (`heldSigs`). An identical block is not released again without a newer removal event.
