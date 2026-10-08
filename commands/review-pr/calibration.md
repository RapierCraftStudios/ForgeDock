---
description: review-pr fragment — Phase 7B.5 calibration threshold consultation (read by /review-pr when its trigger holds; not a user entrypoint)
user-invocable: false
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<!-- Fragment of commands/review-pr.md (forge#3405): read on demand, run exactly as if inline. -->

## Phase 7B.5: Calibration Threshold Consultation (Conditional) <!-- Added: forge#1741 -->

**Skip if**: `AUTO_MERGE=false` AND no calibration-based routing is needed (this phase is informational even when not auto-merging — run it to populate `CALIBRATION_NEEDS_HUMAN` for Phase 8).

**Purpose**: Read the confidence calibration table (published to the `forge-knowledge` branch by `scripts/calibration.mjs`) and check whether the current PR's task-type × confidence combination has a survival rate below the overconfidence threshold. If the table says HIGH-confidence in this task type has historically performed poorly (< 80% survival), route to needs-human regardless of the agent verdict.

**Fail-safe**: ANY error reading the calibration table (branch absent, file missing, JSON parse error, git failure) MUST result in `CALIBRATION_NEEDS_HUMAN=false` and the current static blocking criteria (Phase 7B verdict) remaining authoritative. The calibration table can ONLY tighten behavior (add needs-human); it NEVER loosens behavior below the current static baseline.

```bash
# Phase 7B.5: Calibration threshold consultation
CALIBRATION_NEEDS_HUMAN=false
CALIBRATION_CELL=""
CALIBRATION_NOTE=""

# Read task type from FORGE:INVESTIGATOR on the linked issue
# (MERGE_ISSUE is the issue number; passed from the merge-mode args)
ISSUE_NUMBER="${MERGE_ISSUE:-}"

if [ -n "$ISSUE_NUMBER" ]; then
  INVESTIGATOR_BODY=$(gh api "repos/{GH_REPO}/issues/${ISSUE_NUMBER}/comments" \
    --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body // ""' 2>/dev/null || echo '')
  TASK_TYPE=$(echo "$INVESTIGATOR_BODY" | sed -n 's/.*\*\*Task Type\*\*: //p' | head -1 | tr -d ' \r')
  CONFIDENCE=$(echo "$INVESTIGATOR_BODY" | sed -n 's/.*\*\*Confidence\*\*: //p' | head -1 | tr -d ' \r')
  echo "Phase 7B.5: task_type=${TASK_TYPE:-unknown} confidence=${CONFIDENCE:-unknown} (from issue #${ISSUE_NUMBER})"
fi

# Read calibration table from forge-knowledge branch (fail-safe: any error → skip)
if [ -n "${TASK_TYPE:-}" ] && [ -n "${CONFIDENCE:-}" ]; then
  CALIB_RAW=$(git show "origin/forge-knowledge:calibration/table.json" 2>/dev/null || echo '')

  if [ -n "$CALIB_RAW" ]; then
    # Look up the task-type × confidence cell
    CALIB_CELL=$(echo "$CALIB_RAW" | jq -r --arg tt "$TASK_TYPE" --arg c "$CONFIDENCE" \
      '.rows[] | select(.taskType == $tt and .confidence == $c and .trusted == true)' 2>/dev/null || echo '')

    if [ -n "$CALIB_CELL" ]; then
      SURVIVAL_RATE=$(echo "$CALIB_CELL" | jq -r '.survivalRate // "null"' 2>/dev/null || echo 'null')
      SAMPLE_COUNT=$(echo "$CALIB_CELL" | jq -r '.sampleCount // 0' 2>/dev/null || echo '0')
      CELL_FLAG=$(echo "$CALIB_CELL" | jq -r '.flag // "null"' 2>/dev/null || echo 'null')

      CALIBRATION_CELL="${TASK_TYPE} × ${CONFIDENCE}: survival=${SURVIVAL_RATE} (n=${SAMPLE_COUNT})"
      echo "Phase 7B.5: calibration cell found — ${CALIBRATION_CELL} flag=${CELL_FLAG}"

      # Check overconfidence threshold: HIGH confidence with survival < 0.8
      if [ "$CONFIDENCE" = "HIGH" ] && [ "$CELL_FLAG" = "overconfidence" ]; then
        CALIBRATION_NEEDS_HUMAN=true
        CALIBRATION_NOTE="Calibration table: ${TASK_TYPE} × HIGH confidence has ${SURVIVAL_RATE} survival rate (< 0.80 threshold, n=${SAMPLE_COUNT}). Routing to needs-human per forge#1741 policy."
        echo "Phase 7B.5: CALIBRATION_NEEDS_HUMAN=true — ${CALIBRATION_NOTE}"
      else
        CALIBRATION_NOTE="Calibration cell: ${CALIBRATION_CELL} — within acceptable threshold"
        echo "Phase 7B.5: CALIBRATION_NEEDS_HUMAN=false — ${CALIBRATION_NOTE}"
      fi
    else
      # Cell not found or not trusted (below min-samples) — static behavior applies
      CALIBRATION_NOTE="Calibration cell for ${TASK_TYPE} × ${CONFIDENCE} is absent or untrusted — using static behavior"
      echo "Phase 7B.5: no trusted cell — ${CALIBRATION_NOTE}"
    fi
  else
    CALIBRATION_NOTE="forge-knowledge:calibration/table.json not found — using static behavior"
    echo "Phase 7B.5: calibration table unavailable — ${CALIBRATION_NOTE}"
  fi
else
  CALIBRATION_NOTE="task type or confidence not resolved from FORGE:INVESTIGATOR — using static behavior"
  echo "Phase 7B.5: could not resolve task type/confidence — ${CALIBRATION_NOTE}"
fi

# Log threshold decision in TRAJECTORY (append to existing issue comment or note for Phase 6)
# This satisfies the acceptance criterion: "Threshold adjustments appear in TRAJECTORY with the cell that justified them"
if [ -n "$ISSUE_NUMBER" ] && [ "${DRY_RUN:-false}" != "true" ]; then
  gh issue comment "${ISSUE_NUMBER}" {MERGE_GH_FLAG} --body "<!-- FORGE:CALIBRATION_CHECK -->
**Phase 7B.5 — Calibration Threshold Check**
**Cell**: ${CALIBRATION_CELL:-not found}
**CALIBRATION_NEEDS_HUMAN**: ${CALIBRATION_NEEDS_HUMAN}
**Note**: ${CALIBRATION_NOTE}

**Phase 3B.5 — Provenance Trust Decision**
**Intensity tier**: ${INTENSITY_TIER:-SHADOW}
**Provenance cell**: \`${TABLE_CELL_KEY:-(unavailable)}\`
**Shadow mode**: ${TRUST_SHADOW_MODE:-true}
**TRUST_NEEDS_HUMAN**: ${TRUST_NEEDS_HUMAN:-false}
**Timestamp**: $(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || true
fi
```
