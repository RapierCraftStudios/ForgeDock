<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /pipeline-health — Phase 3: Analyze & Correlate

## Phase 3: Analyze & Correlate

### 3A: Defect category breakdown

**3A-I: Pre-merge defects** — Group review findings (from Phase 2B) by agent prefix.

First, count findings per category from the Phase 2B output:

```bash
# Count review findings per agent prefix (SEC, AUTH, BILL, DB, FE, INFRA, API, CONC, SCRP)
# These are the current-period counts to compare against PRIOR_* vars from Phase 1C
COUNT_SEC=$(echo "$FINDINGS_RAW" | grep -c '"SEC' || echo 0)
COUNT_AUTH=$(echo "$FINDINGS_RAW" | grep -c '"AUTH' || echo 0)
COUNT_BILL=$(echo "$FINDINGS_RAW" | grep -c '"BILL' || echo 0)
COUNT_DB=$(echo "$FINDINGS_RAW" | grep -c '"DB' || echo 0)
COUNT_FE=$(echo "$FINDINGS_RAW" | grep -c '"FE' || echo 0)
COUNT_INFRA=$(echo "$FINDINGS_RAW" | grep -c '"INFRA' || echo 0)
COUNT_API=$(echo "$FINDINGS_RAW" | grep -c '"API' || echo 0)
COUNT_CONC=$(echo "$FINDINGS_RAW" | grep -c '"CONC' || echo 0)
COUNT_SCRP=$(echo "$FINDINGS_RAW" | grep -c '"SCRP' || echo 0)
# ISSUE_SPEC from Phase 2L audit findings
COUNT_ISSUE_SPEC=$ISSUE_SPEC_COUNT

TOTAL_FINDINGS=$((COUNT_SEC + COUNT_AUTH + COUNT_BILL + COUNT_DB + COUNT_FE + COUNT_INFRA + COUNT_API + COUNT_CONC + COUNT_SCRP))

# Compute trend for each category using _trend helper from Phase 1C
TREND_SEC=$(       _trend "$COUNT_SEC"        "$PRIOR_SEC")
TREND_AUTH=$(      _trend "$COUNT_AUTH"       "$PRIOR_AUTH")
TREND_BILL=$(      _trend "$COUNT_BILL"       "$PRIOR_BILL")
TREND_DB=$(        _trend "$COUNT_DB"         "$PRIOR_DB")
TREND_FE=$(        _trend "$COUNT_FE"         "$PRIOR_FE")
TREND_INFRA=$(     _trend "$COUNT_INFRA"      "$PRIOR_INFRA")
TREND_API=$(       _trend "$COUNT_API"        "$PRIOR_API")
TREND_CONC=$(      _trend "$COUNT_CONC"       "$PRIOR_CONC")
TREND_SCRP=$(      _trend "$COUNT_SCRP"       "$PRIOR_SCRP")
TREND_ISSUE_SPEC=$(_trend "$COUNT_ISSUE_SPEC" "$PRIOR_ISSUE_SPEC")

_pct() { [ "$TOTAL_FINDINGS" -gt 0 ] && echo "scale=0; $1 * 100 / $TOTAL_FINDINGS" | bc || echo "0"; }
```

Then render the table using the computed values:

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

**If PRIOR_* vars are all empty (baseline run)**: all trend cells show "—" (no prior period to compare against).

**Note**: ISSUE_SPEC findings come from `/audit` (`audit-finding` label + body contains "ISSUE_SPEC"), not from review agents. They represent upstream failures — bad issue specs that the pipeline followed correctly but that produced wrong or wasted work.

**3A-II: Post-deploy defects** — Group audit findings (from Phase 2L) by failure point:

| Failure Point | Count | % of Total | Meaning |
|---------------|-------|------------|---------|
| INVESTIGATION | ? | ?% | Wrong verdict or missed scope — root cause misdiagnosed |
| IMPLEMENTATION | ? | ?% | Code written incorrectly or incompletely |
| REVIEW | ? | ?% | Review agents missed the issue or wrong agents triggered |
| REVIEW_FALSE_NEG | ? | ?% | Review agent saw area but approved a defect (escape signal) |
| QUALITY_GATE | ? | ?% | Static check should have caught this pattern but didn't |
| DEPLOY_GATE | ? | ?% | Deploy-info should have flagged risk but didn't |
| CONTEXT | ? | ?% | Missed relevant prior work or related code paths |
| ARCHITECT | ? | ?% | Missed code paths or wrong implementation plan |
| ORCHESTRATION | ? | ?% | Wave ordering wrong or dependency missed |
| ISSUE_SPEC | ? | ?% | Bad issue spec — pipeline followed it correctly, spec was wrong |
| OTHER | ? | ?% | Uncategorized or compound failure |

