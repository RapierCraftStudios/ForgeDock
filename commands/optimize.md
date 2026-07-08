---
description: Analyze this repo and generate per-repo adaptive scripts from learned patterns, git history, and existing configuration
argument-hint: [--dry-run | --force | --no-registry]
install: extras
---

# /optimize — Per-Repo Adaptive Script Generation

**Input**: $ARGUMENTS

Proactively analyze the current repository and generate `.forgedock/scripts/` entries from `forge.yaml → learned:`, git commit history, and pipeline annotations — without waiting for a correction event. This is the proactive half of the learning loop; reactive capture happens in `/work-on` Phase 1D.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Full run: analyze → generate → registry → report |
| `--dry-run` | Analyze and report what would be generated; write nothing to disk |
| `--force` | Overwrite scripts even if confidence < 0.7 |
| `--no-registry` | Skip `registry.json` update |

Parse `$ARGUMENTS` and set:
```
DRY_RUN   = true if --dry-run present, else false
FORCE     = true if --force present, else false
NO_REG    = true if --no-registry present, else false
```

---

## Prerequisites

### P1: Read forge.yaml

```bash
REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
FORGE_YAML="$REPO_PATH/forge.yaml"
GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$FORGE_YAML" 2>/dev/null)
SCRIPTS_DIR="$REPO_PATH/.forgedock/scripts"
ADAPTIVE_ENABLED=$(yq '.adaptive_scripts.enabled // true' "$FORGE_YAML" 2>/dev/null || echo "true")
ADAPTIVE_COMMIT=$(yq '.adaptive_scripts.commit // false' "$FORGE_YAML" 2>/dev/null || echo "false")
```

If `$FORGE_YAML` is missing:
```
STOP: forge.yaml not found. Run `npx forgedock init` to generate it, then re-run /optimize.
```

If `ADAPTIVE_ENABLED` is `false`:
```
STOP: adaptive_scripts.enabled is false in forge.yaml. Set it to true to use /optimize.
```

### P2: Ensure scripts directory exists

```bash
mkdir -p "$SCRIPTS_DIR"
```

If `.forgedock/scripts/` is not gitignored, note in the report (non-blocking).

---

## Phase 1: Pattern Analysis

Read all available signal sources. Build a `PATTERNS` map — keyed by script name, value is `{evidence, confidence, value}`.

**Confidence scale**:
- `1.0` — explicit value in `forge.yaml → learned:` (authoritative)
- `0.85` — value confirmed by 3+ independent signals (git history, FORGE:LEARNED annotations)
- `0.7` — value confirmed by 2 independent signals
- `0.5` — single signal (heuristic only)
- `<0.5` — insufficient evidence; skip unless `--force`

### 1A: Read forge.yaml → learned: section

```bash
LEARNED=$(yq '.learned // {}' "$FORGE_YAML" 2>/dev/null || echo '{}')
echo "Learned section: $LEARNED"
```

Extract each known key:
```bash
LEARNED_STAGING=$(yq '.learned.branch_targets.staging // ""' "$FORGE_YAML" 2>/dev/null)
LEARNED_TEST_CMDS=$(yq '.learned.test_commands // []' "$FORGE_YAML" -o json 2>/dev/null)
LEARNED_TEST_LOCS=$(yq '.learned.test_locations // []' "$FORGE_YAML" -o json 2>/dev/null)
LEARNED_LABEL_MAP=$(yq '.learned.label_map // {}' "$FORGE_YAML" -o json 2>/dev/null)
LEARNED_COMMIT_STYLE=$(yq '.learned.commit_style // ""' "$FORGE_YAML" 2>/dev/null)
```

For each non-empty learned key, add to PATTERNS with confidence `1.0`:

| Non-empty key | Script to generate |
|---------------|--------------------|
| `branch_targets.staging` | `branch-targets.sh` |
| `test_commands` (non-empty array) | `run-tests.sh` |
| `test_locations` (non-empty array) | `find-tests.sh` |
| `label_map` (non-empty object) | `label-map.sh` |
| `commit_style` | `format-commit.sh` |

### 1B: Analyze git commit history

```bash
cd "$REPO_PATH"

# Sample last 50 commits for style analysis
COMMIT_SUBJECTS=$(git log --oneline -50 --format="%s" 2>/dev/null | head -50)
echo "$COMMIT_SUBJECTS"
```

