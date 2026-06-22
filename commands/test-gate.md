---
description: Deterministic deploy-gate — verify a staging→main bundle's acceptance criteria against running code before deploy
argument-hint: [--prs "<N1 N2 ...>"] [--base <branch>]
allowed-tools: Task, Bash, Read, Grep, Glob
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /test-gate — Deterministic Deploy-Gate Testing

**Input**: `$ARGUMENTS` — optional `--prs "<space-separated PR numbers>"` and `--base <branch>`.

Verifies a staging→main bundle's acceptance criteria against running code before deploy. Called by `/review-pr-staging` (Phase 6.5) with the bundle PRs, or run standalone when `--prs` is absent (computes the bundle itself). Returns a machine-readable BLOCK / PASS / SKIP verdict for the caller to consume.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.

**Posture**: Blocking-with-override at the staging→main boundary (mirrors the Phase 0A open-finding gate in `/review-pr-staging`). Posture is config-driven via `verification.test_gate`.

---

## Config Resolution

Read `forge.yaml` **before** running any commands. All variable references below are populated from this block.

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
DEFAULT_BRANCH=$(yq '.branches.default' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging' "$CONFIG_FILE")

# Test-gate config (all fields optional — defaults shown)
INTEGRATION_TESTS=$(yq '.verification.integration_tests // []' "$CONFIG_FILE")
TEST_SERVICES=$(yq '.verification.test_services // {}' "$CONFIG_FILE")
GATE_POSTURE=$(yq '.verification.test_gate.posture // "blocking"' "$CONFIG_FILE")
OVERRIDE_PHRASE=$(yq '.verification.test_gate.override_phrase // "OVERRIDE: shipping with test failures —"' "$CONFIG_FILE")
```

---

## Input Parsing

```bash
BUNDLE_PRS=""
BASE_BRANCH="${DEFAULT_BRANCH}"

# Parse --prs and --base from $ARGUMENTS
while [[ "$@" ]]; do
  case "$1" in
    --prs)   shift; BUNDLE_PRS="$1";;
    --base)  shift; BASE_BRANCH="$1";;
  esac
  shift
done
```

If `--prs` is absent, Phase 0 computes the bundle.

---

## Missing-Config Guard (MANDATORY — runs before all phases)

```bash
# If integration_tests is empty/absent, exit ADVISORY — never crash
TEST_COUNT=$(yq '.verification.integration_tests | length' "$CONFIG_FILE" 2>/dev/null || echo 0)
if [ "${TEST_COUNT:-0}" -eq 0 ]; then
  echo "ADVISORY: verification.integration_tests is not configured in $CONFIG_FILE."
  echo "No tests to run. Emitting SKIP verdict."
  echo ""
  echo "To enable /test-gate, add to forge.yaml:"
  echo "  verification:"
  echo "    integration_tests:"
  echo "      - cluster: \"api\""
  echo "        command: \"pytest tests/integration/ -q --tb=short\""
  echo "        working_dir: \".\""
  echo "    test_services:"
  echo "      api: \"your-api-container-name\""
  echo "    test_gate:"
  echo "      posture: \"blocking\""
  echo "      override_phrase: \"OVERRIDE: shipping with test failures —\""
  # Emit structured SKIP verdict and exit
  echo "<!-- FORGE:TEST_GATE:RESULT=SKIP -->"
  exit 0
fi
```

---

## Phase 0: Triage — Test-or-Skip

**Purpose**: Intelligently decide whether this bundle needs runtime testing. Skip docs-only, config-only, or no-executable-change bundles to avoid unnecessary provisioning overhead.

<!-- EXPAND: This phase is intentionally minimal. A full triage heuristic (detecting docs-only bundles, no-executable-change patterns, etc.) is tracked as a dedicated sub-issue: #945. The current implementation applies a basic diff-based filter. -->

### 0A: Resolve bundle PRs

```bash
git fetch origin ${DEFAULT_BRANCH} ${STAGING_BRANCH} 2>/dev/null

if [ -n "$BUNDLE_PRS" ]; then
  # Caller passed PR numbers explicitly (standard case when invoked by review-pr-staging)
  echo "Bundle PRs (from --prs): $BUNDLE_PRS"
