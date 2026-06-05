---
description: AI-powered forge.yaml config generator — scans codebase, queries GitHub, fills all optional sections interactively
argument-hint: [--force | --section <name>]
---

# /forgedock-init — AI-Powered Config Generator

**Input**: $ARGUMENTS

You complete the `forge.yaml` configuration that `npx forgedock init` started. The CLI generates required sections (project, paths, branches) from auto-detection. Your job is to scan the codebase, query GitHub APIs, ask targeted clarifying questions, and produce a complete `forge.yaml` with every applicable optional section filled.

**Agent model policy**: Default `model: "sonnet"`. Fallback: `model: "opus"` if Sonnet is rate-limited.
**NEVER use plan mode (EnterPlanMode).**

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Fill all optional sections not yet configured |
| `--force` | Overwrite ALL optional sections without asking |
| `--section <name>` | Fill only one section: `repos`, `project_board`, `services`, `review`, or `verification` |

Parse `$ARGUMENTS` and set:
```
FORCE = true if --force present
TARGET_SECTION = value from --section <name>, or "all"
```

---

## Phase 1: Load forge.yaml

### 1A: Locate and read

```bash
FORGE_YAML="$(pwd)/forge.yaml"
if [ ! -f "$FORGE_YAML" ]; then
  echo "forge.yaml not found in current directory."
  echo ""
  echo "Run first:  npx forgedock init"
  echo ""
  echo "This generates the required skeleton (project, paths, branches)."
  echo "Then re-run /forgedock-init to complete the optional sections."
  exit 1
fi
cat "$FORGE_YAML"
```

### 1B: Extract required section values

Parse these from the existing file — they are needed for all subsequent queries:

```
OWNER     = project.owner
REPO      = project.repo
REPO_ROOT = paths.root
```

### 1C: Detect already-configured optional sections

For each optional section, check if it has an UNCOMMENTED entry in the file. A commented-out section (all lines starting with `#`) is NOT configured.

```bash
# Check which optional sections are already active (uncommented)
grep -q "^repos:" "$FORGE_YAML" && HAS_REPOS=true || HAS_REPOS=false
grep -q "^project_board:" "$FORGE_YAML" && HAS_PROJECT_BOARD=true || HAS_PROJECT_BOARD=false
grep -q "^services:" "$FORGE_YAML" && HAS_SERVICES=true || HAS_SERVICES=false
grep -q "^review:" "$FORGE_YAML" && HAS_REVIEW=true || HAS_REVIEW=false
grep -q "^verification:" "$FORGE_YAML" && HAS_VERIFICATION=true || HAS_VERIFICATION=false
```

If `FORCE=false` and a section is already active, skip it (unless `--section` targets it explicitly). Tell the user which sections were skipped and why.

---

## Phase 2: Codebase Scan

Run these scans unconditionally — they populate defaults that reduce the number of clarifying questions needed.

### 2A: Tech stack detection

```bash
# Node.js / TypeScript
[ -f "$REPO_ROOT/package.json" ] && \
  cat "$REPO_ROOT/package.json" | grep -E '"name"|"dependencies"|"devDependencies"' | head -30

# Python
[ -f "$REPO_ROOT/pyproject.toml" ] && grep -E "^\[project\]|^name|^requires-python|^dependencies" "$REPO_ROOT/pyproject.toml" | head -20
[ -f "$REPO_ROOT/requirements.txt" ] && head -20 "$REPO_ROOT/requirements.txt"

# Rust
[ -f "$REPO_ROOT/Cargo.toml" ] && grep -E "^\[package\]|^name|^edition|^\[dependencies\]" "$REPO_ROOT/Cargo.toml" | head -20

# Ruby
[ -f "$REPO_ROOT/Gemfile" ] && head -15 "$REPO_ROOT/Gemfile"

# Go
[ -f "$REPO_ROOT/go.mod" ] && head -10 "$REPO_ROOT/go.mod"
```