**Detect commit style**:
```bash
CONV_COUNT=$(echo "$COMMIT_SUBJECTS" | grep -cE '^(feat|fix|docs|chore|refactor|test|style|ci|build|perf)\(' 2>/dev/null || echo 0)
CONV_SIMPLE=$(echo "$COMMIT_SUBJECTS" | grep -cE '^(feat|fix|docs|chore|refactor|test|style|ci|build|perf):' 2>/dev/null || echo 0)
TOTAL=$(echo "$COMMIT_SUBJECTS" | wc -l | tr -d ' ')

CONV_WITH_SCOPE_PCT=$(( (CONV_COUNT * 100) / (TOTAL + 1) ))
CONV_SIMPLE_PCT=$(( (CONV_SIMPLE * 100) / (TOTAL + 1) ))
```

Determine `DETECTED_COMMIT_STYLE`:
- If `CONV_WITH_SCOPE_PCT >= 60` → `"conventional-with-scope"`, confidence `0.85`
- If `CONV_SIMPLE_PCT >= 60` → `"conventional"`, confidence `0.85`
- If `(CONV_COUNT + CONV_SIMPLE) < 20%` → `"plain"`, confidence `0.7`
- Otherwise → insufficient signal, skip `format-commit.sh` unless already in `learned:`

**If `LEARNED_COMMIT_STYLE` is non-empty**: use it (confidence `1.0`), skip git analysis for this signal.

**Detect test locations** (if `LEARNED_TEST_LOCS` is empty):
```bash
# Look for test directories with actual test files
TEST_DIRS=""
for candidate in tests/ __tests__/ test/ spec/ src/__tests__/; do
  COUNT=$(git ls-files "$candidate" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$COUNT" -gt "0" ]; then
    TEST_DIRS="$TEST_DIRS $candidate"
  fi
done
TEST_DIRS=$(echo "$TEST_DIRS" | xargs)  # trim
```

If `TEST_DIRS` is non-empty and differs from the default (`tests/`): add to PATTERNS for `find-tests.sh` with confidence `0.7`.

### 1C: Mine FORGE:LEARNED annotations from closed issues

```bash
# Read closed issues for repeated FORGE:LEARNED annotations (last 30 closed issues)
FORGE_LEARNED_BODIES=$(gh api "repos/$GH_REPO/issues?state=closed&per_page=30" \
  --jq '[.[] | .number]' 2>/dev/null | jq -r '.[]' 2>/dev/null | \
  while read -r n; do
    gh api "repos/$GH_REPO/issues/$n/comments" \
      --jq '.[] | select(.body | contains("FORGE:LEARNED")) | .body' 2>/dev/null
  done | head -200)
echo "$FORGE_LEARNED_BODIES" | head -50
```

**Extract corroborating signals from annotations**:
- Count occurrences of each staging branch override, test command, label remap, commit style across annotations
- Each repeated annotation (≥2 occurrences) raises confidence by `+0.15` for the matching pattern
- Cap confidence at `1.0`

**Practical limit**: Process at most 30 issues. If `gh` rate-limits, skip 1C and note in report.

---

## Phase 2: Script Generation

For each pattern in PATTERNS with `confidence >= 0.7` (or all if `--force`):

**Overwrite mode**: if a script already exists, read it first, then overwrite — never append. Log "updated" vs "created" in the report.

### 2A: branch-targets.sh

Trigger: `branch_targets.staging` set in `learned:` (confidence `1.0`), OR git history shows consistent use of a non-default staging branch.

```bash
cat > "$SCRIPTS_DIR/branch-targets.sh" << 'SCRIPT_EOF'
#!/usr/bin/env bash
# Auto-generated by /optimize — branch target overrides for this repo.
# Source: forge.yaml → learned.branch_targets
# Edit manually if your branch structure changes.

# STAGING_BRANCH: override the default staging branch for fast-lane PRs
echo "STAGING_BRANCH={LEARNED_STAGING_VALUE}"
SCRIPT_EOF
chmod +x "$SCRIPTS_DIR/branch-targets.sh"
```

Replace `{LEARNED_STAGING_VALUE}` with the actual value from `learned.branch_targets.staging`.

