---
description: Deterministic deploy-gate — verify a staging→main bundle's acceptance criteria against running code before deploy
argument-hint: "[--prs \"<N1 N2 ...>\"] [--base <branch>]"
allowed-tools: Task, Bash, Read, Grep, Glob
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /test-gate — Deterministic Deploy-Gate Testing

**Input**: `$ARGUMENTS` — optional `--prs "<space-separated PR numbers>"` and `--base <branch>`.

Verifies a staging→main bundle's acceptance criteria against running code before deploy. Called by `/review-pr-staging` (Phase 6.5) with the bundle PRs, or run standalone when `--prs` is absent (computes the bundle itself). Returns a machine-readable BLOCK / PASS / SKIP verdict for the caller to consume.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**
**NEVER use the Agent tool** — test-gate dispatches test clusters via `Task` only. The Agent tool bypasses the allowed-tools constraint and produces output that cannot be structured into the machine-readable BLOCK / PASS / SKIP verdict.

<!-- FORGE:SPEC_LOADED — test-gate.md loaded and active. Agent is bound by this spec. -->

## Forbidden Tools Self-Check

**Before executing any phase**, verify you are NOT using any of these tools:

| Tool | Status | Reason |
|------|--------|--------|
| `Agent` | **FORBIDDEN** | Bypasses allowed-tools constraint; produces unstructured output that cannot be parsed into the machine-readable BLOCK / PASS / SKIP verdict |
| `EnterPlanMode` | **FORBIDDEN** | Breaks execution context; gate phases must execute, not be planned |

If you find yourself about to call `Agent(...)`, stop and use `Task(...)` instead.

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
  echo "<!-- FORGE:TEST_GATE:SKIP|reason=no-tests-configured -->"
  echo "<!-- FORGE:TEST_GATE:RESULT=SKIP -->"
  exit 0
fi
```

---

## Phase 0: Triage — Test-or-Skip

**Purpose**: Decide test-or-skip before any provisioning. Three ordered checks:
1. **0A** — no PRs in bundle → SKIP
2. **0B** — no executable file changes → SKIP (docs/config/markdown-only)
3. **0C** — no runtime-testable acceptance criteria → SKIP (all-manual or no criteria)

Every SKIP emits both a machine-readable verdict (`FORGE:TEST_GATE:RESULT=SKIP`) and a logged reason annotation (`FORGE:TEST_GATE:SKIP|reason=...`) so the caller and pipeline-health see a deliberate skip, not a silent gap.

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
  echo "<!-- FORGE:TEST_GATE:SKIP|reason=no-bundle-prs -->"
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
  echo "<!-- FORGE:TEST_GATE:SKIP|reason=no-executable-changes -->"
  echo "<!-- FORGE:TEST_GATE:RESULT=SKIP -->"
  exit 0
fi

echo "Executable files changed in bundle:"
echo "$EXECUTABLE_FILES"
```

### 0C: Criteria pre-check — test-or-skip before provisioning

Check whether any solved issue in the bundle carries at least one runtime-testable acceptance criterion (`[type:api]`, `[type:unit]`, or `[type:e2e]`, or an unannotated criterion that does not match `[type:manual]`). Skip provisioning entirely if all criteria are manual-only or no criteria exist.

