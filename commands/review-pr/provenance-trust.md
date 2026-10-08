---
description: review-pr fragment — Phase 3B.5 provenance-based trust escalation (read by /review-pr when its trigger holds; not a user entrypoint)
user-invocable: false
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<!-- Fragment of commands/review-pr.md (forge#3405): read on demand, run exactly as if inline. -->

### 3B.5: Provenance-Based Trust Escalation (Conditional)

**Skip if**: `THOROUGH=true` OR `IS_MILESTONE_TO_STAGING=true` — these modes already run full union dispatch; provenance de-escalation must not narrow an already-thorough review. This skip is enforced in code at the Step 4 application block (not merely relied upon via a downstream overwrite). <!-- forge#1804 -->


**Purpose**: Adjust the agent roster based on the PR's verifiable track record. Proven `(task-type × module-set)` combinations may drop optional judgment agents; novel combinations escalate to full panel plus `needs-human` on merge. The hard floor (Security agent + all Phase 2 automated checks) runs at every intensity tier, unconditionally.

**HARD FLOOR (non-negotiable)**: Security agent always stays in `SELECTED_AGENTS`. Phase 2 automated checks (linting, typecheck, secrets scan, SQL validation) run regardless of intensity tier. Trust only modulates optional LLM judgment breadth.

#### Step 1: Declare defaults (fail-safe initialization)

```bash
# Default: SHADOW — no roster change, log the decision only.
# This ensures that any error path (absent table, parse failure, git error)
# falls back to the current static behavior — never looser, never tighter.
INTENSITY_TIER="SHADOW"
TABLE_CELL_KEY="(unavailable)"
PROVENANCE_TABLE_LOADED=false
TRUST_SHADOW_MODE=$(yq '.review.trust_shadow_mode // "true"' "${FORGE_YAML:-forge.yaml}" 2>/dev/null || echo "true")
```

#### Step 2: Read provenance table from forge-knowledge branch

```bash
# Single bounded git-show read — no network round-trip if the branch is local.
# Fail-safe: any non-zero exit or parse error → PROVENANCE_JSON stays empty.
PROVENANCE_JSON=""
if git show-ref --quiet "refs/remotes/origin/forge-knowledge" 2>/dev/null || \
   git show-ref --quiet "refs/heads/forge-knowledge" 2>/dev/null; then
  PROVENANCE_JSON=$(git show "forge-knowledge:calibration/provenance.json" 2>/dev/null || \
                    git show "origin/forge-knowledge:calibration/provenance.json" 2>/dev/null || echo "")
fi

if [ -n "$PROVENANCE_JSON" ] && echo "$PROVENANCE_JSON" | jq -e '.rows' >/dev/null 2>&1; then
  PROVENANCE_TABLE_LOADED=true
  echo "=== PROVENANCE TABLE: loaded ($(echo "$PROVENANCE_JSON" | jq '.rows | length') cells) ==="
else
  echo "=== PROVENANCE TABLE: absent or invalid — intensity tier defaults to SHADOW (no roster change) ==="
fi
```

#### Step 3: Compute module key and look up cell

```bash
if [ "$PROVENANCE_TABLE_LOADED" = "true" ]; then
  # Normalize changed files to module key (mirrors normalizeModules() in calibration.mjs):
  # Take the top-level directory of each file; for two-level prefixes (services/*, apps/*,
  # packages/*, clients/*, sdk/*) include the second directory segment too.
  # Sort + deduplicate + join with "|".
  TWO_LEVEL="services apps packages clients sdk"
  RAW_PREFIXES=$(echo "$FILES" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    top=$(echo "$f" | cut -d/ -f1)
    second=$(echo "$f" | cut -d/ -f2)
    two_level_match=false
    for prefix in $TWO_LEVEL; do
      [ "$top" = "$prefix" ] && two_level_match=true && break
    done
    if [ "$two_level_match" = "true" ] && [ -n "$second" ]; then
      echo "${top}/${second}"
    else
      echo "$top"
    fi
  done | sort -u | tr '\n' '|' | sed 's/|$//')

  # Determine task type from FORGE:INVESTIGATOR annotation on the linked issue (if available)
  ISSUE_NUM_FOR_TRUST=$(gh pr view "$PR_NUMBER" -R "$REPO" --json body \
    --jq '.body | gsub("(?s).*?(?:Closes #|#)(?<n>[0-9]+).*"; "\(.n)") // ""' 2>/dev/null | head -1)
  TASK_TYPE_FOR_TRUST=""
  if [ -n "$ISSUE_NUM_FOR_TRUST" ]; then
    TASK_TYPE_FOR_TRUST=$(gh api "repos/${REPO}/issues/${ISSUE_NUM_FOR_TRUST}/comments" \
      --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR"))] | last | .body' 2>/dev/null \
      | grep -oP '(?<=\*\*Task Type\*\*: )[\w /]+' | head -1 | xargs || echo "")
  fi
  # Fall back to title-based inference if INVESTIGATOR comment absent
  if [ -z "$TASK_TYPE_FOR_TRUST" ]; then
    PR_TITLE=$(gh pr view "$PR_NUMBER" -R "$REPO" --json title --jq '.title' 2>/dev/null || echo "")
    case "$PR_TITLE" in
      fix*|Fix*)   TASK_TYPE_FOR_TRUST="Bug Fix" ;;
      feat*|Feat*) TASK_TYPE_FOR_TRUST="Feature" ;;
      refactor*)   TASK_TYPE_FOR_TRUST="Refactor" ;;
      docs*|chore*)TASK_TYPE_FOR_TRUST="Maintenance" ;;
      *)           TASK_TYPE_FOR_TRUST="Feature" ;;
    esac
  fi

  TABLE_CELL_KEY="${TASK_TYPE_FOR_TRUST}::${RAW_PREFIXES}"
  echo "=== PROVENANCE CELL KEY: ${TABLE_CELL_KEY} ==="

  # Look up the cell in the provenance table
  CELL_DATA=$(echo "$PROVENANCE_JSON" | jq -r \
    --arg key "$TABLE_CELL_KEY" \
    '.rows[] | select(.key == $key)' 2>/dev/null || echo "")

  if [ -z "$CELL_DATA" ]; then
    INTENSITY_TIER="NOVEL"
    echo "=== PROVENANCE: cell not found — NOVEL (no prior data for this task-type × module-set) ==="
  else
    CELL_TRUSTED=$(echo "$CELL_DATA" | jq -r '.trusted' 2>/dev/null || echo "false")
    CELL_TIER=$(echo "$CELL_DATA" | jq -r '.intensityTier' 2>/dev/null || echo "NOVEL")
    CELL_SURVIVAL=$(echo "$CELL_DATA" | jq -r '.survivalRate // "null"' 2>/dev/null || echo "null")
    CELL_SAMPLES=$(echo "$CELL_DATA" | jq -r '.sampleCount' 2>/dev/null || echo "0")

    if [ "$CELL_TRUSTED" = "true" ]; then
      INTENSITY_TIER="$CELL_TIER"
      echo "=== PROVENANCE: cell found (${CELL_SAMPLES} samples, survival ${CELL_SURVIVAL}) — tier: ${INTENSITY_TIER} ==="
    else
      INTENSITY_TIER="NOVEL"
      echo "=== PROVENANCE: cell found but not yet trusted (${CELL_SAMPLES} samples < min_samples) — tier: NOVEL ==="
    fi
  fi
fi
```

#### Step 4: Apply intensity tier (shadow-mode gated)

```bash
echo "=== TRUST_SHADOW_MODE: ${TRUST_SHADOW_MODE} ==="
echo "=== INTENSITY_TIER (pre-application): ${INTENSITY_TIER} ==="

# Explicit skip guard (enforces the "Skip if" prose above in code): in THOROUGH or
# milestone mode the full union dispatch is authoritative — provenance MUST NOT narrow
# the roster here. Enforcing it at the application point means correctness no longer
# depends on a downstream overwrite re-widening SELECTED_AGENTS. <!-- forge#1804 -->
if [ "$THOROUGH" = "true" ] || [ "$IS_MILESTONE_TO_STAGING" = "true" ]; then
  echo "=== TRUST ESCALATION: skipped (THOROUGH/milestone mode — full union dispatch is authoritative) ==="
# Shadow mode: log the decision but do NOT modify SELECTED_AGENTS.
# Set review.trust_shadow_mode: "false" in forge.yaml to enforce after the 30-day window.
elif [ "$TRUST_SHADOW_MODE" != "false" ]; then
  echo "=== TRUST ESCALATION: shadow-mode active — logging decision, roster unchanged ==="
  # SELECTED_AGENTS is NOT modified — current behavior preserved
else
  case "$INTENSITY_TIER" in
    PROVEN)
      # PROVEN tier: may drop optional judgment agents, but NEVER the hard floor.
      # The Security agent and any agents added by hard-signal escalation triggers
      # (SCORE_AUTH >= 3, SCORE_BILLING >= 3, SCORE_DATABASE >= 3, SCORE_INFRA >= 3)
      # are part of the floor — provenance trust MUST NOT remove them.
      #
      # Only agents added by the top-1/2-domain scoring (Step 1 baseline selection)
      # that are NOT flagged by a hard escalation trigger are eligible for removal.
      # For safety in the initial enforcement window, we only remove agents that
      # scored exactly 1 (informational — file-presence only) and were not triggered
      # by any cross-critical or churn escalation.
      FLOOR_AGENTS="Security"
      [ "$SCORE_AUTH"     -ge 3 ] && FLOOR_AGENTS="$FLOOR_AGENTS Auth"
      [ "$SCORE_BILLING"  -ge 3 ] && FLOOR_AGENTS="$FLOOR_AGENTS Billing Concurrency"
      [ "$SCORE_DATABASE" -ge 3 ] && FLOOR_AGENTS="$FLOOR_AGENTS Database"
      [ "$SCORE_INFRA"    -ge 3 ] && FLOOR_AGENTS="$FLOOR_AGENTS Infrastructure"
      [ "$CHURN_ESCALATION" = "true" ] && FLOOR_AGENTS="$FLOOR_AGENTS $TOP_CHURN_DOMAIN"
      # Deduplicate floor
      FLOOR_AGENTS=$(echo "$FLOOR_AGENTS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
      # PROVEN: keep only floor agents (drop optional judgment-only agents)
      SELECTED_AGENTS="$FLOOR_AGENTS"
      echo "=== TRUST ESCALATION: PROVEN — roster narrowed to floor: ${SELECTED_AGENTS} ==="
      ;;
    NOVEL|NOVEL_NEEDS_HUMAN)
      # NOVEL tier: escalate to full affected-domain panel (add all scored domains)
      for DOMAIN in AUTH BILLING CONCURRENCY DATABASE INFRA FRONTEND API; do
        SCORE_VAR="SCORE_${DOMAIN}"
        [ "${!SCORE_VAR:-0}" -gt 0 ] && add_agent "$DOMAIN"
      done
      SELECTED_AGENTS=$(echo "$SELECTED_AGENTS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
      echo "=== TRUST ESCALATION: ${INTENSITY_TIER} — roster widened to full panel: ${SELECTED_AGENTS} ==="
      if [ "$INTENSITY_TIER" = "NOVEL_NEEDS_HUMAN" ]; then
        echo "=== TRUST ESCALATION: NOVEL_NEEDS_HUMAN — needs-human will be added on merge ==="
        TRUST_NEEDS_HUMAN=true
      fi
      ;;
    SHADOW|*)
      # SHADOW or unknown: no change
      echo "=== TRUST ESCALATION: ${INTENSITY_TIER} — roster unchanged ==="
      ;;
  esac
fi

# Record TRUST_NEEDS_HUMAN default (set to false if not already set by NOVEL_NEEDS_HUMAN branch)
TRUST_NEEDS_HUMAN="${TRUST_NEEDS_HUMAN:-false}"

echo "=== FINAL ROSTER (after trust escalation): $SELECTED_AGENTS ==="
echo "=== INTENSITY_TIER: ${INTENSITY_TIER} | TABLE_CELL_KEY: ${TABLE_CELL_KEY} | SHADOW: ${TRUST_SHADOW_MODE} | NEEDS_HUMAN: ${TRUST_NEEDS_HUMAN} ==="
```

<!-- Added: forge#1745 -->

**Full union dispatch (THOROUGH=true or IS_MILESTONE_TO_STAGING=true):**

```bash
if [ "$THOROUGH" = "true" ] || [ "$IS_MILESTONE_TO_STAGING" = "true" ]; then
    SELECTED_AGENTS="Security"
    [ "$SCORE_AUTH" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Auth"
    [ "$SCORE_BILLING" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Billing Concurrency"
    [ "$SCORE_DATABASE" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Database"
    [ "$SCORE_INFRA" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Infrastructure"
    # Scraping agent only added in thorough mode when review.domains.scraping is configured
    SCRAPING_ENABLED=$(yq '.review.domains.scraping' "$FORGE_YAML" 2>/dev/null || echo "")
    [ "$SCORE_SCRAPING" -gt 0 ] && [ -n "$SCRAPING_ENABLED" ] && SELECTED_AGENTS="$SELECTED_AGENTS Scraping"
    [ "$SCORE_FRONTEND" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Frontend"
    [ "$SCORE_API" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS API"
    # Deduplicate
    SELECTED_AGENTS=$(echo "$SELECTED_AGENTS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
    echo "=== THOROUGH mode: FULL UNION DISPATCH — $SELECTED_AGENTS ==="
fi
```

**Why cross-critical domain pairs always escalate**: A 2-file PR touching both `services/api/app/core/auth.py` and `services/api/app/routers/billing.py` creates interaction bugs that single-domain reviewers cannot catch. Never rely on a single agent for multi-domain risk.

**General Security agent ALWAYS runs.** If BILLING is selected, Concurrency is always added. If SHARED module is touched, add agents for all importing services.