### 2B: run-tests.sh

Trigger: `test_commands` array non-empty in `learned:` (confidence `1.0`), OR FORGE:LEARNED annotations contain repeated test command corrections.

```bash
cat > "$SCRIPTS_DIR/run-tests.sh" << 'SCRIPT_EOF'
#!/usr/bin/env bash
# Auto-generated by /optimize — test command sequence for this repo.
# Source: forge.yaml → learned.test_commands
# Edit manually if your test setup changes.

set -e

{LEARNED_TEST_COMMANDS_EXPANDED}
SCRIPT_EOF
chmod +x "$SCRIPTS_DIR/run-tests.sh"
```

Expand `{LEARNED_TEST_COMMANDS_EXPANDED}` to one command per line, in array order.

### 2C: find-tests.sh

Trigger: `test_locations` array non-empty in `learned:` (confidence `1.0`), OR git ls-files shows non-default test directories (confidence `0.7`).

```bash
cat > "$SCRIPTS_DIR/find-tests.sh" << 'SCRIPT_EOF'
#!/usr/bin/env bash
# Auto-generated by /optimize — test file discovery for this repo.
# Source: forge.yaml → learned.test_locations
# Returns a list of test files matching this repo's actual test directory layout.

set -e

{FIND_COMMANDS_EXPANDED}
SCRIPT_EOF
chmod +x "$SCRIPTS_DIR/find-tests.sh"
```

Expand `{FIND_COMMANDS_EXPANDED}` to `find {dir} -name "*.test.*" -o -name "*.spec.*" 2>/dev/null` for each location, plus glob patterns if specified. Patterns ending in `*` are expanded with `git ls-files`.

### 2D: label-map.sh

Trigger: `label_map` non-empty in `learned:` (confidence `1.0`).

```bash
cat > "$SCRIPTS_DIR/label-map.sh" << 'SCRIPT_EOF'
#!/usr/bin/env bash
# Auto-generated by /optimize — label name remapping for this repo.
# Source: forge.yaml → learned.label_map
# Usage: source this file, then use map_label() to resolve canonical → repo label.

# Associative array: canonical ForgeDock label → repo-specific label
declare -A LABEL_MAP=(
{LABEL_MAP_ENTRIES}
)

map_label() {
  local canonical="$1"
  echo "${LABEL_MAP[$canonical]:-$canonical}"
}
SCRIPT_EOF
chmod +x "$SCRIPTS_DIR/label-map.sh"
```

Expand `{LABEL_MAP_ENTRIES}` to `["canonical"]="repo-specific"` pairs.

### 2E: format-commit.sh

Trigger: `commit_style` set in `learned:` (confidence `1.0`), OR git history analysis produces `confidence >= 0.7`.

```bash
cat > "$SCRIPTS_DIR/format-commit.sh" << 'SCRIPT_EOF'
#!/usr/bin/env bash
# Auto-generated by /optimize — commit message style enforcer for this repo.
# Source: forge.yaml → learned.commit_style (or git history analysis)
# Usage: ./format-commit.sh "type" "scope" "description" "issue_number"
#   type: conventional prefix (feat, fix, refactor, docs, chore, etc.)
#   scope: component or area being changed (e.g. auth, pipeline, commands)
#   description: short imperative summary of the change
#   issue_number: GitHub issue number (without #)
#   Outputs: the correctly-formatted commit message for this repo.

set -e

STYLE="{COMMIT_STYLE}"
TYPE="${1:-}"
SCOPE="${2:-}"
DESCRIPTION="${3:-}"
ISSUE="${4:-}"

case "$STYLE" in
  conventional-with-scope)
    if [ -n "$SCOPE" ]; then
      echo "${TYPE}(${SCOPE}): ${DESCRIPTION} (#${ISSUE})"
    else
      echo "${TYPE:-chore}: ${DESCRIPTION} (#${ISSUE})"
    fi
    ;;
  conventional)
    echo "${TYPE:-chore}: ${DESCRIPTION} (#${ISSUE})"
    ;;
  plain)
    echo "${DESCRIPTION} (#${ISSUE})"
    ;;
  *)
    echo "${DESCRIPTION}"
    ;;
esac
SCRIPT_EOF
chmod +x "$SCRIPTS_DIR/format-commit.sh"
```

