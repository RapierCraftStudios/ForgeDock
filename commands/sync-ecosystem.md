---
description: Detect API changes, sync satellite repos, and publish releases
argument-hint: [check | auto | status | publish | trigger | PR-number]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /sync-ecosystem — Cross-Project Sync & Publish

**Input**: $ARGUMENTS

When the `{project.name}` API surface changes (new parameters, endpoints, modes, pricing), satellite projects need updates. This command detects what changed, creates tracking issues, checks publication status, and publishes releases.

---

## Config Preamble

Before any phase runs, build the ecosystem registry from `forge.yaml → repos.satellites`.

```bash
# Read satellite repos from forge.yaml
# Each entry provides: prefix, repo, staging_branch, local_path
# (Optional: package, publish_workflow — read from each satellite's package.json / workflow files)
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"

# Gate: if repos section is absent or has no satellites, stop here
if [ -z "$(yq '.repos.satellites // empty' "$CONFIG_FILE" 2>/dev/null)" ]; then
  echo "No satellite repos configured in forge.yaml → repos.satellites."
  echo "Add entries to forge.yaml to use /sync-ecosystem:"
  echo ""
  echo "  repos:"
  echo "    satellites:"
  echo "      - prefix: \"sdk\""
  echo "        repo: \"your-org/your-sdk\""
  echo "        staging_branch: \"main\""
  echo "        local_path: \"/home/youruser/projects/your-sdk\""
  exit 0
fi

# For each satellite entry, resolve template variables:
#   {COMPONENT}        = prefix (e.g. "mcp", "sdk", "n8n")
#   {GH_REPO}          = repo   (e.g. "your-org/your-mcp-server")
#   {REPO_PATH}        = local_path  (e.g. "/home/youruser/projects/your-mcp-server")
#   {STAGING_BRANCH}   = staging_branch (e.g. "main")
#   {PACKAGE}          = read from {REPO_PATH}/package.json "name" field (npm)
#                        or {REPO_PATH}/pyproject.toml "name" field (PyPI)
#   {PUBLISH_WORKFLOW} = read from {REPO_PATH}/.github/workflows/ — the workflow
#                        triggered by GitHub Release (look for "on: release:")

# For monorepo satellites (multiple packages in one repo):
#   Use a subpath qualifier in local_path, e.g.:
#     local_path: "/home/youruser/projects/myproject"
#     subpaths:
#       python_sdk: "sdk/python"
#       node_sdk: "sdk/node"
#   Then {REPO_PATH}/sdk/python and {REPO_PATH}/sdk/node are the per-SDK roots.

PROJECT_NAME=$(yq '.project.name' "$CONFIG_FILE")
PROJECT_BOARD_OWNER=$(yq '.project_board.owner // .project.owner' "$CONFIG_FILE")
PROJECT_BOARD_NUMBER=$(yq '.project_board.project_number // empty' "$CONFIG_FILE")
PROJECT_BOARD_ID=$(yq '.project_board.project_id // empty' "$CONFIG_FILE")
```

---

## Ecosystem Registry

### Satellite Projects

Build the ecosystem registry from `forge.yaml → repos.satellites`. Each entry in the `satellites` array becomes one row in the registry:

| Field in `forge.yaml` | Maps to |
|-----------------------|---------|
| `satellites[].prefix` | `{COMPONENT}` — the short identifier used in issue routing (e.g. `mcp:5`) |
| `satellites[].repo` | `{GH_REPO}` — full `owner/repo` used in all `gh` commands |
| `satellites[].local_path` | `{REPO_PATH}` — absolute local path used in all `cd` commands |
| `satellites[].staging_branch` | `{STAGING_BRANCH}` — PR target branch for this satellite |
| Read from `{REPO_PATH}/package.json` | `{PACKAGE}` — npm package name |
| Read from `{REPO_PATH}/.github/workflows/` | `{PUBLISH_WORKFLOW}` — workflow file triggered on release |

**Example registry output** (what the agent constructs from your `forge.yaml`):

```
Component: {COMPONENT}
  Repo:             {GH_REPO}
  Local path:       {REPO_PATH}
  Package:          {PACKAGE} ({REGISTRY: npm or PyPI})
  Publish trigger:  GitHub Release → {PUBLISH_WORKFLOW}
```