else
  # Standalone invocation: compute bundle from staging→main diff
  BUNDLE_PRS=$(git log origin/${DEFAULT_BRANCH}..origin/${STAGING_BRANCH} --merges --oneline \
    | grep -oP '(?<=pull request #)\d+' \
    | sort -u \
    | tr '\n' ' ')
  echo "Bundle PRs (computed from ${STAGING_BRANCH}→${DEFAULT_BRANCH}): $BUNDLE_PRS"
fi

if [ -z "$BUNDLE_PRS" ]; then
  echo "No PRs found in bundle. Emitting SKIP verdict."
  echo "<!-- FORGE:TEST_GATE:RESULT=SKIP -->"
  exit 0
fi
```

### 0B: Detect executable changes

```bash
BUNDLE_DIFF=$(git diff origin/${BASE_BRANCH}...origin/${STAGING_BRANCH} --name-only 2>/dev/null)

EXECUTABLE_FILES=$(echo "$BUNDLE_DIFF" | grep -vE '\.(md|txt|yaml|yml|json|toml|lock|ini|cfg|env\.example|gitignore)$' | grep -v '^docs/' | grep -v '^\.github/' || true)

if [ -z "$EXECUTABLE_FILES" ]; then
  echo "Bundle contains only documentation/config changes. No runtime testing required."
  echo "Files changed:"
  echo "$BUNDLE_DIFF"
  echo "RESULT: SKIP (no executable changes in bundle)"
  echo "<!-- FORGE:TEST_GATE:RESULT=SKIP -->"
  exit 0
fi

echo "Executable files changed in bundle:"
echo "$EXECUTABLE_FILES"
echo "Proceeding with runtime testing."
```

---

## Phase 1: Collate — Bundle PRs → Solved Issues → Acceptance Criteria

```bash
echo "=== Phase 1: Collating acceptance criteria from bundle ==="

COLLATED_CRITERIA=""
SOLVED_ISSUES=""

for pr_num in $BUNDLE_PRS; do
  # Get PR body to extract closing references
  PR_BODY=$(gh pr view "$pr_num" ${GH_FLAG} --json body --jq '.body' 2>/dev/null || echo "")

  # Extract issue numbers from Closes/Fixes references (case-insensitive)
  CLOSED_ISSUES=$(echo "$PR_BODY" | grep -iP '(closes|fixes|resolves)\s+#\d+' | grep -oP '#\d+' | tr -d '#' || true)

  # Also extract from linked issues via GitHub API
  LINKED_ISSUES=$(gh pr view "$pr_num" ${GH_FLAG} --json closingIssuesReferences \
    --jq '.closingIssuesReferences[].number' 2>/dev/null || true)

  ALL_ISSUES=$(echo "${CLOSED_ISSUES} ${LINKED_ISSUES}" | tr ' ' '\n' | sort -u | grep -E '^[0-9]+$' || true)

  for issue_num in $ALL_ISSUES; do
    SOLVED_ISSUES="${SOLVED_ISSUES} ${issue_num}"

    # Extract Acceptance Criteria section from issue body
    CRITERIA=$(gh issue view "$issue_num" ${GH_FLAG} --json body \
      --jq '.body' 2>/dev/null \
      | awk '/^## Acceptance Criteria/{found=1; next} /^## /{if(found) exit} found{print}' \
      | grep -E '^- \[' || true)

    if [ -n "$CRITERIA" ]; then
      COLLATED_CRITERIA="${COLLATED_CRITERIA}
### Issue #${issue_num} (PR #${pr_num})
${CRITERIA}"
    fi
  done
done

echo "Solved issues: $(echo $SOLVED_ISSUES | tr ' ' '\n' | sort -u | tr '\n' ' ')"
echo ""
echo "Collated Acceptance Criteria:"
echo "$COLLATED_CRITERIA"
```

---

## Phase 2: Classify — Bucket Criteria by Test Type

Bucket each acceptance criterion by `[type:api|unit|e2e|manual]` annotation. Regex fallback when unannotated.

```bash
echo "=== Phase 2: Classifying criteria by test type ==="