Replace `{COMMIT_STYLE}` with the detected or learned value.

---

## Phase 3: Registry Update

Skip if `--no-registry`.

Write (overwrite) `.forgedock/scripts/registry.json`:

```bash
GENERATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$SCRIPTS_DIR/registry.json" << JSON_EOF
{
  "schema_version": 1,
  "generated_at": "${GENERATED_AT}",
  "generated_by": "/optimize",
  "scripts": {
{REGISTRY_ENTRIES}
  }
}
JSON_EOF
```

Build `{REGISTRY_ENTRIES}` from the PATTERNS map. For each generated script:
```json
    "branch-targets": {
      "path": "branch-targets.sh",
      "confidence": 1.0,
      "evidence": "forge.yaml → learned.branch_targets.staging",
      "generated_at": "2026-03-15T10:30:00Z"
    }
```

Comma-separate all entries. If `--dry-run`: print the registry JSON to stdout instead of writing it.

---

## Phase 4: Report

Output a human-readable summary. Do NOT commit anything — `adaptive_scripts.commit` is respected:

```bash
echo ""
echo "=== /optimize Report ==="
echo "Run at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Repo: $GH_REPO"
echo "Scripts dir: $SCRIPTS_DIR"
if [ "$DRY_RUN" = "true" ]; then
  echo "Mode: DRY RUN — no files written"
fi
echo ""
echo "--- Patterns detected ---"
```

For each pattern in PATTERNS (sorted by confidence descending):
```
  {script_name}.sh   confidence={confidence}   source={evidence}   action={created|updated|skipped|would-create}
```

For patterns with `confidence < 0.7` that were skipped:
```
  {script_name}.sh   SKIPPED (confidence={confidence} < 0.7 — run with --force to generate)
```

Then:
```
--- Summary ---
  Scripts created:  N
  Scripts updated:  N
  Scripts skipped:  N
  Registry:         {written|skipped}
  Commit:           NOT done (adaptive_scripts.commit=false — review scripts before committing)

--- Next steps ---
  1. Review generated scripts in .forgedock/scripts/
  2. Run each script manually to verify output
  3. If correct: git add .forgedock/scripts/ && git commit -s -m "feat(scripts): adaptive scripts from /optimize"
  4. If not: edit scripts directly or update forge.yaml → learned: and re-run /optimize
```

If no patterns were detected at all:
```
No patterns detected with sufficient confidence.

Possible reasons:
  - forge.yaml → learned: is empty (no corrections captured yet)
  - Git history is too short (< 10 commits) to detect commit style
  - Test directories match the default (tests/) — no override needed

Run /work-on on a few issues to let the pipeline capture corrections, then re-run /optimize.
```

---

## Phase 5: Promotion Loop (Tier-A and Tier-B)

<!-- Added: forge#1739 -->

**Purpose**: Scan the Forge Ledger for validated finding patterns that have recurred ≥3 times and promote them — either as a Tier-A mechanizable check script in `gate.d/` or as a Tier-B prose entry in `devdocs/learned-rules/{domain}.md`. Both promotion paths open as a PR for human review. Checks are never silently auto-enforced.

**Skip if**: `--dry-run` flag is set (print what would be promoted without creating PRs).

**Skip if**: The Forge Ledger CLI (`forge recall`) is not available — log a note and continue.

### 5A: Query the Ledger for promotion candidates

```bash
# forge recall requires the Forge Ledger from #1732 to be indexed.
# If not available, skip Phase 5 with a note.
if ! command -v forge >/dev/null 2>&1; then
  echo "Phase 5: forge CLI not found — skipping promotion loop."
  echo "  Install: https://github.com/RapierCraftStudios/forgedock#forge-ledger"
  return 0 2>/dev/null || exit 0
fi

# Query for patterns with ≥3 validated occurrences (never unvalidated or false-positive)
# Output: one JSON object per line with fields: slug, domain, count, type, summary, citations[]
PROMOTION_CANDIDATES=$(forge recall \
  --filter validated \
  --min-count 3 \
  --output jsonl \
  --repo "$GH_REPO" \
  2>/dev/null || echo '')

if [ -z "$PROMOTION_CANDIDATES" ]; then
  echo "Phase 5: No patterns with ≥3 validated occurrences found — nothing to promote."
  return 0 2>/dev/null || exit 0
fi

CANDIDATE_COUNT=$(echo "$PROMOTION_CANDIDATES" | grep -c '"slug"' 2>/dev/null || echo 0)
echo "Phase 5: Found $CANDIDATE_COUNT promotion candidate(s)"
```

