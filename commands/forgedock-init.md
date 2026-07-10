---
description: AI-powered forge.yaml config generator — scans codebase, queries GitHub, auto-fills all optional sections from detection
argument-hint: [--preserve | --interactive | --section <name>]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /forgedock-init — AI-Powered Config Generator

**Input**: $ARGUMENTS

You complete the `forge.yaml` configuration that `npx forgedock init` started. The CLI generates required sections (project, paths, branches) from auto-detection. Your job is to scan the codebase, query GitHub APIs, and produce a complete `forge.yaml` with every applicable optional section filled — using detected values directly, without asking for confirmation.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Fill all optional sections — overwrite existing values with newly detected ones, skip sections with nothing detected |
| `--preserve` | Keep existing active section values unchanged — only fill sections that are not yet configured |
| `--interactive` | Ask confirmation for every detected value and present menus for optional features |
| `--section <name>` | Fill only one section: `repos`, `project_board`, `services`, `review`, or `verification` |

Parse `$ARGUMENTS` and set:
```
PRESERVE = true if --preserve present
INTERACTIVE = true if --interactive present (restores full questionnaire behavior for all sections)
TARGET_SECTION = value from --section <name>, or "all"
```

If both `--preserve` and `--interactive` are present, `--interactive` takes precedence (`PRESERVE = false`).

If `--section` was provided, validate the value immediately:

```bash
ALLOWED_SECTIONS="repos project_board services review verification"
if [ "$TARGET_SECTION" != "all" ]; then
  VALID=false
  for s in $ALLOWED_SECTIONS; do
    [ "$TARGET_SECTION" = "$s" ] && VALID=true && break
  done
  if [ "$VALID" = "false" ]; then
    echo "Error: '$TARGET_SECTION' is not a valid section name."
    echo ""
    echo "Valid sections: repos, project_board, services, review, verification"
    echo ""
    echo "Usage: /forgedock-init --section <name>"
    exit 1
  fi
fi
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

After extracting these values, validate that OWNER and REPO are non-empty and do not contain placeholder values. If placeholders are found, attempt auto-detection from the git remote before erroring:

```bash
OWNER_IS_PLACEHOLDER=false
REPO_IS_PLACEHOLDER=false
[ -z "$OWNER" ] || [ "$OWNER" = "your-github-org" ] && OWNER_IS_PLACEHOLDER=true
[ -z "$REPO" ] || [ "$REPO" = "your-repo-name" ] && REPO_IS_PLACEHOLDER=true

if [ "$OWNER_IS_PLACEHOLDER" = "true" ] || [ "$REPO_IS_PLACEHOLDER" = "true" ]; then
  echo "Placeholder values detected in forge.yaml — attempting auto-detection from git remote..."

  REMOTE_URL=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)
  DETECTED_OWNER=""
  DETECTED_REPO=""

  if [ -n "$REMOTE_URL" ]; then
    # SSH format: git@github.com:owner/repo.git
    if echo "$REMOTE_URL" | grep -qE '^git@[^:]+:'; then
      DETECTED_OWNER=$(echo "$REMOTE_URL" | sed -E 's|^git@[^:]+:([^/]+)/.*|\1|')
      DETECTED_REPO=$(echo "$REMOTE_URL" | sed -E 's|^git@[^:]+:[^/]+/||; s|\.git$||')
    # HTTPS format: https://github.com/owner/repo.git
    elif echo "$REMOTE_URL" | grep -qE '^https?://'; then
      DETECTED_OWNER=$(echo "$REMOTE_URL" | sed -E 's|^https?://[^/]+/([^/]+)/.*|\1|')
      DETECTED_REPO=$(echo "$REMOTE_URL" | sed -E 's|^https?://[^/]+/[^/]+/||; s|\.git$||')
    fi
  fi

  if [ -n "$DETECTED_OWNER" ] && [ -n "$DETECTED_REPO" ]; then
    echo "Auto-detected: owner=\"$DETECTED_OWNER\" repo=\"$DETECTED_REPO\""
    # Update forge.yaml in-place with detected values
    [ "$OWNER_IS_PLACEHOLDER" = "true" ] && \
      sed -i '/^project:/,/^[a-z]/{s|^  owner:.*|  owner: "'"$DETECTED_OWNER"'"|}' "$FORGE_YAML"
    [ "$REPO_IS_PLACEHOLDER" = "true" ] && \
      sed -i "s|^  repo:.*|  repo: \"$DETECTED_REPO\"|" "$FORGE_YAML"
    echo "forge.yaml updated with auto-detected values. Continuing..."
    # Re-read the corrected values
    OWNER="$DETECTED_OWNER"
    REPO="$DETECTED_REPO"
  else
    echo "Error: project.owner/project.repo contain placeholder values and auto-detection failed."
    echo ""
    echo "Could not detect owner/repo from git remote. Open forge.yaml and fill in the 'project:' section:"
    echo "  project:"
    echo "    owner: \"your-actual-github-org-or-username\""
    echo "    repo: \"your-actual-repo-name\""
    echo ""
    echo "Then re-run /forgedock-init."
    exit 1
  fi