Build `TECH_STACK` description from findings (e.g., "Next.js 15, FastAPI, PostgreSQL").

### 2B: Project context

```bash
# CLAUDE.md — primary context source
[ -f "$REPO_ROOT/CLAUDE.md" ] && cat "$REPO_ROOT/CLAUDE.md"

# README.md — fallback
[ -f "$REPO_ROOT/README.md" ] && head -60 "$REPO_ROOT/README.md"
```

Extract a 2–4 sentence project description for `review.context`.

### 2C: Docker / service names

```bash
# Container name prefixes for verification section
ls "$REPO_ROOT"/docker-compose*.yml 2>/dev/null
for f in "$REPO_ROOT"/docker-compose*.yml; do
  [ -f "$f" ] || continue
  grep -E "^\s+container_name:|^\s+image:" "$f" | head -20
done
```

Extract container name prefixes (e.g., `acme-`, `my-app-`) for `verification.internal_service_patterns` and `verification.services`.

### 2D: Branch topology

```bash
# Staging branch detection
git -C "$REPO_ROOT" branch -r | grep -E "staging|develop|dev" | head -5

# CI/CD target branches
grep -rh "branches:" "$REPO_ROOT/.github/workflows/"*.yml 2>/dev/null | head -20
```

Use to confirm or suggest `branches.staging`.

### 2E: API health endpoint hints

```bash
# Look for health route definitions
grep -rn "health\|/ping\|/status" "$REPO_ROOT" --include="*.py" --include="*.ts" --include="*.go" -l 2>/dev/null | head -10
grep -rn "healthcheck\|health_endpoint\|HEALTH_URL" "$REPO_ROOT" --include="*.yml" --include="*.yaml" -l 2>/dev/null | head -5
```

---

## Phase 3: GitHub Queries

Run these to gather live IDs. Failures are non-blocking — skip the section if the query fails.

### 3A: Check GitHub auth

```bash
gh auth status 2>&1
```

If not authenticated, skip all GitHub queries and note which sections will need manual completion.

### 3B: Project board discovery

```bash
# List projects owned by this org/user
gh project list --owner "$OWNER" --format json 2>/dev/null \
  | jq '.projects[] | {number: .number, title: .title, id: .id}'
```

If projects found: ask the user which one ForgeDock should use (or `none`). Record:
- `PROJECT_NUMBER`
- `PROJECT_ID` (the `PVT_...` node ID)

### 3C: Project board field IDs

```bash
# Only run if PROJECT_NUMBER is set
gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json 2>/dev/null \
  | jq '.fields[] | {name: .name, id: .id, type: .type}'
```

Map field names to their IDs:
- Look for fields named `Status`, `Lane`, `Component`, `Priority`, `Workflow` (case-insensitive)
- Record their `PVTSSF_...` IDs

```bash
# Get option IDs for single-select fields
gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json 2>/dev/null \
  | jq '.fields[] | select(.type == "SINGLE_SELECT") | {name: .name, options: [.options[] | {name: .name, id: .id}]}'
```

Map option names to IDs for `status` (Todo/In Progress/Done), `lane` (Fast/Feature/Sync), `priority` (P0/P1/P2/P3), `workflow` (Investigating/Building/In Review/Merged).

### 3D: Satellite repo discovery

```bash
# List all repos under this owner
gh repo list "$OWNER" --limit 50 --json name,description,url 2>/dev/null \
  | jq '.[] | select(.name != "'"$REPO"'") | {name: .name, description: .description}'
```

Present the list and ask: "Do any of these serve as satellite repos that you'd route issues to with a prefix (e.g., `mcp:5`)?"

---

## Phase 4: Interactive Clarification

Ask only about items NOT already determined by Phases 2–3. Keep questions grouped by section. Use `read` or present multiple-choice.

### 4A: repos section

Only ask if satellite repos were found in 3D:

```
The following repos were found under {OWNER}:
  - {repo_name}: {description}
  (...)

Do any of these serve as satellite repos for ForgeDock routing?
If yes, enter a prefix:repo mapping (e.g., "mcp:acme-mcp-server"), or "none":
```