API_CRITERIA=""
UNIT_CRITERIA=""
E2E_CRITERIA=""
MANUAL_CRITERIA=""
UNCLASSIFIED=""

while IFS= read -r line; do
  if echo "$line" | grep -qP '\[type:api\]'; then
    API_CRITERIA="${API_CRITERIA}\n${line}"
  elif echo "$line" | grep -qP '\[type:unit\]'; then
    UNIT_CRITERIA="${UNIT_CRITERIA}\n${line}"
  elif echo "$line" | grep -qP '\[type:e2e\]'; then
    E2E_CRITERIA="${E2E_CRITERIA}\n${line}"
  elif echo "$line" | grep -qP '\[type:manual\]'; then
    MANUAL_CRITERIA="${MANUAL_CRITERIA}\n${line}"
  elif echo "$line" | grep -qP '(endpoint|request|response|status\s+\d{3}|curl|API|HTTP)'; then
    API_CRITERIA="${API_CRITERIA}\n${line} [inferred:api]"
  elif echo "$line" | grep -qP '(unit|function|return|assert|throws)'; then
    UNIT_CRITERIA="${UNIT_CRITERIA}\n${line} [inferred:unit]"
  elif echo "$line" | grep -qP '(browser|click|navigate|render|page|user flow)'; then
    E2E_CRITERIA="${E2E_CRITERIA}\n${line} [inferred:e2e]"
  elif echo "$line" | grep -qP '^-\s+\['; then
    # Has content but no type signal — treat as manual
    MANUAL_CRITERIA="${MANUAL_CRITERIA}\n${line} [inferred:manual]"
  fi
done <<< "$(echo -e "$COLLATED_CRITERIA")"

echo "API criteria:    $(echo -e "$API_CRITERIA" | grep -c '^\-' || echo 0)"
echo "Unit criteria:   $(echo -e "$UNIT_CRITERIA" | grep -c '^\-' || echo 0)"
echo "E2E criteria:    $(echo -e "$E2E_CRITERIA" | grep -c '^\-' || echo 0)"
echo "Manual criteria: $(echo -e "$MANUAL_CRITERIA" | grep -c '^\-' || echo 0)"

AUTOMATED_CRITERIA="${API_CRITERIA}${UNIT_CRITERIA}${E2E_CRITERIA}"
if [ -z "$(echo -e "$AUTOMATED_CRITERIA" | grep -E '^-')" ]; then
  echo "All criteria are manual — no automated test clusters to run."
  echo "Emitting SKIP verdict (manual-only bundle)."
  echo "<!-- FORGE:TEST_GATE:RESULT=SKIP -->"
  exit 0
fi
```

---

## Phase 3: Provision — Bring Up Test Services

For each cluster in `verification.integration_tests`, verify the mapped container is running. CLI-only projects (no `test_services` mapping) skip this phase.

```bash
echo "=== Phase 3: Provisioning test services ==="

PROVISION_FAILURES=""
CLUSTERS=$(yq '.verification.integration_tests[].cluster' "$CONFIG_FILE" 2>/dev/null | sort -u)

for cluster in $CLUSTERS; do
  # Look up container name for this cluster
  CONTAINER=$(yq ".verification.test_services.${cluster} // \"\"" "$CONFIG_FILE" 2>/dev/null || echo "")

  if [ -z "$CONTAINER" ] || [ "$CONTAINER" = "null" ]; then
    echo "ADVISORY: No container mapped for cluster '${cluster}' in verification.test_services."
    echo "  Running in CLI-only mode — skipping container health check for '${cluster}'."
    continue
  fi

  # Check if container is running
  CONTAINER_STATE=$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo "false")
  if [ "$CONTAINER_STATE" != "true" ]; then
    echo "WARNING: Container '${CONTAINER}' (cluster: ${cluster}) is not running."
    PROVISION_FAILURES="${PROVISION_FAILURES}\n- Cluster '${cluster}': container '${CONTAINER}' not running"
  else
    echo "OK: Container '${CONTAINER}' (cluster: ${cluster}) is healthy."
  fi
done

