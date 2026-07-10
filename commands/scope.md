---
description: Estimate issue complexity before running /work-on — affected files, blast radius, risk flags, and decomposition recommendation
argument-hint: <issue number> [--repo {owner}/{repo}]
install: extras
---

# /scope — Pre-Flight Complexity Estimator

**Input**: $ARGUMENTS

You are a read-only pre-flight analyst. Given a GitHub issue number, you estimate how complex it is BEFORE the user commits to running `/work-on`. You surface affected files, blast radius, dependency risks, estimated pipeline phases, and a decomposition recommendation.

**This command is strictly READ-ONLY.** No labels are written, no comments are posted, no worktrees are created.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

---

## Config Preamble

Read `forge.yaml` before running any phase:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ -f "$CONFIG_FILE" ]; then
  GH_OWNER=$(yq '.project.owner' "$CONFIG_FILE")
  GH_REPO_NAME=$(yq '.project.repo' "$CONFIG_FILE")
  GH_REPO="${GH_OWNER}/${GH_REPO_NAME}"
  GH_FLAG="-R $GH_REPO"
  REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
else
  echo "WARNING: forge.yaml not found."
  echo "Run: npx forgedock init"
  exit 1
fi
```

Parse `$ARGUMENTS`:
- `{NUMBER}` — issue number (required)
- `--repo {owner}/{repo}` — override GH_REPO (optional; useful for satellite repos)

If `--repo` is provided: set `GH_REPO` and `GH_FLAG` to the override value.

---

## Phase 1: Load Issue

```bash
gh issue view {NUMBER} {GH_FLAG} \
  --json number,title,body,labels,milestone,state
```

If the issue is CLOSED: print `Issue #{NUMBER} is already closed — scope analysis may not be actionable.` and continue anyway (the user may be scoping a re-open or reference).

Extract:
- `TITLE` — issue title (strip conventional commit prefix: `fix:`, `feat:`, `refactor:`, `chore:`)
- `BODY` — full body text
- `LABELS` — label names (used for domain detection)
- `MILESTONE` — milestone title if set (indicates feature lane)
- `TASK_TYPE` — infer from title prefix: `fix:` → Bug Fix, `feat:` → Feature, `refactor:` → Refactor, `chore:` → Maintenance, other → Unknown

---

## Phase 2: Extract Keywords

From `TITLE` and `BODY`, extract:
1. **Explicit file references** — anything matching `*.py`, `*.ts`, `*.tsx`, `*.md`, `*.yml`, `*.yaml`, `*.json`, `*.sh`, `docker-compose*`, `Dockerfile*` — collect as `EXPLICIT_FILES`
2. **Domain terms** — nouns and compound terms (e.g. function names, service names, component names, CLI command names) — collect as `DOMAIN_TERMS`
3. **Affected section files** — lines under `## Affected Files` section in the body (if present)

Merge `EXPLICIT_FILES` + `AFFECTED_SECTION_FILES` into `TARGET_FILES` (deduplicated).

Limit `DOMAIN_TERMS` to the 10 most specific (skip generic words: "fix", "bug", "issue", "add", "the", "and", "for", "with", "use", "get", "set").

---

## Phase 3: Affected-File Discovery

Search `REPO_PATH` for each keyword to find candidate files:

```bash
# {TARGET_FILES} and {DOMAIN_TERMS} are space-separated arguments (same contract
# as {AFFECTED_FILES} elsewhere) — split explicitly on IFS=' ' into arrays instead
# of a bare `for x in {PLACEHOLDER}`, which word-splits on the shell's default IFS
# (space, tab, AND newline) and would corrupt any file path or compound domain
# term containing a space.
IFS=' ' read -ra TARGET_FILES_ARR <<< "{TARGET_FILES}"
IFS=' ' read -ra DOMAIN_TERMS_ARR <<< "{DOMAIN_TERMS}"

# For each file explicitly named in the issue
for file in "${TARGET_FILES_ARR[@]}"; do
  find "$REPO_PATH" -name "$file" -not -path "*/.git/*" -not -path "*/node_modules/*" 2>/dev/null
done

# For each domain term: grep for references
for term in "${DOMAIN_TERMS_ARR[@]}"; do
  grep -rl "$term" "$REPO_PATH" \
    --include="*.py" --include="*.ts" --include="*.tsx" \
    --include="*.md" --include="*.yml" --include="*.yaml" \
    --include="*.json" --include="*.sh" \
    --exclude-dir=".git" --exclude-dir="node_modules" \
    --exclude-dir=".claude" 2>/dev/null | head -5
done

# Git log — files recently changed alongside the named files
if [ -n "{TARGET_FILES}" ]; then
  for file in "${TARGET_FILES_ARR[@]}"; do
    git -C "$REPO_PATH" log --oneline -20 -- "$file" \
      --name-only --format="" 2>/dev/null | grep -v "^$" | sort -u | head -10
  done
fi
```