Iterate over all `repos.satellites` entries before proceeding to Phase 1.

### Version Bump Rules

- **Satellite repos** (separate GitHub repos): Version lives in `package.json`. Must be bumped, committed, and pushed to `main` BEFORE creating the GitHub Release tag. The release tag must match the version (`v{VERSION}`).
- **Monorepo packages** (SDKs or tools inside a single repo): Version lives in `pyproject.toml` / `package.json` in the monorepo. Must be bumped, committed, and pushed to `main` BEFORE triggering the publish workflow.

---

## Command Router

| Input | Action |
|-------|--------|
| `check` or empty | Scan recent PRs for API changes, report what needs syncing |
| `auto` | Same as check, but auto-create issues in satellite repos |
| `status` | Check publication status of ALL ecosystem components (code vs published versions) |
| `publish` | Bump versions, cut releases, and trigger publishes for all components with unpublished changes |
| `publish {COMPONENT}` | Publish a specific component by prefix |
| `trigger` | Detect open `FORGE:CROSS_REPO_TRIGGER` issues in this repo and process them (auto-run `/work-on` or prompt maintainer) |
| `PR-number` (e.g., `#1500`) | Analyze a specific PR for ecosystem impact |

---

## Phase 1: Detect API Surface Changes

**Skip this phase if input is `status` or `publish`.**

### If input is a PR number:

```bash
# Get the PR diff
gh pr diff {PR_NUMBER} --name-only
gh pr view {PR_NUMBER} --json title,body,files
```

### If input is `check` or `auto`:

```bash
# Find recent merged PRs to staging or main (last 7 days)
gh pr list --state merged --base {branches.staging} --limit 20 --json number,title,mergedAt,files
gh pr list --state merged --base {branches.default} --limit 10 --json number,title,mergedAt,files
```

### Analyze changes for sync triggers

Scan the changed files for API surface modifications. The file patterns below are illustrative — adapt to your project's structure:

| File Pattern | Trigger Type | Satellite Impact |
|-------------|--------------|------------------|
| API router files (`routers/`, `controllers/`) | New/changed parameters or endpoints | All satellites |
| Schema files (`schemas/`, `types/`) | Schema changes | All satellites |
| Pricing/billing files | Pricing/credit changes | Satellites exposing cost estimates |
| New router/controller file | New endpoint | All satellites |
| Auth files | Auth changes | All satellite credential configs |
| Existing SDK subpath | SDK already updated | Check if other satellites need matching update |

**Read the actual diff** for each matched file to understand what specifically changed (new parameter, renamed field, new endpoint, etc.).

---

## Phase 2: Map Impact to Satellite Projects

For each detected change, determine which satellite projects need updates:

```yaml
# Example impact map
changes:
  - description: "Added `cookies` parameter to /api/v1/scrape"
    source_pr: "#1800"
    impacts:
      - repo: "{GH_REPO}"           # e.g. your-org/your-mcp-server
        what: "Add `cookies` param to scrape tool schema"
        files: ["{REPO_PATH}/src/tools/scrape.ts"]
      - repo: "{GH_REPO}"           # e.g. your-org/your-n8n-node
        what: "Add `cookies` field to Scrape operation"
        files: ["{REPO_PATH}/nodes/YourNode/YourNode.node.ts"]
      - repo: "{GH_REPO} (monorepo)" # e.g. your-org/your-project
        what: "Add `cookies` kwarg to client.scrape()"
        files: ["{REPO_PATH}/sdk/python/src/client.py"]
      - repo: "{GH_REPO} (monorepo)"
        what: "Add `cookies` option to scrape()"
        files: ["{REPO_PATH}/sdk/node/src/index.ts"]
```

**Check if sync is already done**: Before creating issues, check if the satellite repo already has the change:

```bash
# For each satellite repo (check git main, not local disk — local may be stale):
cd {REPO_PATH} && git fetch origin main && git show origin/main:{RELEVANT_FILE} | grep -n "{FEATURE}"

# For monorepo satellites with subpaths:
cd {REPO_PATH} && git show origin/main:{SUBPATH}/{RELEVANT_FILE} | grep -n "{FEATURE}"
```