fi
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

If `PRESERVE=true` and a section is already active, skip it (unless `--section` targets it explicitly). For skipped sections, tell the user: `{section}: already configured — skipped (--preserve). Use /forgedock-init --section {section} to update.`

If `PRESERVE=false` (the default) and a section is already active, it will be overwritten with newly detected values in Phase 5C — no prompt needed.

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

Build `DETECTED_HEALTH_PATH` from findings (e.g., `/health`, `/api/health`). If nothing found, leave empty.

### 2F: Analytics/services detection

```bash
# Umami — look for self-hosted instance config or tracking script
grep -rn "umami\|UMAMI_WEBSITE_ID\|umami.is" "$REPO_ROOT" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.env*" -l 2>/dev/null | head -5

# Microsoft Clarity
grep -rn "clarity\|CLARITY_PROJECT_ID\|clarity.ms" "$REPO_ROOT" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.html" -l 2>/dev/null | head -5

# Google Analytics 4
grep -rn "G-[A-Z0-9]\+\|GA4\|gtag\|NEXT_PUBLIC_GA_ID\|GA_MEASUREMENT_ID" "$REPO_ROOT" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.env*" -l 2>/dev/null | head -5
```

Build `DETECTED_ANALYTICS` list from findings:
- `DETECTED_UMAMI=true` if umami references found
- `DETECTED_CLARITY=true` if Clarity references found
- `DETECTED_GA4=true` if GA4 references found
- If none found, `DETECTED_ANALYTICS_EMPTY=true`

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

Store results in `FOUND_PROJECT_BOARDS`. Do NOT ask the user at this stage — Phase 4B decides based on the count of boards found. If exactly one is found, it will be used automatically. If multiple are found, Phase 4B will ask once. Record:
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

Store results in `SIBLING_REPOS`. Assess satellite signals for each repo — strong signals are: separate CI workflow files, separate `package.json`, separate staging branch. Do NOT ask the user at this stage — Phase 4A decides whether to ask based on signal strength.

---

## Phase 4: Resolve Values for Optional Sections

**Decision rule** (applies to every sub-phase below):
- **Auto-detected value** → use it directly. No confirmation prompt.
- **Genuine ambiguity** (e.g., multiple project boards, multiple candidates for the same field) → ask once with the detected candidates listed.
- **Nothing detected** → skip the section silently. Do NOT offer a menu or ask "do you want X?".
- **`--interactive` flag** → override the above and ask confirmation/selection for every section, even when detection found a clear answer.

### 4A: repos section

**Determine `SATELLITE_CANDIDATES`**: From `SIBLING_REPOS` (Phase 3D), filter to repos with strong satellite signals — repos that have their own CI workflow files, separate `package.json`, or a staging branch distinct from this repo's staging branch. Repos without any of these signals are NOT satellite candidates.