### 5B: Classify each candidate as Tier-A or Tier-B

For each candidate pattern, classify it:

| Tier | Condition | Promotion target |
|------|-----------|-----------------|
| **Tier-A** | Pattern is mechanically grep-detectable in a diff (literal string, regex, or structural property) AND can be expressed as a bash check returning the standard `SLUG \| SEVERITY \| FILE \| MESSAGE` format | Draft gate.d script → PR |
| **Tier-B** | Pattern requires LLM reasoning to detect (code semantics, logic flow, cross-file reasoning) OR the fix depends on project-specific context that can't be encoded in a grep | Draft learned-rules.md entry → PR |

```bash
TIER_A_PROMOTIONS=()
TIER_B_PROMOTIONS=()

while IFS= read -r candidate; do
  [ -z "$candidate" ] && continue
  SLUG=$(echo "$candidate" | jq -r '.slug // ""' 2>/dev/null)
  DOMAIN=$(echo "$candidate" | jq -r '.domain // "GENERAL"' 2>/dev/null)
  COUNT=$(echo "$candidate" | jq -r '.count // 0' 2>/dev/null)
  TYPE=$(echo "$candidate" | jq -r '.type // "prose"' 2>/dev/null)   # "mechanical" or "prose"
  SUMMARY=$(echo "$candidate" | jq -r '.summary // ""' 2>/dev/null)
  CITATIONS=$(echo "$candidate" | jq -r '[.citations[] | "#" + tostring] | join(", ")' 2>/dev/null)

  [ -z "$SLUG" ] && continue

  if [ "$TYPE" = "mechanical" ]; then
    TIER_A_PROMOTIONS+=("$candidate")
    echo "  Tier-A candidate: $SLUG (domain=$DOMAIN, count=$COUNT, citations=$CITATIONS)"
  else
    TIER_B_PROMOTIONS+=("$candidate")
    echo "  Tier-B candidate: $SLUG (domain=$DOMAIN, count=$COUNT, citations=$CITATIONS)"
  fi
done <<< "$PROMOTION_CANDIDATES"
```

### 5C: Draft Tier-A gate.d scripts

For each Tier-A candidate, draft a gate.d script and open it as a PR:

```bash
GATE_D_DIR="$SCRIPTS_DIR/gate.d"
mkdir -p "$GATE_D_DIR"

for candidate in "${TIER_A_PROMOTIONS[@]}"; do
  SLUG=$(echo "$candidate" | jq -r '.slug' 2>/dev/null)
  DOMAIN=$(echo "$candidate" | jq -r '.domain // "GENERAL"' 2>/dev/null)
  SUMMARY=$(echo "$candidate" | jq -r '.summary' 2>/dev/null)
  PATTERN=$(echo "$candidate" | jq -r '.pattern // ""' 2>/dev/null)   # grep-ready pattern string
  CITATIONS=$(echo "$candidate" | jq -r '[.citations[] | "#" + tostring] | join(", ")' 2>/dev/null)
  COUNT=$(echo "$candidate" | jq -r '.count' 2>/dev/null)
  SEVERITY=$(echo "$candidate" | jq -r '.severity // "HIGH"' 2>/dev/null)

  SCRIPT_PATH="$GATE_D_DIR/${SLUG}.sh"

  # Skip if already promoted (idempotent)
  if [ -f "$SCRIPT_PATH" ] && [ "$DRY_RUN" != "true" ]; then
    echo "  Tier-A: $SLUG — already exists at $SCRIPT_PATH, skipping"
    continue
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "  [DRY RUN] Would create gate.d/${SLUG}.sh (domain=$DOMAIN, citations=$CITATIONS)"
    continue
  fi

  # Generate the gate.d script
  cat > "$SCRIPT_PATH" << GATE_SCRIPT_EOF
#!/usr/bin/env bash
# gate.d/${SLUG}.sh — auto-generated by /optimize Phase 5
# Domain: ${DOMAIN}
# Pattern: ${SUMMARY}
# Evidence: ${COUNT} validated occurrences — ${CITATIONS}
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
#
# CONTRACT:
#   \$1 = absolute path to unified diff (git diff HEAD)
#   \$2 = absolute path to worktree root
#   stdout = findings lines: SLUG | SEVERITY | FILE | MESSAGE
#   exit 0 = pass, exit 1 = findings, exit 2 = inapplicable
#   30s timeout enforced by quality-gate (fail-closed)
#
# EDIT THIS SCRIPT: the pattern below was auto-generated. Review and test
# it against real diffs before the PR is merged.

set -euo pipefail

DIFF_PATH="\${1:-}"
WORKTREE="\${2:-}"
FOUND=0

if [ -z "\$DIFF_PATH" ] || [ ! -f "\$DIFF_PATH" ]; then
  exit 2  # inapplicable — no diff provided
fi

# Check for the pattern in added lines of the diff
# TODO: refine this pattern based on the specific defect class
PATTERN='${PATTERN}'
if [ -z "\$PATTERN" ]; then
  exit 2  # no pattern configured — mark inapplicable until author fills it in
fi

while IFS= read -r line; do
  [ -z "\$line" ] && continue
  FILE=\$(echo "\$line" | grep -oP '(?<=\+\+\+ b/).*' || true)
done < <(grep '^+++ b/' "\$DIFF_PATH" 2>/dev/null)

# Scan added lines for the pattern
MATCHES=\$(grep -nP "^\+" "\$DIFF_PATH" 2>/dev/null | grep -v "^+++" | grep -P "\$PATTERN" 2>/dev/null || true)

if [ -n "\$MATCHES" ]; then
  while IFS= read -r match; do
    [ -z "\$match" ] && continue
    echo "GATD-${SLUG} | ${SEVERITY} | (diff) | ${SUMMARY} — pattern matched in added lines. Citations: ${CITATIONS}"
    FOUND=1
  done <<< "\$MATCHES"
fi

exit \$FOUND
GATE_SCRIPT_EOF
  chmod +x "$SCRIPT_PATH"
  echo "  Tier-A: Created gate.d/${SLUG}.sh (citations=$CITATIONS)"
done
```

After drafting all Tier-A scripts, open a single PR with all new gate.d scripts:

```bash
if [ "${#TIER_A_PROMOTIONS[@]}" -gt 0 ] && [ "$DRY_RUN" != "true" ]; then
  PROMO_BRANCH="feat/gate-d-promotion-$(date -u +%Y%m%d)"
  git -C "$REPO_PATH" checkout -b "$PROMO_BRANCH" "origin/${STAGING_BRANCH:-staging}" 2>/dev/null || \
    git -C "$REPO_PATH" checkout "$PROMO_BRANCH" 2>/dev/null
  git -C "$REPO_PATH" add "$GATE_D_DIR"
  git -C "$REPO_PATH" diff --cached --quiet || \
    git -C "$REPO_PATH" commit -s -m "feat(gate.d): promote ${#TIER_A_PROMOTIONS[@]} learned check(s) from Ledger patterns"
  git -C "$REPO_PATH" push -u origin "$PROMO_BRANCH"

  CITATIONS_BODY=""
  for candidate in "${TIER_A_PROMOTIONS[@]}"; do
    SLUG=$(echo "$candidate" | jq -r '.slug' 2>/dev/null)
    SUMMARY=$(echo "$candidate" | jq -r '.summary' 2>/dev/null)
    COUNT=$(echo "$candidate" | jq -r '.count' 2>/dev/null)
    CITS=$(echo "$candidate" | jq -r '[.citations[] | "#" + tostring] | join(", ")' 2>/dev/null)
    CITATIONS_BODY="${CITATIONS_BODY}
- **\`${SLUG}\`**: ${SUMMARY} — ${COUNT} validated occurrences (${CITS})"
  done

  gh pr create -R "$GH_REPO" \
    --base "${STAGING_BRANCH:-staging}" \
    --head "$PROMO_BRANCH" \
    --title "feat(gate.d): promote ${#TIER_A_PROMOTIONS[@]} learned check(s) from recurring patterns" \
    --body "$(cat <<PR_BODY_EOF
## Summary

This PR was generated by \`/optimize\` Phase 5. It promotes ${#TIER_A_PROMOTIONS[@]} recurring pattern(s) from the Forge Ledger into deterministic gate.d check scripts.

Each promoted script represents a defect class that appeared ≥3 times in validated findings for this codebase. Once merged, the check runs pre-commit on every future PR.

## Promoted checks
${CITATIONS_BODY}

## Review notes

**Please review each gate.d script carefully before merging.**

- Verify the grep pattern matches the intended defect class
- Test against a real diff that should fire (and one that should not)
- The pattern comment in each script links to the source finding issues
- Edit the \`PATTERN\` variable in the script if the auto-generated pattern needs refinement
- If a promoted check is incorrect, close this PR and file a rule-contest issue

## gate.d contract

Each script receives:
- \$1 = path to unified diff
- \$2 = path to worktree root
- exits 0 (pass), 1 (findings on stdout), or 2 (inapplicable)
- 30-second timeout enforced by quality-gate (fail-closed on timeout)

---
Generated by: \`/optimize\` Phase 5 — pattern promotion loop
PR_BODY_EOF
)"
  echo "Phase 5: Opened Tier-A promotion PR on branch $PROMO_BRANCH"
fi
```