**Cross-signal analysis**: Compare 3A-I (pre-merge review findings) with 3A-II (post-deploy audit findings) to identify where the pipeline gates are misaligned. High REVIEW_FALSE_NEG in 3A-II with low REVIEW findings per PR in 3A-I suggests review agents are approving too liberally rather than finding real defects.

**Identify the top 3 defect categories across both tables.** These are where the builder/review is weakest and where pipeline improvements would have the highest ROI.

### 3B: Prompt change impact

For each Forge commit in the window:
1. What command was changed?
2. What was the intent? (read the commit message)
3. Did the target metric improve after this change?
   - If the change was to `review-pr-agents.md` → did false positive rate change?
   - If the change was to `work-on.md` Step 3G → did build failure rate change?
   - If the change was to `orchestrate.md` → did milestone merge success rate change?

**Caution**: Correlation ≠ causation. Note confounding factors (e.g., milestone size, new developers).

### 3C: Compute health score

```
Health Score = weighted average of:
  Pre-merge quality:
  - Build pass rate (staging→main):         weight 12%    target 95%+
  - Review findings per PR:                 weight 9%     target < 0.5
  - Manual fix-up rate:                     weight 8%     target < 15%
  - False positive rate:                    weight 6%     target < 10%
  - Pipeline self-correction rate:          weight 7%     target < 15%

  Post-deploy quality:
  - Post-deploy failure rate (Phase 2L):    weight 9%     target < 5%
  - Review escape rate (Phase 2L):          weight 9%     target < 2%

  Pipeline health signals:
  - Issue quality score (Phase 2J):         weight 8%     target > 80%
  - Investigation accuracy (Phase 2I):      weight 6%     target > 85%
  - Milestone merge success rate:           weight 6%     target 80%+
  - Orchestration efficiency (Phase 2K):    weight 5%     target score > 70
  - Original work ratio:                   weight 4%     target > 70%
  - Issue close velocity (days):            weight 1%     target < 2 days

  Transcript analytics (supplementary — Phase 2M–2Q):
  - Transcript health score (Phase 2N/2Q):  weight 10%    target > 70
```

**Total weight**: 12+9+8+6+7+9+9+8+6+6+5+4+1+10 = 100%.

**Post-deploy failure rate** (Phase 2L): scored as `max(0, 100 - (rate / 5%) * 100)` — i.e., 0% failure rate = 100 score, 5% failure rate = 0 score. If no audit findings exist in the window, score = 100.

**Review escape rate** (Phase 2L): scored as `max(0, 100 - (rate / 2%) * 100)` — i.e., 0% escape rate = 100 score, 2% escape rate = 0 score. If no REVIEW_FALSE_NEG findings exist, score = 100. This metric directly measures review agent effectiveness: a high escape rate with a low findings-per-PR rate indicates review agents are approving too liberally.

**Issue quality score** is computed from Phase 2J sub-metrics: invalidation rate (40%), ISSUE_SPEC findings (30%), re-investigation rate (20%), structure compliance (10%). A perfect score (100) requires: 0% invalidation, 0 ISSUE_SPEC audit findings, 0 re-investigations, 100% structure compliance.

**Investigation accuracy** comes from Phase 2I trajectory data: (CONFIRMED + PARTIAL) / total issues with trajectory comments. If no trajectory data is available in the window, omit this metric from the weighted average and redistribute its 7% proportionally across the other metrics.

**Orchestration efficiency score** is computed from Phase 2K metrics: avg idle% (40% weight — lower is better, 0% idle = 100 score), avg resumes per agent (35% weight — 0 resumes = 100, ≥2 resumes = 0), clean agent rate (25% weight — equals clean_rate%). If no persisted `FORGE:AUDIT-AGENTS` data is available in the window, omit this metric and redistribute its 5% proportionally across the remaining metrics.

**Transcript health score** (Phase 2N/2Q — supplementary signal, weight 10%): Computed from three Phase 2N/2Q output variables. If `TRANSCRIPT_DATA_AVAILABLE=false`, skip this metric and redistribute its 10% proportionally across the remaining metrics.