**Decision**:
- `SATELLITE_CANDIDATES` is non-empty AND `INTERACTIVE=false` → log detected candidates but do NOT configure satellites automatically (routing prefix assignments require human intent). Ask once:
  ```
  Detected potential satellite repos with separate CI/branches:
    - {repo_name}: {description}
    (...)

  Do any of these serve as ForgeDock routing satellites? Enter prefix:repo mappings
  (e.g., "mcp:acme-mcp-server,api:acme-api"), or press Enter to skip:
  ```
- `SATELLITE_CANDIDATES` is empty AND `INTERACTIVE=false` → skip this section silently.
- `INTERACTIVE=true` → present all sibling repos and ask which (if any) are satellites.

**Rationale**: Satellite routing prefix assignments require deliberate human intent — there is no safe auto-detection heuristic. Ask only when strong signals exist.

### 4B: project_board section

**Decision**:
- Exactly one project board found in 3B → use it. Auto-map field names to IDs. Only ask if field name matching is ambiguous (multiple fields could map to `Status`, etc.).
- Multiple project boards found → ask which one ForgeDock should use:
  ```
  Multiple project boards found under {OWNER}:
    [1] {TITLE_1} (#{NUMBER_1})
    [2] {TITLE_2} (#{NUMBER_2})
    ...

  Which board should ForgeDock use? Enter number, or press Enter to skip:
  ```
- Zero project boards found AND `INTERACTIVE=false` → skip this section silently.
- `INTERACTIVE=true` → present all boards and ask which one to use.

### 4C: services section

**Decision** (based on `DETECTED_ANALYTICS` from Phase 2F):
- `DETECTED_UMAMI=true` → record Umami; ask for the specific `UMAMI_URL` and `UMAMI_WEBSITE_ID` if not found in env/config files.
- `DETECTED_CLARITY=true` → record Clarity; ask for `CLARITY_PROJECT_ID` if not found in env/config files.
- `DETECTED_GA4=true` → record GA4; ask for `GA4_PROPERTY_ID` if not found in env/config files.
- `DETECTED_ANALYTICS_EMPTY=true` AND `INTERACTIVE=false` → skip this section silently.
- `INTERACTIVE=true` → present the full analytics menu regardless of detection:
  ```
  Does your project use any of the following analytics/monitoring services?
    [1] Umami (self-hosted)
    [2] Microsoft Clarity
    [3] Google Analytics 4
    [4] None / Skip this section

  Enter numbers separated by commas (e.g., "1,3"), or "4" to skip:
  ```

**API URL for health checks** (services.api_url):
- `DETECTED_HEALTH_PATH` is set (from Phase 2E) AND a domain is known → compose `API_URL` directly. Do not ask.
- Nothing detected AND `INTERACTIVE=false` → leave `api_url` empty in the section.
- `INTERACTIVE=true` → ask:
  ```
  Do you have an API URL for health checks? (e.g., https://api.myproject.io)
  Enter URL or press Enter to skip:
  ```

### 4D: review section

**Decision**:
- `TECH_STACK` built in Phase 2A → use it directly as `review.tech_stack`. Do not ask for confirmation.
- `review.context` → derive from `REPO_ROOT/CLAUDE.md` or README.md (Phase 2B) without prompting. Use the extracted 2–4 sentence description.
- `INTERACTIVE=true` → show detected value and ask:
  ```
  Detected tech stack: {TECH_STACK}
  Is this accurate? Add/edit if needed, or press Enter to accept:
  ```
  Then ask:
  ```
  Any additional context for code reviewers? (unusual conventions, deploy setup, known pitfalls)
  Press Enter to skip, or describe briefly:
  ```

### 4E: verification section

**Decision**:
- `DETECTED_HEALTH_PATH` is set (from Phase 2E) AND a base domain is known → compose full `HEALTH_ENDPOINT` URL directly. Do not ask.
- Container name prefixes detected in Phase 2C → use them directly as `internal_service_patterns`. Do not ask for confirmation.
- Nothing detected for health endpoint AND nothing detected for containers AND `INTERACTIVE=false` → skip this section silently.
- `INTERACTIVE=true` → show detected values and ask for confirmation:
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