If the change already exists in a satellite's `origin/main` → skip it (code synced). Then check if it's also **published** (see Phase 5).

---

## Phase 3: Report or Create Issues

### If `check` mode:

Report what needs syncing without creating issues:

```
## Ecosystem Sync Report

### API Changes Detected
{list of changes from recent PRs}

### Sync Needed

| Repo | Change Needed | Source PR | Status |
|------|--------------|-----------|--------|
| {GH_REPO} | Add `cookies` to scrape tool | #1800 | Needs sync |
| {GH_REPO} | Add `cookies` to Scrape op | #1800 | Needs sync |
| {GH_REPO} (sdk/python) | Already has `cookies` | #1800 | In sync |
| {GH_REPO} (sdk/node) | Add `cookies` option | #1800 | Needs sync |

Run `/sync-ecosystem auto` to create issues automatically.
```

**Always append the Phase 5 publication status table** to `check` output — code sync is not enough, users need to know if changes are published.

### If `auto` mode:

Create issues in the affected repos:

```bash
# For satellite repos (separate GitHub repos):
gh issue create -R {TARGET_REPO} \
  --title "feat(sync): {description of what API change needs to be reflected}" \
  --label "feature,priority:P2" \
  --body "$(cat <<'BODY_EOF'
## Problem

{1-3 sentences: what API or schema change in the upstream repo needs to be reflected in this satellite repo. What will break or be missing if this sync is not done.}

## Root Cause (if known)

The upstream {project.name} API changed in PR #{SOURCE_PR}: {brief description of the change}. This satellite repo must be updated to stay in sync.

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific sync criterion — e.g., new parameter available in tool schema}
- [ ] Changes passed through to {project.name} API correctly
- [ ] TypeScript types / validation schemas updated

## Context

**Source**: {SOURCE_REPO} PR #{SOURCE_PR}
**Change**: {description of upstream API change}
**Detected by**: `/sync-ecosystem`

## API Reference

{If applicable: describe the new API shape with an example}
BODY_EOF
)"

# For monorepo issues (SDKs, packages inside a single repo):
gh issue create \
  --title "feat(sync): {description of what API change needs to be reflected}" \
  --label "feature,priority:P2" \
  --body "$(cat <<'BODY_EOF'
## Problem

{1-3 sentences: what API or schema change needs to be reflected in this SDK or package. What will be out of sync if not updated.}

## Root Cause (if known)

The upstream {project.name} API changed in PR #{SOURCE_PR}: {brief description of the change}. This SDK must be updated to expose the new capability.

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific sync criterion}
- [ ] Types and documentation updated to match new API
- [ ] No regression in existing SDK functionality

## Context

**Source**: {SOURCE_REPO} PR #{SOURCE_PR}
**Change**: {description of upstream API change}
**Detected by**: `/sync-ecosystem`
BODY_EOF
)"
```

### Add sync issues to Project board

For each created issue, add it to the GitHub Project with `Lane=Sync` and the correct `Component`. Reference `docs/WORKFLOW.md` → "Project Board Integration" for field IDs (or read them from `forge.yaml → project_board`).

```bash
# For each created issue:
ISSUE_URL="https://github.com/{TARGET_REPO}/issues/${ISSUE_NUM}"
ITEM_ID=$(gh project item-add {project_board.project_number} --owner {project_board.owner} --url "$ISSUE_URL" --format json --jq '.id' 2>/dev/null)
if [ -n "$ITEM_ID" ]; then
  gh project item-edit --project-id {project_board.project_id} --id "$ITEM_ID" \
    --field-id {project_board.field_ids.status} \
    --single-select-option-id {project_board.option_ids.status.todo} 2>/dev/null || true
  gh project item-edit --project-id {project_board.project_id} --id "$ITEM_ID" \
    --field-id {project_board.field_ids.lane} \
    --single-select-option-id {project_board.option_ids.lane.sync} 2>/dev/null || true
  gh project item-edit --project-id {project_board.project_id} --id "$ITEM_ID" \
    --field-id {project_board.field_ids.component} \
    --single-select-option-id {COMPONENT_OPTION_ID} 2>/dev/null || true
  gh project item-edit --project-id {project_board.project_id} --id "$ITEM_ID" \
    --field-id {project_board.field_ids.priority} \
    --single-select-option-id {project_board.option_ids.priority.p2} 2>/dev/null || true
fi
```