Collect all results into `CANDIDATE_FILES` (deduplicated, sorted, absolute paths stripped to relative).

**Relevance filter**: Keep only files where the keyword match is in the file's primary logic — not in test fixtures, lock files, or generated output. Exclude: `*.lock`, `package-lock.json`, `yarn.lock`, `*.min.js`, `dist/`, `build/`, `.next/`, `__pycache__/`.

Final list: `AFFECTED_FILES` — at most 25 files.

---

## Phase 4: Blast Radius

From `AFFECTED_FILES`, compute:

```bash
# Count unique top-level directories
DIRS=$(echo "{AFFECTED_FILES}" | xargs -I{} dirname {} | sort -u)
DIR_COUNT=$(echo "$DIRS" | grep -c .)

# Count unique service groups (second-level directories under known roots)
# Adapt to project structure — common roots: services/, apps/, packages/, web/, commands/
SERVICE_GROUPS=$(echo "{AFFECTED_FILES}" | sed 's|/[^/]*$||' | sort -u)
SERVICE_COUNT=$(echo "$SERVICE_GROUPS" | grep -c .)

# Classify affected modules
MODULES=""
echo "{AFFECTED_FILES}" | grep -q "^commands/" && MODULES="$MODULES pipeline-commands"
echo "{AFFECTED_FILES}" | grep -q "^bin/" && MODULES="$MODULES installer"
echo "{AFFECTED_FILES}" | grep -q "^\.github/" && MODULES="$MODULES CI/CD"
echo "{AFFECTED_FILES}" | grep -q "^docs/" && MODULES="$MODULES docs"
echo "{AFFECTED_FILES}" | grep -q "services/" && MODULES="$MODULES backend-services"
echo "{AFFECTED_FILES}" | grep -q "web/" && MODULES="$MODULES frontend"
echo "{AFFECTED_FILES}" | grep -q "infra/\|docker-compose" && MODULES="$MODULES infrastructure"
echo "{AFFECTED_FILES}" | grep -q "migrations/" && MODULES="$MODULES database"
```

---

## Phase 5: Risk Flag Detection

Scan `AFFECTED_FILES` and the issue body for high-risk signals:

```bash
RISK_FLAGS=""

# Auth risk
(echo "{AFFECTED_FILES}" | grep -qiE "auth|login|session|token|jwt|oauth|permission|role" || \
 echo "$BODY" | grep -qiE "auth|login|session|token|jwt|oauth|permission|role") && \
  RISK_FLAGS="$RISK_FLAGS AUTH"

# Billing risk
(echo "{AFFECTED_FILES}" | grep -qiE "billing|payment|stripe|subscription|credit|invoice" || \
 echo "$BODY" | grep -qiE "billing|payment|stripe|subscription|credit|invoice") && \
  RISK_FLAGS="$RISK_FLAGS BILLING"

# Database migration risk
(echo "{AFFECTED_FILES}" | grep -qiE "migration|alembic|schema|model" || \
 echo "$BODY" | grep -qiE "migration|schema change|db migration|database") && \
  RISK_FLAGS="$RISK_FLAGS DB-MIGRATION"

# API schema / contract risk
(echo "{AFFECTED_FILES}" | grep -qiE "openapi|schema|serializer|types\.ts|api\.ts|client\.py" || \
 echo "$BODY" | grep -qiE "api.contract|breaking.change|response.shape|openapi") && \
  RISK_FLAGS="$RISK_FLAGS API-CONTRACT"

# CI/CD risk
(echo "{AFFECTED_FILES}" | grep -qiE "\.github/workflows|Dockerfile|docker-compose|deploy|infra/" || \
 echo "$BODY" | grep -qiE "deploy|CI|CD|workflow|dockerfile|container") && \
  RISK_FLAGS="$RISK_FLAGS CI-CD"

# Pipeline-phase risk (for ForgeDock itself)
echo "{AFFECTED_FILES}" | grep -qE "^commands/(work-on|review-pr|quality-gate|orchestrate)" && \
  RISK_FLAGS="$RISK_FLAGS PIPELINE-CORE"

# New env vars
echo "$BODY" | grep -qiE "env var|environment variable|\.env|getenv|process\.env" && \
  RISK_FLAGS="$RISK_FLAGS ENV-VARS"
```

