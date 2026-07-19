---
install: core
---
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

### Step 5C: Close the coordination issue (claims board) <!-- Added: forge#2072 -->

**Why this step exists**: Step 3D.1 (`phase-3-dependency.md`) creates a per-batch coordination issue (the claims board) and exports `FORGE_COORD_ISSUE`/`COORD_ISSUE_NUMBER`. Step 5A's `/cleanup` sweep only closes orphaned issues whose PR merged — the claims board has no PR of its own, so that heuristic never matches it. Without this step, one `automation`-labelled issue leaks per orchestration batch.

**Run after Step 5B, before Step 5D.** No-ops cleanly if the claims board was never created this run (`COORD_ISSUE_NUMBER` unset/empty — e.g. Step 3D.1's `gh issue create` failed, or this batch never reached DAG construction). Tolerates GitHub API failures without aborting the rest of Phase 5 — the same tolerant-failure convention (`2>/dev/null || echo ...`, `|| true`) used throughout `phase-3-dependency.md`/`phase-4-execution.md`.

**Orchestrator lease should already be released by this point** (forge#2627): `phase-4-execution.md`'s Termination condition (end of Step 4B) calls `release_orchestrator_lease()` before handing off to Phase 5 on a normal drain, and the "Stopping the orchestrator" procedure (Step 4A-pre.-0.5) does the same on an interrupted exit. Closing the coordination issue here does not depend on lease state either way — an unreleased lease on an issue about to be closed is harmless (a future batch creates its own new coordination issue per Step 3D.1), but if `ACTIVE_CLAIMS_NOTE` logic is ever extended to also surface lease state, prefer checking for a still-unreleased `FORGE:LEASE` the same way `ACTIVE_CLAIMS` is computed above.

```bash
if [ -n "${COORD_ISSUE_NUMBER:-}" ]; then
  # Detect any still-active (unreleased) claims — a claim posted with no matching
  # CLAIM_RELEASED comment on the same coordination issue. Adapted from the query
  # phase-4-execution.md's claims-board relaxation sweep uses (Step 4B item 4),
  # simplified to holder-only (a flat string array) since Step 5C only needs
  # holder names for the closure note — unlike phase-4-execution.md's version,
  # which also captures each claim's `files` into an object alongside `holder`.
  ACTIVE_CLAIMS=$(gh api repos/{GH_REPO}/issues/${COORD_ISSUE_NUMBER}/comments \
    --jq '[.[] | select(.body | contains("<!-- FORGE:CLAIM -->")) |
           select(.body | contains("<!-- FORGE:CLAIM_RELEASED -->") | not)] |
          map(.body | capture("\\*\\*Holder\\*\\*: (?P<h>[^\\n]+)").h // "unknown")' 2>/dev/null || echo '[]')
  ACTIVE_CLAIMS_COUNT=$(echo "$ACTIVE_CLAIMS" | jq 'length' 2>/dev/null || echo 0)

  if [ "$ACTIVE_CLAIMS_COUNT" -gt 0 ] 2>/dev/null; then
    ACTIVE_CLAIMS_NOTE="**Still-active claims at close time** (${ACTIVE_CLAIMS_COUNT}) — not blocking closure, listed for visibility:
$(echo "$ACTIVE_CLAIMS" | jq -r '.[] | "- " + .' 2>/dev/null)"
  else
    ACTIVE_CLAIMS_NOTE="No active (unreleased) claims at close time."
  fi

  gh issue close "$COORD_ISSUE_NUMBER" -R {GH_REPO} --comment "Batch complete — closing claims board.

${ACTIVE_CLAIMS_NOTE}

Closed automatically by \`/orchestrate\` Phase 5 Step 5C." 2>/dev/null \
    && echo "Closed coordination issue #${COORD_ISSUE_NUMBER}" \
    || echo "WARNING: failed to close coordination issue #${COORD_ISSUE_NUMBER} — non-fatal, continuing Phase 5"
else
  echo "No coordination issue for this batch (FORGE_COORD_ISSUE unset) — Step 5C is a no-op"
fi
```

**Idempotency**: `gh issue close` on an already-closed issue succeeds as a no-op (no error) — safe to re-run this step on a resumed/compacted session without an extra pre-check.

### Step 5D: Report cleanup results

Include the cleanup summary in the final report (Phase 6), including whether the coordination issue was closed this run (see Step 5C). If cleanup found problems, call them out — they indicate agent pipeline failures that may need investigation.

---