### Report created issues:

```
## Ecosystem Sync: {N} issues created

| # | Repo | Issue | Priority |
|---|------|-------|----------|
| {COMPONENT}:#{NUM} | {GH_REPO} | {CHANGE_DESCRIPTION} | P2 |

Run `/orchestrate {COMPONENT}:#{NUM} ...` to implement all sync issues in parallel.
```

---

## Phase 4: Version Bump Tracking

If the API change warrants a version bump in satellite packages:

```
### Version Bumps Needed

| Package | Current | Suggested | Reason |
|---------|---------|-----------|--------|
| {PACKAGE} ({REGISTRY}) | {CURRENT_VERSION} | {NEW_VERSION} | {CHANGE_DESCRIPTION} |
```

Include version bump instructions in the created issues.

---

## Phase 5: Publication Status Check

**Run this phase for ALL inputs** (`check`, `auto`, `status`, `publish`). This is the critical gap — code being merged to `main` is NOT the same as being published to npm/PyPI.

### 5A: Collect current versions (code vs published)

For each satellite in `repos.satellites`, collect code version vs published version:

```bash
# For each satellite: {COMPONENT}, {GH_REPO}, {REPO_PATH}, {PACKAGE}

echo "=== {COMPONENT} ==="
# Version in code (on main):
cd {REPO_PATH} && git fetch origin main 2>/dev/null
CODE_VERSION=$(git show origin/main:package.json | grep '"version"' | head -1 | grep -oP '\d+\.\d+\.\d+')
# (For pyproject.toml: git show origin/main:pyproject.toml | grep '^version' | grep -oP '\d+\.\d+\.\d+')
echo "Code version: $CODE_VERSION"

# Latest GitHub release:
LATEST_RELEASE=$(gh release list -R {GH_REPO} --limit 1 --json tagName,publishedAt \
  --jq '.[0] | "\(.tagName) (\(.publishedAt))"' 2>/dev/null)
echo "Latest release: $LATEST_RELEASE"

# Commits since last release tag:
RELEASE_TAG=$(gh release list -R {GH_REPO} --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null)
COMMITS_SINCE=$(git rev-list ${RELEASE_TAG}..origin/main --count 2>/dev/null || echo "unknown")
echo "Commits since release: $COMMITS_SINCE"
```

For monorepo packages that use `workflow_dispatch` instead of GitHub Releases:

```bash
# Check last publish workflow run date
LAST_PUBLISH=$(gh run list --repo {GH_REPO} --workflow={PUBLISH_WORKFLOW} \
  --status=success --limit 1 \
  --json createdAt,headBranch \
  --jq '.[0] | "\(.headBranch) (\(.createdAt))"' 2>/dev/null)
echo "Last publish: $LAST_PUBLISH"
```

### 5B: Determine what needs publishing

A component needs publishing when ANY of these are true:
- Commits exist on `main` after the last release tag (for satellite repos)
- The version in code is newer than the last published version
- The last publish workflow run predates commits that changed the package source

### 5C: Report publication status

```
## Publication Status

| Component | Code Version | Published Version | Commits Behind | Status |
|-----------|-------------|-------------------|----------------|--------|
| {COMPONENT} ({REGISTRY}) | {CODE_VERSION} | {RELEASE_TAG} | {N} commits | {PUBLISHED / STALE} |

{If any STALE:}
Run `/sync-ecosystem publish` to bump versions and publish all stale components.
```

---

## Phase 6: Publish Releases

**Only run when input is `publish` (or `publish {COMPONENT}`).** This phase bumps versions, creates releases, and triggers publish workflows.

**IMPORTANT**: Always confirm with the user before publishing. Show the Phase 5 status table and ask: "These components will be published. Proceed?"

### 6A: Determine version bumps

For each stale component, determine the appropriate semver bump:

| Change Type | Bump | Example |
|------------|------|---------|
| New parameter/field (additive) | MINOR | 1.2.0 → 1.3.0 |
| Bug fix, formatting, internal | PATCH | 1.2.0 → 1.2.1 |
| Breaking change (removed/renamed field) | MAJOR | 1.2.0 → 2.0.0 |

Read the commit log since the last release to determine the bump type:

```bash
# For each satellite:
cd {REPO_PATH}
git log ${RELEASE_TAG}..origin/main --oneline --no-merges
# Look for feat: (MINOR), fix: (PATCH), or BREAKING CHANGE (MAJOR)
```

### 6B: Publish satellite repos (separate GitHub repos)

For each satellite repo that needs publishing:

```bash
cd {REPO_PATH}