```bash
echo "=== Phase 0C: Criteria pre-check ==="

TRIAGE_HAS_TESTABLE_CRITERIA=false
TRIAGE_ALL_ISSUES=""
TRIAGE_CRITERIA_COUNT=0
TRIAGE_MANUAL_COUNT=0

for pr_num in $BUNDLE_PRS; do
  # Extract closing issue references from PR body and GitHub API
  PR_BODY=$(gh pr view "$pr_num" ${GH_FLAG} --json body --jq '.body' 2>/dev/null || echo "")
  CLOSED_ISSUES=$(echo "$PR_BODY" | grep -iP '(closes|fixes|resolves)\s+#\d+' | grep -oP '#\d+' | tr -d '#' || true)
  LINKED_ISSUES=$(gh pr view "$pr_num" ${GH_FLAG} --json closingIssuesReferences \
    --jq '.closingIssuesReferences[].number' 2>/dev/null || true)
  ALL_ISSUES_FOR_PR=$(echo "${CLOSED_ISSUES} ${LINKED_ISSUES}" | tr ' ' '\n' | sort -u | grep -E '^[0-9]+$' || true)
  TRIAGE_ALL_ISSUES="${TRIAGE_ALL_ISSUES} ${ALL_ISSUES_FOR_PR}"

  for issue_num in $ALL_ISSUES_FOR_PR; do
    CRITERIA=$(gh issue view "$issue_num" ${GH_FLAG} --json body \
      --jq '.body' 2>/dev/null \
      | awk '/^## Acceptance Criteria/{found=1; next} /^## /{if(found) exit} found{print}' \
      | grep -E '^- \[' || true)

    if [ -z "$CRITERIA" ]; then
      continue
    fi

    # Check for any non-manual criterion — exit early as soon as one is found
    while IFS= read -r criterion; do
      [ -z "$criterion" ] && continue
      TRIAGE_CRITERIA_COUNT=$((TRIAGE_CRITERIA_COUNT + 1))
      if echo "$criterion" | grep -qP '\[type:(api|unit|e2e)\]'; then
        # Explicit automated annotation found
        TRIAGE_HAS_TESTABLE_CRITERIA=true
        echo "  Testable criterion found in issue #${issue_num}: ${criterion}"
        break 3  # Break out of criterion loop, issue loop, and PR loop
      elif echo "$criterion" | grep -qP '\[type:manual\]'; then
        TRIAGE_MANUAL_COUNT=$((TRIAGE_MANUAL_COUNT + 1))
      else
        # Unannotated criterion — apply same regex heuristics as Phase 2
        if echo "$criterion" | grep -qP '(endpoint|request|response|status\s+\d{3}|curl|API|HTTP|unit|function|return|assert|throws|browser|click|navigate|render|page|user flow)'; then
          TRIAGE_HAS_TESTABLE_CRITERIA=true
          echo "  Testable criterion found (inferred) in issue #${issue_num}: ${criterion}"
          break 3  # Break out of all loops
        else
          # No type signal — treat as manual for triage purposes
          TRIAGE_MANUAL_COUNT=$((TRIAGE_MANUAL_COUNT + 1))
        fi
      fi
    done <<< "$CRITERIA"
  done
done

TRIAGE_ISSUE_COUNT=$(echo "$TRIAGE_ALL_ISSUES" | tr ' ' '\n' | sort -u | grep -cE '^[0-9]+$' || echo 0)
echo "Triage summary: ${TRIAGE_ISSUE_COUNT} solved issue(s), ${TRIAGE_CRITERIA_COUNT} criterion/criteria found, ${TRIAGE_MANUAL_COUNT} manual"

if [ "$TRIAGE_HAS_TESTABLE_CRITERIA" = "false" ]; then
  if [ "${TRIAGE_CRITERIA_COUNT}" -eq 0 ]; then
    SKIP_REASON="no-acceptance-criteria"
    echo "No acceptance criteria found in any solved issue. No automated tests to run."
  else
    SKIP_REASON="no-testable-criteria"
    echo "All ${TRIAGE_CRITERIA_COUNT} acceptance criteria are manual-only. No automated tests to run."
  fi
  echo "Emitting SKIP verdict (triage: ${SKIP_REASON})."
  echo "<!-- FORGE:TEST_GATE:SKIP|reason=${SKIP_REASON} -->"
  echo "<!-- FORGE:TEST_GATE:RESULT=SKIP -->"
  exit 0
fi

echo "Runtime-testable criteria confirmed. Proceeding with provisioning."
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
  echo "Emitting SKIP verdict (manual-only bundle — defense-in-depth check after Phase 0C)."
  echo "<!-- FORGE:TEST_GATE:SKIP|reason=manual-only-criteria -->"
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

    TESTGATE_FAIL_TITLE="fix: test-gate FAIL — cluster '${cluster}' broken by staging→${DEFAULT_BRANCH} bundle"
    TESTGATE_FAIL_BODY_FILE=$(mktemp)
    cat <<ISSUE_EOF > "$TESTGATE_FAIL_BODY_FILE"
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

    # Route through the /issue create-hook's programmatic invocation contract (see
    # commands/issue.md § "Programmatic Invocation Contract") instead of the raw issue-creation call.
    Skill(skill="issue", args="--title \"$TESTGATE_FAIL_TITLE\" --body-file \"$TESTGATE_FAIL_BODY_FILE\" --label test-failure --label priority:P1")
    rm -f "$TESTGATE_FAIL_BODY_FILE"

    # /issue has no machine-readable return contract — resolve the created issue's number by
    # exact-title search immediately after the call.
    ISSUE_NUM=$(gh issue list ${GH_FLAG} --search "in:title \"${TESTGATE_FAIL_TITLE}\"" --state open --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null || echo "FAILED")

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

Reconcile the executed test plan against each solved issue's acceptance criteria. For each solved issue, map individual acceptance criteria to the clusters that ran. Flag uncovered criteria (runtime-testable, no cluster maps to them) and untestable-as-written criteria (vague oracle, no deterministic verification) as distinct finding classes. Coverage gaps contribute to the BLOCK verdict.

```bash
echo "=== Phase 6: Criteria-adequacy check ==="

