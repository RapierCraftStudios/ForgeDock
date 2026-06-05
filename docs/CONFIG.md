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

**Routing syntax in commands**: `<prefix>:<issue_number>` — e.g., `mcp:5`, `sdk:12`

**Commands that use this section**: `work-on` (multi-repo prefix table), `sync-ecosystem`

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

**Commands that use this section**: `analytics`, `geo-audit`, `autopilot` (analytics snapshot)

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
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tech_stack` | string | No | One-line tech stack summary. Injected into all review agent prompts |
| `context` | string (multiline) | No | Freeform context about architecture, deploy model, and known pitfalls |
| `domains.*` | string | No | Domain-specific notes keyed by review agent name (`billing`, `auth`, `database`, `frontend`, `api`, `infra`, `security`) |

**Commands that use this section**: `review-pr`, `review-pr-agents` (all domain agents)

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

## Complete Example

See [`forge.yaml.example`](../forge.yaml.example) at the repository root for a fully annotated example covering all sections.