# 1. Pull latest main
git checkout main && git pull origin main

# 2. Bump version in package.json
npm version {minor|patch|major} --no-git-tag-version

# 3. Commit the version bump
NEW_VERSION=$(grep '"version"' package.json | grep -oP '\d+\.\d+\.\d+')
git add package.json package-lock.json
git commit -m "chore: bump version to ${NEW_VERSION}"
git push origin main

# 4. Create GitHub Release (triggers {PUBLISH_WORKFLOW} automatically)
gh release create "v${NEW_VERSION}" \
  --repo {GH_REPO} \
  --title "v${NEW_VERSION}" \
  --generate-notes \
  --target main

# 5. Verify publish workflow started
sleep 5
gh run list --repo {GH_REPO} --workflow={PUBLISH_WORKFLOW} --limit 1 --json status,conclusion
```

### 6C: Publish monorepo packages (SDKs and tools inside a shared repo)

Monorepo packages use a `workflow_dispatch` workflow triggered manually (not on GitHub Release):

```bash
cd {REPO_PATH}

# 1. Check if package versions need bumping (compare code version to last publish)
PY_VERSION=$(git show origin/main:{SUBPATH}/pyproject.toml | grep '^version' | grep -oP '\d+\.\d+\.\d+')
NODE_VERSION=$(git show origin/main:{SUBPATH}/package.json | grep '"version"' | head -1 | grep -oP '\d+\.\d+\.\d+')

# 2. If versions already bumped in code, just trigger the publish
# If versions need bumping, create a worktree, bump, commit, push, then trigger

# 3. Trigger publish workflow
gh workflow run {PUBLISH_WORKFLOW} --repo {GH_REPO} --ref main -f sdk=both

# 4. Verify workflow started
sleep 5
gh run list --repo {GH_REPO} --workflow={PUBLISH_WORKFLOW} --limit 1 --json status,conclusion,createdAt
```

**If versions need bumping** (code version matches last published version but code has changed):

```bash
# Create worktree for version bump
cd {REPO_PATH}
git worktree add ../{COMPONENT}-version-bump -b fix/{COMPONENT}-version-bump origin/main
cd ../{COMPONENT}-version-bump

# Bump version (example: pyproject.toml or package.json)
# Edit {SUBPATH}/pyproject.toml: version = "{NEW_VERSION}"
cd {SUBPATH} && npm version {minor|patch} --no-git-tag-version && cd -

# Commit and push
git add {SUBPATH}/pyproject.toml {SUBPATH}/package.json {SUBPATH}/package-lock.json
git commit -m "chore({COMPONENT}): bump version to {NEW_VERSION}"
git push origin fix/{COMPONENT}-version-bump

# Create PR to {STAGING_BRANCH}, merge, then trigger publish from main
gh pr create --repo {GH_REPO} --base {STAGING_BRANCH} \
  --title "chore: bump {COMPONENT} version to {NEW_VERSION}" \
  --body "Version bump for {COMPONENT} publish"
```

### 6D: Monitor publish workflows

After triggering publishes, monitor completion for each satellite:

```bash
echo "=== Publish Status ==="

# For each satellite: {COMPONENT}, {GH_REPO}, {PUBLISH_WORKFLOW}
echo "{COMPONENT}:"
gh run list --repo {GH_REPO} --workflow={PUBLISH_WORKFLOW} \
  --limit 1 --json status,conclusion,createdAt --jq '.[0]'
```

### 6E: Generate changelog for releases

When creating GitHub releases, generate notes from commits since the last tag:

```bash
# Collect commit messages since last release
cd {REPO_PATH}
CHANGES=$(git log ${LAST_TAG}..origin/main --oneline --no-merges | sed 's/^/- /')