if [ -n "$PROVISION_FAILURES" ]; then
  echo ""
  echo "Provision warnings (advisory — continuing with available clusters):"
  echo -e "$PROVISION_FAILURES"
fi
```

---

## Phase 4: Fan Out — Execute Test Clusters

Spawn a narrow-band test subagent per cluster. Each executes its configured command and captures pass/fail output. Flaky-retry: up to 2 retries per cluster on non-deterministic failures.

```bash
echo "=== Phase 4: Fanning out test clusters ==="

CLUSTER_RESULTS=""
CLUSTER_COUNT=$(yq '.verification.integration_tests | length' "$CONFIG_FILE" 2>/dev/null || echo 0)

for i in $(seq 0 $((CLUSTER_COUNT - 1))); do
  CLUSTER=$(yq ".verification.integration_tests[${i}].cluster" "$CONFIG_FILE")
  CMD=$(yq ".verification.integration_tests[${i}].command" "$CONFIG_FILE")
  WORKING_DIR=$(yq ".verification.integration_tests[${i}].working_dir // \".\"" "$CONFIG_FILE")

  echo "Running cluster '${CLUSTER}': ${CMD}"

  RETRY=0
  MAX_RETRIES=2
  CLUSTER_EXIT=1

  while [ $RETRY -le $MAX_RETRIES ]; do
    if (cd "${REPO_PATH}/${WORKING_DIR}" && eval "$CMD") 2>&1; then
      CLUSTER_EXIT=0
      break
    else
      CLUSTER_EXIT=$?
      RETRY=$((RETRY + 1))
      if [ $RETRY -le $MAX_RETRIES ]; then
        echo "  Cluster '${CLUSTER}' failed (exit ${CLUSTER_EXIT}) — retry ${RETRY}/${MAX_RETRIES}..."
      fi
    fi
  done

  if [ "$CLUSTER_EXIT" -eq 0 ]; then
    CLUSTER_RESULTS="${CLUSTER_RESULTS}\n- ${CLUSTER}: PASS"
    echo "  PASS: cluster '${CLUSTER}'"
  else
    CLUSTER_RESULTS="${CLUSTER_RESULTS}\n- ${CLUSTER}: FAIL (after ${MAX_RETRIES} retries)"
    echo "  FAIL: cluster '${CLUSTER}'"
  fi
done

echo ""
echo "Cluster results:"
echo -e "$CLUSTER_RESULTS"
```

---

## Phase 5: Baseline Comparison + Test-Failure Issue Creation

Capture a pre-batch baseline from the base branch (or previous run) to distinguish batch-introduced failures from pre-existing ones. File `test-failure` issues for batch-introduced failures only.

### 5A: Capture baseline

```bash
echo "=== Phase 5A: Capturing baseline from base branch (${BASE_BRANCH}) ==="

BASELINE_RESULTS=""

# Run the same tests against the base branch state to establish baseline
# If base-branch tests also fail, those are pre-existing failures — not batch-introduced
git stash 2>/dev/null || true
git checkout "origin/${BASE_BRANCH}" -- . 2>/dev/null || true

for i in $(seq 0 $((CLUSTER_COUNT - 1))); do
  CLUSTER=$(yq ".verification.integration_tests[${i}].cluster" "$CONFIG_FILE")
  CMD=$(yq ".verification.integration_tests[${i}].command" "$CONFIG_FILE")
  WORKING_DIR=$(yq ".verification.integration_tests[${i}].working_dir // \".\"" "$CONFIG_FILE")

  if (cd "${REPO_PATH}/${WORKING_DIR}" && eval "$CMD") 2>&1; then
    BASELINE_RESULTS="${BASELINE_RESULTS}\n- ${CLUSTER}: PASS"
  else
    BASELINE_RESULTS="${BASELINE_RESULTS}\n- ${CLUSTER}: FAIL (pre-existing)"
  fi
done

# Restore working state
git checkout HEAD -- . 2>/dev/null || true

echo "Baseline results:"
echo -e "$BASELINE_RESULTS"
```

### 5B: Identify batch-introduced failures

```bash
echo "=== Phase 5B: Identifying batch-introduced failures ==="

BATCH_FAILURES=""