# Initialize adequacy state — all variables must be set before Phase 7 reads them
COVERAGE_BLOCK=false
UNCOVERED_BLOCK_COUNT=0
ADEQUACY_COVERED_LIST=""
ADEQUACY_UNCOVERED_LIST=""
ADEQUACY_UNTESTABLE_LIST=""
ADEQUACY_MANUAL_LIST=""

# Build a flat list of cluster names that passed, for mapping lookup
PASSING_CLUSTERS=$(echo -e "$CLUSTER_RESULTS" | grep ": PASS" | grep -oP '^- \K[^:]+' | tr '\n' ' ' || true)
ALL_CLUSTERS=$(yq '.verification.integration_tests[].cluster' "$CONFIG_FILE" 2>/dev/null | tr '\n' ' ' || true)

echo "Passing clusters: ${PASSING_CLUSTERS:-none}"
echo "All configured clusters: ${ALL_CLUSTERS:-none}"
echo ""

# Helper: classify a single criterion line into one of four buckets:
#   covered, uncovered, untestable, manual
# Arguments: $1 = criterion text, $2 = source_issue, $3 = source_pr
classify_criterion() {
  local criterion="$1"
  local source_issue="$2"
  local source_pr="$3"

  # --- Step 1: Detect explicitly manual criteria ---
  if echo "$criterion" | grep -qP '\[type:manual\]'; then
    ADEQUACY_MANUAL_LIST="${ADEQUACY_MANUAL_LIST}\n  [manual] Issue #${source_issue} (PR #${source_pr}): ${criterion}"
    return
  fi

  # --- Step 2: Detect untestable-as-written criteria ---
  # Vague oracles: subjective language, pure process requirements, non-deterministic assertions
  if echo "$criterion" | grep -qiP '(should feel|must be appropriate|is good|as needed|where applicable|adequacy findings are filed|filed as tracked|flow back through|human validation|manual review|out-of-band|up to the reviewer|at the discretion|be reasonable|be sufficient|when possible|if applicable)'; then
    ADEQUACY_UNTESTABLE_LIST="${ADEQUACY_UNTESTABLE_LIST}\n  [untestable-as-written] Issue #${source_issue} (PR #${source_pr}): ${criterion}"
    return
  fi

  # --- Step 3: Determine if criterion is runtime-testable ---
  local is_automated=false
  local inferred_type=""

  if echo "$criterion" | grep -qP '\[type:(api|unit|e2e)\]'; then
    is_automated=true
    inferred_type=$(echo "$criterion" | grep -oP '\[type:\K(api|unit|e2e)' || echo "automated")
  elif echo "$criterion" | grep -qP '(endpoint|request|response|status\s+\d{3}|curl|API|HTTP)'; then
    is_automated=true
    inferred_type="api"
  elif echo "$criterion" | grep -qP '(unit|function|return|assert|throws)'; then
    is_automated=true
    inferred_type="unit"
  elif echo "$criterion" | grep -qP '(browser|click|navigate|render|page|user flow)'; then
    is_automated=true
    inferred_type="e2e"
  fi

  if [ "$is_automated" = "false" ]; then
    # No automation signal — treat as manual (inferred)
    ADEQUACY_MANUAL_LIST="${ADEQUACY_MANUAL_LIST}\n  [manual/inferred] Issue #${source_issue} (PR #${source_pr}): ${criterion}"
    return
  fi

  # --- Step 4: Map automated criterion to a cluster ---
  # A criterion is "covered" if at least one passing cluster name or cluster type
  # matches the criterion's inferred type or the criterion text.
  local is_covered=false

  for cluster in $PASSING_CLUSTERS; do
    # Match: cluster name substring appears in criterion text, OR
    #        cluster name matches the inferred test type (api/unit/e2e)
    if echo "$criterion" | grep -qiF "$cluster"; then
      is_covered=true
      break
    fi
    if [ "$inferred_type" = "$cluster" ]; then
      is_covered=true
      break
    fi
    # Broad type-level match: if a passing cluster name contains the type keyword
    if echo "$cluster" | grep -qiF "$inferred_type"; then
      is_covered=true
      break
    fi
  done

  if [ "$is_covered" = "true" ]; then
    ADEQUACY_COVERED_LIST="${ADEQUACY_COVERED_LIST}\n  [covered:${inferred_type}] Issue #${source_issue} (PR #${source_pr}): ${criterion}"
  else
    ADEQUACY_UNCOVERED_LIST="${ADEQUACY_UNCOVERED_LIST}\n  [UNCOVERED:${inferred_type}] Issue #${source_issue} (PR #${source_pr}): ${criterion}"
    UNCOVERED_BLOCK_COUNT=$((UNCOVERED_BLOCK_COUNT + 1))
  fi
}

