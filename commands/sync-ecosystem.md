---
description: Detect API changes, sync satellite repos, and publish releases (SDKs, MCP server, n8n node)
argument-hint: [check | auto | status | publish | PR-number]
---

# /sync-ecosystem — Cross-Project Sync & Publish

**Input**: $ARGUMENTS

When the AlterLab API surface changes (new parameters, endpoints, modes, pricing), satellite projects (SDKs, MCP server, n8n node) need updates. This command detects what changed, creates tracking issues, checks publication status, and publishes releases.

---

## Ecosystem Registry

### Satellite Projects

| Component | Repo | Local Path | Package | Publish Trigger |
|-----------|------|------------|---------|-----------------|
| MCP Server | `RapierCraft/alterlab-mcp-server` | `/home/mrdubey/projects/ScraperAPI/alterlab-mcp-server` | `alterlab-mcp-server` (npm) | GitHub Release → `publish-npm.yml` + `publish-mcp-registry.yml` |
| n8n Node | `RapierCraft/n8n-nodes-alterlab` | `/home/mrdubey/projects/ScraperAPI/n8n-nodes-alterlab` | `n8n-nodes-alterlab` (npm) | GitHub Release → `publish.yml` |
| Python SDK | monorepo `sdk/python/` | `/home/mrdubey/projects/ScraperAPI/alterlab/sdk/python` | `alterlab` (PyPI) | Manual `workflow_dispatch` → `publish-sdks.yml` (input: `python` or `both`) |
| Node SDK | monorepo `sdk/node/` | `/home/mrdubey/projects/ScraperAPI/alterlab/sdk/node` | `@alterlab/sdk` (npm) | Manual `workflow_dispatch` → `publish-sdks.yml` (input: `node` or `both`) |

### Version Bump Rules

- **Satellite repos** (MCP, n8n): Version lives in `package.json`. Must be bumped, committed, and pushed to `main` BEFORE creating the GitHub Release tag. The release tag must match the version (`v{VERSION}`).
- **SDKs** (Python, Node): Version lives in `pyproject.toml` / `package.json` in the monorepo. Must be bumped, committed, and pushed to `main` BEFORE triggering `publish-sdks.yml`.

---

## Command Router