```bash
if [ "${TRANSCRIPT_DATA_AVAILABLE:-false}" = "true" ]; then
  # stall_rate_score: 0% stall rate = 100, 10%+ stall rate = 0
  # STALL_TURN_RATE is a percentage integer from Phase 2N (e.g., 5 for 5%)
  STALL_TURN_RATE=${STALL_TURN_RATE:-0}
  STALL_RATE_SCORE=$(echo "scale=0; r=$STALL_TURN_RATE; if(r>10) 0 else (10-r)*10" | bc 2>/dev/null || echo 0)

  # compaction_score: 0 compactions = 100, 5+ compactions = 0
  # COMPACTION_TOTAL is the total compaction events across all sessions from Phase 2N
  COMPACTION_TOTAL=${COMPACTION_TOTAL:-0}
  COMPACTION_SCORE=$(echo "scale=0; c=$COMPACTION_TOTAL; if(c>5) 0 else (5-c)*20" | bc 2>/dev/null || echo 0)

  # model_split_score: 0% opus = 100, 100% opus = 0
  # OPUS_PCT is derived from Phase 2Q's model_distribution output (integer 0-100)
  # If not set (Phase 2Q skipped), use 0 as conservative fallback
  OPUS_PCT=${OPUS_PCT:-0}
  MODEL_SPLIT_SCORE=$(echo "scale=0; 100 - $OPUS_PCT" | bc 2>/dev/null || echo 100)
  [ "$MODEL_SPLIT_SCORE" -lt 0 ] 2>/dev/null && MODEL_SPLIT_SCORE=0

  # Weighted composite: stall 50% + compaction 30% + model split 20%
  TRANSCRIPT_HEALTH_SCORE=$(echo "scale=0; ($STALL_RATE_SCORE * 50 + $COMPACTION_SCORE * 30 + $MODEL_SPLIT_SCORE * 20) / 100" | bc 2>/dev/null || echo 0)
  echo "Transcript health score: $TRANSCRIPT_HEALTH_SCORE/100 (stall_rate_score=$STALL_RATE_SCORE compaction_score=$COMPACTION_SCORE model_split_score=$MODEL_SPLIT_SCORE)"
  TRANSCRIPT_SCORE_AVAILABLE=true
else
  TRANSCRIPT_HEALTH_SCORE=""
  TRANSCRIPT_SCORE_AVAILABLE=false
  echo "Transcript health score: N/A (TRANSCRIPT_DATA_AVAILABLE=false — 10% weight redistributed proportionally)"
fi
```

**Transcript flow qualitative flags** (supplementary, appear in report alongside the numeric score):
- Stall turn rate > 10%: flag as ⚠️ `High stall rate — agents spending >10% of turns in long waits`
- Compaction events > 5 in window: flag as ⚠️ `Frequent context compaction — consider reducing prompt or tool output size`
- Stall turn rate ≤ 10% and compaction ≤ 5: flag as ✅ `Session flow healthy`
- Data not available: flag as ℹ️ `Transcript flow metrics unavailable (requires Phase 2M session data)`

**Aggregated session metrics** (Phase 2Q): If `$TRANSCRIPT_AGGREGATION_AVAILABLE` is true, embed `$AGGREGATED_TRANSCRIPT_METRICS` verbatim into the \"Aggregated Session Metrics\" section of the Phase 5A report. The guardrail footnotes (5 harmful-takeaway warnings from #347) MUST be included in that section even when session count is low — they protect against misreading the metrics table. If `TRANSCRIPT_AGGREGATION_AVAILABLE` is false, emit the unavailability note from Phase 2Q.

**Anomaly signal**: If Phase 2I anomaly rate exceeds 10% of issues, flag it as a warning in the health report even though it does not feed the score directly — high anomaly rates indicate pipeline instability not captured by outcome metrics.

Score 0-100. Categorize:
- 90-100: Excellent — pipeline is shipping clean code
- 70-89: Good — some defect categories need attention
- 50-69: Needs work — specific pipeline links are underperforming
- < 50: Critical — systemic issues in the pipeline

**Health score trend**: Compare the computed score against `$PRIOR_HEALTH_SCORE` from Phase 1C:

```bash
# Compute score trend string for report header
if [ -z "$PRIOR_HEALTH_SCORE" ]; then
    SCORE_TREND="(baseline — no prior period)"
elif [ "$HEALTH_SCORE" -gt "$PRIOR_HEALTH_SCORE" ] 2>/dev/null; then
    SCORE_TREND="(↑ from $PRIOR_HEALTH_SCORE — +$(( HEALTH_SCORE - PRIOR_HEALTH_SCORE )) pts)"
elif [ "$HEALTH_SCORE" -lt "$PRIOR_HEALTH_SCORE" ] 2>/dev/null; then
    SCORE_TREND="(↓ from $PRIOR_HEALTH_SCORE — -$(( PRIOR_HEALTH_SCORE - HEALTH_SCORE )) pts)"
else
    SCORE_TREND="(= unchanged from $PRIOR_HEALTH_SCORE)"
fi
echo "Health Score: $HEALTH_SCORE/100 $SCORE_TREND"
```

---