# --- Iterate COLLATED_CRITERIA by issue section ---
# COLLATED_CRITERIA format:
#   ### Issue #N (PR #M)
#   - [ ] criterion text
#   - [x] completed criterion
CURRENT_ISSUE=""
CURRENT_PR=""

while IFS= read -r line; do
  # Detect section header: ### Issue #N (PR #M)
  if echo "$line" | grep -qP '^### Issue #\d+'; then
    CURRENT_ISSUE=$(echo "$line" | grep -oP '(?<=Issue #)\d+' | head -1)
    CURRENT_PR=$(echo "$line" | grep -oP '(?<=PR #)\d+' | head -1)
    continue
  fi

  # Process criterion lines (both checked and unchecked)
  if echo "$line" | grep -qP '^- \['; then
    [ -z "$CURRENT_ISSUE" ] && continue
    classify_criterion "$line" "$CURRENT_ISSUE" "$CURRENT_PR"
  fi
done <<< "$(echo -e "$COLLATED_CRITERIA")"

# --- Report adequacy findings ---
COVERED_COUNT=$(echo -e "$ADEQUACY_COVERED_LIST" | grep -c '^\s*\[covered' || echo 0)
UNCOVERED_COUNT=$(echo -e "$ADEQUACY_UNCOVERED_LIST" | grep -c '^\s*\[UNCOVERED' || echo 0)
UNTESTABLE_COUNT=$(echo -e "$ADEQUACY_UNTESTABLE_LIST" | grep -c '^\s*\[untestable' || echo 0)
MANUAL_COUNT=$(echo -e "$ADEQUACY_MANUAL_LIST" | grep -c '^\s*\[manual' || echo 0)

echo "Criteria-adequacy summary:"
echo "  Covered (mapped to a passing cluster): ${COVERED_COUNT}"
echo "  Uncovered (runtime-testable, no cluster maps):  ${UNCOVERED_COUNT}"
echo "  Untestable-as-written (vague oracle):           ${UNTESTABLE_COUNT}"
echo "  Manual (require human validation):              ${MANUAL_COUNT}"
echo ""

if [ "${COVERED_COUNT}" -gt 0 ]; then
  echo "Covered criteria:"
  echo -e "$ADEQUACY_COVERED_LIST"
  echo ""
fi

if [ "${UNCOVERED_COUNT}" -gt 0 ]; then
  echo "UNCOVERED criteria (coverage gaps — no passing cluster maps to these):"
  echo -e "$ADEQUACY_UNCOVERED_LIST"
  echo ""
fi

if [ "${UNTESTABLE_COUNT}" -gt 0 ]; then
  echo "Untestable-as-written criteria (flagged — not counted as failures):"
  echo -e "$ADEQUACY_UNTESTABLE_LIST"
  echo ""
