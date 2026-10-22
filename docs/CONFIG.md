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
| [`orchestration`](#orchestration-optional) | No | `/orchestrate` concurrency and cascade admission policy |
| [`hygiene`](#hygiene-optional) | No | Automatic reclaim of ForgeDock-owned leftovers: TTLs, branch deletion, near-ceiling GC, `auto_gc` |
| [`pipeline`](#pipeline-optional) | No | `/orchestrate` batch-engine tuning (stall detection, token budget, narration) |
| [`build`](#build-optional) | No | `/work-on` build-phase scope check (`build.scope.*`) and review depth (`review.depth.*`) |
| [`services`](#services-optional) | No | External service URLs and IDs |
| [`review`](#review-optional) | No | Context injected into review agents |
| [`devdocs`](#devdocs-optional) | No | Devdocs knowledge tree path |
| [`verification`](#verification-optional) | No | Health-check patterns |
| [`execution`](#execution-optional) | No | `forgedock orchestrate`: run lanes in sandboxes instead of host processes (`mode: local\|remote\|hybrid`, `max_remote`) |
| [`verify`](#verify-optional) | No | Core work-on: run lane verification on CI runners instead of the host (`mode: local\|ci\|hybrid`) |
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
| `satellites[].trigger_on_merge` | boolean | No | When `true`, fires a cross-repo trigger when a PR merges in the parent repo and touches paths matching `trigger_paths`. Set to `false` to disable triggering for this satellite. Defaults to `true` when `trigger_paths` is present; otherwise has no effect until runtime trigger support is configured. |
| `satellites[].trigger_paths` | list of strings | No | Path glob patterns that constrain when the trigger fires. Uses GitHub Actions glob syntax (same as `on: push: paths:`). The trigger fires only when at least one changed file matches a pattern in this list. When omitted, the trigger fires on every merge (if `trigger_on_merge: true`). |
| `satellites[].auto_run` | boolean | No | When `true`, automatically invokes `/work-on` on the satellite issue when the cross-repo trigger fires. Requires a running Claude Code session with ForgeDock installed in the satellite repo. Advanced opt-in — defaults to `false`. Do not set to `true` unless a persistent Claude Code session is available in the satellite repo. |

**Routing syntax in commands**: `<prefix>:<issue_number>` — e.g., `mcp:5`, `sdk:12`

**Commands that use this section**: `work-on` (multi-repo prefix table), `sync-ecosystem`, `security-audit` (satellite billing audit)

---

## `project_board` (OPTIONAL)

GitHub Projects v2 integration. When configured, ForgeDock automatically adds issues to the project board and updates Status, Lane, Component, Priority, and Workflow fields as issues progress through the pipeline.

`/forgedock-init` fills this section for you: it links an existing board or creates a new one, links it to the repo, adds any missing Lane/Priority/Workflow/Component fields (Status is built in), and writes the IDs below. Projects v2 needs the `read:project`/`project` token scope, which `gh auth login` does not grant by default. If the scope is missing, `/forgedock-init` prints the fix:

```bash
gh auth refresh -h github.com -s read:project,project
```

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

## `orchestration` (OPTIONAL)

Concurrency limits and cascade admission policy for `/orchestrate`'s batch engine. Previously read at runtime (`orchestration.max_concurrent`) but undocumented; this section is the first place it — and the newer `cascade` sub-section (forge#2234) — are formally specified.

```yaml
orchestration:
  # Maximum number of top-level /work-on agents dispatched concurrently. Each
  # worker normally fans out to about 8 total subagent spawns (build, quality
  # gate, and review included), so set this to no more than session_budget / 8.
  # Default: 12; use 25 or fewer for a 200-spawn session budget. This limits
  # in-flight workers only: under cascade.policy: all, raising it increases
  # both completion and finding-spawn throughput and does not itself bound or
  # shrink cascade queue growth.
  max_concurrent: 12

  # Age (hours since the issue last updated) after which a predecessor still at
  # `workflow:remediating` or `workflow:engine-error` is classified GATED
  # (stalled, needs a human) instead of IN_PROGRESS. Default: 48.
  in_progress_max_hours: 48

  cascade:
    # Named preset expanding to the granular keys below. Any granular key set
    # explicitly overrides just that field — the preset supplies defaults, not
    # hard values. Default: "balanced".
    #   all          — admit everything: no generation cap, no token cap, every
    #                  heuristic-based defer disabled. For a maintainer draining
    #                  a backlog who wants /orchestrate to "pick up everything."
    #   balanced     — the pre-#2234 hardcoded behavior, unchanged: generation
    #                  cap at 1 (i.e. cascade-spawned findings deferred),
    #                  900000-token per-batch ceiling, idle/keyword/same-file
    #                  heuristics all active.
    #   conservative — same admission shape as balanced, with a lower
    #                  (450000) token ceiling for cost-sensitive or noisy repos.
    policy: "balanced"

    # Maximum cascade generation depth admitted. Generation 1 = an original
    # issue (not spawned from a review-finding). Generation 2 = spawned from a
    # review-finding. Generation 3 = spawned from a finding that was itself
    # spawned from a review-finding. Accepts a positive integer or the literal
    # string "unlimited". Governs Phase 1 resolve-time admission only (the
    # `cascade`/`review-findings`/`findings` resolution in phase-1-resolve.md)
    # — it does NOT individually dispatch deferred generation-2+ findings in
    # Step 4C. Bounded P3 batching is the sole automated exception: it may
    # aggregate a finite generation-2 member set under batch_max_generation,
    # as implemented by #2849. This is what makes "admit gen-2, stop at gen-3"
    # expressible, which the pre-#2234 --allow-gen2 flag could not say.
    # Default: 1 (from the "balanced" preset); "unlimited" under "all".
    max_generation: 1

    # Maximum generation a P3 batch may aggregate. Batching is a sanctioned,
    # auditable exception to Step 4C's autonomous cascade cap: it can fold
    # several deferred low-priority findings into one reviewed unit, but it
    # must never make recursion unbounded. Every batch records the maximum
    # member generation in FORGE:BATCH_MAX_GENERATION. This value is always
    # finite, even under policy: all. Default: 2.
    batch_max_generation: 2

    # Permit closure only of mechanically identical bot/app alerts: same
    # normalized title, generator, and trigger condition, while retaining one
    # canonical issue. Human reports are never included. Default: false.
    dedup_automated: false
    # Per-batch token ceiling for Step 4C's review-finding cascade dispatch.
    # New home for the same lever previously read only as
    # `pipeline.token_budget_per_batch` (kept working as a deprecated alias —
    # see the `pipeline` section below). Accepts a positive integer or
    # "unlimited". Default: 900000 (from "balanced"); 450000 under
    # "conservative"; "unlimited" under "all".
    token_budget: 900000

    # Whether a fully human-gated original batch (forge#1814's
    # BATCH_FULLY_GATED — every original-batch issue DONE/FAILED/GATED with at
    # least one GATED) suppresses further cascade-finding dispatch. Default:
    # true (from "balanced"); false under "all".
    defer_on_batch_gated: true

    # Whether the comment/typo title-keyword heuristic defers P3-and-below
    # cascade findings. Default: true (from "balanced"); false under "all".
    keyword_heuristic: true

    # Whether a P3 finding sharing a file with the active batch is deferred
    # (avoids serializing agents on same-file predecessor edges). Default:
    # true (from "balanced"); false under "all".
    p3_same_file_defer: true

    # Running findings-spawned / merged-units ceiling. "off" (the default)
    # only reports amplification; a positive decimal defers further
    # same-lineage refinements to the completion sweep once exceeded.
    max_amplification: "off"

    # Number of consecutive merged-unit observations at ratio >= 1.0 before
    # printing a convergence warning. Default: 3.
    convergence_window: 3

    # On-by-default amplification circuit breaker (forge#3060). Counts ALL
    # cascade findings (new surface as well as same-lineage refinements). When
    # the ratio stays >= 1.0 for convergence_window merged units, P3-and-below
    # admission pauses, the operator gets a report (ratio + queue size), and the
    # paused P3s wait for bounded P3 batches. P1/P2 are never affected, and
    # `policy: all` / unlimited overrides do not disable it. "on" (default) | "off".
    amplification_breaker: on

  # In-batch recovery (#4267): recovery lanes `forgedock orchestrate` launches
  # per issue for a mechanical needs-human (ci.red, base.conflict, ...).
  # Default 1; 0 disables in-batch recovery.
  recovery:
    max_attempts: 1
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `max_concurrent` | integer | No | Max concurrent top-level `/work-on` dispatches. It does not bound cascade growth; under `policy: all` it raises drain and spawn throughput together. Default: 12. |
| `breaker.errors` / `breaker.window_min` | integer | No | `forgedock orchestrate` circuit breaker (#4121): after `errors` engine-errors within `window_min` minutes the batch stops admitting lanes, lets running lanes finish, and keeps the rest pending for `--resume`. `errors: 0` turns it off. Default: 3 in 30 |
| `max_deferrals` | integer | No | `forgedock orchestrate`: requeues of one issue after a non-host `deferred` (usage limit, merge/push transient, CLI idle, lease held, gh unavailable) before its row is final. `host.busy` deferrals are not capped. Default: 3 |
| `global_parallel` | integer | No | `forgedock orchestrate` (#4191): host-wide cap on running lanes across every batch and repo on the host, enforced through the host lane registry (`~/.forge/sched/`, or `FORGEDOCK_SCHED_DIR`). A freed slot goes to the highest-priority queued issue (`priority:P<n>` / `P<n>` labels, unlabelled P2); within a priority, slots are shared across repos by weight (#4193: `forgedock sched weight <owner/repo> N`, `--clear` resets; default equal, FIFO inside a repo), and priority always dominates weights; running lanes are never preempted and `--parallel` K still bounds each batch. `forgedock sched cap N` overrides it live for the whole host (`--clear` reverts); `forgedock sched show` lists the weights, slots and the queue. Default: unset (no global cap) |
| `recovery.max_attempts` | integer | No | `forgedock orchestrate` in-batch recovery (#4267): how many recovery lanes the batch launches per issue for a `needs-human` with a mechanical code (`ci.red`, `base.conflict`, `ci-pending` on a conflicting PR, `contract.invalid` after a mid-run issue edit, `builder.block_untyped`). A recovery lane (`run-issue --recover <code>`) removes `needs-human`, posts a `FORGE:DECISION`, resumes the open PR and re-queues the issue with its dependents. If it ends anything but `merged`, the issue is labelled `needs-human` again with a recovery-evidence `FORGE:NEEDS_HUMAN` comment. Human codes are never recovered. Flat form: `recovery_max_attempts`. Default: 1; `0` disables in-batch recovery (a mechanical `needs-human` is final, as before). |
| `cascade.policy` | string | No | `all` \| `balanced` \| `conservative`. Default: `balanced` |
| `cascade.max_generation` | integer or `"unlimited"` | No | Max cascade generation admitted at Phase 1 resolve time. Default: 1 |
| `cascade.batch_max_generation` | integer | No | Finite maximum member generation that an automated P3 batch may aggregate. Default: 2 |
| `cascade.dedup_automated` | boolean | No | Allow only mechanically identical bot/app alerts to be closed with a retained canonical issue. Default: `false` |
| `cascade.token_budget` | integer or `"unlimited"` | No | Per-batch token ceiling for Step 4C cascade dispatch. Default: 900000 (deprecated alias: `pipeline.token_budget_per_batch`) |
| `cascade.defer_on_batch_gated` | boolean | No | Suppress cascade dispatch when the original batch is fully human-gated. Default: `true` |
| `cascade.keyword_heuristic` | boolean | No | Defer P3-and-below comment/typo-titled findings. Default: `true` |
| `cascade.p3_same_file_defer` | boolean | No | Defer P3 findings sharing a file with the active batch. Default: `true` |
| `cascade.max_amplification` | positive number or `"off"` | No | Opt-in ceiling for same-lineage refinement dispatch. Default: `"off"` |
| `cascade.convergence_window` | positive integer | No | Consecutive ratio observations at or above 1.0 before warning. Default: 3 |
| `cascade.amplification_breaker` | `on` \| `off` | No | Pause P3-and-below cascade admission while the findings-spawned / merged-units ratio stays at or above 1.0 for `convergence_window` units. Counts all cascade findings (not only same-lineage); P1/P2 unaffected; independent of `cascade.policy`, so `policy: all` does not disable it. Paused P3s route to bounded P3 batches. Default: `on`. Opt out with `off` (boolean `false` is accepted as `off`, `true` as `on`). |

**Upgrade note — in-batch recovery is on by default** (1.29.0): without `orchestration.recovery.max_attempts`, `forgedock orchestrate` launches one recovery lane per issue for a mechanical `needs-human` before reporting it. To keep the previous behavior (every `needs-human` final), set `orchestration.recovery.max_attempts: 0`.

**Upgrade note — `cascade.amplification_breaker` is on by default**: existing configs that do not set this key now get the breaker automatically. During a batch, once the findings-spawned / merged-units ratio stays at or above 1.0 for `convergence_window` units (it can trip at exactly 1.0 over 3 units), P3-and-below cascade admission pauses; paused P3s are routed to bounded P3 batches rather than dispatched individually. P1/P2 are unaffected. To keep the previous behavior, set `orchestration.cascade.amplification_breaker: off` (or `false`). See [RELEASE-NOTES.md](RELEASE-NOTES.md) for the release that introduced this default.

**Hard invariant — not configurable**: safety exclusions (findings whose `## Problem` section indicates security/billing/anti-bot/auth concerns) are never batched and never auto-admitted by any `cascade.policy`, including `all`. That exclusion is enforced upstream of this section (the P3 batching eligibility check) and has no corresponding key here by design.

**CLI overrides**: `--policy`, `--max-generation`, `--token-budget` on `/orchestrate` take precedence over these keys for a single invocation — see `commands/orchestrate/config.md` → "Cascade Policy CLI Flags".

**Commands that use this section**: `orchestrate`

---

## `hygiene` (OPTIONAL)

Automatic reclaim of what ForgeDock leaves behind (#4183), using the `forgedock gc` reaper. Only resources ForgeDock provably owns are reclaimed: entries of a stale lane ledger, Docker containers and volumes labelled `forgedock.owner=1`, `lean-*`/`agent-*` dirs under `.claude/worktrees`, `feat/issue-<n>-lean` branches of closed issues, and ForgeDock scratch under `~/.forge/tmp`. Everything else is reported, never touched, and so are unpushed or uncommitted work, live lanes, protected branches and branches with an open PR. Block form only.

```yaml
hygiene:
  container_ttl_hours: 6
  worktree_ttl_hours: 24
  tmp_ttl_hours: 6
  delete_merged_branches: true
  max_host_load_ratio: 0.8
  auto_gc: true
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `container_ttl_hours` | number | `6` | Age after which owned Docker containers and volumes are reclaimed (an expired `forgedock.expires` label reclaims earlier). |
| `worktree_ttl_hours` | number | `24` | Age after which owned worktrees (clean and pushed) and abandoned lane branches are reclaimed. |
| `tmp_ttl_hours` | number | `6` | Age after which `~/.forge/tmp` run dirs (owner dead) and runner scratch (no live process) are reclaimed. |
| `delete_merged_branches` | boolean | `true` | `false`: lane branches of closed issues are reported, never deleted. |
| `max_host_load_ratio` | number in (0,1] | `0.8` | Near-ceiling trigger relative to the `engine` admission thresholds: load/core at or above ratio × `max_load_per_core`, or free memory/tmp at or below the minimum ÷ ratio. |
| `auto_gc` | boolean | `true` | `false` disables GC in `forgedock orchestrate`; `forgedock gc` and `forgedock doctor --fix` still work. |

Invalid values fall back to the default. `forgedock gc --older-than <d>` overrides every TTL for that run. Resources of a live lane (its ledger owner is alive) are always skipped.

**Where it runs**: `forgedock orchestrate` applies GC once before admitting lanes, and again before an admission when the host is near the ceiling (at most every 5 minutes). The batch report ends with `reclaimed: N item(s), SIZE (preflight A, admissions B)`, or `reclaimed: off (hygiene.auto_gc: false)`. `forgedock doctor` shows a **Resource hygiene** check (owned counts and sizes, reclaimable count, unowned stale items as warnings), and `doctor --fix` runs the reaper. `/cleanup branches` calls `forgedock gc`.

**Commands that use this section**: `orchestrate`, `doctor`, `gc`, `cleanup`

---

## `pipeline` (OPTIONAL)

Tuning knobs for the CLI backend and `/orchestrate`'s batch engine — invocation and stall timeouts, narration verbosity, and (deprecated alias only, see `orchestration.cascade` above) the review-finding cascade token budget. All keys optional; sane defaults apply when omitted.

```yaml
pipeline:
  # Wall-clock limit for one CLI backend invocation. The environment variable
  # FORGEDOCK_CLI_TIMEOUT_MS (milliseconds) takes precedence. Default: 60.
  cli_timeout_minutes: 60

  # Minutes an agent may sit idle (no FORGE:HEARTBEAT / label change) before
  # /orchestrate's stall detector treats it as stuck and attempts an
  # auto-resume. Default: 15.
  stall_timeout_minutes: 15

  # Deprecated alias for orchestration.cascade.token_budget (forge#2234) — kept
  # working so existing configs are unaffected. When both are set,
  # orchestration.cascade.token_budget wins. Default: 900000.
  token_budget_per_batch: 900000

  # Estimated token cost of a single P3-or-lower review-finding /work-on
  # pipeline, used to decrement the token budget above. Default: 150000.
  token_estimate_per_finding: 150000

  # Narration verbosity for /orchestrate's per-completion status updates.
  # "terse" (default): one line per completion. "verbose": adds a running
  # per-completion recap table. Cosmetic only — never changes which phases run.
  narration: "terse"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cli_timeout_minutes` | integer | No | Wall-clock minutes for one CLI backend invocation. Default: 60. `FORGEDOCK_CLI_TIMEOUT_MS` (milliseconds) takes precedence. |
| `stall_timeout_minutes` | integer | No | Idle minutes before the stall detector attempts auto-resume. Default: 15 |
| `token_budget_per_batch` | integer | No | **Deprecated** — use `orchestration.cascade.token_budget`. Default: 900000 |
| `token_estimate_per_finding` | integer | No | Estimated tokens per P3-or-lower cascade finding. Default: 150000 |
| `narration` | string | No | `terse` \| `verbose`. Default: `terse` |

**Commands that use this section**: CLI backend (`cli_timeout_minutes`); `orchestrate` (remaining keys)

---

## `execution` (OPTIONAL)

Owner opt-in for the paid API agent backend (#4257). The API backend is **never the default**: under `--backend auto` (the default) ForgeDock uses the `claude` CLI, and when no CLI is available it fails with `CLI_BACKEND_UNAVAILABLE` instead of billing `ANTHROPIC_API_KEY`.

```yaml
execution:
  # Use the API backend when `auto` finds no usable claude CLI. Takes effect only
  # together with the env var FORGEDOCK_ALLOW_API_BACKEND=1 on the host.
  agent_backend: api
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_backend` | string | No | `api` approves the API backend as the `auto` fallback, only when `FORGEDOCK_ALLOW_API_BACKEND=1` is also set. Any other value, or no value, means `auto` never selects `api`. |

An explicit `--backend api` / `FORGEDOCK_BACKEND=api` still selects the API backend without this section; that flag is itself the explicit choice.

**Commands that use this section**: `forgedock run`, `forgedock run-issue`, `forgedock backend-check`

---

## `engine` (OPTIONAL)

Per-command `--model` and `--max-turns` for the CLI backend (`forgedock run-issue` phases and `forgedock run <command>`). Opt-in: with no keys set, the `claude` invocation is unchanged and uses the CLI's own default model with no turn bound. `forge.yaml` is parsed one level deep, so settings are **flat** keys under `engine:`, named `<key>_model` and `<key>_max_turns`, where `<key>` is the command name with every non-alphanumeric character replaced by `_`.

```yaml
engine:
  # work-on/review -> work_on_review (the review phase is the most expensive).
  work_on_review_model: sonnet
  work_on_review_max_turns: 120

  # review-pr-staging -> review_pr_staging (non-work-on commands work the same way).
  review_pr_staging_max_turns: 80
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `<key>_model` | string | No | Model alias (`sonnet`, `opus`, `haiku`) or full model id passed as `--model`. Invalid values are ignored. |
| `<key>_max_turns` | integer | No | Positive integer passed as `--max-turns`. Invalid values are ignored. |

| `path` | string | No | `core` (default), `full`, `lean` or `auto`. `core` is the lean work-on (`bin/lean/`): a planning call that writes a frozen contract, an implement call in the same session, one read-only conformance reviewer, GitHub as the register (see `conformance`). `lean` and `auto` are aliases of `core`; `full` runs the legacy multi-phase pipeline and is required for `--retry` and `--wait-lease`. The `--path` flag overrides. `lean_reviewer_model` sets the reviewer model (default `claude-sonnet-5-5`); the builder uses `--model` or the CLI default. `forgedock orchestrate <issues...> [--parallel K] [--lane L]` runs the core per issue (K default 3, lane default `staging`) and honours `**Depends on**` ordering among the given issues. |
| `conformance` | string | No | Core work-on conformance gate. The builder first writes a contract (requirements quoted verbatim from the issue and maintainers' comments, deliverables, preserve constraints, validate commands), which the engine freezes and posts as `FORGE:CONTRACT`; changes go only through typed amendments (`FORGE:AMENDMENT`). A deterministic precheck (scope, validation, deferrals) and a row-based conformance review follow, and the engine computes the verdict. `shadow` (default): the verdict is posted in `FORGE:REVIEW` and logged (`CONFORMANCE_SHADOW` event) but only what the previous reviewer blocked on still blocks (a requirement found not implemented, a regression), plus the precheck's equivalent: any `conformance.unimplemented` precheck or amendment failure (a validate command that failed or has no recorded result, a deliver requirement the builder reported as not implemented, an invalid amendment; #4160). These block before any reviewer run. Scope creep and omissions are recorded only. A review still incomplete or inconsistent after one targeted re-ask (only the missing ids) ends `needs-human`, or with `review_incomplete: degraded` merges with a `review-degraded` PR label and a tracked follow-up. Accepted deferrals are filed and linked, as in enforce. `scripts/calibration.mjs --shadow` reports the per-repo shadow verdict mix and when to switch to enforce. `enforce`: every failure blocks (one same-session builder resume, then `needs-human` with a `conformance.*`/`review.*` code, see docs/OUTCOME-CODES.md); deferrals the reviewer accepts are filed in one batched follow-up issue (`scripts/file-deferred-followups.sh`) and linked in the PR body and a `FORGE:TRACKED` comment before merge. |
| `cli_idle_minutes` | number | No | Core builder idle timeout (#4112): the builder CLI runs with `--output-format stream-json` and is killed (code `cli.idle`) when it shows no stream activity for this many minutes. The run log records the last tool call and the live child processes. Default 15. |
| `cli_max_minutes` | number | No | Absolute ceiling for a core builder session (code `cli.timeout`), replacing the fixed 60-minute kill. A session that keeps making progress is never idle-killed. Default 180. On either kill, uncommitted work is committed as `wip(forge): checkpoint after <reason>` and the lane branch is pushed (with the push retry), the builder retries once from the checkpoint, and a second kill ends `deferred`; a rerun resumes from the branch. |
| `lane_limits` | map | No | Cap each core lane's whole process tree (#4115), under `pipeline:` or `engine:`: `memory_max` (for example `3G`) and `cpu_quota` (for example `150%`). When set and `systemd-run --user --scope` works (probed once), the builder CLI is spawned as `systemd-run --user --scope -q -p MemoryMax=... -p CPUQuota=... -- claude ...`; elsewhere the caps are ignored. Write it nested or flat (`lane_limits_memory_max`, `lane_limits_cpu_quota`). While a builder runs the engine polls host load and memory every 15 s against the `admission` thresholds: over them it SIGSTOPs the lane's process group, under them SIGCONT, and never pauses longer than 10 minutes. |
| `admission` | map | No | Host-resource admission for the core work-on (#4105), checked before the lease, worktree or any GitHub call. When a check fails the run ends `deferred` (code `host.busy`, exit 75) with a last line such as `issue #N → deferred (host busy: mem 1.2G < 2G; retry in 60s)`; no lease is taken and nothing is posted. Keys: `enabled` (default `true`; `false` disables admission), `min_free_mem_mb` (default 2048; `MemAvailable` from `/proc/meminfo`, else `os.freemem()`), `min_free_tmp_mb` (default 1024; free space of the run TMPDIR filesystem, `~/.forge/tmp`, and of `/tmp`, via `statfs`), `max_load_per_core` (default 4; 1-minute load average divided by cores). Write it nested (`engine:` then `admission:` with the keys indented) or flat as `admission_enabled`, `admission_min_free_mem_mb`, `admission_min_free_tmp_mb`, `admission_max_load_per_core`; the parser reads one nested level into `engine`. `/orchestrate` requeues a host-busy lane and lowers K by 1 for 5 minutes. |
| `merge_wait` | string | No | Core work-on merge gate. `required` (default): wait only for the status checks the base branch requires: the union of classic branch protection (`gh api repos/{o}/{r}/branches/{base}/protection/required_status_checks`, contexts and checks) and repository rulesets (`gh api repos/{o}/{r}/rules/branches/{base}`, `required_status_checks` rules); with neither (404 or empty) merge right after review PASS. A merge rejected by base branch policy (PR `MERGEABLE` but `BLOCKED`) is waited on and retried within the CI budget, then left `ci-pending`; it is never base-synced and never `base.conflict`. A failing required check is `needs-human`; a pending one is polled with backoff and never `needs-human`. `all`: wait for every check (`scripts/wait-ci-green.sh`). `none`: merge right after review. Always `--match-head-commit` at the reviewed head. The policy used is recorded in the `FORGE:WORK-ON` comment. |
| `context_pack` | string | No | Context pack (#4275). Before the plan call the core compiles the issue's GitHub/git neighbourhood into a small, budgeted pack: linked issues and PRs (parent, `Depends on`, body links, same-repo cross-references, siblings), prior attempts, merged PRs on the issue's files that were reverted or whose decisions/findings name a symbol from the issue, and repo-fact file pointers. `shadow` (default): the pack is compiled, posted on the issue as a collapsed `FORGE:CONTEXT` comment and logged as a `CONTEXT_PACK` event; the builder prompt is unchanged. `on`: it is also appended to the plan prompt as hints. `off`: nothing is gathered, posted or logged. The pack never enters the text contract quotes are checked against. Values read from linked issues' `FORGE:STATE` are kept only when they are outcome codes. Compare with `forgedock stats --context-ab`. |
| `context_pack_sources` | string | No | Comma list of the pack sources to use: `graph`, `attempts`, `ledger`, `facts`. Default: all four. |
| `context_pack_bytes` | integer | No | Hard byte cap of the pack; items that do not fit are dropped whole and counted. Default: 6144. |
| `context_pack_days` | integer | No | Window of the merged-PR ledger, in days. Default: 30. |
| `ci_pending_max_minutes` | integer | No | Minutes the engine waits for CI when the review phase ends BLOCKED with "checks still pending", or the remediate phase holds at its M7 re-gate on "CI pending" (the merge gate's wait window ended while CI was still running). Default: 90. Invalid values are ignored. This key is flat like the others but is not part of the `<key>_model` / `<key>_max_turns` pattern. |

**CI still pending**: the engine polls `scripts/wait-ci-green.sh` (no model calls) one read per poll on a 60 s, 2 min, 4 min, 5 min (cap) backoff with +/-20% jitter, while the lease keeps renewing, then re-dispatches the phase that was waiting, review or remediate (idempotent at an unchanged head: review re-runs the merge gate and merges; remediate resumes at its M7 re-gate). Before each poll it reads `gh api rate_limit` (not itself rate-limited) and, below 10% of the REST budget, sleeps until the window resets instead of polling; a rate-limited or transient (5xx, network) poll is retried and never re-dispatches the phase. Red CI takes the normal ci-gate path. When the budget is exhausted the run ends `needs-human` with outcome code `review.ci_pending_timeout`; `--retry` resumes. Each wait emits a `ci_pending_wait` telemetry event (`docs/TELEMETRY.md`) with the minutes waited, polls made and rate-limit sleeps.

**Precedence** (model): `engine.<key>_model`, then the run-level model the caller passed explicitly, then omitted. `max_turns` comes only from this section. No defaults ship.

**Version gate**: the flags are added only when the installed `claude --version` supports them (`--max-turns` is hidden from `claude --help`, so help text is never scraped); an unparseable version omits both flags.

**Turn exhaustion**: when `--max-turns` is exhausted the run ends `engine-error` (detail `max-turns`) and the phase is never committed, so `forgedock run-issue --retry` re-enters the same phase. Raise `<key>_max_turns` before retrying. Phase runlog events record `model` and `turns` next to `usage` so a limit can be sized from measured turn counts.

**Per-run scratch dir** (`tmp_root`): every engine child runs with `TMPDIR` and `CLAUDE_CODE_TMPDIR` set to `<tmp_root>/<repo-key>/<issue>` so venvs and Claude session data stay off a size-limited `/tmp`. `engine.tmp_root` is an absolute or `~`-prefixed path; default `~/.forge/tmp`. The `<repo-key>` is the checkout's directory name plus 8 hex characters of a hash of its real path, so the same issue number in two repos never shares a dir; the dir is created `0700` and an existing symlink or dir owned by another user is not used (the child keeps the inherited tmp). Old `<tmp_root>/<issue>` dirs from earlier versions are not migrated. When `tmp_root` is unset and the operator already exported `TMPDIR` or `CLAUDE_CODE_TMPDIR`, that choice is respected and never cleaned. The dir is removed on a terminal outcome and kept on `engine-error` so `--retry` resumes. A disk-full/quota failure (EDQUOT, ENOSPC, errno -28/-122) ends a retryable `engine-error` (outcome code `infra.disk_quota`), never `needs-human`.

**Minimal phase sessions** (forge#4065): on a supported CLI (`claude --version` >= 2.1.296, probed once and cached like the flags above) every engine phase (`work-on/*`) runs with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, so operator MCP servers and connectors are not loaded. Phases whose spec never calls `Skill(...)` (`work-on/investigate`, `work-on/close`) also get `--disable-slash-commands`; skill-using phases keep skills. Operator settings are intentionally not skipped (no `--setting-sources`), because ForgeDock's user-scope PreToolUse/SubagentStop hooks must keep running. Set `FORGEDOCK_FULL_SESSION=1` to restore the previous full session (no flags). Other `forgedock run` commands (qa-sweep, analytics, geo-audit, autopilot) keep the full session because they may need MCP servers. An old or unparseable CLI version also omits the flags.

**Commands that use this section**: CLI backend (`runCommand` in `bin/runner.mjs`)

---

## `lean` (OPTIONAL)

Settings of the core work-on (`bin/lean/`) that change its contract.

```yaml
lean:
  repro_test: prefer   # off | prefer (default)
  precheck:
    max_minutes: 10    # optional pre-PR check round budget in minutes (1-120)
  fix_model: claude-sonnet-5-5   # optional model of fresh fix-round sessions (default: the reviewer model)
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repro_test` | string | No | `prefer` (default): on an issue labelled `bug` or `type:bug`, the plan step must freeze a `repro_test` in the contract (`{"path","id","command"}`) when the bug is testable. Before review, the engine runs `scripts/acceptance-red-green.sh` for that command on the host in every verify mode: one targeted test, red on the base (head's changed test files overlaid) and green on head. A test that ran but is not red on the base and green on head fails the precheck as `conformance.unimplemented` (it blocks in shadow too) and goes back to the builder for one in-session fix round. A head the harness could not run at all (timeout, missing runner or dependencies) ends `needs-human` with the recoverable code `env.repro_unrunnable`, not a builder round: the batch runner's recovery lane reruns it through the repo's own toolchain (see docs/OUTCOME-CODES.md). The harness runs with the lane env (`TMPDIR`, toolchain) and the workspace dependency trees, and a repro test file that is new on head is run against the base sources. A bug that is not testable (specs, docs, workflows, environment) records `"repro_test":"none"` with a one-line `repro_test_reason` and the lane continues as before. `off` gives exactly the previous contract and precheck. Each proof emits a `REPRO_RED_GREEN` run-log event (`base`, `head`) and adds a trajectory decision. |
| `precheck.max_minutes` | number | No | Total budget in minutes (1–120) of one round of pre-PR check commands (#4331). The flat form `lean.precheck_max_minutes` also works and wins. When unset, `verify.precheck_total_seconds` applies (default 600 s). Check commands run change-scoped (a learned command with a test-map entry runs only when its globs match the changed files; unmapped commands always run), concurrently up to the host worker cap under one heavy slot, each timed (`ms` in the `PRECHECK_COMMANDS` run-log event). Commands not started when the budget runs out are recorded `deferred-to-ci` (an anomaly, not a failure) and left to CI. |
| `fix_model` | string | No | Model of fresh fix-round sessions (#4363; `engine.lean_fix_model` is also read). Default: the reviewer model (`engine.lean_reviewer_model`, else Sonnet). Fix rounds for precheck, CI, docs, structure, enumerating-test and sequence-number failures, and conformance or review FAILs whose failures all cite a `file:line`, run in a fresh session (no resume of the builder's transcript) whose prompt carries only the round's failure output, the capped `git diff <base>...HEAD`, the frozen contract and the issue title and summary (under 60K characters). A fresh session that makes no commit gets one resume of the original builder session in the same round. Other rounds (block or contract corrections, CI unavailable, base-sync conflicts, failures without a file:line) resume the builder as before; round limits (`verify.max_rounds`, the one review retry) are unchanged. The run log's `PHASE_ATTEMPT_USAGE` records `mode: "fresh"\|"resume"` on each fix-round attempt. Plan and build sessions keep the builder model. |

## `stats` (OPTIONAL)

Thresholds of the fail-soft alerts (#4354). `forgedock stats` prints them as an `ALERTS` section, and the `forgedock orchestrate` batch report ends with the alerts for the batch's repo. Steps that never fail a run (shared dependency cache, pre-PR check budget, toolchain detection) can degrade silently. The alerts compare their rates in the local run logs (`~/.forge/runs`, or `FORGE_RUNS_DIR` for `forgedock stats`) against these thresholds. They read no network source and use no model.

```yaml
stats:
  alerts:
    window: 50                # last N lanes per repo
    min_lanes: 10             # fewer lanes in the window: nothing is printed
    deps_failed_pct: 20       # DEPS_PREPARED status failed, per ecosystem
    deferred_to_ci_pct: 30    # lanes with a deferred-to-ci pre-PR check
    toolchain_warning_pct: 50 # lanes repeating the same TOOLCHAIN_WARNING
    outcome_share_factor: 2   # outcome code share vs the previous window
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `alerts.window` | number | No | Rolling window: the last N lanes of the repo, ordered by `RUN_START`. Each run in a run log is one lane. Default 50. |
| `alerts.min_lanes` | number | No | With fewer lanes in the window, or no run logs, nothing is printed. Default 10. |
| `alerts.deps_failed_pct` | number | No | Alert when `DEPS_PREPARED` status `failed` is above this percentage of the lanes that prepared that ecosystem. Default 20. |
| `alerts.deferred_to_ci_pct` | number | No | Alert when more than this percentage of lanes left a pre-PR check `deferred-to-ci`. Default 30. |
| `alerts.toolchain_warning_pct` | number | No | Alert when one `TOOLCHAIN_WARNING` text is repeated on more than this percentage of lanes. Default 50. |
| `alerts.outcome_share_factor` | number | No | Alert when an outcome code other than `completed` has at least this factor of its share in the previous window. The code must be on at least 2 lanes, and the previous window must have at least `min_lanes` lanes. A code new in this window counts. Default 2. |

Each alert line names the event, the rate, the sample size (`count/sample` lanes) and one example reason. When no alert fires, nothing is printed. The flat form `stats.alerts_<key>` also works and wins. `forgedock stats --no-local` skips the alerts.

## `verify` (OPTIONAL)

Verify-by-CI for the core work-on path (forge#4167). It moves a lane's heavy verification (type-checks, test suites, docker test containers) off the host and onto CI runners, and it catches CI-class failures (lock files, suite wiring, hangs, formatting) before the lane merges into staging. Write it as a block-style section: `parseForgeYaml` does not read inline `{ ... }` maps.

```yaml
verify:
  mode: ci                      # local (default) | ci | hybrid
  workflow: forgedock-verify.yml  # optional; needs an `on: workflow_dispatch` trigger
  paths_input: changed_paths    # optional workflow_dispatch input that receives the changed paths (newline-separated)
  skip_paths: "*.md,docs/**"    # optional, comma-separated; default *.md,*.mdx,*.rst,*.txt,docs/**,devdocs/**
  max_rounds: 2                 # optional CI fix rounds before needs-human (default 2)
  precheck_timeout_seconds: 300 # optional per-command timeout of the declared pre-PR checks (default 300)
  precheck_total_seconds: 600   # optional total budget of one pre-PR check round (default 600)
  check_run: true               # optional; post the forgedock/verify check run (default false)
  e2e: auto                     # optional e2e merge gate: auto (default) | always | never
  e2e_label: full-ci            # PR label that makes the repo's CI run e2e (label path)
  e2e_checks: "e2e"             # check names of the e2e jobs the label path waits on
  # e2e_workflow: e2e.yml       # or: a workflow_dispatch workflow that runs e2e (wins over the label)
  # e2e_paths_input: specs      # its input that receives the changed spec paths
  # e2e_paths: "e2e/**,tests/e2e/**"  # globs of e2e specs (default below)
  # e2e_blocking: changed       # changed (default) | all
```

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `mode` | string | No | `local` (default): today's behaviour; the builder runs every validate command on the host and no CI is started before review. `ci`: the builder runs only formatters and linters on the files it changed (no type-checks, test suites or test containers) and records validate ids it left to CI as `{"id","command","ci":true}`; the engine verifies on CI. `hybrid`: the builder runs the targeted validate commands too, and CI also verifies. |
| `workflow` | string | No | Workflow file name or id dispatched on the lane branch (`gh workflow run <workflow> --ref <branch>`). The engine waits for the `workflow_dispatch` run of the lane's head commit. Without it, the engine waits on the head commit's push-triggered check runs. |
| `paths_input` | string | No | Name of a `workflow_dispatch` input that receives the changed paths, so the workflow can scope its jobs to the change. |
| `skip_paths` | string | No | Comma-separated globs. A glob without `/` matches the basename anywhere; `**` spans directories. When every changed file matches, the lane skips CI verification (a docs-only lane runs no CI matrix). |
| `max_rounds` | integer | No | Builder fix rounds for red CI (0–10, default 2). Also bounds the merge-time fix rounds and the declared-check fix rounds below, in every mode. |
| `precheck_timeout_seconds` | integer | No | Timeout of each declared check command (1–3600, default 300); a timed-out command counts as failed (exit 124). |
| `precheck_total_seconds` | integer | No | Total budget of one round of pre-PR check commands (1–7200, default 600; it was 1800 before 1.30.0). `lean.precheck.max_minutes` takes precedence. Commands not started within the budget are deferred to CI, not failed. |
| `check_run` | boolean | No | Default `false` (no Checks API call, behaviour unchanged). `true`: after each push of a reviewed head (PR open, base-sync, merge-time fix round) the engine posts one completed `forgedock/verify` check run on that head (forge#4270), `success` iff every deterministic gate the lane already ran passed: declared check commands, undeclared package edges, docs freshness, contract scope, validate ids, requirement status, hotspot growth, amendments. The output carries each gate's id, pass/fail and evidence as JSON; the run log records a `VERIFY` event. Report only: ForgeDock never makes it required and never waits on it (it is ignored by its own CI waits); requiring it is the repository's branch-protection choice. Creating check runs needs a token that may (a GitHub App with `checks: write`); a Checks API failure is logged as an anomaly and never fails the lane. |
| `e2e` | string | No | e2e merge gate (forge#4403). `auto` (default): run e2e when the diff touches `e2e_paths` or a contract requirement quote has `[type:e2e]`. `always`: on every lane except docs-only ones. `never`: today's behaviour. Without `e2e_label` or `e2e_workflow` no e2e can run, so every mode keeps today's behaviour (a lane that changed specs records a decision saying so). |
| `e2e_label` | string | No | Label added to the PR (`gh pr edit --add-label`) so tiered CI runs its e2e jobs. The label must already exist in the repo. |
| `e2e_checks` | string | No | Comma-separated check-run names of the e2e jobs the label path waits on. Default: every check on the head except `forgedock/verify`. A check run concluded `skipped` (the unlabelled tier) counts as not run. |
| `e2e_workflow` | string | No | Workflow file name or id dispatched on the lane branch instead of the label (`workflow_dispatch`); the engine waits for its run of the reviewed head. Wins over `e2e_label`. |
| `e2e_paths_input` | string | No | `workflow_dispatch` input of `e2e_workflow` that receives the changed spec paths (newline-separated). |
| `e2e_paths` | string | No | Comma-separated globs of e2e specs (same glob rules as `skip_paths`). Default `e2e/**,**/e2e/**,*.e2e.*,*.e2e-spec.*,cypress/**,playwright/**`. |
| `e2e_blocking` | string | No | `changed` (default): only failures of the lane's own specs block the merge; other e2e failures are reported as an anomaly. `all`: every e2e failure blocks. |

**Flow** (`ci`/`hybrid`, `bin/lean/verify.mjs` `runCiVerify`):

1. After the build and before every conformance review, the engine pushes the lane branch (a plain push, never forced) and runs CI on the head. A base-sync that moves the head is verified again.
2. Green (or skipped by `skip_paths`): the review runs. The precheck accepts validate ids left to CI for that head, but a recorded non-zero exit still fails.
3. Red: the failed jobs' logs (`gh run view --log-failed`, tails capped at about 12 KB) go back to the builder session. The builder fixes and commits, and the engine pushes and verifies again. Still red after `max_rounds`, or a fix round with no new commit, ends as `needs-human` (`ci.red`) and nothing merges.
4. Slow CI: once the core CI wait budget (360 min, the same budget the merge wait uses) is used up, the lane ends `ci-pending` and can be resumed. Slow CI is never `needs-human`.
5. CI unavailable (dispatch refused, or no run or check for the head within 5 minutes): one local fallback. The builder runs every validate command on the host and records real exit codes.

Each verification emits a `CI_VERIFY` run-log/telemetry event (`mode`, `round`, `result`, `skipped`, `run_url`) and adds a **Verify** row to the trajectory.

**Every mode, including the default `local` (forge#4240):**

- **Declared check commands before the PR.** Each `learned.test_commands` entry (a block list under `learned:`) runs with `bash -c` in the lane worktree after the build commit, before review and before the PR, with the per-command timeout above. These run on the host and use no Actions minutes. If they all pass, there is no extra builder turn. A failure resumes the builder in its session with the command, its exit code and the output tail, then the commands run again, up to `max_rounds`. A round with no new commit, or exhausted rounds, is recorded as an anomaly and the lane continues, because CI stays the gate. The engine has no built-in command list: to run `scripts/ci-local.sh`, list it here. Each round emits a `PRECHECK_COMMANDS` run-log event (`round`, `results: [{command, rc}]`).
- **The same checks in the builder's session (#4364).** The builder runs `forgedock check` in the lane worktree before it writes its result: the contract's validate commands plus the same change-scoped pre-PR commands, budget and worker cap, locally (no GitHub, no Actions minutes). The engine hands it the settings above in `.forge-lean/check-plan.json`; outside a lane, `forgedock check --base REF` reads this file's `learned.test_commands`, `lean.precheck.max_minutes` and `verify:`. A builder result of `fixed` without a passing run on its final tree logs a `SELF_CHECK_MISSING` run-log event (`state`: `skipped`, `stale` or `red`), and a failed pre-PR round's `PRECHECK_COMMANDS` event carries `self_check`. Neither fails the lane: the engine's own checks and CI stay authoritative.
- **Fix rounds at merge.** When a required check fails on the PR (`engine.merge_wait: required`), the failed jobs' logs (`gh run view --log-failed`, capped) go back to the builder session. The fixed head is re-reviewed and pushed, then the wait starts again. Still red after `max_rounds` (one budget shared with the `ci`/`hybrid` rounds above), or a round with no new commit, ends `needs-human` (`ci.red`). `max_rounds: 0` ends `ci.red` on the first failure. Each round emits a `CI_FIX_ROUND` run-log event (`trigger`, `round`, `jobs`). `merge_wait: all` is unchanged.

**e2e merge gate (forge#4403, every verify mode).** Tiered CI usually skips e2e on lane PRs, so required checks alone let a lane merge with its own e2e specs failing. When the gate runs (see `e2e` above), after the merge wait and before `gh pr merge`, once per reviewed head, the engine labels the PR with `e2e_label` and waits on the head's `e2e_checks` (or dispatches `e2e_workflow` and waits on its run), with the same CI wait budget.
- Green: the PR merges.
- Red: a failure is the lane's when its failed-job log names one of the spec files the lane changed (path or basename), when the log is empty, or when the lane changed no spec (a `[type:e2e]` contract). The lane's failures (all failures with `e2e_blocking: all`) go back to the builder like a failed required check: one fix round from the shared `max_rounds` budget, re-review, push, then the wait and the e2e run start again; `ci.red` when the rounds are spent. Other failures are recorded as an anomaly and the PR merges.
- Still pending at the budget: `ci-pending` (resumable). Label refused, dispatch refused, or no e2e run within 5 minutes: `needs-human`, nothing merged.

Each run emits an `E2E_VERIFY` run-log/telemetry event (`pr`, `head`, `reason`, `result`, `specs`, `failures`, `own`, `blocking`). It spends Actions minutes only after review, on lanes that touch e2e.

**Cost:** `ci`/`hybrid` spend GitHub Actions minutes before review, so they are opt-in per repo. On the green path they add no LLM calls; each red CI round adds one builder resume. The merge gate (`engine.merge_wait`) is unchanged.

**Commands that use this section**: core work-on (`forgedock run-issue`, `forgedock orchestrate`; `bin/engine-cli.mjs` `readVerify`)

## `execution` (OPTIONAL)

Where `forgedock orchestrate` runs its lanes (forge#4253). Block style only.

```yaml
execution:
  mode: remote          # local (default) | remote | hybrid
  max_remote: 4         # remote lanes running at once (default 0 = remote off)
  provider: container   # default container when mode is not local
  image: my/lane-image:1  # container provider: an image with git and forgedock; never pulled
  secrets: GH_TOKEN,ANTHROPIC_API_KEY  # env var NAMES forwarded to the sandbox; nothing else is
  # provider: remote (forge#4254), only when named explicitly:
  # endpoint: https://runner-pool.example/v1  # sandbox HTTP API (protocol below)
  # token_env: FORGEDOCK_SANDBOX_TOKEN        # credential NAME: read from the env, else the OS keychain
  # cache_store: s3://lane-cache               # shared cache store the sandbox mounts
  # allow_actions: false                       # true only to accept a GitHub Actions endpoint
  # execution budget (forge#4255): flat keys, forge.yaml is parsed one level deep
  budget_minutes: 600      # hard cap on sandbox-minutes per batch
  budget_usd: 25           # hard cap on estimated sandbox USD per batch
  day_budget_minutes: 2000 # hard cap on sandbox-minutes per host UTC day (all batches, schedd or not)
  day_budget_usd: 80       # hard cap on estimated sandbox USD per host UTC day
  on_budget: stop          # stop (default) | local: what the queue does once a cap is reached
  cost_per_minute: 0.04    # USD per sandbox-minute when the provider reports no cost (default 0)
```

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `mode` | string | No | `local` (default): lanes are detached host processes, as before. `remote`: lanes run in sandboxes of `provider`. `hybrid`: each lane is placed from facts (forge#4256, below). |
| `max_remote` | integer | No | Remote lanes of the batch that may run at once. They take no slot of the host lane cap (`orchestration.global_parallel`, `forgedock sched cap`); the batch `--parallel` still applies. `0` (default) keeps lanes local. |
| `provider` | string | No | `container` (reference: an ephemeral local container), `remote` (a runner pool or remote session over HTTP, forge#4254) or `local`. The default is `container` off `local` mode; `remote` is used only when named. Unknown names fail the batch start. |
| `image` | string | No | Container provider image; it must provide `git` and `forgedock`. Started with `--pull never`. |
| `secrets` | string | No | Comma-separated env var names copied from the dispatcher's env into the sandbox. The sandbox also gets `GH_REPO` (the target repo) and `FORGEDOCK_BATCH_ID`, and nothing else from the host. |
| `endpoint` | string | `remote` | Base URL of the sandbox API. A GitHub Actions API (`api.github.com`, or any `/actions/` path) is refused unless `allow_actions: true`, so pre-review Actions minutes are never spent implicitly. Missing: the batch start fails (`execution.provider.misconfigured`). |
| `token_env` | string | No | Name of the API credential, sent as `Authorization: Bearer`. Read from the env, else the OS keychain (service `forgedock`, account = the name: `secret-tool store --label forgedock service forgedock account NAME` on Linux, `security add-generic-password -s forgedock -a NAME -w` on macOS). Never written to the ledger, the batch state, logs or GitHub. |
| `cache_store` | string | No | Shared cache store the remote sandbox mounts (sent as `cache.store` with `cache.key` = the repo). |
| `allow_actions` | boolean | No | `true` accepts a GitHub Actions endpoint. Default `false`. |
| `budget_minutes`, `budget_usd` | number | No | The `execution.budget` per batch: once the batch's sandbox minutes / estimated USD (settled lanes plus the running ones' elapsed time) reach the cap, no new remote lane is admitted. Missing, non-numeric or negative means no cap. |
| `day_budget_minutes`, `day_budget_usd` | number | No | The same cap per host UTC day, summed over every batch on the host from the host-day store (`execution-budget.json` in `~/.forge/sched/`, or `FORGEDOCK_EXECUTION_BUDGET_FILE`). A corrupt or unreadable store refuses remote lanes while a day cap is set; remove the file to reset it. |
| `on_budget` | string | No | `stop` (default): running lanes finish and the rest end `held` (`execution budget: ...`) for a later `--resume`. `local`: the rest run as detached host lanes. |
| `cost_per_minute` | number | No | USD per sandbox-minute, used when the provider reports no cost of its own (the `container` provider never does). Default `0`. |

**Lifecycle:** each sandbox is listed in the lane ledger (`~/.forge/ledger/<batch>/sandbox-<n>.json`, kind `sandbox`) before it starts and removed from it only after teardown succeeded: on success, failure, a lane that exits without a result, and adopt after `--resume`. A sandbox left by a killed dispatcher is reaped by `forgedock gc --apply` (scope `--sandboxes`). The container provider mounts the checkout's git dir read-only at `/src` (cloned to the container's own `/work`), `~/.forge/verify-cache` read-only at `/cache`, and the batch `lanes/` dir at `/result`.

**Remote provider** (`bin/lean/sandbox-remote.mjs`, forge#4254). The sandbox is addressed by the id ForgeDock picks (`fdrsbx-<batch>-<issue>`), JSON over HTTP:

| Request | Response |
|---------|----------|
| `POST /sandboxes` | Launch spec `{id, issue, batch, image, repo: {slug, url, ref}, cache: {store, key} \| null, env, command, result_file}`. The sandbox clones `repo.url` at `repo.ref`, mounts the cache, runs `command` (`forgedock run-issue ...`) with exactly `env` (the `secrets` names, resolved from the env or keychain, plus `GH_REPO` and `FORGEDOCK_BATCH_ID`). `429`/`503` = no capacity (`Retry-After` honoured). |
| `GET /sandboxes/:id` | `{state}`: `pending`/`starting`/`running`, `exited`, or `404` = gone |
| `GET /sandboxes/:id/logs?cursor=N` | `{text, cursor}`: lane log since `cursor`; appended to the batch lane log with secret values redacted |
| `GET /sandboxes/:id/result` | The lane's result file (`404` until written) |
| `GET /sandboxes/:id/usage` | `{minutes}`: billable sandbox minutes, set on the handle and the lane result (`sandbox.minutes`); without it, wall-clock minutes |
| `DELETE /sandboxes/:id` | Teardown; `404` counts as torn down |

**Start failures** (every provider): a sandbox that cannot start ends the lane `needs-human` with code `sandbox.start_failed`, not relaunched and not counted by the engine-error breaker; a capacity error ends it `deferred` (`sandbox.capacity`, backoff, bounded by `orchestration.max_deferrals`). See docs/OUTCOME-CODES.md. `forgedock gc --apply --sandboxes` tears a stale remote sandbox down through the same API (the checkout's forge.yaml `execution`).

**Hybrid placement** (`mode: hybrid`, forge#4256, `bin/lean/execution.mjs` `placeLane`, no model call). Each lane is placed when it is admitted. The first matching rule wins:

1. `max_remote: 0` → local.
2. `verify.mode: ci` → local. Heavy validation already runs, and is billed, on CI, so the lane is not billed twice.
3. A docs-only lane (issue label `docs`, `documentation` or `type:docs`) → local.
4. Heavy expected validation → remote. This means a declared check command (`learned.test_commands`) is a type check, linter, test runner or build, or the repo has a heavy toolchain marker: `tsconfig.json`, an eslint config, a package.json `test`/`lint`/`typecheck`/`build` script, `Cargo.toml`, `go.mod`, `pyproject.toml`/`setup.cfg`/`pytest.ini`, `pom.xml` or `build.gradle`.
5. A host without headroom → remote. "Without headroom" means MemAvailable is below `engine.min_free_mem_mb` + `engine.heavy_step_mem_mb`, or the load per core is above `engine.max_load_per_core` when that is set.
6. Otherwise → local.

A lane placed remote runs on the host instead when `max_remote` remote lanes are already running, or when the execution budget refuses it. In hybrid mode this happens whatever `on_budget` says. The decision `{where, reason}` (for example `fallback to local: max_remote 4 reached (heavy validation: tsc)`) is recorded:

- in the batch row (`placement`);
- in the trajectory (`Placement: ...`);
- in the lane's FORGE:STATE as `placement: {where, reason, mode}`. The lane gets it as `run-issue --placement <local|remote> --placement-reason <text>`.

**Cost and budget:** every remote lane's sandbox minutes and estimated cost (the provider's own usage report, e.g. the remote provider's `/usage` minutes, else wall-clock minutes × `cost_per_minute`) land in its row (`sandbox: {minutes, cost_usd, attempts}`, summed over relaunches), in `report.json`, in the printed table (`sbx-min`, `sbx-$` next to the token `cost`, shown only when a lane used a sandbox), in a `sandbox:` summary line with the budget state, and in FORGE:TELEMETRY as one `sandbox_usage` event per lane. The caps are plain arithmetic, no model call. The batch total is kept in the batch `state.json` and the day total in the host-day store, so both survive `--resume` and a schedd restart.

**Commands that use this section**: `forgedock orchestrate` (`bin/engine-cli.mjs` `readExecution`), `forgedock gc`

## `env` (OPTIONAL)

Lane environment for the core work-on (#4163). With no keys set, lanes still pin the target repo's own toolchain:

- **Package manager**: `package.json` `packageManager` (`pnpm|yarn|npm@x.y.z`, a `+sha…` suffix is ignored), else a `pnpm`/`yarn` line in `.tool-versions`. After the worktree is added the engine writes shims for it (`pnpm`+`pnpx`, `yarn`, or `npm`+`npx`) to `<run tmp>/toolchain/bin`. Each shim runs `corepack <pm>@<version>` (npm always via `npx -y`), or `npx -y` when corepack is not on PATH (yarn ≥ 2 via `@yarnpkg/cli-dist`). The shim dir goes first on the PATH of every runner call (builder and reviewer), so the builder's shell, its validate commands and git hooks (lefthook, husky) resolve the pinned version. `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` and `COREPACK_ENABLE_STRICT=0` are set. The builder prompt says the toolchain is pinned and not to install global shims.
- **Node**: `.nvmrc`, else `.node-version`, else `.tool-versions` `nodejs`, else `package.json` `engines.node`. When the host `node` does not satisfy it, the run's trajectory shows a warning under **Anomalies**. Node is not switched.

A repo with no pins and no `env` keys runs exactly as before: no shim dir, no env change, no prompt change.

```yaml
env:
  toolchain: "pnpm@10.4.1"              # optional: overrides the detected package manager; "off" disables detection
  setup: "bash scripts/reconcile-dev-db.sh"   # optional: run once per fresh lane worktree, before the builder
  sparse_max_kb: 1024                   # optional: tracked files this size or larger stay out of lane worktrees; 0 = full checkout
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `toolchain` | string | No | `<pnpm\|yarn\|npm>@<x.y.z>` replaces the detected package-manager pin; `off` disables all toolchain detection. An invalid value is ignored and recorded as an anomaly. |
| `setup` | string | No | Shell command (`bash -c`) run once in each fresh lane worktree before the builder starts, with the lane's PATH and `TMPDIR`. Use it for environment drift the repo's migrations don't cover, for example a dev-database reconcile script. Timeout 15 min. A non-zero exit ends the lane `needs-human` with code `env.setup_failed`: an environment error, not a build failure. The builder never runs. |
| `sparse_max_kb` | integer | No | Default `1024`. Lane worktrees are sparse checkouts: tracked files of this many KB or more (generated JSON, screenshots, PDFs, media) are not written to disk, which cuts per-lane disk in repos that track large assets (#4221). Lockfiles, manifests (`package.json`, `pyproject.toml`, `requirements*.txt`, ...), toolchain pins, `tsconfig*.json`, `forge.yaml`, `.gitattributes` and `.gitignore` are always checked out. A repo with no such file gets a plain checkout. The builder prompt names the absent files; `git sparse-checkout add /<path>` brings one back. `0` disables it. Git sets `extensions.worktreeConfig=true` in the repo's shared config; the sparse setting itself is per lane worktree, so the main checkout is unchanged. If the sparse setup fails, the lane uses a full checkout. |

**Commands that use this section**: `forgedock run-issue`, `forgedock orchestrate` (core path; `bin/engine-cli.mjs` `readEnvConfig`)

---

## `build` (OPTIONAL)

Tuning for the `/work-on` build phase. Today it holds the **scope check** (forge#3862, replacing the diff-size gate): after the implement phase stages its changes and before validation commits them, the build compares the staged diff with the architect plan (the `PLANNED_FILES:` list and `ESTIMATED_DIFF_LINES` in the plan's `### Scope Baseline`), measures a deterministic `review_weight` with `scripts/diff-size.sh`, and records the outcome in `FORGE:DIFF_SIZE`. **Size never blocks, a finished build is never discarded, and a completed build is never routed to decompose.**

```yaml
build:
  scope:
    test_weight: 50          # percent weight of test lines in review_weight (default 50)
    module_depth: 2          # path segments that define a module (default 2)
    overrun_pct: 200         # whitespace-insensitive lines over the plan estimate, in percent, that count as scope creep (default 200)
    trim_out_of_plan: false  # move out-of-plan hunks into the batched follow-up checklist (default false: flag only)
    trim_max_files: 3        # trim only when at most this many files are out of plan (default 3)
    # Extra exclusion globs, ADDITIVE to the built-in defaults below.
    exclude_globs:
      - "docs/api/*"
      - "*.pb.go"

review:
  depth:
    extended_weight: 1500    # review_weight at or above which review is EXTENDED (default 1500)
    extended_modules: 6      # modules touched at or above which review is EXTENDED (default 6)
    slice_files: 12          # changed files per slice in extended review (default 12)
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `build.scope.test_weight` | integer | No | Percent of a test file's changed lines counted in `review_weight` (tests are easier to review). Default: 50 |
| `build.scope.module_depth` | integer | No | Leading path segments of a file's directory that identify a module for the `modules` count. Default: 2 |
| `build.scope.overrun_pct` | integer | No | The scope is flagged when whitespace-insensitive changed lines exceed the plan's estimate by more than this percent (200 = more than twice the estimate). Default: 200 |
| `build.scope.trim_out_of_plan` | boolean | No | Opt-in. Moves each out-of-plan file's hunks out of the PR into the batched follow-up issue (forge#3843); the hunks are saved in a patch file next to the git dir, so nothing is lost. Never triggered by an overrun alone. Default: `false` (flag only) |
| `build.scope.trim_max_files` | integer | No | Trim only when at most this many files are out of plan; more is flagged, not trimmed. Default: 3 |
| `build.scope.exclude_globs` | list of strings | No | Globs excluded from the measurement, in addition to the built-in defaults. Default: `[]` |
| `review.depth.extended_weight` | integer | No | `review_weight` at or above which the build records `review_depth: EXTENDED`. Default: 1500 |
| `review.depth.extended_modules` | integer | No | Modules touched at or above which the build records `review_depth: EXTENDED`. Default: 6 |
| `review.depth.slice_files` | integer | No | In extended review, each domain agent reviews slices of at most this many changed files. Default: 12 |

All thresholds are config values with generous defaults, to be calibrated from telemetry (`diff_size` events carry the plan estimate, the actual, `review_weight`, the scope outcome and the review depth; see `docs/TELEMETRY.md`).

**`review_weight`** (computed by `scripts/diff-size.sh`): changed lines with whitespace ignored (`git diff -w`, so a pure re-indent counts about 0), over the counted files only (generated and vendored code excluded), where test files count `test_weight` percent. `modules` counts the distinct directories (first `module_depth` segments) holding at least one non-whitespace change. It drives review depth, never blocking.

**Built-in default exclusions** (always applied, defined once in `scripts/diff-size.sh`): lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`), `*.min.*`, `*.snap`, and the directories `dist/`, `build/`, `generated/`, `fixtures/`, `vendor/` (anchored to the repo root, so first-party directories such as `commands/work-on/build/` are counted) plus `__generated__/` and `__snapshots__/` (any depth). The diff is measured against the merge base of `HEAD` and `origin/<base>`, so commits that landed on the base after the branch point are not counted. A configured glob ending in `/` matches that directory at any depth; any other glob is matched against the file basename and the full path. Globs are treated as data, never evaluated.

**Scope-check outcomes** (`result:` in `FORGE:DIFF_SIZE`): `OK` (in plan, standard depth); `EXTENDED_REVIEW` (in plan, `review_weight` or `modules` at the extended threshold: review adds reviewers and per-file slices); `SCOPE_FLAGGED` (files outside the plan, or an estimate overrun: listed in the comment for review, review extended, optionally trimmed); `OVERRIDDEN` (scope flagged but a justified `FORGE:SIZE_OVERRIDE` is present). An architect skip marker (empty plan) means no plan baseline: the out-of-plan check is skipped, never blocking. A `FORGE:SIZE_OVERRIDE` comment (trusted author, non-empty justification on the line after the marker) suppresses the scope flag and the decompose loop guard. The measured `diff_lines` is still recorded in the `FORGE:TRAJECTORY` comment.

**Decomposition is a planning decision**: `work-on:investigate` answers `**YES**` only when the work is separable (independent modules or services, no shared files, no ordering dependency, each piece independently testable), with the reason recorded; a cohesive change stays one unit at any size. It emits `ESTIMATED_DIFF_LINES` (the scope baseline) and `INDEPENDENT_SEAMS` inside `### Decomposition Assessment`. The engine downgrades a `**YES**` to NO unless `INDEPENDENT_SEAMS` is at least 2 with an own-line `DECOMPOSE_JUSTIFICATION:`; it has no line-count rule. A sub-issue, an issue with a trusted `FORGE:DECOMPOSED` comment, or one with a justified `FORGE:SIZE_OVERRIDE` is never decomposed (decompose Guard 1).

**Migration from `build.diff_size.*`** (deprecated; read as aliases for one release, then removed):

| Old key | New behaviour |
|---------|---------------|
| `build.diff_size.threshold` | No longer a gate. A positive value is read as `review.depth.extended_weight` (extended review instead of a block or split); `0` (gate disabled) now just means the defaults. The build records `deprecated_config` in `FORGE:DIFF_SIZE` when an alias supplied a value |
| `build.diff_size.exclude_globs` | Read as an alias of `build.scope.exclude_globs` (additive) |
| `build.diff_size.estimate_factor`, `build.diff_size.batch_seam_min` | Ignored. The investigator's decomposition rule is separability, not a line count |

`BUILD_RESULT: status: NEEDS_DECOMPOSE`, the `forge/wip/{NUMBER}` ref, the cohesive-overage path and the outcome code `build.size_over_gate` are retired. An old run whose build was handed to decompose can be resumed at build with `run-issue --retry` once a trusted `FORGE:DECOMPOSED:REVOKED` comment (newer than the `FORGE:DECOMPOSED` comment) and a justified `FORGE:SIZE_OVERRIDE` are on the issue; untrusted comments never reopen a run.

**Commands that use this section**: `work-on` (build phase B5.5, `close`), `review-pr` (Phase 3 review depth)

---

## `decomposition` (OPTIONAL)

Controls what happens to a decomposed parent issue. A parent is only a tracker for its sub-issues, but while it is open it inflates GitHub's open-issue count and every backlog view.

```yaml
decomposition:
  # Close the parent at decomposition. Default: false (parent stays open until its last child closes).
  close_parent: true
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `close_parent` | boolean | No | When `true`, `work-on:decompose` (Phase D6.5) closes the parent after the sub-issues exist, `FORGE:DECOMPOSED:COMPLETE` is posted and `workflow:decomposed` is set, with the comment "Decomposed into #a #b #c; tracked here until all complete". The label is kept. Every child body is also checked for the `**Parent**: #N` reference. Default: `false`. Any value other than `true`, or an unreadable config, leaves the parent open |

**Batch members**: when the parent carries a `FORGE:BATCH_MEMBERS` block, `work-on:decompose` (Phase D2.7) reopens and reuses a closed member that matches a planned sub-issue one to one, instead of filing a duplicate. Members with a merged PR or a `false-positive`, `needs-human` or `operator-only` label are never reopened, and any ambiguity falls back to creating a new issue. There is no config key for this.

**With `close_parent: true`**: `work-on:close` Phase C3 keeps checking children off the closed parent's checklist. When the last child closes, the parent gets an "All sub-issues complete" comment and `workflow:merged`; it is not closed a second time and never reopened. `/pipeline-status` and `/pipeline-health` exclude `workflow:decomposed` from work counts and report them separately as `trackers (N)`. `/orchestrate` expands an explicitly requested closed decomposed parent to its open children.

**With `close_parent: false`** (default): unchanged. The parent stays open and is closed by C3 when the last child closes.

The lean (core) path reads the same key (#4337): with `close_parent: true` it closes the parent at decomposition as `not planned`, keeps `workflow:decomposed` and lists the sub-issues in the closing comment; dependents still wait on the sub-issues, and a trusted `FORGE:DECOMPOSED:REVOKED` reopens it. With the default `false` the lean parent stays open.

**Limitation**: `--retry` and engine resume refuse closed issues, so a closed decomposed parent cannot be re-run. It has nothing left to run; work on its open children instead.

**Commands that use this section**: `work-on` (`decompose` D6.5, `close` C3), `orchestrate`

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

  # max_filed_findings: 2   # per-review cap on filed findings (default 2; 1 on review-finding lineage)

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
| `max_filed_findings` | integer >= 0 | No | Per-review cap on ISSUE dispositions (`scripts/cap-findings.sh`, applied by `review-pr` §6B.5 and `review-pr-staging` §7B (via `review-finalize.sh classify`) after classification). Default `2`; `1` when the reviewed PR is itself a fix for a `review-finding` issue, where every filed HIGH/CRITICAL consumes that budget. ISSUE findings are ranked by severity, then confidence, then safety-domain agent (security, auth, billing, concurrency, database), then input order; an unparseable severity or confidence ranks as MEDIUM/LIKELY. The overflow becomes `NOTE capped`: listed in the PR body and counted as `notes_capped` in `FORGE:NOTE_DISPOSITION`, never filed and never dropped. **HIGH/CRITICAL findings are never capped** and still block; `ISSUE fix-efficacy-*` findings (the linked issue is not fixed, or the PR re-introduces its defect) are never capped either and count against the review-finding budget like HIGH. `0` is valid (cap every MEDIUM/LOW finding); a non-numeric or negative value falls back to the default with a warning. An explicit value overrides both defaults. |
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

  consumer_sweep:
    mode: advisory         # advisory (default) | blocking
    budget_seconds: 60     # wall-clock budget for the sweep
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `health_endpoint` | string | No | Primary health-check URL that should return HTTP 200 |
| `health_patterns` | array of strings | No | Strings that must appear in the health endpoint response body |
| `services` | array | No | Named services to verify as part of deployment validation |
| `services[].name` | string | **Yes (per entry)** | Human-readable service name |
| `services[].container` | string | No | Docker container name for `docker exec` verification |
| `services[].health_url` | string | No | Local URL for container-level health checks |
| `ci_local` | object | No | Local CI gate settings (see below) |
| `consumer_sweep.mode` | string | No | `advisory` (default): the validate consumer sweep (`scripts/consumer-sweep.sh`, V4.6) records unaddressed referencing sites and never fails. `blocking`: unaddressed sites fail validate with `consumer_unaddressed`, build runs one repair round, and sites still unaddressed are recorded as `CONSUMERS: unresolved` and passed to review as known risk (never `needs-human`). Flip to `blocking` only after `bash scripts/consumer-sweep.sh --eval-history 20` shows a mean of at most 2 flagged sites per merge and none above 10 on your repo |
| `consumer_sweep.budget_seconds` | integer | No | Wall-clock budget for the sweep (default `60`). When it runs out the sweep stops with `BUDGET_EXCEEDED`, reports the partial result, and never fails, in either mode |

**Commands that use this section**: `quality-gate`, `validate` (V2 runs `verification.commands`; V4.8 runs the local CI gate; health checks and `consumer_sweep`), `work-on`

### `verification.ci_local` (OPTIONAL)

Validate Phase V4.8 runs `scripts/ci-local.sh` before review: it derives the repo's pull-request checks from its own CI
definitions and runs them locally in the build worktree, so deterministic CI failures are fixed in build (at most 2 fix
iterations; a failure still unfixable after that is DEGRADED by default, see `mode`). It never contacts GitHub and never triggers a remote
workflow; remote CI still runs once, at merge. Everything works with no configuration.

```yaml
verification:
  ci_local:
    mode: advisory
    exclude_jobs: ["gha:ci:e2e-*"]
    include_jobs: []
    extra_commands:
      - "make lint-docs"
    services: auto
    budget_minutes: 15
    max_parallel: 4
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `advisory` \| `blocking` | `advisory` | `advisory`: a runnable job still failing after the 2 fix iterations is DEGRADED (`DEGRADED_CHECKS+=ci-local`), recorded in `FORGE:BUILDER` under `### Local CI unresolved` and surfaced to review; the build is not blocked. `blocking` (opt-in): the build is blocked with `ci-local: <jobs>`. Flip to `blocking` only once telemetry (`ci_local` events) shows a low false-fail rate on your repo |
| `exclude_jobs` | array of globs | `[]` | Job ids or names to drop from the plan (matched against `gha:<workflow>:<job>`, `gitlab:<job>`, and the job name) |
| `include_jobs` | array of globs | `[]` | When non-empty, only matching CI jobs run (an allowlist); `extra_commands` and the portability checks (when they apply) always run |
| `extra_commands` | array of strings or `{name, command}` | `[]` | Extra commands always added to the plan. `verification.commands` is not repeated here: V2 already runs it as the fast pre-step |
| `services` | `auto` \| `off` | `auto` | `auto` starts a job's service containers with docker (same image, env, ports), tearing them down afterwards; without docker, or with `off`, such jobs are deferred |
| `budget_minutes` | number | `15` | Overall wall-time budget; jobs not finished or started within it leave the run DEGRADED (never PASS, never FAIL). One invocation is capped at 9 minutes whatever this says (the Bash tool limit is 10): beyond that the run is a partial DEGRADED result and re-running resumes from the result cache (`FORGE_CI_LOCAL_MAX_INVOCATION_SECONDS`, default 540) |
| `max_parallel` | number | `4` | Jobs run in parallel by one run (also bounded machine-wide, see below) |

**Trusted config**: every field above is read from the main checkout's `forge.yaml` (for a plain checkout, the base ref's
copy), never from the PR's own tree, so a PR cannot exclude jobs from the gate that checks it.

**Where checks come from**: GitHub Actions (`.github/workflows`), GitLab CI, CircleCI, Azure Pipelines, Bitbucket Pipelines
and Buildkite definitions, read from the trusted base ref plus the PR's own edits (a PR can add a check but cannot delete
one). Only when the repo has NO CI definitions are its task runners used; when CI exists but its path filters leave no job
applicable the run executes nothing and records `no_applicable_jobs` (a docs-only change never triggers a full suite) (`package.json` scripts, Makefile, justfile,
Taskfile, tox/nox, pre-commit, pyproject tools, Cargo, Go, Maven, Gradle). Deterministic portability checks (Windows-invalid
filenames, case collisions, CRLF in scripts, bash 3.2 constructs and GNU-only flags on added lines, plus the repo's
`scripts/check-shell-portability.sh` when present) run only when the repo's CI definitions target macOS or Windows (a
`macos-*`/`windows-*` runner, matrix entry or executor); for a Linux-only repo they are skipped with a note, so correct
Linux-only code is never blocked on bash 3.2 rules.

**Deferred to CI** (listed in the `FORGE:BUILDER` comment under `### Deferred to CI`, never guessed): jobs that reference
`secrets.` or `environment:`, deploy/publish jobs, `pull_request_target`, schedule/dispatch-only workflows, unknown `uses:`
actions, orbs, plugins and templates, service containers without docker, macOS/Windows variants on another host, matrix
variants beyond the first host-compatible one, and jobs whose tools are not installed locally. A failed dependency install
(for example offline) defers the job instead of failing it, and so does a failure of a job whose pinned toolchain differs
from the host by a major version (`setup-node` 18 vs host 26: version drift, listed with its reason). A job timeout is
DEGRADED, never FAIL, and its clock starts when the job starts executing, not while it waits for a machine slot.

**Exact scoping** (runs only what the change can affect): job-level path filters from the CI definition (including
`dorny/paths-filter` outputs) gate whole jobs; per-file linters (shellcheck, eslint, prettier, ruff, black, flake8, ...) run
on the changed files only; tests use the ecosystem selector (`jest --findRelatedTests`, `vitest related`, `go` affected
packages with reverse dependencies, `cargo test -p` affected crates, Maven `-pl ... -amd`, `nx affected`, `turbo --filter`) or a
git-grep reference graph for file-list runners (pytest, mocha, `node --test`, bats, rspec, direct `*.test.*` invocations);
changed test files always run. **Fail-safe widening**: a lockfile, build or lint config, CI definition, unreferenced shared
fixture, an unknown file type, or an empty test selection for a changed source file widens the step to the full command (the
reason is reported, never silently narrowed). Short module names (`app/db.py`, `__init__.py`) are matched by their qualified
import forms. `${{ github.* }}` expressions in `run:` scripts are passed to the script as environment variables, never
substituted into the script text. CircleCI secondary containers run on a per-job docker network and publish only declared
(or well-known default) ports on 127.0.0.1, never `--network host`.
Passing results are cached by input hash under `~/.forge/ci-local/results` and reused across build iterations, lanes and
issues on the same base. An identical check (command, cwd, shell, env, input hash) that appears in several jobs of one invocation
runs once; the later jobs reuse its result (`cache=dedup`, a failure is shared). Machine slots are granted in FIFO ticket order
across invocations (`~/.forge/ci-local.lock/queue`; tickets of dead processes are reaped), and a slot is taken only right before a
step really executes. Job lines, `CI_LOCAL_CHECK`, `CI_LOCAL_RESULT` and the `ci_local` telemetry report `wait_ms` (time queued
for a slot) separately from `duration_ms` (execution). Ready jobs run narrow/scoped first, then cheapest first (cached durations).

**Environment** (all optional): `FORGE_CI_LOCAL_SLOTS` (machine-wide concurrent jobs across all runs, default
`max(2, min(8, cpus/2))`; slots live under `~/.forge/ci-local.lock` and stale ones are reclaimed), `FORGE_CI_LOCAL_BUDGET_MINUTES`,
`FORGE_CI_LOCAL_MAX_PARALLEL`, `FORGE_CI_LOCAL_JOB_TIMEOUT` (seconds, default min(900, budget)), `FORGE_CI_LOCAL_SERVICES=off`,
`FORGE_CI_LOCAL_MAX_INVOCATION_SECONDS` (default 540), `FORGE_CI_LOCAL_HOME` (default `~/.forge`), `FORGE_CI_LOCAL_NO_CACHE=1`. Jobs run in a runner-like environment: an allowlist of
system and toolchain variables (PATH, HOME, locale, XDG_*, CARGO_*, GOPATH, JAVA_HOME, proxies, ...) plus `CI=true`; credentials and
ambient operator state (agent tokens, `FORGE_*`/`CLAUDE_*` settings, git hook variables) never reach them. Extra names can be
listed in `FORGE_CI_LOCAL_PASSTHROUGH` (comma separated). Requires `node`, `git`, and mikefarah `yq` v4 for YAML CI definitions (without `yq`
the gate is DEGRADED and reported in `verification_skipped`, never a silent pass).

**Commands that use this section**: `work-on` (validate V4.8)

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

# Also create per-repo domain labels (comma-separated):
npx forgedock labels setup --domain frontend,backend,infra,design,legal-gated
```

Domain labels are optional and per-repo. They are not part of `bin/labels.json`, so `forgedock doctor` never requires them. Each one gets the description `Domain: <name>. Managed by ForgeDock.`. `frontend`, `backend`, `infra`, `design` and `legal-gated` have fixed colors; any other name is grey (`#EDEDED`). A name that is already in the manifest is not created twice. `/forgedock-init` derives the list from your spec or takes it from `--domain-labels`.

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

## `branding` (OPTIONAL)

Controls attribution in FORGE annotation comments posted to GitHub issues and PRs by pipeline commands.

When `show_attribution` is `true` (the default), every annotation comment (`FORGE:INVESTIGATOR`, `FORGE:CONTRACT`, `FORGE:BUILDER`, `FORGE:TRAJECTORY`, `FORGE:DECOMPOSED`, etc.) ends with a one-line footer:

```
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)
```

This follows the pattern established by Dependabot, Renovate, and similar tools. It helps new users discover the tooling when they encounter FORGE: annotations in a public thread. Set to `false` to suppress the attribution entirely.

```yaml
branding:
  show_attribution: true
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `show_attribution` | boolean | No | `true` | When `true`, annotation comments posted by the pipeline include a one-line attribution footer. Set to `false` to suppress it entirely. Opt-out model — attribution is on by default. |

**Commands that use this section**: `work-on` (all phases that post FORGE: annotation comments)

**Config read pattern** (yq, with default-true fallback):

```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

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

## Environment Variables

These variables are read from the operator's runner environment, not from `forge.yaml`. Set them in a trusted environment only (shell profile, CI runner settings); never from PR content, issue text or contributor-controlled CI variables.

| Variable | Default | Purpose |
|----------|---------|---------|
| `FORGEDOCK_HOME` | unset | Absolute path to the ForgeDock install root (the directory holding `scripts/` and `commands/`). Authoritative over every other source when set. Relative values are rejected; Windows drive-letter forms (`C:/forge`, `C:\forge`) are normalized to `/c/forge`. |
| `FORGE_HOME` | unset | Absolute path to the ForgeDock clone. Used when `FORGEDOCK_HOME` is unset. Required for Codex, which has no `~/.claude` fallback. Relative values are ignored. |
| `FORGE_SKILL_NAMESPACE` | auto-detected | Forces the skill prefix and nesting separator for `Skill(...)` calls. `forgedock` = `forgedock:` / `:`; `none` = empty / `:`; `codex` = `forge-` / `-`; `opencode` = empty / `-`. Any other value is an error. When unset, `FORGE_RUNTIME` (`codex` or `opencode`) is used, then the available-skills list. |
| `FORGE_TRAIL_TRUSTED_LOGINS` | empty | Comma-separated GitHub logins whose FORGE markers count toward the phase-trail merge gate. Matching is case-sensitive. |
| `FORGE_TRAIL_TRUSTED_ASSOCIATIONS` | `OWNER,MEMBER,COLLABORATOR` | Comma-separated `author_association` values whose FORGE markers count toward the merge gate. Do not add `CONTRIBUTOR` here: any listed association can post FORGE markers that satisfy the gate. |
| `FORGE_TRAIL_OVERRIDE_ASSOCIATIONS` | the resolved `FORGE_TRAIL_TRUSTED_ASSOCIATIONS` value | Comma-separated `author_association` values prefiltering break-glass override candidates (the permission API stays authoritative). Never affects which FORGE markers count toward the gate. An approver with concealed org membership can show `CONTRIBUTOR`/`NONE`, so widen this variable (not the trail list) to accept them. An explicitly empty value means no override candidates. |
| `FORGE_TRAIL_PIPELINE_LOGINS` | empty | Comma-separated GitHub logins (case-insensitive) that are the pipeline's own identity and can never approve a phase-trail break-glass override. The authors of trusted FORGE marker comments on the issue are added automatically. |
| `FORGE_TRAIL_QG_SINCE` | `2026-10-07T03:40:12Z` | ISO-8601 UTC cutoff for the legacy `FORGE:QUALITY_GATE` grace. An issue whose trusted `FORGE:BUILDER:COMPLETE` comment was last updated before this time has `QUALITY_GATE` waived. Set to an empty string to disable the grace. A malformed or future value (including a runner clock earlier than this default) fails closed: the verifier exits 2, an infrastructure block rather than `MISSING`. |
| `FORGEDOCK_ALLOW_API_BACKEND` | unset | Set to `1` (host owner approval) together with forge.yaml `execution.agent_backend: api` to let `--backend auto` use the paid API backend when no `claude` CLI is available. Without both, `auto` never selects `api` (#4257). |
| `FORGE_TELEMETRY` | `on` | Set to `off` to disable gate telemetry. Gate scripts append one structured record per decision to a trusted `FORGE:TELEMETRY v1` comment; emission is best-effort and never changes a gate's output or exit code. See [TELEMETRY.md](TELEMETRY.md). |

### Install root resolution

`FORGE_ROOT` (where the merge trail gate, dispatch lint and engine modules are resolved) is computed in this order: `FORGEDOCK_HOME` (authoritative: when set, nothing else is consulted, and a relative value leaves `FORGE_ROOT` empty so the gate fails closed) > the running plugin's own root (substituted by Claude Code, not a runtime env var; the stub hands it to the helper as `FORGE_SOURCED_ROOT`, so it wins over `FORGE_ROOT`, `FORGE_HOME` and any newer cached version) > `FORGE_HOME` > the `~/.claude/commands/work-on.md` symlink target > the clone path recorded in `$CODEX_HOME/forge-home` (Codex; a relative `CODEX_HOME` is ignored) > the newest semver directory in the Claude plugin cache (official `forgedock` marketplace only; `FORGEDOCK_MARKETPLACE` pins a differently named one) > the marketplace directory. If nothing resolves, `FORGE_ROOT` stays empty and the trail gate refuses to merge (fail closed). See [CODEX.md](CODEX.md#forge_home-and-install-root-resolution).

### Keeping the phase-trail merge gate satisfiable

The merge gate (`scripts/verify-phase-trail.sh`) ignores FORGE markers posted by untrusted commenters. A commenter is trusted when ANY of these hold: `author_association` is in `FORGE_TRAIL_TRUSTED_ASSOCIATIONS`; the account type is `Bot` (the pipeline's GitHub App identity); or the login is in `FORGE_TRAIL_TRUSTED_LOGINS`.

The note-disposition gate (`FORGE:NOTE_DISPOSITION`) and the in-PR fix markers (`FORGE:INPR_FIX*`) in `commands/review-pr.md` and `commands/work-on/review.md` use the same predicate through one shared helper, `scripts/trusted-comments.sh`, so a disposition posted by the pipeline's bot identity counts. An unresolvable helper blocks the merge (fail closed).

Pipelines that run under a human login with association `CONTRIBUTOR`, `NONE` or `FIRST_TIME_CONTRIBUTOR` will see every marker reported `MISSING`, and the gate prints a NOTE when untrusted-author markers were seen. Fix it by either:

```bash
export FORGE_TRAIL_TRUSTED_LOGINS="my-pipeline-login,other-login"   # preferred: name the identity
export FORGE_TRAIL_TRUSTED_ASSOCIATIONS="OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR"   # broader
```

Warning: widening `FORGE_TRAIL_TRUSTED_ASSOCIATIONS` to include `CONTRIBUTOR` lets any contributor post forged `FORGE:*` markers that satisfy the merge gate. To only accept override approvers with concealed org membership, widen `FORGE_TRAIL_OVERRIDE_ASSOCIATIONS` instead.

#### Break-glass override

A misfiring phase-trail gate can be cleared by a human without a revert or manual merge. Post a comment on the issue that starts with `<!-- FORGE:PHASE_TRAIL_OVERRIDE -->` and has these lines:

```
**Head**: <full 40/64-hex head commit>
**Missing**: <the MISSING marker names, comma separated, e.g. CONTEXT,ARCHITECT>
**Reason**: <one line>
```

`scripts/verify-phase-trail.sh` honours it only when the verifier would otherwise exit 1 and every rule holds: the author is `user.type == "User"` with repo `admin` or `write` permission; the author is not a pipeline identity (`FORGE_TRAIL_PIPELINE_LOGINS` plus the authors of the issue's trusted FORGE marker comments, so a pipeline running under a human token cannot approve itself, and a solo operator needs a second human with write access); the comment was never edited (`updated_at == created_at`); `**Head**` equals the commit being gated (passed as `--head-sha`) and `**Missing**` equals the current MISSING set; and the comment is newer than the latest `FORGE:BUILDER:COMPLETE`. Any API error or missing field rejects it. An unreadable trail (exit 2) is never overridable. The reason is sanitized (control characters stripped, comment markers neutralized, capped at 200 characters) and `/review-pr` and `/work-on` record the accepted override as `FORGE:PHASE_TRAIL_OVERRIDE_APPLIED` from the verifier's output. A new commit invalidates the override: post a new one for the new head. Operational limits: the collaborator-permission lookup (`gh api repos/.../collaborators/<login>/permission`) needs a token with push access, otherwise it returns 403 and the override is rejected (a `NOTE:` is written to stderr); at most 5 eligible override comments are checked per run (comments failing the head, missing-set, reason, identity or edit checks do not count toward the cap); logins may contain letters, digits, `-` and `_` (Enterprise Managed User logins are accepted); the login the verifier itself runs under counts as a pipeline identity and cannot approve; with no trusted `FORGE:BUILDER:COMPLETE`, the override must be newer than the latest trusted FORGE marker instead; and `/review-pr` refuses to merge any commit other than the exact head the override was bound to.

Limits: `Bot` trusts any GitHub App or bot able to comment on the repo, and `COLLABORATOR` includes read-level collaborators. Tighten with the two variables above if that is too broad. An earlier `FORGE_TRAIL_QG_SINCE` waives `QUALITY_GATE` for every build completed before it, so never derive it from untrusted input.

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
| `npx forgedock update` | Re-registers the hook when the resolved source can be safely refreshed (relink only — does not touch `forge.yaml`) |
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

For npm/npx sources, every `npx forgedock` (or `npx forgedock update`) run copies ForgeDock's own installable payload into a stable, version-independent home:

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
| `npx forgedock update` (git-clone install) | Updates and relinks a `main` checkout; a non-main checkout is left untouched and gets actionable guidance because the current source must remain the source used after the command returns |
| `npx forgedock doctor` | Reports the effective source path, version, and git branch, then reports `~/.forge/version` and confirms `~/.forge/{bin,commands,scripts,templates}` for npm installs |

The copy is idempotent: files whose content is already byte-identical are never rewritten, so steady-state re-runs are fast and don't generate false "updated" noise.

### The Git-Clone Exemption

If you run ForgeDock from a git clone (or a git worktree) of the repo itself — the development/self-hosted install mode — nothing is copied into `~/.forge/`. A git clone is already a stable, user-owned location; copying it into `~/.forge/` and linking commands from the copy instead of the clone would silently disconnect `git pull` (or `npx forgedock update`'s git branch) from what's actually linked into `~/.claude/commands/`. So:

- `~/.claude/commands/` continues to symlink directly from the clone, exactly as before this feature.
- `~/.forge/{bin,commands,scripts,templates}` correctly does **not** exist for this install mode — `npx forgedock doctor` treats that absence as healthy, not a warning.
- `npx forgedock update` never switches a non-main checkout to `main` and then restores it. That transient update would leave the next invocation running the old branch source, so the command reports the effective path, branch, and version and tells you to run from a main checkout instead.

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
- After every successful `npx forgedock update` — the main git-clone branch and npm branch route through the same repair step (`relinkAndHint()`), so the receipt is refreshed either way. A non-main git-clone advisory intentionally does not relink or rewrite the receipt.

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