### 5D: Draft Tier-B learned-rules.md entries

For each Tier-B candidate, append a prose entry to `devdocs/learned-rules/{domain}.md` and open a PR:

```bash
LEARNED_RULES_DIR="$REPO_PATH/devdocs/learned-rules"
mkdir -p "$LEARNED_RULES_DIR"

TIER_B_ENTRIES=""
for candidate in "${TIER_B_PROMOTIONS[@]}"; do
  SLUG=$(echo "$candidate" | jq -r '.slug' 2>/dev/null)
  DOMAIN=$(echo "$candidate" | jq -r '.domain // "GENERAL"' 2>/dev/null)
  SUMMARY=$(echo "$candidate" | jq -r '.summary' 2>/dev/null)
  COUNT=$(echo "$candidate" | jq -r '.count' 2>/dev/null)
  CITATIONS=$(echo "$candidate" | jq -r '[.citations[] | "#" + tostring] | join(", ")' 2>/dev/null)
  SEVERITY=$(echo "$candidate" | jq -r '.severity // "MEDIUM"' 2>/dev/null)
  RULES_FILE="$LEARNED_RULES_DIR/${DOMAIN}.md"

  if [ "$DRY_RUN" = "true" ]; then
    echo "  [DRY RUN] Would append to devdocs/learned-rules/${DOMAIN}.md — rule: $SLUG"
    continue
  fi

  # Create file with header if it doesn't exist
  if [ ! -f "$RULES_FILE" ]; then
    cat > "$RULES_FILE" << RULES_HEADER_EOF
# Learned Rules — ${DOMAIN} Domain

This file contains Tier-B prose rules promoted by \`/optimize\` from recurring validated findings.
These rules are injected into the quality gate's ${DOMAIN} domain scan to guide LLM-assisted checks.

Each rule carries citations to the source findings that justified its promotion.
Rules are removed when evidence is refuted (two sustained contests → promotion issue reopened).

<!-- FORGE:LEARNED_RULES domain=${DOMAIN} -->
RULES_HEADER_EOF
    echo "  Tier-B: Created $RULES_FILE"
  fi

  # Check if rule already exists (idempotent by slug)
  if grep -q "<!-- rule:${SLUG} -->" "$RULES_FILE" 2>/dev/null; then
    echo "  Tier-B: $SLUG already present in ${DOMAIN}.md — skipping"
    continue
  fi

  # Append the rule entry
  cat >> "$RULES_FILE" << RULE_EOF

## ${SLUG} <!-- rule:${SLUG} -->

**Severity**: ${SEVERITY}
**Pattern type**: Tier-B (prose — requires reasoning to detect)
**Validated occurrences**: ${COUNT}
**Citations**: ${CITATIONS}
**Promoted**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

${SUMMARY}

**What to check**: When reviewing ${DOMAIN} domain changes, flag any instance matching this pattern as \`SHELL-LEARNED-${SLUG} | ${SEVERITY} | {file} | {description}\`.

**Refutation**: If this rule produces a false finding, file a rule-contest issue with the blocked diff attached. One sustained contest → rule demoted to advisory. Two sustained contests → this rule entry is removed and the promotion issue is reopened.

---
RULE_EOF
  TIER_B_ENTRIES="${TIER_B_ENTRIES} devdocs/learned-rules/${DOMAIN}.md"
  echo "  Tier-B: Appended rule $SLUG to devdocs/learned-rules/${DOMAIN}.md (citations=$CITATIONS)"
done

# Open PR for Tier-B entries
if [ -n "$TIER_B_ENTRIES" ] && [ "$DRY_RUN" != "true" ]; then
  TIER_B_BRANCH="feat/learned-rules-promotion-$(date -u +%Y%m%d)"
  git -C "$REPO_PATH" checkout -b "$TIER_B_BRANCH" "origin/${STAGING_BRANCH:-staging}" 2>/dev/null || \
    git -C "$REPO_PATH" checkout "$TIER_B_BRANCH" 2>/dev/null
  # Stage only learned-rules files changed in this run
  for f in $TIER_B_ENTRIES; do
    git -C "$REPO_PATH" add "$f" 2>/dev/null || true
  done
  git -C "$REPO_PATH" diff --cached --quiet || \
    git -C "$REPO_PATH" commit -s -m "feat(learned-rules): promote ${#TIER_B_PROMOTIONS[@]} Tier-B prose rule(s) from Ledger patterns"
  git -C "$REPO_PATH" push -u origin "$TIER_B_BRANCH"

  gh pr create -R "$GH_REPO" \
    --base "${STAGING_BRANCH:-staging}" \
    --head "$TIER_B_BRANCH" \
    --title "feat(learned-rules): promote ${#TIER_B_PROMOTIONS[@]} Tier-B prose rule(s) from recurring patterns" \
    --body "$(cat <<TIER_B_PR_EOF
## Summary

This PR was generated by \`/optimize\` Phase 5. It adds ${#TIER_B_PROMOTIONS[@]} prose rule(s) to \`devdocs/learned-rules/\` from recurring Ledger patterns.

These are **Tier-B** rules — defect classes that cannot be caught by a mechanical grep but recur in LLM-assisted gate scans. Once merged, the relevant domain scan in \`/quality-gate\` will inject these rules as additional context (~200 tokens per domain).

## Review notes

- Verify each rule accurately describes the defect class and doesn't over-generalize
- Rules carry evidence citations — check that the cited findings actually justify the rule
- A builder can contest a rule by filing a rule-contest issue with the blocked diff
- Rules are injected as Tier-B guidance, not as mechanical blockers

---
Generated by: \`/optimize\` Phase 5 — pattern promotion loop
TIER_B_PR_EOF
)"
  echo "Phase 5: Opened Tier-B learned-rules promotion PR on branch $TIER_B_BRANCH"
fi
```

