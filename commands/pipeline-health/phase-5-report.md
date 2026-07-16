---
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /pipeline-health — Phase 5: Report & Track

## Phase 5: Report & Track

### 5A: Post health report

Create a detailed health report as a GitHub issue in the Forge repo, routed through the
`/issue` programmatic create-hook (#2085) instead of a raw `gh issue create`. Because `/issue`'s
programmatic mode resolves `GH_REPO` from `forge.yaml → project.owner/repo` (via `$FORGE_CONFIG`,
default `forge.yaml`) with no explicit `-R` override, and `$FORGE_REPO` may differ from the
analyzed project's own repo (`forge.yaml → project.forge_repo`, see Config Resolution), point
`$FORGE_CONFIG` at a synthesized minimal config for the duration of the call so the create-hook
targets the Forge repo, not the analyzed repo:

```bash
FORGE_ISSUE_HOOK_CONFIG=$(mktemp)
cat > "$FORGE_ISSUE_HOOK_CONFIG" <<HOOKCFG_EOF
project:
  owner: "${FORGE_REPO%%/*}"
  repo: "${FORGE_REPO##*/}"
paths:
  root: "$FORGE_HOME"
HOOKCFG_EOF

HEALTH_BODY_FILE=$(mktemp)
cat > "$HEALTH_BODY_FILE" <<'EOF'
## Pipeline Health Report

**Project**: $REPO
**Period**: $SINCE → $(date +%Y-%m-%dT%H:%M:%SZ)
**Health Score**: [SCORE]/100 ([CATEGORY]) $SCORE_TREND

## Metrics

### Pre-Merge Quality

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Build pass rate (staging→main) | ?% | 95%+ | ✅/⚠️/❌ |
| Review findings per PR | ? | < 0.5 | ✅/⚠️/❌ |
| Manual fix-up rate | ?% | < 15% | ✅/⚠️/❌ |
| False positive rate | ?% | < 10% | ✅/⚠️/❌ |
| Pipeline self-correction rate | ?% | < 15% | ✅/⚠️/❌ |

### Post-Deploy Quality

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Post-deploy failure rate | ?% | < 5% | ✅/⚠️/❌ |
| Review escape rate (REVIEW_FALSE_NEG) | ?% | < 2% | ✅/⚠️/❌ |
| Mean time to detect | ? days | < 7 days | ✅/⚠️/❌ |
| Audit findings (total in window) | ? | — | ℹ️ |
| — by failure point | see breakdown | — | ℹ️ |

### Pipeline Health Signals

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Issue quality score | ?/100 | > 80 | ✅/⚠️/❌ |
| — Investigation invalidation rate | ?% | < 15% | ✅/⚠️/❌ |
| — ISSUE_SPEC audit findings | ? | 0 | ✅/⚠️/❌ |
| — Re-investigation rate | ? | 0 | ✅/⚠️/❌ |
| — Issue structure compliance | ?% | > 80% | ✅/⚠️/❌ |
| Investigation accuracy (trajectory) | ?% | > 85% | ✅/⚠️/❌ |
| Orchestration efficiency score | ?/100 | > 70 | ✅/⚠️/❌ |
| — Avg agent idle% | ?% | < 30% | ✅/⚠️/❌ |
| — Avg resume cycles per agent | ? | < 1 | ✅/⚠️/❌ |
| — Clean agent rate | ?% | > 60% | ✅/⚠️/❌ |
| — Batch stall rate | ?% (?/? issues) | < 10% | ✅/⚠️/❌ |
| — Escalated to needs-human | ? issues | 0 | ✅/⚠️/❌ |
| Original work ratio | ?% | > 70% | ✅/⚠️/❌ |
| Milestone merge success | ?% | 80%+ | ✅/⚠️/❌ |
| Issue close velocity | ? days | < 2 days | ✅/⚠️/❌ |
| Transcript health score (Phase 2N/2Q) | ?/100 $(_trend $TRANSCRIPT_HEALTH_SCORE $PRIOR_TRANSCRIPT_SCORE) | > 70 | ✅/⚠️/❌/ℹ️ |
| — Session flow flag | [✅ Healthy / ⚠️ flag / ℹ️ unavailable] | — | ℹ️ |
| — Aggregated session metrics (Phase 2Q) | [✅ Available / ℹ️ unavailable] | — | ℹ️ |
| Avg cost per issue (FORGE:DECISION_RECORD) | $? / ℹ️ unavailable | — | ℹ️ |

## Trajectory Analytics

_From Phase 2I — FORGE:TRAJECTORY comments on [N] closed issues in window_

| Metric | Value |
|--------|-------|
| Issues with trajectory data | ? / ? closed |
| Investigation accuracy | ?% (CONFIRMED: ?, PARTIAL: ?, INVALID: ?) |
| Task type distribution | Bug Fix: ?, Feature: ?, Refactor: ?, Maintenance: ? |
| Anomalies flagged | ? issues |
| Notable anomalies | [list top 3 or "None"] |

_If no trajectory data available in window: "No FORGE:TRAJECTORY comments found — pipeline may be running pre-trajectory version or window is too narrow."_

## Orchestration Efficiency

_From Phase 2K — persisted FORGE:AUDIT-AGENTS summaries ([N] sessions, [M] agents total) + FORGE:STALL_DETECTED annotations_

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Avg agent idle% | ?% | < 30% | ✅/⚠️/❌ |
| Avg resume cycles per agent | ? | < 1 | ✅/⚠️/❌ |
| Clean agent rate | ?% | > 60% | ✅/⚠️/❌ |
| Batch stall rate | ?% (?/? issues) | < 10% | ✅/⚠️/❌ |
| Escalated to needs-human | ? issues | 0 | ✅/⚠️/❌ |

**Top stall boundaries** (phase transitions causing the most stalls):
| Boundary | Occurrences |
|----------|-------------|
| [boundary_1] | [N] |
| [boundary_2] | [N] |
| [boundary_3] | [N] |

_If no FORGE:AUDIT-AGENTS data available: "No persisted audit-agents summaries found in window. Run \`audit-agents --persist\` after orchestration runs to enable this metric. Proxy: [N] issues had resume/stall anomalies in trajectory data."_

_Batch stall rate: sourced from \`FORGE:STALL_DETECTED\` comments (requires \`/orchestrate\` Step 4B.5 to be active). N/A if stall detector is not deployed._

## Transcript Flow Metrics

_From Phase 2N — JSONL transcript analytics ([N] pipeline sessions, [M] subagent sessions in window)_

| Metric | Value | Signal |
|--------|-------|--------|
| Pipeline sessions parsed | ? parent, ? subagent | ℹ️ |
| Total turns with timing | ? | ℹ️ |
| Avg turn duration | ?s | ℹ️ |
| Max turn duration | ?s | ℹ️ |
| Stall turns (>120s) | ? (?%) | ✅/⚠️ |
| Rate-limit indicator turns (60–120s) | ? | ℹ️ |
| Context compaction events | ? | ✅/⚠️ |
| Session flow flag | [✅ Healthy / ⚠️ High stall rate / ⚠️ Frequent compaction] | — |

**Top tools by call frequency**:
| Tool | Calls |
|------|-------|
| [tool_1] | [N] |
| [tool_2] | [N] |
| [tool_3] | [N] |

_If transcript data unavailable: "Transcript flow metrics unavailable — Phase 2M found no pipeline sessions in window (SESSION_TOTAL=0). Run `/pipeline-health` on the same machine where Claude Code sessions are stored."_

## Aggregated Session Metrics

_From Phase 2Q — privacy-safe aggregation of [N] pipeline sessions (session IDs excluded; structural data only)_

| Metric | Value (median) | Range [P25–P75] | Context |
|--------|---------------|-----------------|---------|
| Active compute time | ?s | [?s–?s] | Agent tool-call time only — excludes human idle. Target: — (baseline) |
| Context compaction events | ? | [?–?] | Per session. >2 median = prompts/diffs may be oversized |
| Sonnet / Opus split | ?% / ?% | — | Opus% = rate-limit fallback pressure |

**Tool call distribution** (top 5 tools, all sessions combined):
| Tool | Total Calls |
|------|-------------|
| [tool_1] | [N] |
| [tool_2] | [N] |
| [tool_3] | [N] |
| [tool_4] | [N] |
| [tool_5] | [N] |

**Active time by command type** (median):
| Command | Median duration | Range [P25–P75] | Sessions |
|---------|-----------------|-----------------|----------|
| [command_1] | ?s | [?s–?s] | ? |
| [command_2] | ?s | [?s–?s] | ? |

**Interpretation guardrails** (sourced from investigation #347):

> ⚠️ **Guard 1**: Duration shown is *agent compute time*, not wall-clock. Wall-clock varies 2–10x due to human idle. "Sessions are long" ≠ prompts are bad. Compare against the command-type median, not a global average.

> ⚠️ **Guard 2**: Tool call count is normalized per task type. A 15-file feature legitimately requires 200+ calls; a 1-file fix needs 30–50. Flag only if count per files-changed is ≥3× the command-type median.

> ⚠️ **Guard 3**: Skill invocation count reflects which pipeline commands ran — not whether they ran correctly. High skill count without checking workflow:* label progression is a false signal.

> ⚠️ **Guard 4**: Opus% is rate-limit pressure proxy — high opus% means fallback occurred, not that better models were chosen. Remedy: spread sessions across time or reduce prompt token usage.

> ⚠️ **Guard 5**: Compaction events indicate large context windows, not inefficiency. Flag only if median compaction_count > 2 AND correlated with review-finding quality degradation.

_If aggregated metrics unavailable: "Phase 2Q did not produce data — TRANSCRIPT_DATA_AVAILABLE=false or PER_SESSION_METRICS_RAW was empty. Run `/pipeline-health` on the machine where Claude Code sessions are stored."_

## Post-Deploy Failure Analysis

_From Phase 2L — \`audit-finding\` issues in the Forge repo ([N] findings in window)_

| Metric | Value | Target |
|--------|-------|--------|
| Post-deploy failure rate | ?% | < 5% |
| Review escape rate | ?% | < 2% |
| Mean time to detect | ? days | < 7 days |

**Failure point distribution** ([N] total audit findings):
| Failure Point | Count | % | Meaning |
|---------------|-------|---|---------|
| REVIEW_FALSE_NEG | ? | ?% | Review agent saw area but approved defect |
| IMPLEMENTATION | ? | ?% | Code written incorrectly |
| INVESTIGATION | ? | ?% | Wrong verdict or missed scope |
| DEPLOY_GATE | ? | ?% | Deploy-info missed risk signal |
| [other] | ? | ?% | — |

_If no audit findings in window: "No \`audit-finding\` issues in window — post-deploy failure rate = 0%."_

## Defect Category Breakdown

_Pre-merge review findings by agent prefix (from Phase 3A-I). Trends computed vs prior report #$PRIOR_NUMBER (or "—" if baseline run)._

| Category | Count | % of Total | Trend vs Prior Period |
|----------|-------|------------|---------------------|
| SEC | $COUNT_SEC | $(_pct $COUNT_SEC)% | $TREND_SEC |
| AUTH | $COUNT_AUTH | $(_pct $COUNT_AUTH)% | $TREND_AUTH |
| BILL | $COUNT_BILL | $(_pct $COUNT_BILL)% | $TREND_BILL |
| DB | $COUNT_DB | $(_pct $COUNT_DB)% | $TREND_DB |
| FE | $COUNT_FE | $(_pct $COUNT_FE)% | $TREND_FE |
| INFRA | $COUNT_INFRA | $(_pct $COUNT_INFRA)% | $TREND_INFRA |
| API | $COUNT_API | $(_pct $COUNT_API)% | $TREND_API |
| CONC | $COUNT_CONC | $(_pct $COUNT_CONC)% | $TREND_CONC |
| SCRP | $COUNT_SCRP | $(_pct $COUNT_SCRP)% | $TREND_SCRP |
| ISSUE_SPEC | $COUNT_ISSUE_SPEC | $(_pct $COUNT_ISSUE_SPEC)% | $TREND_ISSUE_SPEC |

_Post-deploy audit findings by failure point — see Phase 3A-II table above._

## Prompt Change Impact

[Analysis from Phase 3B]

## Top 3 Improvement Proposals

### 1. [Category] — [Proposal title]
**File**: `commands/[file].md`
**Change**: [Description]
**Expected impact**: [Metric] should improve by ~[X]%
**Risk**: [Low/Medium/High]

### 2. ...

### 3. ...

## Forge Commits in Window

[Git log from Phase 2A]
EOF

# Environment variable state is not guaranteed to persist across separate tool-call
# boundaries (a Bash call's shell state does not carry into the next Bash call, and the
# Skill tool has no env-passthrough parameter — it only accepts `skill`/`args`; `Skill`
# is a distinct tool invocation, not a bash subprocess, so an `export` in a prior Bash
# call cannot reach the nested /issue phases' own Bash calls at all). What DOES persist
# reliably across tool-call boundaries is the working directory (per the Bash tool's own
# contract) and the filesystem it points at. commands/issue.md Phase 1A resolves
# `CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"` — when `$FORGE_CONFIG` is unset (the normal
# case, since env vars do not propagate), it falls back to the literal relative path
# `forge.yaml`, which resolves against the current working directory. So instead of
# relying on env-var propagation, temporarily swap the on-disk `forge.yaml` at the repo
# root for the synthesized hook config, invoke /issue, then restore the original content —
# this is observed correctly by every nested Bash call regardless of tool-call boundaries.
FORGE_YAML_BACKUP=$(mktemp)
FORGE_YAML_EXISTED=false
[ -f forge.yaml ] && FORGE_YAML_EXISTED=true
cp forge.yaml "$FORGE_YAML_BACKUP" 2>/dev/null || true
# Restore helper: distinguishes "forge.yaml existed before the swap" (restore the backup)
# from "forge.yaml was absent before the swap" (remove the stub rather than leaving an
# empty file behind, which `mv`-ing an empty mktemp file would otherwise do).
restore_forge_yaml() {
  if [ "$FORGE_YAML_EXISTED" = "true" ]; then
    cp "$FORGE_YAML_BACKUP" forge.yaml 2>/dev/null || echo "ERROR: failed to restore forge.yaml from backup ${FORGE_YAML_BACKUP} — repo config may still be the synthesized Forge-repo stub. Restore manually before running any other command." >&2
  else
    rm -f forge.yaml 2>/dev/null || true
  fi
}
# Register the restore as a trap on EXIT (covers normal completion, an error inside the
# Skill(...) call, AND an unexpected early termination of this bash invocation) — not just
# the sequential "restore line after the Skill call" below, which would be skipped if this
# script/session terminates before reaching it. The trap is cleared right after the
# sequential restore succeeds, so it does not double-restore (harmless if it did, but
# avoids a redundant no-op restore on the normal path).
trap restore_forge_yaml EXIT
cp "$FORGE_ISSUE_HOOK_CONFIG" forge.yaml

ISSUE_RESULT=$(Skill(skill="issue", args="--title \"Pipeline Health: $REPO — $(date +%Y-%m-%d) — Score: [SCORE]/100\" --body-file $HEALTH_BODY_FILE --label health-report"))
echo "$ISSUE_RESULT"

# Restore the original forge.yaml immediately — so a subsequent Bash call in this same
# pipeline-health run (or any other command) does not keep reading the analyzed project's
# config as the Forge repo's synthesized hook config. The EXIT trap above is the backstop
# for abnormal termination; this is the normal-path restore, and clears the trap once done.
restore_forge_yaml
trap - EXIT

# Verify the issue actually landed in FORGE_REPO — if the forge.yaml swap above was not
# honored (e.g. some nested phase re-read a cached config from before the swap), the report
# would be mis-filed into the analyzed project's own GH_REPO instead of the Forge repo. Fail
# loudly rather than let a pipeline-health report silently spam the analyzed project's issue
# tracker.
if ! echo "$ISSUE_RESULT" | grep -q "github.com/${FORGE_REPO}/issues/"; then
  echo "ERROR: pipeline-health report was not created in FORGE_REPO ($FORGE_REPO) — verify the forge.yaml swap propagated to the /issue invocation above before proceeding."
fi

rm -f "$FORGE_ISSUE_HOOK_CONFIG" "$HEALTH_BODY_FILE"
```

The health report body above does not carry the `## Problem`/`## Affected Files`/`## Acceptance
Criteria` mandatory sections (it is a metrics report, not a pipeline work item) — `/issue`'s
Phase 3F pre-create validation auto-repairs this non-blockingly by appending placeholder
sections, exactly as it does for any other programmatic caller that omits them. This is expected
and does not indicate a problem with the report body.

### 5B: Create improvement issues in Forge

For each improvement proposal, create a trackable issue using the `/issue` structure.

**Before creating**: Read the target file (`commands/[file].md`) and verify that the section reference in the issue body is accurate — confirm the section heading and line range exist.

**Title format**: Use conventional commit prefix based on proposal type:
- Proposed fix for a broken behaviour → `fix([command]): [description]`
- New capability or enhancement → `feat([command]): [description]`
- Restructuring without behaviour change → `refactor([command]): [description]`

**Priority label**: Assign based on how far the metric deviates from its target:
- Metric ≥ 20% below target → `P1`
- Metric 10–20% below target → `P2`
- Metric < 10% below target → `P3`

Routed through the `/issue` programmatic create-hook (#2085), same as 5A — `$FORGE_REPO` may
differ from the analyzed repo's own `forge.yaml → project.owner/repo`, so `$FORGE_CONFIG` is
pointed at a synthesized minimal config for the duration of the call. This body already carries
all three mandatory sections (`## Problem`, `## Affected Files`, `## Acceptance Criteria`), so
Phase 3F's pre-create validation is expected to be a no-op here.

```bash
FORGE_ISSUE_HOOK_CONFIG=$(mktemp)
cat > "$FORGE_ISSUE_HOOK_CONFIG" <<HOOKCFG_EOF
project:
  owner: "${FORGE_REPO%%/*}"
  repo: "${FORGE_REPO##*/}"
paths:
  root: "$FORGE_HOME"
HOOKCFG_EOF

PROPOSAL_BODY_FILE=$(mktemp)
cat > "$PROPOSAL_BODY_FILE" <<'EOF'
## Problem

[1–3 sentences describing what the pipeline health metric reveals. Include the current value and target value.]

**Source**: Health report #[REPORT_NUMBER] — [metric]: [current value] (target: [target value])

## Root Cause (if known)

`commands/[file].md` [section] — [what the section currently does that causes the metric to suffer]

## Affected Files

Files that need changes:

1. `commands/[file].md` — [what needs to change in this file]

## Expected Behavior

After the fix, [metric] should reach [target value]. [Describe the concrete behaviour change in the command.]

## Acceptance Criteria

- [ ] [Specific, testable criterion tied to the metric]
- [ ] [Specific, testable criterion tied to the command behaviour]
- [ ] No regression in other pipeline-health metrics
EOF

# See the persistence note in 5A above — env vars do not cross tool-call boundaries, and
# the Skill tool is a distinct invocation, not a bash subprocess. Use the same
# working-directory-relative forge.yaml swap as 5A instead of relying on `export`. This is a
# separate bash invocation from 5A's, so the swap/restore/trap setup is repeated here rather
# than reused (shell functions and traps do not persist across separate tool-call boundaries
# any more than exported env vars do).
FORGE_YAML_BACKUP=$(mktemp)
FORGE_YAML_EXISTED=false
[ -f forge.yaml ] && FORGE_YAML_EXISTED=true
cp forge.yaml "$FORGE_YAML_BACKUP" 2>/dev/null || true
restore_forge_yaml() {
  if [ "$FORGE_YAML_EXISTED" = "true" ]; then
    cp "$FORGE_YAML_BACKUP" forge.yaml 2>/dev/null || echo "ERROR: failed to restore forge.yaml from backup ${FORGE_YAML_BACKUP} — repo config may still be the synthesized Forge-repo stub. Restore manually before running any other command." >&2
  else
    rm -f forge.yaml 2>/dev/null || true
  fi
}
# Same EXIT-trap backstop as 5A — restores forge.yaml even if the Skill(...) call errors or
# this bash invocation terminates early, not just on the normal sequential path below.
trap restore_forge_yaml EXIT
cp "$FORGE_ISSUE_HOOK_CONFIG" forge.yaml

ISSUE_RESULT=$(Skill(skill="issue", args="--title \"fix([command]): [description]\" --body-file $PROPOSAL_BODY_FILE --label \"[bug|enhancement|feature]\" --label \"[P1|P2|P3]\""))
echo "$ISSUE_RESULT"

# Restore the original forge.yaml immediately — same rationale as 5A. Clears the EXIT trap
# once the normal-path restore succeeds.
restore_forge_yaml
trap - EXIT

# Same wrong-repo safeguard as 5A — fail loudly instead of silently filing the improvement
# proposal into the analyzed project's own repo.
if ! echo "$ISSUE_RESULT" | grep -q "github.com/${FORGE_REPO}/issues/"; then
  echo "ERROR: pipeline-health proposal was not created in FORGE_REPO ($FORGE_REPO) — verify the forge.yaml swap propagated to the /issue invocation above before proceeding."
fi

rm -f "$FORGE_ISSUE_HOOK_CONFIG" "$PROPOSAL_BODY_FILE"
```

---

