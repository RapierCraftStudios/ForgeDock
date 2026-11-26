---
status: fresh
anchor: bin/lean/envgap.mjs
created: 2026-11-26
---

# #6106: environment gaps are env.* outcomes, not ci.red or human blocks

- `bin/lean/envgap.mjs`: `envGapBlockCode` maps a builder block typed `product-decision` or `credentials` whose text names a missing tool, binary, interpreter, lane-tools recipe, package or sandbox capability to `env.tool_missing` / `env.capability_remote`. Any human signal in the text (approval, spend, secret, token, customer, legal, pricing) keeps it human. `endBlocked` in lean.mjs applies it on every placement.
- A declared check that fails only because its tool is missing (the heavy shim's "PATH pass-through wrapper with no real binary", `command not found`) gets one dependency preparation and a rerun; if it still fails it ends `env.tool_missing`, never ci.red and no builder round. Before the checks run, package dirs they reference (`cd web`, `--prefix web`, `web/node_modules/.bin/..`) that have a package.json and no node_modules trigger the preparation.

# #6094: flaky unrelated test and the rerun rule

- `pool/image/mirror.sh`: a mirror is judged corrupt only by a process that holds the per-repo lock (`mirror_corrupt`, try-lock). An unlocked probe racing a build or fetch saw git's empty temp files, quarantined a healthy mirror and printed `direct` (and rebuilt it, a second build). In-flight `tmp_*` and `*.lock` files no longer count as zero-length objects. The regression test orders by lock, not time.
- lean.mjs pre-PR checks: a failing check whose output names test files none of which the diff touches (`failureOutsideDiff`) is rerun once before ci.red or a builder round. CI-side failures already got one rerun of the failed jobs per head (#4586).

# #6098: bounded, niced release-review panel

- `release-review.mjs`: `mapLimit` caps reviewers in flight at forge.yaml `review.max_parallel`, default max(2, cores/2); the rest queue. Reviewer processes are lowered to nice 19 and ionice idle on spawn (`lowerPriority`). Running the panel on a pool worker stays out of scope.

# #6055

Already merged to staging (PR #6071); this PR changes nothing for it.
