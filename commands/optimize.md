---
description: Analyze this repo and generate per-repo adaptive scripts from learned patterns, git history, and existing configuration
argument-hint: [--dry-run | --force | --no-registry]
install: extras
---

# /optimize — Per-Repo Adaptive Script Generation

**Input**: $ARGUMENTS

Proactively analyze the current repository and generate `.forgedock/scripts/` entries from `forge.yaml → learned:`, git commit history, and pipeline annotations — without waiting for a correction event. This is the proactive half of the learning loop; reactive capture happens in `/work-on` Phase 1D.

**Agent model policy**: Default `model: "sonnet"`. Fallback: `model: "opus"` if Sonnet is rate-limited.
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

## Idempotency Guarantee

Running `/optimize` twice produces the same output. Specifically:
- Scripts are always overwritten, never appended to
- `registry.json` is always overwritten with current analysis results
- Generated timestamps in scripts and registry will update on each run (this is expected)
- Content of scripts changes only if the underlying patterns change

To verify: run `/optimize` twice and compare outputs — the only differences should be the `generated_at` timestamps.