# Create release body
cat <<EOF
## Changes

$CHANGES

## Ecosystem Sync

This release brings parity with {project.name} API changes from the following PRs:
{list of source PRs that drove these changes}
EOF
```

### 6F: Report publish results

```
## Publish Results

| Component | Old Version | New Version | Status | Registry |
|-----------|------------|-------------|--------|----------|
| {COMPONENT} | {OLD_VERSION} | {NEW_VERSION} | Published | {REGISTRY} |

### Verification

```bash
# Verify packages are live on registries:
npm view {PACKAGE} version          # for npm packages
pip index versions {PACKAGE} 2>/dev/null || pip install {PACKAGE}== 2>&1 | grep -oP '\d+\.\d+\.\d+'
```
```

---

## Trigger Handler: Process Incoming Cross-Repo Dispatch

**Only run when input is `trigger`.**

This phase handles the *inbound* side of cross-repo coordination: it discovers open issues in the current repo that were created by the `cross-repo-trigger.yml` GitHub Actions workflow (installed via `templates/cross-repo-trigger.yml` from #1021), validates them, and either invokes `/work-on` automatically or posts a human-readable prompt for the maintainer.

**Platform boundary note**: This subcommand handles *processing* of already-created trigger issues. *Detection* of new trigger issues without manual polling requires an always-on event listener — that is L2 Platform scope (GitHub App). The AGPL CLI tier implementation is: user or CI runs `/sync-ecosystem trigger` periodically or after receiving a GitHub notification.

### T1: Build satellite registry

Reuse the Config Preamble at the top of this file. The satellite registry (`repos.satellites`) is the authority for `auto_run` values — do NOT read `auto_run` from the trigger issue body.

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"

if [ -z "$(yq '.repos.satellites // empty' "$CONFIG_FILE" 2>/dev/null)" ]; then
  echo "No satellite repos configured in forge.yaml → repos.satellites."
  echo "Cannot determine auto_run policy for trigger issues."
  echo "Add satellite entries to forge.yaml, then re-run /sync-ecosystem trigger."
  exit 0
fi
```

### T2: Detect open trigger issues

```bash
# Find open issues in the current repo that contain the FORGE:CROSS_REPO_TRIGGER marker
TRIGGER_ISSUES=$(gh issue list \
  --search "FORGE:CROSS_REPO_TRIGGER in:body" \
  --state open \
  --limit 50 \
  --json number,title,body,url)

TRIGGER_COUNT=$(echo "$TRIGGER_ISSUES" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")

if [ "$TRIGGER_COUNT" -eq 0 ]; then
  echo "No open FORGE:CROSS_REPO_TRIGGER issues found. Nothing to process."
  exit 0
fi

echo "Found $TRIGGER_COUNT open trigger issue(s). Processing..."

# Export trigger issues under the name T3 expects
export TRIGGER_ISSUES_JSON="$TRIGGER_ISSUES"
```

### T3: Validate and process each trigger issue

For each open trigger issue, validate the body and dispatch the correct action.

