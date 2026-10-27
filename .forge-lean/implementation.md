### Approach
The only requirement (R1) is post-deploy: a baseline run of `forgedock stats --compounding` against this repo and one other. The frozen contract has no deliverables, so there is no code or doc change.

### Changes
- None. The working tree is clean and no commit was made because there is nothing to commit.

### Acceptance Criteria Status
- R1: ❌ not met in this lane. It is a post-deploy item that the engine files as a tracked follow-up. No code is missing (`bin/stats/index.mjs:317`).

### Verification
- V1 `node --test bin/stats/compounding.test.mjs`: 7/7 pass. No new test was added, because no behaviour changed and a regression test would have nothing to fail against.
- `forgedock check`: PASS.

### Notes
No behaviour changes and no env vars.