fi

if [ "${MANUAL_COUNT}" -gt 0 ]; then
  echo "Manual criteria (require human validation — not covered by /test-gate):"
  echo -e "$ADEQUACY_MANUAL_LIST"
  echo ""
fi

# --- Set COVERAGE_BLOCK if uncovered runtime-testable criteria exist ---
if [ "${UNCOVERED_BLOCK_COUNT}" -gt 0 ]; then
  if [ "$GATE_POSTURE" = "blocking" ]; then
    COVERAGE_BLOCK=true
    echo "COVERAGE BLOCK: ${UNCOVERED_BLOCK_COUNT} runtime-testable criterion/criteria have no mapped test cluster."
    echo "Coverage gaps cannot produce a clean PASS verdict (posture: blocking)."
  else
    echo "COVERAGE ADVISORY: ${UNCOVERED_BLOCK_COUNT} runtime-testable criterion/criteria have no mapped test cluster."
    echo "(posture: advisory — surfaced but deploy is not blocked by coverage gaps)"
  fi
fi

# --- File test-gap issues for uncovered runtime-testable criteria ---
if [ "${UNCOVERED_COUNT}" -gt 0 ]; then
  # Ensure test-gap label exists
  gh label create "test-gap" --color "E4E669" \
    --description "Acceptance criterion not covered by any /test-gate cluster. Filed by ForgeDock." \
    --force ${GH_FLAG} 2>/dev/null || true

  while IFS= read -r gap_line; do
    [ -z "$(echo "$gap_line" | grep -E '\S')" ] && continue

    # Extract issue and criterion from gap line format: [UNCOVERED:type] Issue #N (PR #M): criterion
    GAP_ISSUE=$(echo "$gap_line" | grep -oP '(?<=Issue #)\d+' | head -1)
    GAP_PR=$(echo "$gap_line" | grep -oP '(?<=PR #)\d+' | head -1)
    GAP_TYPE=$(echo "$gap_line" | grep -oP '(?<=UNCOVERED:)[^\]]+' | head -1)
    GAP_CRITERION=$(echo "$gap_line" | grep -oP '(?<=: )- \[.+' | head -1 || echo "$gap_line")

    [ -z "$GAP_ISSUE" ] && continue

    # Duplicate prevention: check for open test-gap issues referencing this issue+criterion
    EXISTING_GAP=$(gh issue list ${GH_FLAG} \
      --label "test-gap" \
      --state open \
      --search "test-gap issue #${GAP_ISSUE}" \
      --limit 5 \
      --json number,title \
      --jq '.[0].number // empty' 2>/dev/null || true)

    if [ -n "$EXISTING_GAP" ]; then
      echo "Skipping test-gap issue creation — open issue already exists: #${EXISTING_GAP} (source: #${GAP_ISSUE})"
      continue
    fi

    TESTGAP_TITLE="fix: test-gap — uncovered criterion in issue #${GAP_ISSUE} (${GAP_TYPE})"
    TESTGAP_BODY_FILE=$(mktemp)
    cat <<TGAP_EOF > "$TESTGAP_BODY_FILE"
## Problem