while IFS= read -r result_line; do
  CLUSTER=$(echo "$result_line" | grep -oP '^- \K[^:]+')
  STATUS=$(echo "$result_line" | grep -oP ':\s+\K.+')

  if echo "$STATUS" | grep -q "^FAIL"; then
    # Check if this cluster also failed in baseline
    BASELINE_STATUS=$(echo -e "$BASELINE_RESULTS" | grep "^- ${CLUSTER}:" | grep -oP ':\s+\K.+' || echo "PASS")
    if echo "$BASELINE_STATUS" | grep -q "^PASS"; then
      # This cluster passed in baseline but fails in the bundle — batch-introduced failure
      BATCH_FAILURES="${BATCH_FAILURES}\n${CLUSTER}"
      echo "BATCH-INTRODUCED FAILURE: cluster '${CLUSTER}' (baseline: PASS → bundle: FAIL)"
    else
      echo "PRE-EXISTING FAILURE: cluster '${CLUSTER}' (baseline: FAIL → bundle: FAIL — not this batch)"
    fi
  fi
done <<< "$(echo -e "$CLUSTER_RESULTS")"
```

### 5C: File test-failure issues for batch-introduced failures

```bash
echo "=== Phase 5C: Filing test-failure issues ==="

if [ -z "$(echo -e "$BATCH_FAILURES" | grep -E '\S')" ]; then
  echo "No batch-introduced failures — skipping issue creation."