```python
# Parse trigger issues and process each one
python3 -c "
import json, os, subprocess, sys

config_file = os.environ.get('FORGE_CONFIG', 'forge.yaml')

# Read satellite registry from forge.yaml
try:
    result = subprocess.run(
        ['python3', '-c', '''
import yaml, json, sys
with open(\"''' + config_file + '''\") as f:
    cfg = yaml.safe_load(f)
sats = (cfg.get('repos') or {}).get('satellites') or []
print(json.dumps([
    {'repo': s.get('repo',''), 'auto_run': bool(s.get('auto_run', False))}
    for s in sats if isinstance(s, dict) and s.get('repo')
]))
'''],
        capture_output=True, text=True
    )
    satellites = json.loads(result.stdout.strip() or '[]')
except Exception as e:
    print(f'ERROR reading forge.yaml satellites: {e}')
    sys.exit(1)

# Build lookup: upstream repo → auto_run
satellite_map = {s['repo']: s['auto_run'] for s in satellites}

# Read trigger issues (passed via stdin or environment)
trigger_issues_raw = os.environ.get('TRIGGER_ISSUES_JSON', '[]')
try:
    trigger_issues = json.loads(trigger_issues_raw)
except json.JSONDecodeError:
    trigger_issues = []

processed = 0
skipped = 0
NL = chr(10)

for issue in trigger_issues:
    number = issue.get('number')
    title  = issue.get('title', '')
    body   = issue.get('body', '') or ''
    url    = issue.get('url', '')

    # Guard: must contain the marker
    if 'FORGE:CROSS_REPO_TRIGGER' not in body:
        print(f'Issue #{number}: missing FORGE:CROSS_REPO_TRIGGER marker — skipping')
        skipped += 1
        continue

    # Validate required fields in body
    upstream_repo  = None
    pr_number      = None
    has_files      = False

    for line in body.splitlines():
        line_s = line.strip()
        if line_s.startswith('- Upstream repo:'):
            upstream_repo = line_s.split(':', 1)[-1].strip()
        elif line_s.startswith('- Merged PR:'):
            parts = line_s.split('#', 1)
            if len(parts) > 1:
                pr_number = parts[1].split()[0].rstrip(')')
        elif line_s.startswith('- ') and '### Matched Files' in body:
            # presence of the matched-files list
            has_files = True

    # Accept any issue that has the marker + upstream repo + PR number
    if not upstream_repo or not pr_number:
        comment = (
            f'<!-- FORGE:TRIGGER_VALIDATION_FAILED -->{NL}'
            f'## Trigger Validation Failed{NL}{NL}'
            f'This issue is tagged with \`FORGE:CROSS_REPO_TRIGGER\` but is missing required fields:{NL}'
            f'- upstream repo: {\"present\" if upstream_repo else \"MISSING\"}{NL}'
            f'- PR number: {\"present\" if pr_number else \"MISSING\"}{NL}{NL}'
            f'Expected format is produced by \`templates/cross-repo-trigger.yml\`.{NL}'
            f'Please verify the issue body or recreate the trigger manually.{NL}'
        )
        subprocess.run(['gh', 'issue', 'comment', str(number), '--body', comment], capture_output=True)
        print(f'Issue #{number}: validation failed (upstream_repo={upstream_repo}, pr={pr_number}) — commented and skipped')
        skipped += 1
        continue

    # Look up auto_run from satellite registry
    auto_run = satellite_map.get(upstream_repo)

    if auto_run is None:
        # No satellite entry matches this upstream repo
        comment = (
            f'<!-- FORGE:TRIGGER_NO_SATELLITE -->{NL}'
            f'## No Satellite Entry Found{NL}{NL}'
            f'This trigger issue was created by an upstream merge in \`{upstream_repo}\`,{NL}'
            f'but \`forge.yaml → repos.satellites\` has no entry with \`repo: {upstream_repo}\`.{NL}{NL}'
            f'**Options**:{NL}'
            f'1. Add a satellite entry for \`{upstream_repo}\` to \`forge.yaml\` and re-run \`/sync-ecosystem trigger\`.{NL}'
            f'2. Close this issue if the trigger was unintended.{NL}'
        )
        subprocess.run(['gh', 'issue', 'comment', str(number), '--body', comment], capture_output=True)
        subprocess.run(['gh', 'issue', 'edit', str(number), '--add-label', 'needs-human'], capture_output=True)
        print(f'Issue #{number}: no satellite entry for {upstream_repo} — needs-human label added')
        skipped += 1
        continue

    if auto_run:
        # auto_run: true — add label and note that /work-on should be invoked
        print(f'Issue #{number}: auto_run=true for {upstream_repo} — invoking /work-on #{number}')
        comment = (
            f'<!-- FORGE:TRIGGER_AUTO_RUN -->{NL}'
            f'## Trigger Detected — Auto-Run Enabled{NL}{NL}'
            f'**Upstream**: \`{upstream_repo}\` PR \`#{pr_number}\`{NL}'
            f'**Policy**: \`auto_run: true\` in \`forge.yaml → repos.satellites\`{NL}{NL}'
            f'Invoking \`/work-on {number}\` to begin automated investigation.{NL}'
        )
        subprocess.run(['gh', 'issue', 'comment', str(number), '--body', comment], capture_output=True)
        subprocess.run(['gh', 'issue', 'edit', str(number), '--add-label', 'workflow:investigating'], capture_output=True)
        # Invoke /work-on — this returns control to the Claude Code session
        # Skill(skill='work-on', args=str(number))
        print(f'  -> Skill(skill=\"work-on\", args=\"{number}\")')
        processed += 1
    else:
        # auto_run: false — post human-readable comment prompting maintainer
        print(f'Issue #{number}: auto_run=false for {upstream_repo} — posting manual instruction')
        comment = (
            f'<!-- FORGE:TRIGGER_MANUAL -->{NL}'
            f'## Trigger Detected — Manual Run Required{NL}{NL}'
            f'**Upstream**: \`{upstream_repo}\` PR \`#{pr_number}\`{NL}'
            f'**Policy**: \`auto_run: false\` in \`forge.yaml → repos.satellites\`{NL}{NL}'
            f'A PR merged in \`{upstream_repo}\` has touched files that match this satellite\'s \`trigger_paths\`.{NL}'
            f'This may require investigation to check if your contracts, types, or integrations are affected.{NL}{NL}'
            f'**To process this trigger, run**:{NL}'
            f'\`\`\`{NL}'
            f'/work-on {number}{NL}'
            f'\`\`\`{NL}{NL}'
            f'Or close this issue if no action is needed.{NL}{NL}'
            f'> To enable automatic processing, set \`auto_run: true\` for \`{upstream_repo}\` in \`forge.yaml → repos.satellites\`.{NL}'
            f'> Note: \`auto_run: true\` requires an active Claude Code session with ForgeDock installed in this repo.{NL}'
        )
        subprocess.run(['gh', 'issue', 'comment', str(number), '--body', comment], capture_output=True)
        subprocess.run(['gh', 'issue', 'edit', str(number), '--add-label', 'needs-human'], capture_output=True)
        processed += 1

print(f'{NL}Trigger processing complete: {processed} processed, {skipped} skipped.')
"
```