For each optional section with detected or confirmed values (from Phase 4):

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
  project_id: "{PROJECT_ID}"  # Must be a PVT_... node ID — obtain via: gh project list --owner <owner> --format json | jq '.projects[] | .id'
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
    # Only include subsections detected (or selected in --interactive mode)
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

### 5C: Section merge strategy

For each optional section that is ALREADY ACTIVE in forge.yaml (detected in Phase 1C):

**Default behavior (`PRESERVE=false`)**:
- Overwrite the section with newly detected values.
- Record the old values before overwriting so the Phase 5D summary can show "was X → now Y".
- No prompt. This is the expected behavior when re-running `/forgedock-init` to refresh config.

**`--preserve` flag (`PRESERVE=true`)**:
- Keep the existing section content unchanged. Skip generating new content for this section.
- Phase 5D summary will show: `(preserved — existing values kept)`

**`--interactive` flag (`INTERACTIVE=true`)**:
- Show the detected new value alongside the existing value, then ask:
  ```
  {section}: section already configured.
  Current value: {EXISTING_VALUE}
  Detected value: {DETECTED_VALUE}
  Overwrite? [Y/n]
  ```
- Default is Y (overwrite). If user says N, keep existing content.

**`--section <name>` targeted mode**: Always overwrite the targeted section regardless of `PRESERVE` flag — the explicit targeting signals user intent to update that section.

### 5D: Write the file

Backup the existing file:
```bash
cp "$FORGE_YAML" "${FORGE_YAML}.bak"
echo "Backed up: forge.yaml → forge.yaml.bak"
```

Write the complete new file: required sections (preserved verbatim) + active optional sections (newly generated) + inactive optional sections (left as commented-out blocks matching forge.yaml.example structure).

Print a summary of what was written. For sections that were overwritten (existed before AND PRESERVE=false), show the old → new values for any field that changed. For sections that were newly added (did not exist before), show just the new values.

```
forge.yaml updated:

  Required sections (preserved):
    ✓ project
    ✓ paths
    ✓ branches

  Optional sections (filled):
    ✓ repos          — 2 satellite(s) configured (new)
    ✓ project_board  — field IDs from project "Acme Board" (#1)
                       was: project_number: 2 → now: project_number: 1
    ✓ review         — tech stack updated
                       was: "Node.js" → now: "Node.js 20, TypeScript, PostgreSQL"
    ✓ verification   — health endpoint configured (new)
    ✗ services       — skipped (nothing detected)

  Optional sections (skipped — still commented out):
    - services

  Optional sections (preserved — --preserve flag):
    - {section}  — kept existing values unchanged
```

If nothing changed for an overwritten section (detected values match existing values), show `(no change)` instead of a diff.

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

`project_board.project_id` must be a GitHub Projects v2 node ID with the `PVT_` prefix (e.g. `PVT_kwHOxxxxxxxxxxxxxxxx`). This value is returned by `gh project list --owner <owner> --format json | jq '.projects[] | .id'`. A manually-edited `forge.yaml` with an incorrect value (e.g. a project number instead of a node ID) will produce a confusing GraphQL error — the format check below catches this before attempting the API call.

```bash
# Only run if project_board section was written
if grep -q "^project_board:" "$FORGE_YAML"; then
  PROJECT_ID=$(grep "project_id:" "$FORGE_YAML" | head -1 | awk '{print $2}' | tr -d '"')
  # Validate PVT_ prefix before GraphQL call — any other format will produce a confusing API error
  if [[ "$PROJECT_ID" != PVT_* ]]; then
    echo "ERROR: project_board.project_id must start with 'PVT_' (got: '$PROJECT_ID')"
    echo "  Expected format: PVT_kwHOxxxxxxxxxxxxxxxx"
    echo "  Obtain the correct value with: gh project list --owner ${OWNER} --format json | jq '.projects[] | .id'"
  else
    gh api graphql -f query='query { node(id: "'"$PROJECT_ID"'") { id __typename } }' 2>/dev/null \
      | jq -e '.data.node.id' > /dev/null \
      && echo "✓ project_board.project_id resolves" \
      || echo "WARNING: project_board.project_id may be invalid — verify with: gh project list --owner ${OWNER}"
  fi
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
