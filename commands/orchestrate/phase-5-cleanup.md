<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 5: Post-Batch Cleanup

## Phase 5: Post-Batch Cleanup

**This phase is MANDATORY after every orchestration batch.** It prevents the rot that accumulates when multiple agents merge PRs in parallel — stale labels, orphaned worktrees, unclosed issues.

### Step 5A: Run cleanup sweep

Invoke the `/cleanup` skill with `all` to sweep everything:

```
Skill(skill="cleanup", args="all")
```

This will:
- Fix stale workflow labels on any issues the agents left behind
- Close orphaned open issues whose PRs were merged (common when merging to `staging`)
- Remove worktrees created by agents in this batch
- Delete local/remote `fix/*` and `feat/*` branches whose PR has merged — detection uses merged-PR state (`gh pr list --state merged`) as the source of truth, so it covers feature-lane branches merged into a milestone branch as well as squash-merged branches, not just branches merged directly to staging
- Report milestones that hit 0 open issues — these are ready for `/milestone ship` (staging review + merge). Do NOT close them; closure happens after code reaches staging.
- Sync Project board state

### Step 5B: Run agent audit

Invoke `/audit-agents` on this session to measure pipeline efficiency:

```
Skill(skill="audit-agents", args="latest")
```

Include the audit summary in the final report (Phase 6). Key metrics to surface:
- **Avg idle%** — percentage of time agents spent stalled vs working
- **Resume cycles** — how many times agents had to be resumed
- **Stall boundaries** — which phase transitions cause the most stalls

### Step 5C: Report cleanup results

Include the cleanup summary in the final report (Phase 6). If cleanup found problems, call them out — they indicate agent pipeline failures that may need investigation.

---