**Usage note**: Call this subcommand with the `TRIGGER_ISSUES_JSON` environment variable set to the JSON output from step T2, or use the shell pipeline pattern below:

```bash
TRIGGER_ISSUES_JSON=$(gh issue list \
  --search "FORGE:CROSS_REPO_TRIGGER in:body" \
  --state open \
  --limit 50 \
  --json number,title,body,url) \
python3 -c "... (same script as T3 above) ..."
```

### T4: Report trigger processing results

After processing all trigger issues, output a summary:

```
## Trigger Processing Complete

| Issue | Upstream Repo | PR | auto_run | Action |
|-------|--------------|-----|----------|--------|
| #{NUMBER} | {UPSTREAM_REPO} | #{PR_NUMBER} | true | /work-on invoked |
| #{NUMBER} | {UPSTREAM_REPO} | #{PR_NUMBER} | false | Manual comment posted |
| #{NUMBER} | {UPSTREAM_REPO} | #{PR_NUMBER} | — | Validation failed — see comment |

{If auto_run issues were found:}
/work-on has been invoked for {N} issue(s). Each will run through the full investigation → build → review → merge pipeline.

{If manual issues were found:}
{N} trigger issue(s) are awaiting manual action. Open each issue and run /work-on {NUMBER} when ready.
```

---

## Error Handling

- **No API changes detected**: Report "No API surface changes found in recent PRs. Ecosystem is in sync." — but STILL run Phase 5 to check publication status.
- **Repo not accessible**: Skip and warn (e.g., "Could not access {GH_REPO} — check gh auth")
- **Duplicate issues**: Check for existing open issues with "Sync:" prefix before creating new ones
- **Publish workflow fails**: Report the failure, link to the workflow run, suggest manual investigation. Do NOT retry automatically.
- **Version conflict on npm/PyPI**: The version already exists on the registry. Bump to the next version and retry.
- **OIDC publish fails**: Check that the repo has npm/PyPI trusted publishing configured. See workflow files for required permissions.
- **No repos configured**: If `forge.yaml → repos.satellites` is empty or absent, the command outputs a configuration guide and exits. No error.
