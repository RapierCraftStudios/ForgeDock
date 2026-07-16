# forge.yaml Configuration Reference

`forge.yaml` is placed at your project root and tells ForgeDock commands how to interact with your specific project. Without it, commands cannot resolve your GitHub repository, paths, or branches.

## Quick Start

```bash
cp forge.yaml.example forge.yaml
# Edit forge.yaml with your project details
echo "forge.yaml" >> .gitignore  # if your credentials path is sensitive
```

---

## CLI Flags

`--verbose` and `--fast` apply to both `npx forgedock` (the full install journey) and `npx forgedock init` (config-only regeneration); `--manual` and `--minimal` apply to `init` only:

| Flag | Behavior |
|------|----------|
| `--manual` | `npx forgedock init` only. Skips the annotated review screen and asks plain, one-field-at-a-time prompts instead, pre-filled with the detected values as defaults. |
| `--minimal` | `npx forgedock init` only. Skips detection enrichment and the review screen entirely, and writes a short `forge.yaml` containing only the three required sections (`project`, `paths`, `branches`) with detected values. |
| `--verbose` | Shows each field's detection source and confidence rationale on the review screen (e.g. `git remote`, `package.json`, `gh api`), instead of only flagging low-confidence fields. |
| `--fast` | Skips the animation/motion frames and jumps straight to the static screens. |

**Environment variables:**

| Variable | Behavior |
|----------|----------|
| `FORGE_NO_MOTION=1` | Same effect as `--fast` — disables animation frames. Color is unaffected. |
| `NO_COLOR=1` | Disables ANSI color output only. Motion is unaffected (monochrome choreography). |
| `FORGEDOCK_INIT_BACKEND=cli\|api\|none\|auto` | Overrides AI-enrichment backend selection for `init` (see below). Default `auto` (or unset) preserves the CLI-first ladder. |
| Non-TTY / piped output (or `CI=1`) | Plain sequential log: no color **and** no animation. |

The default (no flags) is the annotated review screen: detection runs, AI enrichment fills in what it can — using a local, authenticated `claude` CLI when available, otherwise falling back to the Anthropic API when `ANTHROPIC_API_KEY` is set, otherwise skipped — and you review the result on a single screen — Enter accepts everything, low-confidence fields are flagged with a `# TODO(forgedock:<field>)` comment if left unedited.

If you have both a local `claude` CLI and `ANTHROPIC_API_KEY` set and want to pin one explicitly instead of letting `init` prefer the CLI, set `FORGEDOCK_INIT_BACKEND=api` (or `=cli`, or `=none` to skip enrichment entirely). This is independent of `FORGEDOCK_BACKEND`, which controls the separate `forgedock run` engine backend.

---

## Schema Overview