### 4B: project_board section

If project board found in 3B but field mapping is ambiguous:

```
Found project board: "{TITLE}" (#{PROJECT_NUMBER})

Field mapping (press Enter to accept detected name, or type correct field name):
  Status field   → detected: "{DETECTED}" (ID: {ID})
  Lane field     → detected: "{DETECTED}" (ID: {ID})
  ...
```

### 4C: services section

```
Does your project use any of the following analytics/monitoring services?
  [1] Umami (self-hosted)
  [2] Microsoft Clarity
  [3] Google Analytics 4
  [4] None / Skip this section

Enter numbers separated by commas (e.g., "1,3"), or "4" to skip:
```

If any selected, ask for the specific IDs/URLs required by each.

```
Do you have an API URL for health checks? (e.g., https://api.myproject.io)
Enter URL or press Enter to skip:
```

### 4D: review section

```
Detected tech stack: {TECH_STACK}

Is this accurate? Add/edit if needed, or press Enter to accept:
```

```
Any additional context for code reviewers? (unusual conventions, deploy setup, known pitfalls)
Press Enter to skip, or describe briefly:
```

### 4E: verification section

```
Detected potential health endpoint path: {DETECTED_PATH}
Full health URL (e.g., https://api.myproject.io/health), or press Enter to skip:
```

```
Detected container name prefixes: {PREFIXES}
Are these correct? Add/edit prefixes, or press Enter to accept:
```

---

## Phase 5: Write forge.yaml

### 5A: Preserve required sections

Read the current `forge.yaml` content. Extract the complete `project:`, `paths:`, and `branches:` blocks verbatim — they must not change.

### 5B: Build optional section YAML

For each optional section the user confirmed:

**repos** (if satellites confirmed):
```yaml
repos:
  default:
    repo: "{OWNER}/{REPO}"
    staging_branch: "{branches.staging}"
  satellites:
    - prefix: "{PREFIX}"
      repo: "{OWNER}/{SATELLITE_REPO}"
      staging_branch: "main"
      local_path: "{REPO_ROOT}/../{SATELLITE_REPO}"
```

**project_board** (if board and field IDs found):
```yaml
project_board:
  owner: "{OWNER}"
  project_number: {PROJECT_NUMBER}
  project_id: "{PROJECT_ID}"
  field_ids:
    status: "{STATUS_FIELD_ID}"
    lane: "{LANE_FIELD_ID}"
    component: "{COMPONENT_FIELD_ID}"
    priority: "{PRIORITY_FIELD_ID}"
    workflow: "{WORKFLOW_FIELD_ID}"
  option_ids:
    status:
      todo: "{TODO_OPTION_ID}"
      in_progress: "{IN_PROGRESS_OPTION_ID}"
      done: "{DONE_OPTION_ID}"
    lane:
      fast: "{FAST_OPTION_ID}"
      feature: "{FEATURE_OPTION_ID}"
    priority:
      p0: "{P0_OPTION_ID}"
      p1: "{P1_OPTION_ID}"
      p2: "{P2_OPTION_ID}"
      p3: "{P3_OPTION_ID}"
    workflow:
      investigating: "{INVESTIGATING_OPTION_ID}"
      building: "{BUILDING_OPTION_ID}"
      in_review: "{IN_REVIEW_OPTION_ID}"
      merged: "{MERGED_OPTION_ID}"
```

**services** (if analytics/monitoring confirmed):
```yaml
services:
  domain: "{ROOT_DOMAIN}"
  api_url: "{API_URL}"
  analytics:
    # Only include subsections the user confirmed
    umami:         # if selected
      url: "{UMAMI_URL}"
      website_id: "{UMAMI_WEBSITE_ID}"
    clarity:       # if selected
      project_id: "{CLARITY_PROJECT_ID}"
    ga4:           # if selected
      property_id: "{GA4_PROPERTY_ID}"
```