### 5E: Phase 5 summary

```bash
echo ""
echo "--- Phase 5: Promotion Loop Summary ---"
if [ "$DRY_RUN" = "true" ]; then
  echo "  Mode: DRY RUN — no PRs opened, no files written"
  echo "  Tier-A candidates: ${#TIER_A_PROMOTIONS[@]}"
  echo "  Tier-B candidates: ${#TIER_B_PROMOTIONS[@]}"
else
  echo "  Tier-A gate.d scripts promoted: ${#TIER_A_PROMOTIONS[@]}"
  echo "  Tier-B learned-rules entries promoted: ${#TIER_B_PROMOTIONS[@]}"
  echo ""
  echo "  Each promotion lands as a PR for human review before enforcement."
  echo "  Demotion is automatic on evidence; promotion requires a human."
fi
```

---

## Idempotency Guarantee

Running `/optimize` twice produces the same output. Specifically:
- Scripts are always overwritten, never appended to
- `registry.json` is always overwritten with current analysis results
- Generated timestamps in scripts and registry will update on each run (this is expected)
- Content of scripts changes only if the underlying patterns change
- Phase 5 is idempotent: existing gate.d scripts and learned-rules entries are detected by slug and skipped (not duplicated)

To verify: run `/optimize` twice and compare outputs — the only differences should be the `generated_at` timestamps.
