<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 1: Resolve the Issue Set

## Phase 1: Resolve the Issue Set

Parse `$ARGUMENTS` to determine which issues to work on:

### Input Patterns

| Input | Resolution |
|-------|------------|
| `milestone <slug>` | All open issues assigned to that GitHub milestone (default repo) |
| `#1 #2 #3` or `1 2 3` | Specific issue numbers, optionally repo-prefixed (e.g., `#123 mcp:5 n8n:12`) |
| `next <N>` | Top N priority open issues (priority:P0 first, then priority:P1, etc.) |
| `next <N> all-repos` | Top N across ALL ecosystem repos |
| `fast-lane` or `fast` | All open fast-lane issues (no milestone, bugs/fixes) |
| `priority:P0` or `priority:P1` | All open issues with that priority label |
| `mcp:fast` or `n8n:next 3` | Repo-scoped queries |
| `<slug>` (no keyword) | Try milestone first, then fall back to label search |

### Fetch the issues

For each resolved repo, use the appropriate `-R` flag:

```bash
# Default repo (no flag needed if using GH_FLAG="" for the default):
gh issue list {GH_FLAG} --milestone "{TITLE}" --state open --limit 500 --json number,title,labels,milestone --jq '.[] | {number, title, labels: [.labels[].name], milestone: .milestone.title}'

# Satellite repos — always include -R flag with the satellite repo from forge.yaml:
# For each satellite in forge.yaml → repos.satellites:
gh issue list -R {SATELLITE_REPO} --milestone "{TITLE}" --state open --limit 500 --json number,title,labels,milestone

# For specific numbers with repo prefix:
gh issue view {NUMBER} -R {SATELLITE_REPO} --json number,title,labels,state,milestone,body

# For "all-repos" — fetch from all configured repos and combine:
gh issue list {GH_FLAG} --state open --limit {N} --json number,title,labels,milestone
# For each satellite in forge.yaml → repos.satellites:
gh issue list -R {SATELLITE_REPO} --state open --limit 500 --json number,title,labels,milestone
# Combine, sort by priority, take top N
```

**Count validation**: After fetching issues, log the count returned. If a milestone query returns exactly 30 issues, warn the user: "WARNING: Exactly 30 issues returned — gh CLI default may have truncated results. Re-running with --limit 500 is recommended." (The --limit 500 above prevents this for standard runs, but verify if the count seems suspiciously low relative to milestone expectations.)

**Tag each issue with its project prefix** in your internal tracking so sub-agents receive the correct repo context.

### Filter out ineligible issues

Remove issues that should NOT be worked on:
- Already closed or has `workflow:merged` label
- Has `workflow:invalid` label
- Has `needs-human` label (requires manual action)
- Has `workflow:decomposed` label (parent tracker — its sub-issues should be picked up instead)
- Has `workflow:building` or `workflow:in-review` label (already in progress)
- Is an epic (`epic` label) — these are planning containers, not buildable

If a `workflow:decomposed` issue is found, automatically expand it to its open sub-issues instead.

### P3 Review-Finding Batching (deterministic grouping rule)

<!-- Added: forge#1333 -->

Before finalizing the issue set, apply the P3 batching rule to reduce full-pipeline overhead on low-severity review findings.

**Trigger conditions** (BOTH must be true to batch):
1. The issue has labels `review-finding` + `priority:P3`
2. The issue has `<!-- FORGE:BATCHABLE -->` in its body

**Safety exclusions — NEVER batch** (override all trigger conditions):
- Issue body contains the word "security" or "billing" anywhere in the title or `## Problem` section
- Issue has a `security` label
- Issue has a `billing` label

**Grouping algorithm:**
```bash
# Fetch all open batchable P3 issues
BATCHABLE_P3=$(gh issue list {GH_FLAG} \
  --state open \
  --label "review-finding,priority:P3" \
  --limit 500 \
  --json number,title,body,labels \
  --jq '.[] | select(.body | test("<!-- FORGE:BATCHABLE -->"))
         | select((.title | test("security|billing"; "i")) | not)
         | select(.body | test("## Problem[\\s\\S]{0,500}(security|billing)"; "i") | not)
         | select(([.labels[].name] | any(. == "security" or . == "billing")) | not)')

# Group by domain (file-cluster derived from the affected file path in each issue body)
# Domain is the top-level directory of the first affected file listed under "## Affected Files"
# e.g., "services/api/auth/login.py" → domain "services/api/auth"
#        "web/src/app/billing/"     → EXCLUDED (billing path)
#        "commands/review-pr.md"    → domain "commands"
```

**Batch creation rule**: When 5+ batchable P3 issues share the same domain, OR when the oldest batchable P3 in a domain exceeds 72 hours, create a single batch issue grouping those issues:

```bash
BATCH_ISSUE_NUM=$(gh issue create {GH_FLAG} \
  --title "fix(batch): P3 review findings — {DOMAIN} domain (batch #{BATCH_N})" \
  --label "review-finding,priority:P3,batch" \
  --body "$(cat <<'BATCH_EOF'
## Problem

Batch of P3 review findings in the **{DOMAIN}** domain, grouped to reduce per-finding pipeline overhead.

## Member Findings

<!-- FORGE:BATCH_MEMBERS -->
{for each member issue: "- [ ] #{NUM}: {TITLE}"}
<!-- /FORGE:BATCH_MEMBERS -->

## Acceptance Criteria

- [ ] All member findings addressed or closed as false-positive
- [ ] Member issues auto-closed with reference to this batch PR on merge
- [ ] No security or billing paths touched (validated before batching)

## Context

**Batch policy**: 5+ open P3 findings in the same domain, or oldest > 72h.
**Member issues**: #{N1}, #{N2}, #{N3}, ...

<!-- FORGE:BATCHABLE -->
BATCH_EOF
)")
```

**Replace member issues with the batch issue** in the resolved issue set. Member issues are NOT individually dispatched to `/work-on` — the batch issue is the single pipeline unit.

**Important limits**:
- Max 10 members per batch issue — if more than 10 batchable P3s exist in a domain, create multiple batch issues of ≤ 10 each
- P1 and P2 issues are NEVER batched — they keep the standard one-issue-one-PR path
- Batch issues themselves are never nested inside other batch issues

If fewer than 5 batchable P3 findings exist in any domain AND none exceed 72h, skip batch creation entirely — individual P3s run through the standard pipeline.

### CRITICAL: No duplicate detection at orchestrator level

**The orchestrator NEVER closes, merges, or deduplicates issues.** Even if two issues look like duplicates (similar titles, same error message, same symptoms), they may target different code paths, different ORM objects, or different failure modes. Only a `/work-on` investigation agent — after reading the actual code — can determine whether an issue is truly a duplicate.

**What the orchestrator must NOT do:**
- Close an issue as "duplicate" based on title/symptom similarity
- Skip an issue because another issue "covers it"
- Merge two issues into one agent
- Make ANY judgment about issue validity

**What the orchestrator SHOULD do:**
- If two issues look related, add a note in the agent prompt: "Note: #{OTHER} has similar symptoms — investigate whether this is the same root cause or a different code path"
- Let both agents run independently — if one finds it's truly a duplicate, `/work-on`'s investigation phase will close it as invalid with evidence
- Flag potential overlap in the DAG plan for the user's awareness, but NEVER act on it

**Why**: Surface-level similarity hides critical differences. #3842 (api_key.id lazy load) and #4039 (user.id lazy load) had identical error messages but targeted completely different ORM objects. Closing #4039 as a "duplicate" would have left a customer-impacting P0 bug unfixed.

---