---

## Phase 6: Complexity Scoring

Compute a complexity score from the signals collected:

| Signal | Points |
|--------|--------|
| Each affected file | +1 |
| Each unique directory | +2 |
| AUTH risk flag | +5 |
| BILLING risk flag | +5 |
| DB-MIGRATION risk flag | +4 |
| API-CONTRACT risk flag | +3 |
| CI-CD risk flag | +3 |
| PIPELINE-CORE risk flag | +4 |
| ENV-VARS risk flag | +2 |
| Milestone set (feature lane) | +3 |
| 2+ task type signals in body | +3 |

**Score bands**:
| Score | Band | Typical pipeline time |
|-------|------|-----------------------|
| 0–10 | TRIVIAL | 5–15 min (1-file fix, 1–2 pipeline phases) |
| 11–20 | SIMPLE | 20–40 min (2–5 files, all phases) |
| 21–35 | MODERATE | 45–90 min (5–10 files, possible review findings) |
| 36–55 | COMPLEX | 90–150 min (10+ files, multiple domains) |
| 56+ | DECOMPOSE | 2h+ (multiple task types, 3+ service groups) |

---

## Phase 7: Decomposition Recommendation

Apply the same signals `/work-on` uses to trigger decomposition. Recommend **decompose: YES** if 2+ of these signals match (at least 1 Strong):

**Strong signals**:
- [ ] 2+ distinct task types (Bug Fix + Feature, Refactor + Feature, etc.)
- [ ] 3+ service groups affected
- [ ] 6+ files across 3+ directories

**Supporting signals**:
- [ ] Phased requirements ("first do X, then Y, then Z")
- [ ] Score band is DECOMPOSE (56+)
- [ ] Both frontend and backend affected
- [ ] DB migration + API contract change in same issue

If decompose: YES — suggest 2–4 sub-issue titles based on the natural fault lines visible in the affected-file analysis.

---

## Phase 8: Output Scope Report

Print a structured scope report. Do NOT post it as a GitHub comment — print to stdout only.

```
╔══════════════════════════════════════════════════════════════╗
║  /scope — Issue #{NUMBER}: {TITLE}
╠══════════════════════════════════════════════════════════════╣
║  Task type : {TASK_TYPE}
║  Lane      : {Fast lane (no milestone) | Feature lane — milestone: {MILESTONE}}
║  Complexity: {SCORE} → {BAND}
║  Est. time : {TYPICAL_PIPELINE_TIME}
╠══════════════════════════════════════════════════════════════╣
║  AFFECTED FILES ({COUNT})
╠══════════════════════════════════════════════════════════════╣
{list each file — one per line, relative to REPO_PATH}
╠══════════════════════════════════════════════════════════════╣
║  BLAST RADIUS
║  Directories : {DIR_COUNT}
║  Modules     : {MODULES}
╠══════════════════════════════════════════════════════════════╣
║  RISK FLAGS
{if no flags: "  None detected"}
{for each flag: "  ⚠  {FLAG} — {brief note on what to watch for}"}
╠══════════════════════════════════════════════════════════════╣
║  DECOMPOSITION
║  Recommendation: {decompose: YES | decompose: NO}
{if YES:
"║  Signals met: {list matched signals}
║  Suggested sub-issues:
║    1. {sub-issue title}
║    2. {sub-issue title}
║  → Run /work-on {NUMBER} — it will auto-decompose based on investigation."
}
{if NO:
"║  → Safe to run /work-on {NUMBER} directly."
}
╚══════════════════════════════════════════════════════════════╝
```

Risk flag annotations:
- AUTH — review auth middleware, permission checks, and session handling carefully
- BILLING — get explicit sign-off before merging; test with real payment fixtures
- DB-MIGRATION — verify migration is reversible and tested on a copy of prod data
- API-CONTRACT — grep all consumers of the changed endpoint before shipping
- CI-CD — test workflow changes in a fork or staging environment first
- PIPELINE-CORE — changes to work-on/review-pr/quality-gate affect the entire AI dev loop; review-pr will run extra scrutiny
- ENV-VARS — ensure new vars are added to .env.example and all required config locations