**review** (if tech stack or context provided):
```yaml
review:
  tech_stack: "{TECH_STACK}"
  context: |
    {PROJECT_CONTEXT}
```

**verification** (if health endpoint or containers found):
```yaml
verification:
  health_endpoint: "{HEALTH_ENDPOINT}"
  health_patterns:
    - '"status": "ok"'
  internal_service_patterns:
    - "{SERVICE_PREFIX}"
```

### 5C: Overwrite protection

For each optional section that is ALREADY ACTIVE in forge.yaml (detected in Phase 1C):

If `FORCE=false`:
```
forge.yaml already has an active {section}: section.
Overwrite it with newly detected values? [y/N]
```

If user says N: keep existing content for that section.

### 5D: Write the file

Backup the existing file:
```bash
cp "$FORGE_YAML" "${FORGE_YAML}.bak"
echo "Backed up: forge.yaml → forge.yaml.bak"
```

Write the complete new file: required sections (preserved verbatim) + active optional sections (newly generated) + inactive optional sections (left as commented-out blocks matching forge.yaml.example structure).

Print a summary of what was written:
```
forge.yaml updated:

  Required sections (preserved):
    ✓ project
    ✓ paths
    ✓ branches

  Optional sections (filled):
    ✓ repos          — 2 satellite(s) configured
    ✓ project_board  — field IDs from project "Acme Board" (#1)
    ✗ services       — skipped (no analytics services)
    ✓ review         — tech stack + context
    ✓ verification   — health endpoint configured

  Optional sections (skipped — still commented out):
    - services
```

---

## Phase 6: Validation

### 6A: Repo access

```bash
gh repo view "${OWNER}/${REPO}" --json name,url 2>/dev/null \
  || echo "WARNING: Cannot access ${OWNER}/${REPO} — check project.owner and project.repo"
```

### 6B: Path existence

```bash
[ -d "$(grep 'root:' "$FORGE_YAML" | head -1 | awk '{print $2}' | tr -d '"')" ] \
  && echo "✓ paths.root exists" \
  || echo "WARNING: paths.root does not exist on this machine"
```

### 6C: Project board ID resolution

```bash
# Only run if project_board section was written
if grep -q "^project_board:" "$FORGE_YAML"; then
  PROJECT_ID=$(grep "project_id:" "$FORGE_YAML" | head -1 | awk '{print $2}' | tr -d '"')
  gh api graphql -f query='query { node(id: "'"$PROJECT_ID"'") { id __typename } }' 2>/dev/null \
    | jq -e '.data.node.id' > /dev/null \
    && echo "✓ project_board.project_id resolves" \
    || echo "WARNING: project_board.project_id may be invalid — verify with: gh project list --owner ${OWNER}"
fi
```

### 6D: Satellite repo access

```bash
# Only run if repos.satellites section was written
if grep -q "^repos:" "$FORGE_YAML"; then
  # Extract satellite repo names and verify each is accessible
  grep -A 20 "^repos:" "$FORGE_YAML" | grep "repo:" | tail -n +2 | while read -r line; do
    SAT_REPO=$(echo "$line" | awk '{print $2}' | tr -d '"')
    gh repo view "$SAT_REPO" --json name 2>/dev/null \
      && echo "✓ satellite repo ${SAT_REPO} accessible" \
      || echo "WARNING: satellite repo ${SAT_REPO} not accessible — check prefix and repo name"
  done
fi
```

### 6E: Final report

```
forge.yaml is ready.

Validation results:
  {validation output from 6A–6D}

Next steps:
  1. If forge.yaml contains sensitive paths (credentials file, local paths):
       echo "forge.yaml" >> .gitignore
  2. Test the pipeline:
       /work-on next
  3. If any WARNING appeared above, edit forge.yaml to fix the flagged values.
  4. Backup file: forge.yaml.bak (delete when satisfied)

ForgeDock commands now use your project's config from forge.yaml.
```
