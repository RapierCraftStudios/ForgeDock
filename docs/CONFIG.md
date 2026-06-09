# forge.yaml Configuration Reference

`forge.yaml` is placed at your project root and tells ForgeDock commands how to interact with your specific project. Without it, commands cannot resolve your GitHub repository, paths, or branches.

## Quick Start

```bash
cp forge.yaml.example forge.yaml
# Edit forge.yaml with your project details
echo "forge.yaml" >> .gitignore  # if your credentials path is sensitive
```

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
| [`billing`](#billing-optional) | No | Enable financial integrity audit phase |

---

## `project` (REQUIRED)

Core identity fields. Used by every command that calls `gh issue`, `gh pr`, or `gh project`.

```yaml
project:
  name: "Acme Platform"
  owner: "acme-org"
  repo: "acme-platform"
  description: "SaaS platform for automated data processing"
  # forge_repo: "acme-org/acme-forge"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **Yes** | Human-readable name used in pipeline reports and issue comments |
| `owner` | string | **Yes** | GitHub org or username. Used as `GH_REPO` prefix and `--owner` flag |
| `repo` | string | **Yes** | Repository name. Combined: `owner/repo` = the `GH_REPO` value in all commands |
| `description` | string | No | One-line description used in issue templates |
| `forge_repo` | string | No | Pipeline repository in `owner/repo` format. Set this when your ForgeDock pipeline lives in a different repo than the project being developed. Used by `audit.md`, `audit-agents.md`, and `security-audit.md` to resolve `{FORGE_REPO}` when looking up pipeline issues and commands. Defaults to `project.owner/project.repo` if omitted. |

**Commands that use this section**: `work-on`, `review-pr`, `orchestrate`, `issue`, `milestone`, `cleanup`, `audit`, `audit-agents`, `security-audit`, `pipeline-health`

---

## `paths` (REQUIRED)

Local filesystem paths. Commands use these to locate the project, create git worktrees, and read credential files.

```yaml
paths:
  root: "/home/youruser/projects/acme-platform"
  worktree_base: "/home/youruser/projects/acme-platform/.claude/worktrees"
  # credentials:
  #   file: "/home/youruser/credentials.yaml"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `root` | string (absolute path) | **Yes** | Absolute path to the project root. Used as the base for `git worktree add` |
| `worktree_base` | string (absolute path) | **Yes** | Directory where per-branch git worktrees are created. Default: `{root}/.claude/worktrees` |
| `credentials.file` | string (absolute path) | No | Path to a YAML credentials file for analytics/monitoring tools. **Do not commit.** |

**Commands that use this section**: `work-on` (Phase 3E), `quality-gate`, `deploy-info`

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
| `default` | string | **Yes** | Default branch (`main` or `master`). Used as fallback PR base |
| `staging` | string | **Yes** | Staging branch for fast-lane PRs (issues without a milestone). Set to `main` if you have no staging branch |
| `feature_pattern` | string | **Yes** | Pattern for feature branches. `{slug}` is the milestone title in kebab-case. Example: `milestone/{slug}` → `milestone/user-auth-v2` |

**Lane routing logic** (from `work-on.md`):
- Issue has no milestone → fast lane → PR targets `branches.staging`
- Issue has milestone → feature lane → PR targets branch matching `branches.feature_pattern`

**Commands that use this section**: `work-on`, `review-pr`, `cleanup`

---

## `repos` (OPTIONAL)

Multi-repository routing. Use this when your project spans multiple GitHub repositories and you want to route issues to satellite repos by prefix.

Without this section, all issues route to `project.owner/project.repo`.

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

    - prefix: "sdk"
      repo: "acme-org/acme-python-sdk"
      staging_branch: "main"
      local_path: "/home/youruser/projects/acme-python-sdk"
      # billing_enabled: false  # set true to run /security-audit Phase 4 on this repo

    # Monorepo satellite: multiple packages in one repo.
    # subpaths maps named identifiers to per-package root directories
    # relative to local_path. Used by /sync-ecosystem when the repo
    # contains multiple independently published packages.
    - prefix: "mono"
      repo: "acme-org/acme-sdks"
      staging_branch: "main"
      local_path: "/home/youruser/projects/acme-sdks"
      subpaths:
        python_sdk: "sdk/python"
        node_sdk: "sdk/node"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `default.repo` | string | No | Full `owner/repo` of the primary repo. Should match `project.owner/project.repo` |
| `default.staging_branch` | string | No | Staging branch for the default repo |
| `satellites[].prefix` | string | **Yes (per entry)** | Short prefix used in issue routing (e.g., `mcp:5` routes issue 5 to the MCP server repo) |
| `satellites[].repo` | string | **Yes (per entry)** | Full `owner/repo` of the satellite repository |
| `satellites[].staging_branch` | string | **Yes (per entry)** | Target branch for fast-lane PRs in this repo |
| `satellites[].local_path` | string | No | Absolute local path to the satellite repo's checkout |
| `satellites[].subpaths` | map(string→string) | No | Named sub-directory paths within `local_path`, for monorepo satellites that publish multiple packages. Each key is a logical name; the value is the relative path to that package's root. Used by `/sync-ecosystem` to locate per-package version files and publish workflows. |
| `satellites[].billing_enabled` | boolean | No | Set to `true` to run Phase 4 (Financial Integrity) of `/security-audit` against this satellite repo. Mirrors the top-level [`billing.enabled`](#billing-optional) flag but scoped per-satellite. Defaults to `false` when absent. |

**Routing syntax in commands**: `<prefix>:<issue_number>` — e.g., `mcp:5`, `sdk:12`

**Commands that use this section**: `work-on` (multi-repo prefix table), `sync-ecosystem`, `security-audit` (satellite billing audit)

---

## `project_board` (OPTIONAL)

GitHub Projects v2 integration. When configured, ForgeDock automatically adds issues to the project board and updates Status, Lane, Component, Priority, and Workflow fields as issues progress through the pipeline.

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
      sync: "xxxxxxxx"
    priority:
      p0: "xxxxxxxx"
      p1: "xxxxxxxx"
      p2: "xxxxxxxx"
      p3: "xxxxxxxx"
    workflow:
      investigating: "xxxxxxxx"
      building: "xxxxxxxx"
      in_review: "xxxxxxxx"
      merged: "xxxxxxxx"

  components:
    - repo: "acme-org/acme-platform"
      option_id: "xxxxxxxx"
      label: "Platform"
```

### Finding Your IDs

```bash
# List projects and their numbers/IDs
gh project list --owner <owner> --format json | jq '.projects[] | {number, id, title}'

# List field IDs for a project
gh project field-list <project_number> --owner <owner> --format json | jq '.fields[]'

# List option IDs for a single-select field
gh project field-list <project_number> --owner <owner> --format json \
  | jq '.fields[] | select(.name == "Status") | .options[]'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `owner` | string | **Yes** | GitHub org/user that owns the project board |
| `project_number` | integer | **Yes** | Project number visible in the URL (`/projects/1`) |
| `project_id` | string | **Yes** | GraphQL node ID (`PVT_...`) returned by `gh project list` |
| `field_ids.*` | string | **Yes (per field)** | `PVTSSF_...` IDs for each custom field |
| `option_ids.*.*` | string | **Yes (per option)** | 8-char hex IDs for each single-select option |
| `components` | array | No | Maps `owner/repo` values to Component field option IDs |

**Commands that use this section**: `work-on` (Phase 0C, Phase 6B), `orchestrate`

---

## `services` (OPTIONAL)

External service endpoints and identifiers. Used by analytics and monitoring commands.

```yaml
services:
  domain: "acme.io"
  gsc_property: "https://acme.io"

  analytics:
    umami:
      url: "https://umami.acme.io"
      website_id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    clarity:
      project_id: "xxxxxxxxxx"
    history_file: "/home/youruser/analytics-history.yaml"
    ga4:
      property_id: "000000000"
      service_account_key: "/home/youruser/credentials/ga4-service-account.json"

  app_url: "https://acme.io"
  api_url: "https://api.acme.io"

  # server_ssh: "ubuntu@203.0.113.42"
  # ememo_path: "/home/ubuntu/ememo"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | No | Primary public domain. Used in GEO and SEO checks |
| `gsc_property` | string | No | Google Search Console property URL or `domain:` prefix |
| `analytics.umami.url` | string | No | Base URL for Umami self-hosted analytics instance |
| `analytics.umami.website_id` | string | No | Umami website UUID for metric queries |
| `analytics.clarity.project_id` | string | No | Microsoft Clarity project identifier |
| `analytics.history_file` | string (absolute path) | No | Path to the persistent audit history YAML file. Written after each `/analytics` run; provides trend baselines. Do not commit. |
| `analytics.ga4.property_id` | string | No | Numeric Google Analytics 4 property ID (from GA4 Admin → Property Details) |
| `analytics.ga4.service_account_key` | string (absolute path) | No | Path to a GA4 service account JSON key file. Grant the account Viewer access in GA4. Do not commit. |
| `app_url` | string | No | Frontend app URL used by `qa-sweep` for page accessibility testing. Default: `http://localhost:3000` |
| `api_url` | string | No | Base URL for the project's API. Used in health checks |
| `server_ssh` | string | No | SSH target for production server health checks. Format: `user@host` (e.g., `ubuntu@203.0.113.42`). Used by `/autopilot` Phase 1 to run server-level checks over SSH. |
| `ememo_path` | string | No | Absolute path on the production server to open eMemo files. Used by `/autopilot` to surface in-progress work notes. Only relevant if your team uses eMemo. |

**Commands that use this section**: `analytics`, `geo-audit`, `autopilot` (analytics snapshot, SSH health check)

---

## `review` (OPTIONAL)

Context injected into review agent prompts. Helps the 9-agent review system give relevant, project-specific feedback.

```yaml
review:
  tech_stack: "Next.js 15 App Router, FastAPI, PostgreSQL 16, Docker, Traefik"

  context: |
    Multi-service monorepo: services/api (Python/FastAPI), web/ (Next.js).
    Deploy: blue/green via Docker Compose on a single VPS behind Traefik.
    Database: PostgreSQL with async SQLAlchemy. No ORM migrations — raw SQL.

  domains:
    billing: "Stripe webhooks; idempotency keys required on all handlers"
    auth: "JWT + refresh token rotation; sessions stored in Redis"
    database: "Always use docker exec <container> for psql/migrations"

  # key_paths:
  #   auth: ["services/api/auth/**", "web/src/lib/auth/**"]
  #   billing: ["services/api/billing/**", "web/src/app/billing/**"]
  #   database: ["services/api/db/**", "migrations/**"]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tech_stack` | string | No | One-line tech stack summary. Injected into all review agent prompts |
| `context` | string (multiline) | No | Freeform context about architecture, deploy model, and known pitfalls |
| `domains.*` | string | No | Domain-specific notes keyed by review agent name (`billing`, `auth`, `database`, `frontend`, `api`, `infra`, `security`) |
| `key_paths` | map(string→list of strings) | No | Domain-to-file mapping used by `/work-on` investigation and `/review-pr` agents to quickly locate relevant files. Keys are domain names matching issue labels; values are lists of file path patterns (glob-style, relative to repo root). When present, agents use this table instead of inferring files from labels and issue body. |

**Commands that use this section**: `review-pr`, `review-pr-agents` (all domain agents), `work-on` (Phase 1B investigation)

---

## `devdocs` (OPTIONAL)

Path configuration for the devdocs knowledge tree. Pipeline agents (work-on, review-pr, etc.) read these files as **authoritative project knowledge** before acting.

Run `npx forgedock docs init` to scaffold the tree from ForgeDock's seed templates into the configured path.

```yaml
devdocs:
  path: "devdocs"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string (relative path) | No | Path to the devdocs tree, relative to project root. Default: `devdocs`. |

**Commands that use this section**: `docs init`, `work-on/build/context` (Phase C-1), `work-on/build/architect` (Phase A0)

### Migration from `review.context`

If you previously stored project context in `forge.yaml → review.context`, move that content into the appropriate devdocs file after running `npx forgedock docs init`:

| `review.context` content | Target devdocs file |
|--------------------------|---------------------|
| Architecture decisions | `devdocs/project/architecture.md` |
| Tech stack details | `devdocs/project/stack.md` |
| Coding conventions | `devdocs/project/conventions.md` |
| Project terminology | `devdocs/project/glossary.md` |
| ForgeDock usage notes | `devdocs/agent/using-forgedock.md` |

Agents read devdocs files as binding source-of-truth, so they receive richer context than the single `review.context` string.

---

## `verification` (OPTIONAL)

Service health-check patterns for the quality gate and validate commands.

```yaml
verification:
  health_endpoint: "https://api.acme.io/health"

  health_patterns:
    - '"status": "ok"'
    - '"database": "connected"'

  services:
    - name: "api"
      container: "acme-api-blue"
      health_url: "http://localhost:8000/health"
    - name: "web"
      container: "acme-web-blue"
      health_url: "http://localhost:3000"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `health_endpoint` | string | No | Primary health-check URL that should return HTTP 200 |
| `health_patterns` | array of strings | No | Strings that must appear in the health endpoint response body |
| `services` | array | No | Named services to verify as part of deployment validation |
| `services[].name` | string | **Yes (per entry)** | Human-readable service name |
| `services[].container` | string | No | Docker container name for `docker exec` verification |
| `services[].health_url` | string | No | Local URL for container-level health checks |

**Commands that use this section**: `quality-gate`, `validate`

---

## Credentials File Format

If `paths.credentials.file` is set, the file at that path is expected to be a YAML file with this structure:

```yaml
# credentials.yaml — DO NOT COMMIT
umami:
  username: "admin"
  password: "your-password"

cloudflare:
  api_token: "your-cf-token"
  zone_id: "your-zone-id"

# QA test user credentials — read by /qa-sweep for browser-based authentication
qa:
  username: "test@example.com"
  password: "your-test-password"

# Add other service credentials as needed
```

The credentials file is read directly by analytics and monitoring commands. It is never committed — add it to `.gitignore`.

---

## `billing` (OPTIONAL)

Controls whether financial integrity checks run in `/security-audit`. Only relevant for projects with Stripe or similar billing infrastructure. When omitted or set to `false`, Phase 4 (Financial Integrity) of the security audit is skipped.

```yaml
billing:
  enabled: false
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | No | `false` | Set to `true` to enable Phase 4 (Financial Integrity) in `/security-audit`. When `false`, the billing audit phase is skipped — appropriate for projects that do not process payments or have no Stripe integration. |

**Commands that use this section**: `security-audit` (Phase 4 — Financial Integrity)

---

## Label Bootstrap

ForgeDock manages a canonical set of GitHub labels for use across all pipeline commands. Labels cover workflow state, priority, review findings, audit findings, and category classification.

### Bootstrap command

```bash
# Create/update all ForgeDock-managed labels on the repo defined in forge.yaml:
npx forgedock labels setup

# Or target a specific repo explicitly:
npx forgedock labels setup --repo owner/repo
```

Running this command is idempotent — it creates labels that don't exist and updates the color/description of labels that do. Safe to re-run at any time.

**When to run it**: Once after `npx forgedock install`, or whenever a pipeline command fails with "label not found". The command bootstraps every label the pipeline relies on.

### Canonical label set

The full manifest lives in [`bin/labels.json`](../bin/labels.json) in the ForgeDock package. Each label has a fixed hex color and a description attributing it to ForgeDock.

| Family | Labels |
|--------|--------|
| Priority | `priority:P0` `priority:P1` `priority:P2` `priority:P3` |
| Workflow | `workflow:investigating` `workflow:ready-to-build` `workflow:building` `workflow:in-review` `workflow:merged` `workflow:decomposed` `workflow:invalid` |
| Pipeline | `needs-human` `review-finding` `needs-validation` `validated` `false-positive` `staging-review` `audit-finding` `orchestration-metrics` `health-report` |
| Category | `bug` `enhancement` `feature` `refactor` `dead-code` `improvement` `documentation` `qa` `security` `performance` |

### Colors

Colors are grouped by semantic meaning:
- **Critical/error** (`#B60205`): `priority:P0`, `security`
- **High/warning-red** (`#D93F0B`): `priority:P1`, `review-finding`, `audit-finding`
- **Medium/yellow** (`#FBCA04`): `priority:P2`, `needs-validation`
- **Low/green** (`#C2E0C6`, `#0E8A16`): `priority:P3`, `workflow:merged`, `validated`
- **Blue pipeline** (`#1D76DB`, `#0075CA`, `#0052CC`): active workflow states
- **Neutral** (`#CCCCCC`, `#E4E669`): terminal/dismissal states

---

## Config Reading Conventions

ForgeDock commands use two accepted patterns for reading `forge.yaml`:

- **`yq` (standard)**: Simple field reads use `yq '.section.field // ""' forge.yaml 2>/dev/null || echo ""`. This is the canonical pattern used by the majority of commands (`cleanup`, `orchestrate`, `work-on/close`, etc.).
- **Python `yaml.safe_load` (complex extraction)**: Commands that need to extract many fields from optional nested sections in a single pass (e.g., `analytics`, `geo-audit`, `qa-sweep`) use a Python heredoc. This avoids chaining many `yq` calls and allows structured error messaging when optional sections are absent.

Do **not** mix the two patterns for the same block of variables (e.g., `yq` with Python fallback). If a command needs more than 5 fields from a deeply nested optional section, use Python. Otherwise, use `yq`.

---

## ConfigDraft Contract

`ConfigDraft` is the shared data structure emitted by `bin/init-detect.mjs` and consumed by the AI enrichment backends (`init-enrich`) and the annotated review renderer (`review-render`). It mirrors the required sections of `forge.yaml` at a per-field granularity, adding provenance and confidence metadata.

### Field shape

Every leaf value in a `ConfigDraft` is a **ConfigField** object:

```ts
{
  value:      string,            // The detected or inferred value
  confidence: "high" | "medium" | "low",  // How certain the detection was
  source:     string,            // Human-readable label for where the value came from
  why:        string,            // Plain-language explanation of why this value was chosen
}
```

**Confidence levels:**

| Level | Meaning |
|-------|---------|
| `"high"` | Verified from a concrete, unambiguous source (e.g., parsed from the git remote URL) |
| `"medium"` | Inferred from available signals; likely correct but not guaranteed (e.g., current branch name, name derived from repo slug) |
| `"low"` | Guessed default — no supporting evidence was found (e.g., no git remote, not a git repo) |

### ConfigDraft shape

```js
{
  project: {
    owner: ConfigField,   // GitHub org or username
    repo:  ConfigField,   // Repository name (without owner prefix)
    name:  ConfigField,   // Human-readable project name
  },
  paths: {
    root:         ConfigField,  // Absolute path to the project root
    worktreeBase: ConfigField,  // Absolute path to the git worktree base dir
  },
  branches: {
    default: ConfigField,  // Default branch (e.g. "main")
    staging: ConfigField,  // Staging branch for fast-lane PRs
  },
  meta: {
    remoteDetected: boolean,  // true iff a parseable git remote URL was found
  },
}
```

### Example output (high-confidence repo)

```js
{
  project: {
    owner: { value: "acme-org",    confidence: "high",   source: "git remote origin (SSH)",   why: "Parsed from SSH remote URL: git@github.com:acme-org/acme-platform.git" },
    repo:  { value: "acme-platform", confidence: "high",   source: "git remote origin (SSH)",   why: "Parsed from SSH remote URL: git@github.com:acme-org/acme-platform.git" },
    name:  { value: "Acme Platform", confidence: "medium", source: "derived from repo slug",     why: "Title-cased version of repo name 'acme-platform' (split on hyphens/underscores)" },
  },
  paths: {
    root:         { value: "/home/user/acme",                      confidence: "high", source: "process.cwd()", why: "Absolute path passed to detectConfig — the project root" },
    worktreeBase: { value: "/home/user/acme/.claude/worktrees",    confidence: "high", source: "derived from root", why: "Convention: {root}/.claude/worktrees" },
  },
  branches: {
    default: { value: "main",    confidence: "high",   source: "git symbolic-ref refs/remotes/origin/HEAD", why: "Remote HEAD points to main" },
    staging: { value: "staging", confidence: "high",   source: "git branch -r",                             why: "Found 'origin/staging' in the remote branch listing" },
  },
  meta: { remoteDetected: true },
}
```

### Producing a ConfigDraft

```js
import { detectConfig } from "./bin/init-detect.mjs";

const draft = await detectConfig(process.cwd());
// draft.project.owner.value  → "acme-org"
// draft.project.owner.confidence  → "high"
```

`detectConfig(cwd)` is the sole public API. It never throws — every error path produces a `low`-confidence default.

### Consuming a ConfigDraft

Downstream consumers read `field.value` for the raw value and `field.confidence` to decide how to handle it:

- **`init-enrich`** (AI enrichment): passes `low`- and `medium`-confidence fields to the AI backend to raise their confidence; leaves `high`-confidence fields untouched.
- **`review-render`** (TUI review screen): shows each field with its source and why; highlights `low`-confidence fields with a `# TODO(forgedock:<field>)` annotation in the generated YAML.

---

## CLAUDE.md Integration

ForgeDock can inject a managed usage block into your project's `CLAUDE.md` so every Claude Code session opened in the repo automatically knows that ForgeDock drives development here and which commands to use.

### How It Works

Running `npx forgedock init` or `npx forgedock integrate` writes a marker-bounded block into `CLAUDE.md`:

```
<!-- BEGIN FORGEDOCK -->
## ForgeDock — Autonomous Development Pipeline
...command index and conventions...
<!-- END FORGEDOCK -->
```

The block is **idempotent** — re-running replaces only the managed section and leaves all other `CLAUDE.md` content untouched. If `CLAUDE.md` does not exist, it is created.

If `AGENTS.md` already exists in the project root, the same block is mirrored into it.

### Commands

| Command | Action |
|---------|--------|
| `npx forgedock init` | Generates `forge.yaml` **and** injects the CLAUDE.md block |
| `npx forgedock integrate` | Injects/refreshes the block without modifying `forge.yaml` |

### Opting Out

To prevent ForgeDock from managing the block, remove the `<!-- BEGIN FORGEDOCK -->` / `<!-- END FORGEDOCK -->` markers from `CLAUDE.md`. Without the markers, subsequent runs will append a new block rather than replacing one — so if you want to opt out permanently, delete or omit the markers **and** do not run `integrate` again.

Alternatively, keep the markers but edit the content between them freely — ForgeDock will replace that section on the next run, so any manual edits inside the markers will be overwritten.

### Re-generating

The command index inside the block is auto-generated from the `description:` frontmatter in each `commands/*.md` file. To refresh it after a ForgeDock update:

```bash
npx forgedock integrate
```

---

## Complete Example

See [`forge.yaml.example`](../forge.yaml.example) at the repository root for a fully annotated example covering all sections.