else
  # Ensure test-failure label exists
  gh label create "test-failure" --color "B60205" \
    --description "Runtime test failure introduced by a bundle of PRs. Managed by ForgeDock." \
    --force ${GH_FLAG} 2>/dev/null || true

  while IFS= read -r cluster; do
    [ -z "$cluster" ] && continue

    # Duplicate prevention: check for open test-failure issues for this cluster
    EXISTING=$(gh issue list ${GH_FLAG} \
      --label "test-failure" \
      --state open \
      --search "test-gate cluster ${cluster}" \
      --limit 5 \
      --json number,title \
      --jq '.[0].number // empty' 2>/dev/null || true)

    if [ -n "$EXISTING" ]; then
      echo "Skipping issue creation — open test-failure issue already exists: #${EXISTING} (cluster: ${cluster})"
      continue
    fi

    # Identify source issues for this cluster's PRs
    SOURCE_ISSUES_LIST=""
    for issue_num in $(echo "$SOLVED_ISSUES" | tr ' ' '\n' | sort -u | grep -E '^[0-9]+$'); do
      SOURCE_ISSUES_LIST="${SOURCE_ISSUES_LIST}\n- #${issue_num}"
    done

    ISSUE_NUM=$(gh issue create ${GH_FLAG} \
      --title "fix: test-gate FAIL — cluster '${cluster}' broken by staging→${DEFAULT_BRANCH} bundle" \
      --label "test-failure,priority:P1" \
      --body "$(cat <<ISSUE_EOF
## Problem

The \`/test-gate\` command detected a runtime failure in cluster \`${cluster}\` that was introduced by the staging→${DEFAULT_BRANCH} bundle. The failure did not exist on \`${BASE_BRANCH}\` (baseline PASS), confirming it is batch-introduced, not pre-existing.

## Root Cause (if known)

Root cause unknown — investigation needed. The test command for cluster \`${cluster}\` failed after 2 retries.

## Affected Files

Files to be identified during investigation. Start with changes in the bundle PRs: $(echo $BUNDLE_PRS | tr ' ' ', ' | sed 's/,\s*$//').

## Acceptance Criteria

- [ ] Root cause of cluster \`${cluster}\` failure identified
- [ ] Fix implemented and cluster passes in isolation
- [ ] Baseline comparison confirms no regression in \`${BASE_BRANCH}\`
- [ ] /test-gate emits PASS verdict for this bundle after fix

## Context

**Detected by**: \`/test-gate\` — Phase 5 baseline comparison
**Bundle PRs**: ${BUNDLE_PRS}
**Base branch**: \`${BASE_BRANCH}\`
**Cluster**: \`${cluster}\`
**Baseline result**: PASS (cluster was healthy on \`${BASE_BRANCH}\`)
**Bundle result**: FAIL (cluster broken after applying bundle)

## Source Issues

The following issues were solved by this bundle:
$(echo -e "$SOURCE_ISSUES_LIST")

## Reproduction Steps

1. Check out \`origin/${STAGING_BRANCH}\`
2. Run the cluster test command from \`forge.yaml\`:
   \`\`\`bash
   $(yq ".verification.integration_tests[] | select(.cluster == \"${cluster}\") | .command" "$CONFIG_FILE")
   \`\`\`
3. Observe failure. Compare against \`${BASE_BRANCH}\` baseline:
   \`\`\`bash
   git checkout origin/${BASE_BRANCH} -- .
   $(yq ".verification.integration_tests[] | select(.cluster == \"${cluster}\") | .command" "$CONFIG_FILE")
   \`\`\`
ISSUE_EOF
)" --json number --jq '.number' 2>/dev/null || echo "FAILED")

    if [ "$ISSUE_NUM" != "FAILED" ] && [ -n "$ISSUE_NUM" ]; then
      echo "Filed test-failure issue #${ISSUE_NUM} for cluster '${cluster}'"
    else
      echo "WARNING: Failed to create test-failure issue for cluster '${cluster}'"
    fi
  done <<< "$(echo -e "$BATCH_FAILURES")"
fi
```

---

## Phase 6: Criteria-Adequacy Check

Reconcile the executed test plan against each solved issue's acceptance criteria. Flag uncovered or untestable criteria so coverage gaps cannot masquerade as passes.

<!-- EXPAND: Full criteria-adequacy logic (mapping individual acceptance criteria to executed test clusters, detecting uncovered criteria, and surfacing coverage gaps) is tracked as a dedicated sub-issue: #946. The current implementation produces a coverage summary report. -->

```bash
echo "=== Phase 6: Criteria-adequacy check ==="

COVERED_CRITERIA=0
UNCOVERED_CRITERIA=0
MANUAL_CRITERIA_COUNT=$(echo -e "$MANUAL_CRITERIA" | grep -c '^-' || echo 0)
AUTOMATED_CRITERIA_COUNT=$(echo -e "$AUTOMATED_CRITERIA" | grep -c '^-' || echo 0)

echo "Criteria coverage summary:"
echo "  Automated criteria: ${AUTOMATED_CRITERIA_COUNT} (api + unit + e2e)"
echo "  Manual criteria:    ${MANUAL_CRITERIA_COUNT} (require human validation)"

if [ "${AUTOMATED_CRITERIA_COUNT}" -gt 0 ]; then
  # Check whether any cluster actually ran
  PASSED_CLUSTERS=$(echo -e "$CLUSTER_RESULTS" | grep "PASS" | wc -l || echo 0)
  if [ "${PASSED_CLUSTERS}" -gt 0 ]; then
    COVERED_CRITERIA="${AUTOMATED_CRITERIA_COUNT}"
    echo "  Coverage: ${COVERED_CRITERIA}/${AUTOMATED_CRITERIA_COUNT} automated criteria exercised by passing clusters"
  else
    UNCOVERED_CRITERIA="${AUTOMATED_CRITERIA_COUNT}"
    echo "  Coverage gap: ${UNCOVERED_CRITERIA}/${AUTOMATED_CRITERIA_COUNT} automated criteria were NOT covered (all clusters failed)"
  fi
fi

if [ "${MANUAL_CRITERIA_COUNT}" -gt 0 ]; then
  echo ""
  echo "NOTE: ${MANUAL_CRITERIA_COUNT} manual criteria require human validation and are not covered by /test-gate."
  echo "These are not counted as failures — they must be validated out-of-band."
fi
```

---

## Phase 7: Verdict — Emit Machine-Readable Result

Determine BLOCK / PASS / SKIP based on batch-introduced failures, cluster results, and posture config.

```bash
echo "=== Phase 7: Emitting verdict ==="

BATCH_FAILURE_COUNT=$(echo -e "$BATCH_FAILURES" | grep -c '\S' || echo 0)
TOTAL_PASS=$(echo -e "$CLUSTER_RESULTS" | grep -c "PASS" || echo 0)
TOTAL_FAIL=$(echo -e "$CLUSTER_RESULTS" | grep -c "FAIL" || echo 0)

if [ "${BATCH_FAILURE_COUNT}" -gt 0 ]; then
  VERDICT="BLOCK"
  VERDICT_REASON="${BATCH_FAILURE_COUNT} cluster(s) failed with batch-introduced regressions: $(echo -e "$BATCH_FAILURES" | tr '\n' ', ' | sed 's/,\s*$//')"
elif [ "${TOTAL_FAIL}" -gt 0 ]; then
  # All failures are pre-existing (baseline also failed) — not blocking
  VERDICT="PASS"
  VERDICT_REASON="${TOTAL_FAIL} pre-existing failure(s) detected (also failed on ${BASE_BRANCH} baseline — not introduced by this batch). ${TOTAL_PASS} cluster(s) passed."
else
  VERDICT="PASS"
  VERDICT_REASON="All ${TOTAL_PASS} cluster(s) passed. No batch-introduced failures."
fi

echo ""
echo "============================================="
echo " TEST GATE VERDICT: ${VERDICT}"
echo "============================================="
echo " Reason: ${VERDICT_REASON}"
echo " Posture: ${GATE_POSTURE}"
echo " Bundle PRs: ${BUNDLE_PRS}"
echo " Solved issues: $(echo $SOLVED_ISSUES | tr ' ' '\n' | sort -u | tr '\n' ' ')"
echo ""
echo "Cluster summary:"
echo -e "$CLUSTER_RESULTS"
echo "============================================="

# Emit machine-readable verdict marker (consumed by review-pr-staging Phase 6.5)
echo ""
echo "<!-- FORGE:TEST_GATE:RESULT=${VERDICT} -->"

# Handle BLOCK verdict according to posture
if [ "$VERDICT" = "BLOCK" ]; then
  if [ "$GATE_POSTURE" = "advisory" ]; then
    echo ""
    echo "ADVISORY posture: BLOCK verdict surfaced but deploy is NOT prevented."
    echo "Switch to posture: blocking in forge.yaml to make this gate enforce."
    echo ""
    echo "TEST GATE: ADVISORY BLOCK"
  else
    # blocking posture (default)
    echo ""
    echo "BLOCKING posture: Deploy is prevented. To override, post a PR comment containing:"
    echo "  ${OVERRIDE_PHRASE} <reason>"
    echo ""
    echo "TEST GATE: BLOCK DEPLOY"
    exit 1
  fi
else
  echo ""
  echo "TEST GATE: ${VERDICT}"
fi
```

---

## Override Escape Hatch

When a PR comment containing `verification.test_gate.override_phrase` (default: `OVERRIDE: shipping with test failures —`) is detected on the staging→main PR, the BLOCK verdict is downgraded and the deploy proceeds. Override detection is performed by the caller (`/review-pr-staging` Phase 6.5) using:

```bash
OVERRIDE=$(gh pr view "$PR_NUMBER" ${GH_FLAG} \
  --json comments \
  --jq "[.comments[].body | select(startswith(\"${OVERRIDE_PHRASE}\"))] | length" 2>/dev/null || echo 0)

if [ "${OVERRIDE:-0}" -gt 0 ]; then
  echo "Override detected — downgrading BLOCK to PASS for this deploy."
  echo "<!-- FORGE:TEST_GATE:RESULT=PASS -->"
fi
```

---

## Structured Verdict Reference

The caller (`/review-pr-staging`) reads the verdict via:

```bash
VERDICT=$(gh pr view "$PR_NUMBER" ${GH_FLAG} --json comments \
  --jq '[.comments[].body | capture("FORGE:TEST_GATE:RESULT=(?<v>BLOCK|PASS|SKIP)").v // empty] | last // "SKIP"')
```

| Verdict | Meaning |
|---------|---------|
| `PASS` | All clusters passed (or all failures are pre-existing). Deploy may proceed. |
| `BLOCK` | Batch-introduced failures detected. Deploy blocked (blocking posture) or warned (advisory posture). |
| `SKIP` | No tests configured, no executable changes, or manual-only criteria. Deploy proceeds without test verification. |
