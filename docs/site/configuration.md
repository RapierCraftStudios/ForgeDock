---
title: "Configuration Reference — forge.yaml"
description: "Complete forge.yaml schema reference for ForgeDock. All required and optional sections explained with examples."
---

# Configuration Reference — forge.yaml

`forge.yaml` lives at your project root and tells ForgeDock commands how to interact with your project. Without it, commands cannot resolve your GitHub repository, paths, or branches.

## Quick Start

```bash
# Option 1: Autopilot setup (recommended)
npx forgedock init

# Option 2: Manual setup
cp forge.yaml.example forge.yaml
# Edit forge.yaml with your project details
echo "forge.yaml" >> .gitignore
```

`npx forgedock init` auto-detects most values from `git remote`, `package.json`, and `gh api`. You review the result on a single annotated screen.

### `init` Flags

| Flag | Behavior |
|------|----------|
| `--manual` | Skip AI enrichment — shows detection baseline values only |
| `--verbose` | Show each field's detection source and confidence rationale |

---

## Schema Overview

| Section | Required | Purpose |
|---------|----------|---------|
| [`project`](#project-required) | **Yes** | GitHub identity (owner, repo, name) |
| [`paths`](#paths-required) | **Yes** | Local filesystem locations |
| [`branches`](#branches-required) | **Yes** | Branch naming conventions |
| [`repos`](#repos-optional) | No | Multi-repository routing |
| [`project_board`](#project_board-optional) | No | GitHub Projects v2 integration |
| [`services`](#services-optional) | No | External service URLs and IDs |
| [`review`](#review-optional) | No | Context injected into review agents |
| [`devdocs`](#devdocs-optional) | No | Devdocs knowledge tree path |
| [`verification`](#verification-optional) | No | Health-check patterns |
| [`billing`](#billing-optional) | No | Financial integrity audit |
| [`adaptive_scripts`](#adaptive_scripts-optional) | No | Per-repo script override configuration |

---

## `project` (REQUIRED)

Core identity fields used by every command that calls `gh issue`, `gh pr`, or `gh project`.

```yaml
project:
  name: "Acme Platform"
  owner: "acme-org"
  repo: "acme-platform"
  description: "SaaS platform for automated data processing"
  # forge_repo: "acme-org/acme-forge"  # if pipeline lives in a separate repo
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **Yes** | Human-readable name used in pipeline reports and issue comments |
| `owner` | string | **Yes** | GitHub org or username |
| `repo` | string | **Yes** | Repository name. Combined as `owner/repo` = the `GH_REPO` in all commands |
| `description` | string | No | One-line description used in issue templates |
| `forge_repo` | string | No | Pipeline repo in `owner/repo` format when pipeline lives separately from the project being developed |

---

## `paths` (REQUIRED)

Local filesystem paths for git worktree operations.

```yaml
paths:
  root: "/home/youruser/projects/acme-platform"
  worktree_base: "/home/youruser/projects/acme-platform/.claude/worktrees"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `root` | string (absolute) | **Yes** | Absolute path to the project root. Base for `git worktree add` |
| `worktree_base` | string (absolute) | **Yes** | Directory where per-branch worktrees are created |

---

## `branches` (REQUIRED)

Branch naming conventions that control PR targeting and source branch selection.

```yaml
branches:
  default: "main"
  staging: "staging"
  feature_pattern: "milestone/{slug}"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `default` | string | **Yes** | Default branch (`main` or `master`) |
| `staging` | string | **Yes** | Staging branch for fast-lane PRs (issues without a milestone) |
| `feature_pattern` | string | **Yes** | Pattern for feature branches. `{slug}` = milestone title in kebab-case |

**Lane routing**: Issues without a milestone → fast lane → PR targets `branches.staging`. Issues with a milestone → feature lane → PR targets `branches.feature_pattern`.

---

## `repos` (OPTIONAL)

Multi-repository routing for projects that span multiple GitHub repos.

```yaml
repos:
  default:
    repo: "acme-org/acme-platform"
    staging_branch: "staging"

  satellites:
    - prefix: "mcp"
      repo: "acme-org/acme-mcp-server"
      staging_branch: "main"
      local_path: "/home/youruser/projects/acme-mcp-server"
```

Use `<prefix>:<issue_number>` syntax in commands: `mcp:5`, `sdk:12`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `satellites[].prefix` | string | **Yes** | Short prefix for issue routing |
| `satellites[].repo` | string | **Yes** | Full `owner/repo` of the satellite repository |
| `satellites[].staging_branch` | string | **Yes** | Target branch for fast-lane PRs |
| `satellites[].local_path` | string | No | Absolute local path to the satellite repo |
| `satellites[].billing_enabled` | boolean | No | Enable financial integrity audit for this satellite |

---

## `project_board` (OPTIONAL)

GitHub Projects v2 integration. When configured, ForgeDock automatically adds issues to the board and updates Status, Lane, Component, Priority, and Workflow fields.

```yaml
project_board:
  owner: "acme-org"
  project_number: 1
  project_id: "PVT_kwHOxxxxxxxxxxxxxxxx"

  field_ids:
    status: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
    lane: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
    component: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
    priority: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"
    workflow: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"

  option_ids:
    status:
      todo: "xxxxxxxx"
      in_progress: "xxxxxxxx"
      done: "xxxxxxxx"
    lane:
      fast: "xxxxxxxx"
      feature: "xxxxxxxx"
```

**Finding your IDs**:

```bash
# List project IDs
gh project list --owner <owner> --format json | jq '.projects[] | {number, id, title}'

# List field IDs
gh project field-list <project_number> --owner <owner> --format json | jq '.fields[]'

# List option IDs for a single-select field
gh project field-list <project_number> --owner <owner> --format json \
  | jq '.fields[] | select(.name == "Status") | .options[]'
```

---

## `review` (OPTIONAL)

Context injected into review agent prompts. Helps agents make project-aware decisions.

```yaml
review:
  context: |
    This is a multi-tenant SaaS. Every endpoint must enforce tenant isolation.
    We use row-level security in PostgreSQL — never bypass it.
    Financial calculations must use Decimal, never float.
```

---

## `devdocs` (OPTIONAL)

Path to your project's devdocs knowledge tree. Agents read this for institutional context before making architectural decisions.

```yaml
devdocs:
  path: "devdocs/"
```

The devdocs directory should contain `project/architecture.md` as the primary strategic context file. See [Architecture](./architecture) for details on ForgeDock's own devdocs structure.

---

## `adaptive_scripts` (OPTIONAL)

Per-repo script overrides for deterministic pipeline operations. Allows you to replace prose instructions with executable scripts for project-specific validation.

```yaml
adaptive_scripts:
  enabled: true
  directory: "scripts/forge/"
```

---

## Full Example

```yaml
# forge.yaml — minimal required config

project:
  name: "My Project"
  owner: "my-org"
  repo: "my-project"

paths:
  root: "/home/me/projects/my-project"
  worktree_base: "/home/me/projects/my-project/.claude/worktrees"

branches:
  default: "main"
  staging: "staging"
  feature_pattern: "milestone/{slug}"
```

For the full annotated example, see [`forge.yaml.example`](https://github.com/RapierCraftStudios/ForgeDock/blob/main/forge.yaml.example) in the repository.