The \`/test-gate\` criteria-adequacy check (Phase 6) found a runtime-testable acceptance criterion in issue #${GAP_ISSUE} that is not covered by any configured test cluster. Coverage gaps cannot produce a clean PASS verdict — this criterion must be covered before the staging→${DEFAULT_BRANCH} bundle can pass the deploy gate.

## Root Cause (if known)

No test cluster in \`forge.yaml verification.integration_tests\` maps to this criterion. Either:
1. The test cluster that would cover this criterion does not exist yet (gap in test suite), or
2. The cluster name does not match the criterion's keywords (mapping heuristic miss).

## Affected Files

Files to be identified during investigation. Start with the test suite for the \`${GAP_TYPE}\` cluster.

## Acceptance Criteria

- [ ] A test cluster that covers this criterion is identified or created
- [ ] The criterion maps to the cluster in a /test-gate run
- [ ] /test-gate Phase 6 reports this criterion as covered (not uncovered) for this bundle

## Context

**Detected by**: \`/test-gate\` — Phase 6 criteria-adequacy check
**Source issue**: #${GAP_ISSUE}
**Source PR**: #${GAP_PR}
**Bundle PRs**: ${BUNDLE_PRS}
**Criterion type**: \`${GAP_TYPE}\`
**Uncovered criterion**:
\`\`\`
${GAP_CRITERION}
\`\`\`
TGAP_EOF

    # Route through the /issue create-hook's programmatic invocation contract (see
    # commands/issue.md § "Programmatic Invocation Contract") instead of the raw issue-creation call.
    Skill(skill="issue", args="--title \"$TESTGAP_TITLE\" --body-file \"$TESTGAP_BODY_FILE\" --label test-gap")
    rm -f "$TESTGAP_BODY_FILE"

    # /issue has no machine-readable return contract — resolve the created issue's number by
    # exact-title search immediately after the call.
    GAP_ISSUE_NUM=$(gh issue list ${GH_FLAG} --search "in:title \"${TESTGAP_TITLE}\"" --state open --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null || echo "FAILED")

    if [ "$GAP_ISSUE_NUM" != "FAILED" ] && [ -n "$GAP_ISSUE_NUM" ]; then
      echo "Filed test-gap issue #${GAP_ISSUE_NUM} for uncovered criterion in #${GAP_ISSUE} (${GAP_TYPE})"
    else
      echo "WARNING: Failed to create test-gap issue for uncovered criterion in #${GAP_ISSUE}"
    fi
  done <<< "$(echo -e "$ADEQUACY_UNCOVERED_LIST")"
fi

---

## Phase 7: Verdict — Emit Machine-Readable Result

Determine BLOCK / PASS / SKIP based on batch-introduced failures, cluster results, coverage gaps, and posture config.

```bash
echo "=== Phase 7: Emitting verdict ==="

BATCH_FAILURE_COUNT=$(echo -e "$BATCH_FAILURES" | grep -c '\S' || echo 0)
TOTAL_PASS=$(echo -e "$CLUSTER_RESULTS" | grep -c "PASS" || echo 0)
TOTAL_FAIL=$(echo -e "$CLUSTER_RESULTS" | grep -c "FAIL" || echo 0)

# COVERAGE_BLOCK is set by Phase 6 when uncovered runtime-testable criteria exist
# and posture is blocking. It is initialized to false if Phase 6 found no gaps.
COVERAGE_BLOCK="${COVERAGE_BLOCK:-false}"
UNCOVERED_BLOCK_COUNT="${UNCOVERED_BLOCK_COUNT:-0}"

if [ "${BATCH_FAILURE_COUNT}" -gt 0 ]; then
  VERDICT="BLOCK"
  VERDICT_REASON="${BATCH_FAILURE_COUNT} cluster(s) failed with batch-introduced regressions: $(echo -e "$BATCH_FAILURES" | tr '\n' ', ' | sed 's/,\s*$//')"
elif [ "$COVERAGE_BLOCK" = "true" ]; then
  # Coverage gaps: runtime-testable criteria exist but no cluster maps to them.
  # A gate that runs some tests but skips verifying specific criteria is not a clean pass.
  VERDICT="BLOCK"
  VERDICT_REASON="${UNCOVERED_BLOCK_COUNT} runtime-testable acceptance criterion/criteria not covered by any test cluster. Coverage gaps cannot produce a clean PASS verdict."
elif [ "${TOTAL_FAIL}" -gt 0 ]; then
  # All failures are pre-existing (baseline also failed) — not blocking
  VERDICT="PASS"
  VERDICT_REASON="${TOTAL_FAIL} pre-existing failure(s) detected (also failed on ${BASE_BRANCH} baseline — not introduced by this batch). ${TOTAL_PASS} cluster(s) passed."
else
  VERDICT="PASS"
  VERDICT_REASON="All ${TOTAL_PASS} cluster(s) passed. No batch-introduced failures. All runtime-testable criteria covered."
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
echo ""
echo "Adequacy summary:"
echo "  Covered: ${COVERED_COUNT:-0} | Uncovered: ${UNCOVERED_COUNT:-0} | Untestable-as-written: ${UNTESTABLE_COUNT:-0} | Manual: ${MANUAL_COUNT:-0}"
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