| Input | Action |
|-------|--------|
| `check` or empty | Scan recent PRs for API changes, report what needs syncing |
| `auto` | Same as check, but auto-create issues in satellite repos |
| `status` | Check publication status of ALL ecosystem components (code vs published versions) |
| `publish` | Bump versions, cut releases, and trigger publishes for all components with unpublished changes |
| `publish mcp` / `publish n8n` / `publish sdks` | Publish a specific component |
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
gh pr list --state merged --base staging --limit 20 --json number,title,mergedAt,files
gh pr list --state merged --base main --limit 10 --json number,title,mergedAt,files
```

### Analyze changes for sync triggers

Scan the changed files for API surface modifications:

| File Pattern | Trigger Type | Satellite Impact |
|-------------|--------------|------------------|
| `services/api/app/routers/scrape*.py` | New/changed scrape parameters | SDKs, MCP, n8n |
| `services/api/app/schemas/scrape*.py` | Schema changes | SDKs, MCP, n8n |
| `services/api/app/routers/extract*.py` | Extraction changes | MCP, n8n |
| `services/api/app/core/pricing.py` | Pricing/credit changes | MCP (estimate tool), SDK docs |
| `services/api/app/routers/*.py` (new file) | New endpoint | SDKs, MCP |
| `services/api/app/auth/` | Auth changes | n8n credentials, SDK auth, MCP config |
| `sdk/python/` | SDK already updated | Check if n8n/MCP need matching update |
| `sdk/node/` | SDK already updated | Check if n8n/MCP need matching update |

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
      - repo: "RapierCraft/alterlab-mcp-server"
        what: "Add `cookies` param to scrape tool schema"
        files: ["src/tools/scrape.ts"]
      - repo: "RapierCraft/n8n-nodes-alterlab"
        what: "Add `cookies` field to Scrape operation"
        files: ["nodes/AlterLab/AlterLab.node.ts"]
      - repo: "sdk/python" (monorepo)
        what: "Add `cookies` kwarg to client.scrape()"
        files: ["sdk/python/alterlab/client.py"]
      - repo: "sdk/node" (monorepo)
        what: "Add `cookies` option to scrape()"
        files: ["sdk/node/src/index.ts"]
```

**Check if sync is already done**: Before creating issues, check if the satellite repo already has the change:

```bash
# For MCP server (check git main, not local disk — local may be stale):
cd /home/mrdubey/projects/ScraperAPI/alterlab-mcp-server && git fetch origin main && git show origin/main:src/tools/scrape.ts | grep -n "cookies"

# For n8n node:
cd /home/mrdubey/projects/ScraperAPI/n8n-nodes-alterlab && git fetch origin main && git show origin/main:nodes/AlterLab/AlterLab.node.ts | grep -n "cookies"

# For SDKs (check origin/main in monorepo):
cd /home/mrdubey/projects/ScraperAPI/alterlab && git show origin/main:sdk/python/alterlab/client.py | grep -n "cookies"
cd /home/mrdubey/projects/ScraperAPI/alterlab && git show origin/main:sdk/node/src/index.ts | grep -n "cookies"
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
| MCP Server | Add `cookies` to scrape tool | #1800 | Needs sync |
| n8n Node | Add `cookies` to Scrape op | #1800 | Needs sync |
| Python SDK | Already has `cookies` | #1800 | In sync |
| Node SDK | Add `cookies` option | #1800 | Needs sync |

Run `/sync-ecosystem auto` to create issues automatically.
```

**Always append the Phase 5 publication status table** to `check` output — code sync is not enough, users need to know if changes are published.

### If `auto` mode:

Create issues in the affected repos:

```bash
# For satellite repos (separate GitHub repos):
gh issue create -R {TARGET_REPO} \
  --title "feat(sync): {description of what API change needs to be reflected}" \
  --label "feature,P2" \
  --body "$(cat <<'BODY_EOF'
## Problem

{1-3 sentences: what API or schema change in the upstream repo needs to be reflected in this satellite repo. What will break or be missing if this sync is not done.}

## Root Cause (if known)

The upstream AlterLab API changed in PR #{SOURCE_PR}: {brief description of the change}. This satellite repo must be updated to stay in sync.

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific sync criterion — e.g., new parameter available in tool schema}
- [ ] Changes passed through to AlterLab API correctly
- [ ] TypeScript types / validation schemas updated

## Context

**Source**: {SOURCE_REPO} PR #{SOURCE_PR}
**Change**: {description of upstream API change}
**Detected by**: \`/sync-ecosystem\`

## API Reference

{If applicable: describe the new API shape with an example}
BODY_EOF
)"

# For monorepo issues (SDKs, chrome extension):
gh issue create \
  --title "feat(sync): {description of what API change needs to be reflected}" \
  --label "feature,P2" \
  --body "$(cat <<'BODY_EOF'
## Problem

{1-3 sentences: what API or schema change needs to be reflected in this SDK or extension. What will be out of sync if not updated.}

## Root Cause (if known)

The upstream AlterLab API changed in PR #{SOURCE_PR}: {brief description of the change}. This SDK must be updated to expose the new capability.

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
**Detected by**: \`/sync-ecosystem\`
BODY_EOF
)"
```

### Add sync issues to Project board

For each created issue, add it to the GitHub Project with `Lane=Sync` and the correct `Component`. Reference `~/projects/forge/docs/WORKFLOW.md` → "Project Board Integration" for field IDs.

```bash
# For each created issue:
ISSUE_URL="https://github.com/{TARGET_REPO}/issues/${ISSUE_NUM}"
ITEM_ID=$(gh project item-add 1 --owner RapierCraft --url "$ISSUE_URL" --format json --jq '.id' 2>/dev/null)
if [ -n "$ITEM_ID" ]; then
  gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF6E --single-select-option-id f75ad846 2>/dev/null || true  # Status=Todo
  gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF98 --single-select-option-id c0c37d33 2>/dev/null || true  # Lane=Sync
  gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF-o --single-select-option-id {COMPONENT_OPTION_ID} 2>/dev/null || true  # Component (MCP Server/n8n Node/Python SDK/Node SDK)
  gh project item-edit --project-id PVT_kwHOCx3gR84BSK2L --id "$ITEM_ID" --field-id PVTSSF_lAHOCx3gR84BSK2Lzg_yF8o --single-select-option-id 4d95eef3 2>/dev/null || true  # Priority=P2
fi
```

### Report created issues:

```
## Ecosystem Sync: {N} issues created

| # | Repo | Issue | Priority |
|---|------|-------|----------|
| mcp:#5 | alterlab-mcp-server | Add cookies to scrape tool | P2 |
| n8n:#12 | n8n-nodes-alterlab | Add cookies to Scrape op | P2 |
| #2100 | AlterLab (SDK) | Add cookies to Node SDK | P2 |

Run `/orchestrate mcp:5 n8n:12 #2100` to implement all sync issues in parallel.
```

---

## Phase 4: Version Bump Tracking

If the API change warrants a version bump in satellite packages:

```
### Version Bumps Needed

| Package | Current | Suggested | Reason |
|---------|---------|-----------|--------|
| alterlab (PyPI) | 2.0.1 | 2.1.0 | New `cookies` parameter |
| @alterlab/sdk (npm) | 2.0.1 | 2.1.0 | New `cookies` parameter |
| alterlab-mcp-server (npm) | 1.0.0 | 1.1.0 | New scrape tool param |
| n8n-nodes-alterlab (npm) | 0.5.0 | 0.6.0 | New Scrape field |
```

Include version bump instructions in the created issues.

---

## Phase 5: Publication Status Check

**Run this phase for ALL inputs** (`check`, `auto`, `status`, `publish`). This is the critical gap — code being merged to `main` is NOT the same as being published to npm/PyPI.

### 5A: Collect current versions (code vs published)

```bash
echo "=== MCP Server ==="
# Version in code (on main):
cd /home/mrdubey/projects/ScraperAPI/alterlab-mcp-server && git fetch origin main 2>/dev/null
MCP_CODE_VERSION=$(git show origin/main:package.json | grep '"version"' | head -1 | grep -oP '\d+\.\d+\.\d+')
echo "Code version: $MCP_CODE_VERSION"
# Latest GitHub release:
MCP_RELEASE=$(gh release list -R RapierCraft/alterlab-mcp-server --limit 1 --json tagName,publishedAt --jq '.[0] | "\(.tagName) (\(.publishedAt))"' 2>/dev/null)
echo "Latest release: $MCP_RELEASE"
# Commits since last release tag:
MCP_RELEASE_TAG=$(gh release list -R RapierCraft/alterlab-mcp-server --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null)
MCP_COMMITS_SINCE=$(git rev-list ${MCP_RELEASE_TAG}..origin/main --count 2>/dev/null || echo "unknown")
echo "Commits since release: $MCP_COMMITS_SINCE"

echo "=== n8n Node ==="
cd /home/mrdubey/projects/ScraperAPI/n8n-nodes-alterlab && git fetch origin main 2>/dev/null
N8N_CODE_VERSION=$(git show origin/main:package.json | grep '"version"' | head -1 | grep -oP '\d+\.\d+\.\d+')
echo "Code version: $N8N_CODE_VERSION"
N8N_RELEASE=$(gh release list -R RapierCraft/n8n-nodes-alterlab --limit 1 --json tagName,publishedAt --jq '.[0] | "\(.tagName) (\(.publishedAt))"' 2>/dev/null)
echo "Latest release: $N8N_RELEASE"
N8N_RELEASE_TAG=$(gh release list -R RapierCraft/n8n-nodes-alterlab --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null)
N8N_COMMITS_SINCE=$(git rev-list ${N8N_RELEASE_TAG}..origin/main --count 2>/dev/null || echo "unknown")
echo "Commits since release: $N8N_COMMITS_SINCE"

echo "=== Python SDK ==="
cd /home/mrdubey/projects/ScraperAPI/alterlab && git fetch origin main 2>/dev/null
PY_CODE_VERSION=$(git show origin/main:sdk/python/pyproject.toml | grep '^version' | grep -oP '\d+\.\d+\.\d+')
echo "Code version: $PY_CODE_VERSION"
# Last publish-sdks workflow run:
PY_LAST_PUBLISH=$(gh run list --workflow=publish-sdks.yml --status=success --limit 1 --json createdAt,headBranch --jq '.[0] | "\(.headBranch) (\(.createdAt))"' 2>/dev/null)
echo "Last SDK publish: $PY_LAST_PUBLISH"

echo "=== Node SDK ==="
NODE_CODE_VERSION=$(git show origin/main:sdk/node/package.json | grep '"version"' | head -1 | grep -oP '\d+\.\d+\.\d+')
echo "Code version: $NODE_CODE_VERSION"
echo "Last SDK publish: $PY_LAST_PUBLISH"  # Same workflow handles both
```

### 5B: Determine what needs publishing

A component needs publishing when ANY of these are true:
- Commits exist on `main` after the last release tag (for satellite repos)
- The version in code is newer than the last published version
- The last `publish-sdks.yml` run predates commits that changed `sdk/python/` or `sdk/node/`

### 5C: Report publication status

```
## Publication Status

| Component | Code Version | Published Version | Commits Behind | Status |
|-----------|-------------|-------------------|----------------|--------|
| MCP Server (npm) | {MCP_CODE_VERSION} | {MCP_RELEASE_TAG} | {N} commits | {PUBLISHED / STALE} |
| n8n Node (npm) | {N8N_CODE_VERSION} | {N8N_RELEASE_TAG} | {N} commits | {PUBLISHED / STALE} |
| Python SDK (PyPI) | {PY_CODE_VERSION} | last publish: {date} | — | {PUBLISHED / STALE} |
| Node SDK (npm) | {NODE_CODE_VERSION} | last publish: {date} | — | {PUBLISHED / STALE} |

{If any STALE:}
Run `/sync-ecosystem publish` to bump versions and publish all stale components.
```

---

## Phase 6: Publish Releases

**Only run when input is `publish` (or `publish <component>`).** This phase bumps versions, creates releases, and triggers publish workflows.

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
# For MCP server:
cd /home/mrdubey/projects/ScraperAPI/alterlab-mcp-server
git log ${MCP_RELEASE_TAG}..origin/main --oneline --no-merges
# Look for feat: (MINOR), fix: (PATCH), or BREAKING CHANGE (MAJOR)
```

### 6B: Publish satellite repos (MCP Server, n8n Node)

For each satellite repo that needs publishing:

```bash
cd {REPO_PATH}

# 1. Pull latest main
git checkout main && git pull origin main

# 2. Bump version in package.json
# Use npm version which updates package.json AND creates a git tag
npm version {minor|patch|major} --no-git-tag-version

# 3. Commit the version bump
NEW_VERSION=$(grep '"version"' package.json | grep -oP '\d+\.\d+\.\d+')
git add package.json package-lock.json
git commit -m "chore: bump version to ${NEW_VERSION}"
git push origin main

# 4. Create GitHub Release (triggers publish-npm.yml automatically)
gh release create "v${NEW_VERSION}" \
  --repo {GH_REPO} \
  --title "v${NEW_VERSION}" \
  --generate-notes \
  --target main

# 5. Verify publish workflow started
sleep 5
gh run list --repo {GH_REPO} --workflow={PUBLISH_WORKFLOW} --limit 1 --json status,conclusion
```

**MCP Server specific**: The `publish-mcp-registry.yml` also fires on release — it publishes to the MCP Registry alongside npm. No extra action needed.

### 6C: Publish SDKs (Python + Node)

SDKs live in the AlterLab monorepo and use a `workflow_dispatch` workflow:

```bash
cd /home/mrdubey/projects/ScraperAPI/alterlab

# 1. Check if SDK versions need bumping (compare code version to last publish)
PY_VERSION=$(git show origin/main:sdk/python/pyproject.toml | grep '^version' | grep -oP '\d+\.\d+\.\d+')
NODE_VERSION=$(git show origin/main:sdk/node/package.json | grep '"version"' | head -1 | grep -oP '\d+\.\d+\.\d+')

# 2. If versions already bumped in code, just trigger the publish
# If versions need bumping, create a worktree, bump, commit, push, then trigger

# 3. Trigger publish workflow
gh workflow run publish-sdks.yml --ref main -f sdk=both

# 4. Verify workflow started
sleep 5
gh run list --workflow=publish-sdks.yml --limit 1 --json status,conclusion,createdAt
```

**If SDK versions need bumping** (code version matches last published version but code has changed):

```bash
# Create worktree for version bump
cd /home/mrdubey/projects/ScraperAPI/alterlab
git worktree add ../alterlab-sdk-bump -b fix/sdk-version-bump origin/main
cd ../alterlab-sdk-bump

# Bump Python SDK version
# Edit sdk/python/pyproject.toml: version = "{NEW_VERSION}"

# Bump Node SDK version
cd sdk/node && npm version {minor|patch} --no-git-tag-version && cd ../..

# Commit and push
git add sdk/python/pyproject.toml sdk/node/package.json sdk/node/package-lock.json
git commit -m "chore(sdk): bump Python SDK to {PY_NEW} and Node SDK to {NODE_NEW}"
git push origin fix/sdk-version-bump

# Create PR to staging (fast-lane), merge, then trigger publish from main after deploy
gh pr create --base staging --title "chore: bump SDK versions" --body "Version bump for SDK publish"
```

### 6D: Monitor publish workflows

After triggering publishes, monitor completion:

```bash
echo "=== Publish Status ==="

# MCP Server
echo "MCP Server:"
gh run list --repo RapierCraft/alterlab-mcp-server --workflow=publish-npm.yml --limit 1 --json status,conclusion,createdAt --jq '.[0]'
gh run list --repo RapierCraft/alterlab-mcp-server --workflow=publish-mcp-registry.yml --limit 1 --json status,conclusion,createdAt --jq '.[0]'

# n8n Node
echo "n8n Node:"
gh run list --repo RapierCraft/n8n-nodes-alterlab --workflow=publish.yml --limit 1 --json status,conclusion,createdAt --jq '.[0]'

# SDKs
echo "SDKs:"
gh run list --workflow=publish-sdks.yml --limit 1 --json status,conclusion,createdAt --jq '.[0]'
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

This release brings parity with AlterLab API changes from the following PRs:
{list of source AlterLab PRs that drove these changes}
EOF
```

### 6F: Report publish results

```
## Publish Results

| Component | Old Version | New Version | Status | Registry |
|-----------|------------|-------------|--------|----------|
| MCP Server | v1.2.0 | v1.3.0 | Published | npm + MCP Registry |
| n8n Node | v0.8.0 | v0.9.0 | Published | npm |
| Python SDK | 2.1.0 | 2.1.1 | Published | PyPI |
| Node SDK | 2.1.0 | 2.1.1 | Published | npm |

### Verification

```bash
# Verify packages are live on registries:
npm view alterlab-mcp-server version
npm view n8n-nodes-alterlab version
npm view @alterlab/sdk version
pip index versions alterlab 2>/dev/null || pip install alterlab== 2>&1 | grep -oP '\d+\.\d+\.\d+'
```
```

---

## Error Handling

- **No API changes detected**: Report "No API surface changes found in recent PRs. Ecosystem is in sync." — but STILL run Phase 5 to check publication status.
- **Repo not accessible**: Skip and warn (e.g., "Could not access RapierCraft/n8n-nodes-alterlab — check gh auth")
- **Duplicate issues**: Check for existing open issues with "Sync:" prefix before creating new ones
- **Publish workflow fails**: Report the failure, link to the workflow run, suggest manual investigation. Do NOT retry automatically.
- **Version conflict on npm/PyPI**: The version already exists on the registry. Bump to the next version and retry.
- **OIDC publish fails**: Check that the repo has npm/PyPI trusted publishing configured. See workflow files for required permissions.