| Section | Required | Purpose |
|---------|----------|---------|
| [`project`](#project-required) | **Yes** | GitHub identity (owner, repo, name) |
| [`paths`](#paths-required) | **Yes** | Local filesystem locations |
| [`branches`](#branches-required) | **Yes** | Branch naming conventions |
| [`agents`](#agents-optional) | No | Default model for pipeline agents |
| [`repos`](#repos-optional) | No | Multi-repository routing |
| [`project_board`](#project_board-optional) | No | GitHub Projects v2 integration |
| [`services`](#services-optional) | No | External service URLs and IDs |
| [`review`](#review-optional) | No | Context injected into review agents |
| [`devdocs`](#devdocs-optional) | No | Devdocs knowledge tree path |
| [`verification`](#verification-optional) | No | Health-check patterns |
| [`billing`](#billing-optional) | No | Enable financial integrity audit phase |
| [`adaptive_scripts`](#adaptive_scripts-optional) | No | Per-repo script override configuration |

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

## `agents` (OPTIONAL)

Model configuration for pipeline agents. `default_model` governs the main agent — the one you invoke directly (`work-on`, `orchestrate`, `review-pr`, etc.), referenced by every command spec's "Agent model policy" line. `subagent_model` governs the **child** sub-agents that a top-level command spawns internally — e.g. `/orchestrate`'s per-issue `/work-on` agents, `/review-pr`'s domain persona reviewers, `/analytics`'s parallel data-collection agents, `/incident-response`'s validation/root-cause agents.

```yaml
agents:
  default_model: "sonnet"
  subagent_model: "sonnet"
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `default_model` | string | No | `"sonnet"` | Short alias — `"sonnet"`, `"opus"`, or `"haiku"` — the same values the Agent/Task tool's `model` parameter accepts. This is the only form that works for interactive command-spec sub-agent spawning. |
| `subagent_model` | string | No | `default_model`, else `"sonnet"` | Short alias, same accepted values as `default_model`. Overrides the model used for child agents spawned internally by a top-level command (see above). Omit to inherit `default_model`. |

**Resolution order** (highest precedence first):
1. `--model <id>` — CLI flag, `npx forgedock run` only (headless; main agent only).
2. `FORGEDOCK_MODEL` env var — headless runner only (main agent only).
3. `agents.default_model` — this field. Governs the main agent.
4. Hardcoded default — `"sonnet"` for interactive agents, `"claude-sonnet-5"` for the headless runner (`bin/runner.mjs`'s `DEFAULT_MODEL`).

**Sub-agent resolution order** (highest precedence first):
1. `agents.subagent_model` — this field. Governs child agents spawned by a top-level command.
2. `agents.default_model` — falls back here when `subagent_model` is unset.
3. Hardcoded default — `"sonnet"`.

**Headless runner note**: `bin/runner.mjs` (`npx forgedock run`, used for CI/headless invocations) calls the Anthropic SDK directly and also accepts a full Anthropic model ID here as a pass-through escape hatch (e.g. `"claude-opus-4-6"`). A full model ID does **not** work for interactive Agent/Task tool calls in command specs — those only accept the short-alias enum (`sonnet`/`opus`/`haiku`/`fable`). Prefer the short alias unless you specifically need a headless-only override. `subagent_model` is interactive-only — it has no headless-runner equivalent, since the headless runner does not spawn child sub-agents.

Projects without this section see no behavior change — everything defaults exactly as it did before these fields existed.

**Commands that use this section**: all commands with an "Agent model policy" line (`default_model`, nearly every command spec) and all commands that spawn internal sub-agents — `orchestrate`, `review-pr`, `analytics`, `incident-response` (`subagent_model`).

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

Create the devdocs tree by copying the seed templates from `devdocs/templates/` (in this repo) into your configured path, or scaffold it manually by creating `devdocs/project/architecture.md`, `devdocs/agent/using-forgedock.md`, and an optional `devdocs/index.yaml`.

```yaml
devdocs:
  path: "devdocs"
  # index_path: "devdocs/index.yaml"   # optional; defaults to {path}/index.yaml
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string (relative path) | No | Path to the devdocs tree, relative to project root. Default: `devdocs`. |
| `index_path` | string (relative or absolute path) | No | Path to the selective loading index file. Default: `{path}/index.yaml`. When the index file exists at this path, agents read it first (~400 tokens) and load only docs whose domain matches the current issue's labels. When absent, agents fall back to loading all docs with `applies_to: work-on` (backward compatible). Create the index manually or copy the seed template from `devdocs/templates/`. |

**Commands that use this section**: `work-on/build/context` (Phase C-1), `work-on/build/architect` (Phase A0)

### Selective Loading (index.yaml)

When `devdocs/index.yaml` exists, agents use **domain-filtered selective loading** instead of reading all applicable devdocs:

1. Read `index.yaml` (~400 tokens)
2. Extract issue labels (e.g. `billing`, `infra`, `auth`)
3. Load only docs in matching domains + all `always_load` entries
4. When no labels match any domain key: load only `always_load` entries

**Domain matching**: GitHub issue labels map directly to domain keys in `index.yaml`. For example, a label `billing` matches `domains.billing`. Prefixes like `workflow:`, `priority:`, and `review-finding` are stripped before matching.

**`always_load` entries** are loaded for every task regardless of domain. Use for `project/custom-instructions.md` and other files every agent must read.

**Token savings**: A typical task loads 1-3 docs (~1,500-3,000 tokens) instead of all docs (~8,000-12,000 tokens). The index itself costs ~400 tokens — break-even at 1 file avoided.

**Backward compatibility**: If `index.yaml` is absent, behavior is unchanged — all docs with `applies_to: work-on` are loaded. No migration required for existing devdocs trees.

Scaffold the index manually by creating `devdocs/index.yaml` (or copy the seed template from `devdocs/templates/` in the ForgeDock repo).

### Migration from `review.context`

If you previously stored project context in `forge.yaml → review.context`, move that content into the appropriate devdocs file:

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

## `adaptive_scripts` (OPTIONAL)

Per-repo script override configuration. Controls whether ForgeDock looks for project-specific scripts in `.forgedock/scripts/` before falling back to universal scripts.

```yaml
adaptive_scripts:
  enabled: true
  directory: ".forgedock/scripts"
  commit: false
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | No | `true` | When `true`, pipeline agents check `.forgedock/scripts/` for a per-repo script before using the universal one. Set to `false` to disable per-repo overrides entirely and always use universal scripts. |
| `directory` | string (relative path) | No | `".forgedock/scripts"` | Directory where per-repo adaptive scripts live, relative to the project root. Scaffolded by `npx forgedock init`. |
| `commit` | boolean | No | `false` | When `false`, `.forgedock/scripts/` is `.gitignore`d — scripts are local-only and not shared with the team. Set to `true` (and remove the `.gitignore` entry) to commit per-repo scripts to version control. |

**Commands that use this section**: `work-on` (Phase 0B script resolution), any pipeline command that calls a deterministic script

### Script Precedence

ForgeDock resolves which script handles each operation using a strict 4-level hierarchy (highest to lowest authority):

```
1. forge.yaml → learned: (machine-captured corrections)        ← highest
2. .forgedock/scripts/{operation}.sh  (per-repo adaptive)
3. scripts/{operation}.sh             (universal, ships with npm)
4. Prose instructions in command specs (fallback)              ← lowest
```

### Override Semantics

- **Per-repo scripts completely replace** the universal script for that operation — there is no partial inheritance or merging.
- **Per-repo scripts may call universal scripts** via the `$FORGEDOCK_SCRIPTS/{operation}.sh` path. Every universal script exports `FORGEDOCK_SCRIPTS` (absolute path to the universal scripts directory) and `FORGEDOCK_HOME` (absolute path to the ForgeDock installation root) so that per-repo scripts can delegate back to them.
- **No circular dependencies**: per-repo scripts may call universal scripts but must NOT call other per-repo scripts. One level of delegation only.
- **`forge.yaml → learned:`** overrides take precedence over everything. They represent explicit user corrections captured by the pipeline.

### Example: per-repo script that delegates to universal

```bash
#!/usr/bin/env bash
# .forgedock/scripts/classify-lane.sh
# Override: this repo uses 'develop' instead of 'staging' for the fast lane.

set -euo pipefail

# Delegate to universal classify-lane.sh to get the standard result
UNIVERSAL_RESULT=$(bash "$FORGEDOCK_SCRIPTS/classify-lane.sh" "$@")

# Override only the fast-lane output for this project
if [ "$UNIVERSAL_RESULT" = "staging" ]; then
  echo "develop"
else
  echo "$UNIVERSAL_RESULT"
fi
```

### Logging

When a pipeline agent resolves a script tier, it logs the result in the FORGE annotation:

```
Script tier: adaptive (.forgedock/scripts/classify-lane.sh)
Script tier: universal (scripts/classify-lane.sh)
Script tier: prose (no script found — using spec instructions)
```

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

## GitHub App Install

During `npx forgedock`, the installer prompts you to install the ForgeDock GitHub App (`rapiercraft-forgedock`) on your account or org.

**What installing it does today**: registers the app against the account/org you choose. That's it.

**What it does NOT do (yet)**:
- It does **not** create a bot token. GitHub App *installation* tokens can only be minted with the app's private key, and that key is held solely by RapierCraft Studios (the app's owner) — your installation grants *your* installation ID against *RapierCraft's* app, not a key you can use yourself.
- It does **not** auto-refresh anything, and there is no background process managing token expiry.
- It does **not** change which `gh` auth context pipeline commands (`/work-on`, `/orchestrate`, etc.) use. Every pipeline `gh` call always uses whatever auth is currently active in your shell — your personal token unless you've manually configured something else.
- It does **not** wire up webhook-driven "automatic pipeline triggers" — no webhook receiver exists yet.

**Why this matters**: GitHub App installation tokens get materially higher API rate limits than a personal access token, and actions taken with them are attributed to the bot (`rapiercraft-forgedock[bot]`) rather than your personal account. Those benefits are real, but delivering them to arbitrary installers requires a hosted token-minting backend service that doesn't exist yet (tracked as forge#1890). Installing the app today is safe and free, but on its own changes nothing about how the pipeline authenticates.

`npx forgedock doctor` reports this status explicitly (Check 12: "GitHub App / bot token") so you aren't left guessing whether a bot token is active.

**If you want bot-token behavior today**: you'd need to register your own GitHub App (with your own private key), and drive your own token-refresh loop (mint an installation token via the app's `/app/installations/{id}/access_tokens` API, then `gh auth login --with-token`, repeating before the ~1-hour expiry). This is an advanced, self-hosted setup — ForgeDock does not package a generic version of this for you.

---

## `marketing` (OPTIONAL)

Controls opt-in growth features such as 'Powered by ForgeDock' footers on PR descriptions created by the pipeline.

> **Note**: `pr_footer` injection requires future pipeline support in `/work-on`. Setting `pr_footer: true` today has no effect — it is a configuration interface that will be activated when the feature ships. When implemented, the pipeline will append a one-line footer to every PR body it creates.

```yaml
marketing:
  pr_footer: false
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `pr_footer` | boolean | No | `false` | When `true`, the pipeline appends a 'Powered by ForgeDock' footer link to every PR description it creates. Opt-in only — non-intrusive one-line footer, not a banner. Requires pipeline support (not yet implemented). |

**Commands that use this section**: `work-on` (Phase 4 PR creation — when `pr_footer: true`)

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

- **`init-enrich`** (AI enrichment): passes `low`- and `medium`-confidence fields to the selected AI backend (a local `claude` CLI when available, otherwise the Anthropic API with `ANTHROPIC_API_KEY`) to raise their confidence; leaves `high`-confidence fields untouched.
- **`review-render`** (TUI review screen): shows each field with its source and why; highlights `low`-confidence fields with a `# TODO(forgedock:<field>)` annotation in the generated YAML.

---

## SessionStart Hook Integration

ForgeDock does **not** write anything into your project's `CLAUDE.md` or `AGENTS.md`. Instead, `npx forgedock` registers a `SessionStart` hook in `~/.claude/settings.json` — a small script that runs at the start of every Claude Code session and prints ForgeDock's context straight to that session, without touching any file in your repo.

### How It Works

The hook resolves the current directory's state and reacts accordingly:

| State | Behavior |
|-------|----------|
| `managed-active` (`forge.yaml` present, not opted out) | Prints a summary of `forge.yaml` (project, repo, branches) plus the available pipeline commands |
| `managed-active`, no `forge.yaml` yet | Suggests running `npx forgedock init` |
| `managed-optedout` | Completely silent — no output |
| `unmanaged` | Prints a one-time, suppressible nudge to run `npx forgedock enable` |

The hook entry is registered idempotently: re-installing (`npx forgedock update`) will not duplicate it, and unrelated hooks or settings in `~/.claude/settings.json` are left untouched. If `settings.json` is malformed, the installer skips writing rather than risk corrupting it.

### Commands

| Command | Action |
|---------|--------|
| `npx forgedock` / `npx forgedock install` | Registers the SessionStart hook (along with installing commands and writing `forge.yaml`) |
| `npx forgedock update` | Re-registers the hook (relink only — does not touch `forge.yaml`) |
| `npx forgedock uninstall` | Removes the hook entry from `settings.json` |

### Opting Out

Per-directory, independent of the global hook registration. Each command acts on the current working directory — run it inside the project directory:

```bash
npx forgedock disable  # the current directory goes silent (managed-optedout)
npx forgedock enable   # re-activate the current directory
npx forgedock status   # show the current directory's resolved state
```

See [Per-Directory State Registry](#per-directory-state-registry) below for how opt-out state is tracked.

---

## Persisted Toolset Home (`~/.forge/`)

`npx`/`npm` never installs `forgedock` to a stable location on your machine — it resolves to wherever `npx`'s cache (or a global npm install, or a git clone) happens to physically live. Historically, `~/.claude/commands/` and the SessionStart hook's script path were symlinked **directly** from that ephemeral location. When npm/npx (or the OS) later evicted its cache, those symlinks silently dangled — Claude Code sessions stopped getting ForgeDock context with no error shown.

As of this feature, every `npx forgedock` (or `npx forgedock update`) run copies ForgeDock's own installable payload into a stable, version-independent home:

```
~/.forge/
  bin/          — the same bin/ tree bundled with the resolved package (hooks, CLI entry points)
  commands/     — the slash-command specs (.md)
  scripts/      — the universal pipeline-agent scripts (classify-lane.sh, etc.)
  templates/    — scaffold templates (e.g. the demo repo)
  version       — plain-text file containing the source package's version (e.g. "1.7.2")
```

`~/.claude/commands/` symlinks and the SessionStart hook's baked-in script path are then built from **this** copy, not the original ephemeral source — so they keep working even after the npm/npx cache that originally served them is cleared.

### When It Runs

| Command | Behavior |
|---------|----------|
| `npx forgedock` / `npx forgedock install` | Copies the resolved package's payload into `~/.forge/` (content-compared — unchanged files are never rewritten) before linking commands, then links from `~/.forge/`, not the original source |
| `npx forgedock init` | Does not touch `~/.forge/` — `init` only writes `forge.yaml`, it never installs commands |
| `npx forgedock update` (npm/npx install) | Refreshes `~/.forge/` from whatever the currently-resolved package looks like, then relinks |
| `npx forgedock update` (git-clone install) | **Does not** touch `~/.forge/` at all — see the exemption below |
| `npx forgedock doctor` | Reports `~/.forge/version` and confirms `~/.forge/{bin,commands,scripts,templates}` exist |

The copy is idempotent: files whose content is already byte-identical are never rewritten, so steady-state re-runs are fast and don't generate false "updated" noise.

### The Git-Clone Exemption

If you run ForgeDock from a git clone (or a git worktree) of the repo itself — the development/self-hosted install mode — nothing is copied into `~/.forge/`. A git clone is already a stable, user-owned location; copying it into `~/.forge/` and linking commands from the copy instead of the clone would silently disconnect `git pull` (or `npx forgedock update`'s git branch) from what's actually linked into `~/.claude/commands/`. So:

- `~/.claude/commands/` continues to symlink directly from the clone, exactly as before this feature.
- `~/.forge/{bin,commands,scripts,templates}` correctly does **not** exist for this install mode — `npx forgedock doctor` treats that absence as healthy, not a warning.

### Not the Same as `~/.forge/{runs,index}`

`~/.forge/` also hosts two **unrelated, pre-existing** directories used by other parts of ForgeDock:

- `~/.forge/runs/` — durable engine run state for `npx forgedock run-issue` / `resume-stalled` (see `bin/engine.mjs`).
- `~/.forge/index/` — the `recall` knowledge index (see `bin/recall.mjs`, `docs/FORGE-PROTOCOL.md`).

These are **engine data**, not the toolset itself, and this feature does not read, write, or otherwise change them. `~/.forge/{bin,commands,scripts,templates,version}` (this section) and `~/.forge/{runs,index}` (engine data) are unrelated siblings that merely happen to live under the same `~/.forge/` root — don't conflate the two when reading `~/.forge/`'s contents.

---

## Per-Directory State Registry

ForgeDock tracks per-directory opt-out state in a central registry file on the local machine.

### Registry File Location

```
~/.claude/forgedock/registry.json
```

The directory (`~/.claude/forgedock/`) is created automatically on first use with mode `0700`. The file is never committed to version control — it is per-user, per-machine state.

### Registry Schema

```json
{
  "version": 1,
  "optedOut": {
    "/absolute/path/to/project": { "at": "2026-06-09T12:00:00.000Z" }
  },
  "nudgeSeen": {
    "/absolute/path/to/project": { "at": "2026-06-09T12:00:00.000Z" }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Schema version — currently `1` |
| `optedOut` | object | Map of absolute directory paths to opt-out metadata |
| `optedOut[path].at` | string | ISO-8601 timestamp of when the opt-out was recorded |
| `nudgeSeen` | object | Map of absolute directory paths where the one-time "Enable ForgeDock here?" nudge has already been shown |
| `nudgeSeen[path].at` | string | ISO-8601 timestamp of when the nudge was shown for this directory |

### State Resolution

The `registry` module resolves one of three states for any directory:

| State | Meaning |
|-------|---------|
| `managed-active` | Directory contains `forge.yaml` or `.forgedock` and is **not** opted out — ForgeDock is active here |
| `managed-optedout` | Directory has a managed marker but the user has explicitly opted out — ForgeDock stays silent |
| `unmanaged` | No `forge.yaml` or `.forgedock` marker found — ForgeDock has no presence here |

**Opt-out wins over managed**: if a directory contains `forge.yaml` but its path is listed in `optedOut`, the state is `managed-optedout`.

### Failure Behaviour

A missing or corrupt `registry.json` is treated as an empty opt-out set. The registry always fails open — it never throws and never blocks a Claude Code session.

### Downgrade Behaviour

Registry keys are the **real path** of a directory (resolved via `realpathSync`) rather than the raw `resolve()` path. This has been the case since v1.0.x (PR #467, which fixed symlinked-directory key mismatches).

If you downgrade to a build older than PR #467 **and** your project is accessed via a symlinked directory path, the older build looks up registry entries using the pre-symlink `resolve()`-only key form. It will not find entries written by the newer build's real-path keys. The practical effect is benign:

- Opt-outs set on the newer build briefly stop applying for one session.
- The one-time "Enable ForgeDock here?" nudge may reappear once.
- No data is lost. No crash. Fail-open behaviour holds throughout.

**Recovery**: after downgrading, re-apply your opt-out with the older build (run inside the project directory):

```bash
npx forgedock disable
```

This re-writes the entry under the key form the older build expects.

### Managing Opt-Out State

Use the `forgedock enable` and `forgedock disable` commands to add or remove a directory from the opt-out set. Each command acts on the current working directory by default — run it inside the project directory, or pass an explicit path:

```bash
npx forgedock enable [dir]   # Remove a directory from the opt-out set (default: cwd)
npx forgedock disable [dir]  # Add a directory to the opt-out set (default: cwd)
npx forgedock status [dir]   # Show a directory's resolved state (default: cwd)
```

---

## Install Receipt

ForgeDock writes a machine-readable receipt of what the last install or update actually did, so debugging drift (wrong commands installed, wrong tier, stale hooks) can start from a recorded fact instead of re-deriving state from scratch.

### Receipt File Location

```
~/.forge/install-receipt.json
```

The directory (`~/.forge/`) is created automatically on first write with `mkdir(..., { recursive: true })`. The file is never committed to version control — it is per-user, per-machine state.

### When It's Written

- After every successful `npx forgedock install` (end of the onboarding journey, right after the "Forged." celebration screen).
- After every `npx forgedock update` — both the git-clone branch (fast-forward pull) and the npm branch (version-check advisory) route through the same repair step (`relinkAndHint()`), so the receipt is refreshed either way.

The write is best-effort and never blocks or fails the install/update it records: any error (permission denied, disk full, unusual `FORGE_HOME` layout) degrades silently to a no-op, matching the fail-open contract already used by the command-manifest and hook-registration steps.

### Receipt Schema

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-07-10T12:00:00.000Z",
  "forgedockVersion": "1.1.6",
  "installMode": "npm",
  "forgeHome": "/home/user/.npm/_npx/abc123/node_modules/forgedock",
  "cwd": "/home/user/projects/my-repo",
  "platform": {
    "platform": "linux",
    "platformLabel": "Linux",
    "isWSL": false,
    "wslDistro": null,
    "shell": "bash"
  },
  "tier": "core",
  "commands": {
    "count": 42,
    "list": ["work-on", "review-pr", "quality-gate", "orchestrate/phase-1-resolve"]
  },
  "hooks": {
    "sessionStart": "registered",
    "preToolUse": "registered",
    "subagentStopEnforce": null
  },
  "forgeYaml": {
    "present": true,
    "validShape": true
  }
}
```

| Field | Type | Description |
|-------|------|--------------|
| `schemaVersion` | number | Schema version — currently `1` |
| `timestamp` | string | ISO-8601 timestamp of this install/update |
| `forgedockVersion` | string | `version` field from `{forgeHome}/package.json` (empty string if unreadable) |
| `installMode` | `"npm"` \| `"git-clone"` | Detected from whether `{forgeHome}/.git` exists — same predicate `update()` already uses to choose its update strategy |
| `forgeHome` | string | Absolute path to the ForgeDock package install (`FORGE_HOME`) |
| `cwd` | string | Absolute path to the project directory the command was run in |
| `platform` | object | `detectEnvironment()`'s output — platform, human label, WSL status/distro, detected shell |
| `tier` | `"core"` \| `"extras"` | Whether `--extras` was passed (opt-in command tier, see `install: extras` frontmatter) |
| `commands` | object | `count` and `list` (relative slash-command names) of everything installed for the resolved tier, sourced from `findMarkdownFiles()` — never a separately maintained list |
| `hooks.sessionStart` | string \| null | SessionStart hook registration status (`"registered"`, `"already"`, `"skipped-malformed"`) |
| `hooks.preToolUse` | string \| null | PreToolUse enforcement hook status, or `null` when the installed Claude Code version doesn't support it |
| `hooks.subagentStopEnforce` | string \| null | Cleanup status of the (retired) SubagentStop enforce hook |
| `forgeYaml.present` | boolean | Whether `forge.yaml` exists in `cwd` at receipt-write time |
| `forgeYaml.validShape` | boolean | Whether `forge.yaml` contains the 3 required top-level sections (`project:`, `paths:`, `branches:`) — a lightweight regex check, not a full YAML parse |

### No PII or Secrets

The receipt never contains `process.env` values, GitHub tokens, API keys, or the contents of `forge.yaml` — only the `present`/`validShape` booleans above. Absolute filesystem paths (`forgeHome`, `cwd`) are included for drift debugging; they typically contain the OS username but nothing more sensitive, consistent with other per-machine ForgeDock state (e.g. `registry.json`'s path-keyed entries, see above).

### Reading the Receipt

```bash
cat ~/.forge/install-receipt.json
```

There is no CLI subcommand to read it yet — `doctor()` reading the receipt to detect drift is a deliberately deferred stretch goal, not part of this feature.

---

## Complete Example

See [`forge.yaml.example`](../forge.yaml.example) at the repository root for a fully annotated example covering all sections.
