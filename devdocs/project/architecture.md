---
authority: required
scope: project
applies_to: [work-on, review-pr, issue, orchestrate, quality-gate, autopilot]
domain: architecture
last_validated: "2026-06-15"
version: "1.0.16"
---

# ForgeDock Architecture & Strategy

Single source of truth for strategic context. Every agent reads this before acting.

## Open-Core Model

ForgeDock uses a strict two-repo model:

| Repository | License | Contains |
|---|---|---|
| [`RapierCraftStudios/ForgeDock`](https://github.com/RapierCraftStudios/ForgeDock) | AGPL-3.0 | CLI, pipeline commands, installer, scripts, `forge.yaml` schema |
| [`RapierCraftStudios/forgedock-platform`](https://github.com/RapierCraftStudios/forgedock-platform) | Proprietary | Web dashboard, backend API, billing, team management, observability |

### Boundary Rules

- **Never import, embed, vendor, or statically link code across repos.** AGPL code in the Platform would copyleft-contaminate it.
- The only connection is the **data contract**: HTTP endpoints, structured JSON payloads, GitHub issue/PR annotations, and the `forge.yaml` schema.
- If shared utility code is ever needed by both sides, it goes in a separately published MIT/Apache-2.0 SDK package — never copied across.
- When building features, always ask: does this belong in the CLI (open) or Platform (commercial)?

### What Lives Where

| Feature | Repo | Why |
|---------|------|-----|
| Pipeline commands (`/work-on`, `/orchestrate`, etc.) | ForgeDock (this repo) | Core product, AGPL |
| Deterministic scripts (lane routing, validation) | ForgeDock (this repo) | Core execution, AGPL |
| Spec graph builder / store / queries (`build-spec-graph.mjs`, `graph-query.sh`, `validate-spec-graph.sh`) | ForgeDock (this repo) | Local CLI, AGPL — runs on-disk, emits structured JSON only |
| Spec-graph observability view (pipeline self-map: runs / timelines) | Platform | Commercial value-add — renders the CLI's emitted JSON, never imports the code |
| Observability dashboard | Platform | Commercial value-add |
| Billing / license management | Platform | Commercial |
| Hosted script API (faster, validated, versioned) | Platform | Commercial premium |
| Token efficiency analytics | Platform | Commercial value-add |
| Website / marketing | Platform | Commercial |
| FORGE annotation parse/validate/emit library (`packages/protocol/`) | ForgeDock (this repo, `packages/` subdir) | MIT-licensed — published as `@forgedock/protocol` on npm; separately versioned and publishable; usable by any producer/consumer of FORGE annotations without AGPL obligation. Implements all 13 reserved types from the spec (parse/validate/emit + conformance suite). Built in #1291. |

## Platform Roadmap

- **L1**: Read-only observability dashboard — renders the GitHub knowledge graph the CLI produces (runs, timelines, stall detection, throughput, cycle time, cost-per-issue)
- **L2**: Central public GitHub App + hosted webhook bot (BYO-key) — always-on backend that triggers pipeline runs, multi-tenant credential isolation, individual paid plan
- **L3**: Hosted dev execution sandboxes — pipeline execution on isolated ephemeral compute

## Target Market

Non-coders and early-stage developers using AI coding agents who need production-grade architecture without deep technical background. ForgeDock provides structured, token-efficient autonomous development that turns Claude Code from a chatbot into a deterministic engineering pipeline.

Key value props:
- **Free to use** (AGPL) — full pipeline, no paywalls on core functionality
- **Token efficient** — structured pipeline reduces wasted context vs raw Claude Code
- **Deterministic** — scripts layer enforces exact outputs where prose instructions fail
- **Traceable** — every decision, finding, and change is tracked via FORGE annotations on GitHub

## Agent Model / Effort Tier Map (#1249)

Every pipeline stage carries an explicit `model` and `effort` in its **Agent model policy** line. Stages are classified into three tiers:

| Tier | Model | Effort | Stages |
|------|-------|--------|--------|
| **mechanical** | `haiku` | `low` | Label transitions, FORGE annotation posting, issue classification, `/orchestrate` dispatch bookkeeping, `/work-on/close`, `/changelog`, `/pipeline-resume` |
| **standard** | `sonnet` | _(default)_ | Context gathering, implement, validate, most review personas, `/work-on`, `/issue`, `/work-on/investigate`, `/work-on/build`, `/work-on/review`, `/review-pr`, `/qa-sweep`, `/adopt`, `/deploy-info`, `/diagnose`, `/explain`, `/scope`, `/validate`, `/replay`, `/rollback`, `/incident-response`, `/compat-audit`, `/ci-audit`, `/analytics`, `/optimize`, `/forgedock-init`, `/pipeline-health`, `/review-pr-staging`, `/audit`, `/autopilot` |
| **deep** | `sonnet` (fallback: `opus`) | `xhigh` | `/work-on/build/architect`, the always-runs General Security & Quality reviewer in `/review-pr`, `/security-audit` |

**Fallback rule** (all tiers): if the designated model is rate-limited, fall back to `opus`.

**Feature gate**: `effort` frontmatter is only emitted when Claude Code >= 2.1.154. Commands that spawn subagents pass `model` and `effort` explicitly in every `Task`/`Skill` call rather than relying on the prose policy line.

**Cost rationale**: Haiku 4.5 is ~$1/$5 per MTok vs Sonnet 5 at ~$3/$15 — assigning mechanical stages to Haiku yields an estimated 40–60% cost reduction on a full `/work-on` run (18–20 agent invocations) with no quality loss on deterministic operations; explicit `xhigh` on architect/security review improves quality where it matters most.

## Known Pipeline Weaknesses (Active Issues)

These are systemic problems being actively addressed:

### Agent Compliance (#639, #1383)
Agents hallucinate branch names and routing targets despite explicit spec instructions. The LLM "reasons" its way around deterministic rules. **Root cause**: prose instructions are suggestions, not constraints. **Fix**: Scripts layer (#651) — extract deterministic operations into executable scripts.

**Concrete incident (#1383)**: Agent invoked with `/review-pr 1378` on a staging-to-main PR completely ignored the command spec — used the `Agent` tool (not in `allowed-tools`), skipped Phase 0 routing to `review-pr-staging`, and never executed deploy gates or test gates. **Mitigations applied**: HARD RULES preambles, `FORGE:SPEC_LOADED` markers, and `NEVER use Agent tool` warnings added to all CRITICAL/HIGH command specs (#1389). Spec compliance rules added to `templates/devdocs/agent/using-forgedock.md` for distribution (#1383). **Long-term fix**: PreToolUse hooks (#1250) for deterministic enforcement.

### Token Bloat (#619)
All 27 command specs (~848KB) load into context at session start via symlinks. Most sessions use 1-2 commands but pay the token cost for all of them. **Fix**: Stub + invoke pattern — install thin stubs, load full specs on demand.

### Version Blindness (#635)
ForgeDock has zero awareness of its host runtime (Claude Code) version. No compatibility checks, no feature detection, no deprecation warnings. **Fix**: Version intelligence system — detect, track, and adapt to Claude Code releases.

## Scripts Layer (Planned — #651)

The next major architectural evolution. Replaces prose instructions with executable scripts for every operation that MUST be deterministic.

```
Current (fragile):
  Command spec (prose) → LLM interprets → LLM executes → non-deterministic

Proposed (deterministic):
  Command spec (routing) → LLM decides WHAT → Script executes HOW → deterministic output
```

### Design Principles
- Scripts are **open source** (bundled with npm package, run locally)
- Platform offers **hosted premium** version (faster, validated, monitored) — same interface, commercial value-add
- Scripts emit **structured JSON events** that the Platform can consume for observability
- The CLI doesn't know or care if the Platform exists — telemetry is opt-in

### Two Tiers of Scripts

**Universal scripts** (ship with npm package):
1. `classify-lane.sh` — milestone → feature lane, no milestone → staging. No interpretation.
2. `transition-label.sh` — label state machine with validation
3. `validate-pr-target.sh` — hard-fail if PR targets wrong branch
4. `worktree-lifecycle.sh` — deterministic worktree create/reuse/cleanup (`ensure`/`cleanup` subcommands; built — #1268). Call-site migration of `work-on.md` Phase 3E/6E to invoke it is a tracked fast-follow (#1247), not yet wired in.
5. `forge-annotation.sh` — FORGE annotation read/write/validate engine (Bash; built in #1267) — single source of truth for annotation schema, sentinel checks, and required-field validation across all 5 marker types (INVESTIGATOR, CONTEXT, ARCHITECT, BUILDER, DECOMPOSED). Subcommands: `write` renders a well-formed `<!-- FORGE:MARKER -->` comment body from field arguments, `read` fetches the latest matching annotation via `gh api`, `validate` rejects a body missing its required completion terminator (e.g. `FORGE:INVESTIGATOR` without `INVESTIGATION:COMPLETE`) with a non-zero exit. Call-site migration tracked in #1247.
6. `validate-annotation-node.mjs` — thin Node.js adapter that validates annotation bodies against the MIT/Apache protocol library (`packages/protocol/`, built in #1291); built in #1292. Complements `forge-annotation.sh`: Bash handles format/sentinel rules (AGPL), Node handles spec-conformance against the library (MIT). Degrades gracefully when the library is not yet installed.

**Deploy-gate testing scripts** (milestone: Deterministic Deploy-Gate Testing — #863):

Runtime testing lives at the **staging→main deploy gate** (`/review-pr-staging` → `/test-gate`), explicitly **not** as an `/orchestrate` barrier. Rationale: a serialized post-batch barrier in `/orchestrate` collapses parallel waves into a single chokepoint and bloats the orchestrator's context window — degrading orchestration throughput and quality. The staging→main gate is the correct home: it tests the **integrated bundle** (where cross-PR interactions actually surface), it is the last line of defence before production, and it already maps bundle → PRs → issues, fans out subagents, and files issues.

Script candidates for the deterministic operations `/test-gate` needs:
1. `collate-bundle-criteria.sh` — bundle PRs → solved issues → acceptance criteria
2. `classify-criteria.sh` — bucket criteria by test type (`[type:api]` / `[type:unit]` / `[type:e2e]` / `[type:manual]`)
3. `provision-test-services.sh` — bring up the server/services needed for deterministic testing
4. `triage-test-gate.sh` — Phase 0 triage: decide test-or-skip per bundle (skip docs-only / no-executable-change) (#945)
5. `criteria-coverage.sh` — verify the derived test plan exercises what each issue defined; flag uncovered/untestable criteria (#946)
6. `test-gate-verdict.sh` — baseline-compare (batch-introduced vs pre-existing), file `test-failure` issues, emit a machine-readable `BLOCK`/`PASS`/`SKIP` verdict to the caller

These scripts sit in the universal tier (bundled with the npm package, run locally). They share the same precedence hierarchy and `resolve_script()` resolution as all other universal scripts.

**Per-repo adaptive scripts** (#653) — generated by ForgeDock over time for each project:
- Encode project-specific patterns (branch names, label schemes, test locations, commit style)
- Live in `.forgedock/scripts/`, `.gitignore`d by default
- Replace repeated per-session re-discovery with cached operational knowledge
- User can opt-in to committing them to the repo

**Measured token savings** (from #673 — based on 5 representative ForgeDock sessions, estimates adjusted ~30% upward for the claude-sonnet-5 tokenizer):

| Operation | Baseline (rediscovery) | With adaptive scripts | Saving |
|-----------|------------------------|----------------------|--------|
| forge.yaml full read | ~1,365 tokens | ~130 tokens (learned: section only) | ~1,235 |
| Branch name determination | ~455 tokens (gh + LLM inference) | ~220 tokens (branch-targets.sh) | ~235 |
| Commit style detection | ~260 tokens (git log + LLM) | ~130 tokens (format-commit.sh) | ~130 |
| Test command discovery | ~520 tokens (package.json + grep) | ~105 tokens (run-tests.sh) | ~415 |
| Test location + label discovery | ~715 tokens | ~0 discovery¹ | ~715 |
| **Session total** | **~3,315 tokens** | **~585 tokens** | **~2,730 tokens** |

¹ The prose-discovery calls for test locations and label schemes are eliminated (replaced by `find-tests.sh` and `label-map.sh`). Script execution costs (~105–130 tokens each) are already included in the ~585 session total above — they are not additive.

Savings range: 1,560 tokens (simple fast-lane issues) to 4,550 tokens (complex multi-file builds).
At claude-sonnet-5 pricing ($3.00/M tokens standard; $2.00/M intro through 2026-08-31): ~$0.0082/session saved at standard pricing, ~$2.46/month per repo at 300 sessions/month. Token estimates use a 1 token ≈ 4 characters heuristic adjusted ~30% for the claude-sonnet-5 tokenizer (±20% error margin).

The primary value is **reliability**, not cost: scripts eliminate LLM inference from deterministic operations. An agent running `branch-targets.sh` cannot hallucinate the branch name (see #639 — hallucinated `milestone/project-agnostic` caused 6-day pipeline misrouting).

Full methodology and data: `docs/articles/per-repo-adaptive-scripts-token-savings.md`

## Topology Benchmark <!-- Added: forge#1279 -->

Measures the end-to-end token cost per issue to validate the agent topology refactor (#1254) claim: inlining sequential build phases eliminates 6-8 fresh-context establishments per standard run, reducing token cost without degrading quality gates.

### Methodology

**Corpus**: 5 seeded issues in `examples/forgedock-demo/` — fixed, reproducible, covers the full issue type range (bug, feature, refactor, performance, docs).

| Issue | Type | Title |
|-------|------|-------|
| #1 | Bug / security | DELETE is missing an auth check |
| #2 | Feature / security | Safe filtering for GET /notes |
| #3 | Refactor | Extract the router module |
| #4 | Performance | O(1) findById |
| #5 | Docs | Add an API reference |

**Measurement unit**: tokens per issue per `/work-on` run — input_tokens + output_tokens (billed), cache_read_tokens, cache_write_tokens (context establishment proxy).

**Primary signal**: `cache_write_tokens` — each spawned subagent establishes fresh context, writing its full prompt into the cache. Inlining phases reduces the number of fresh-context establishments, lowering `cache_write_tokens`.

**Topologies compared**:
- `spawned` — baseline: sequential build phases each spawned as separate subagents (pre-#1254)
- `inline-sequential` — refactored: sequential phases run inline within the orchestrator session (post-#1254)

**Tooling**: `scripts/bench-topology-cost.mjs` — zero-dependency ESM aggregator. Input: structured JSON of per-issue token measurements. Output: per-topology summary, delta, quality gate confirmation.

### Running the Benchmark

```bash
# After collecting measurements from a /work-on session on examples/forgedock-demo/:
node scripts/bench-topology-cost.mjs runs.json

# Help / input schema:
node scripts/bench-topology-cost.mjs --help
```

Input schema: see `scripts/bench-topology-cost.mjs` file header (search: "Input schema").

When `bin/runner.mjs` emits structured token usage (#1295), measurements can be auto-populated from session logs. Until then, capture from Claude Code session summaries.

### Quality Gate Confirmation

For each topology run, all 5 demo issues must pass quality gate (`quality_gate_passed: true`). The benchmark verdict is INVALID if any quality gate regressed in the post-refactor topology.

### Results

> **Status**: Awaiting post-refactor data. Dependencies #1276-#1278 must complete before post-refactor measurements can be captured.

| Metric | Spawned (baseline) | Inline-sequential (refactored) | Delta | Change |
|--------|-------------------|-------------------------------|-------|--------|
| Total tokens (5 issues) | TBD | TBD | TBD | TBD |
| Avg tokens / issue | TBD | TBD | TBD | TBD |
| Cache write tokens | TBD | TBD | TBD | TBD |
| Quality gates passed | TBD | TBD | — | — |

*Update this table when measurements are available. Run `node scripts/bench-topology-cost.mjs runs.json` to generate the delta automatically.*

### Script Precedence

When resolving which script to run for a given operation, agents apply the following hierarchy (highest to lowest authority):

```
1. forge.yaml → learned: (machine-captured corrections)        ← highest
2. .forgedock/scripts/{operation}.sh  (per-repo adaptive)
3. scripts/{operation}.sh             (universal, ships with npm)
4. Prose instructions in command specs (fallback)              ← lowest
```

**Rules**:
- Per-repo scripts **completely replace** the universal script for that operation — no partial inheritance or merging.
- Per-repo scripts **may call** universal scripts via the `$FORGEDOCK_SCRIPTS/{operation}.sh` path. Every universal script exports `FORGEDOCK_SCRIPTS` (path to the universal scripts directory) and `FORGEDOCK_HOME` (path to the ForgeDock installation root) so that per-repo scripts can delegate to them.
- **No circular dependencies**: per-repo scripts may call universal scripts, but must NOT call other per-repo scripts. This prevents dependency chains that cannot be resolved deterministically.
- `forge.yaml → learned:` overrides take precedence over everything. They represent explicit user corrections captured by the pipeline — they are binding.

**Resolution algorithm** (used in `work-on` Phase 0B and wherever scripts are invoked):

```bash
# Paths derived from forge.yaml
ADAPTIVE_DIR="${REPO_PATH}/$(yq '.adaptive_scripts.directory // ".forgedock/scripts"' forge.yaml)"
ADAPTIVE_ENABLED=$(yq '.adaptive_scripts.enabled // "true"' forge.yaml 2>/dev/null || echo 'true')
UNIVERSAL_DIR="${FORGEDOCK_HOME}/scripts"

resolve_script() {
  local operation="$1"
  # Tier 1: forge.yaml → learned: (handled by caller before calling resolve_script)
  # Tier 2: per-repo adaptive script (skip if adaptive_scripts.enabled is false)
  if [ "$ADAPTIVE_ENABLED" != "false" ] && [ -f "${ADAPTIVE_DIR}/${operation}.sh" ]; then
    echo "adaptive:${ADAPTIVE_DIR}/${operation}.sh"
    return
  fi
  # Tier 3: universal script
  if [ -f "${UNIVERSAL_DIR}/${operation}.sh" ]; then
    echo "universal:${UNIVERSAL_DIR}/${operation}.sh"
    return
  fi
  # Tier 4: prose fallback
  echo "prose:"
}

# Usage:
RESOLUTION=$(resolve_script "classify-lane")
TIER="${RESOLUTION%%:*}"
SCRIPT_PATH="${RESOLUTION#*:}"

case "$TIER" in
  adaptive|universal)
    RESULT=$(bash "$SCRIPT_PATH" "$@")
    # Log tier in FORGE annotation: "Script tier: $TIER ($SCRIPT_PATH)"
    ;;
  prose)
    # Fall back to prose instruction in command spec
    ;;
esac
```

**Logging tier in FORGE annotations**: When a script resolution runs, log the tier used (`adaptive`, `universal`, or `prose`) in the corresponding FORGE annotation comment. This gives the pipeline trace full observability into which script tier handled each operation.

## Concurrency Model (Engine, #1324)

**Decision recorded**: 2026-07-04

The durable execution engine (#1256) uses an **in-process worker pool + worktree-per-issue** model for concurrent issue dispatch.

### Chosen model: in-process worker pool

Each concurrent issue runs inside the **same engine process** but is isolated on disk by its own git worktree (created/cleaned up via `scripts/worktree-lifecycle.sh`). A single control plane owns the DAG ready-set, dispatch loop, lease renewal, and rate-limit backpressure.

### Why not process-per-issue

| Concern | Process-per-issue | In-process pool |
|---------|------------------|-----------------|
| Filesystem isolation | Separate clone per issue | Worktree per issue (`worktree-lifecycle.sh` — already shipped, #1268) |
| Rate-limit backpressure | Requires IPC to share API quota | Single gate in the dispatch loop |
| DAG coordination | Cross-process signalling | In-memory ready-set |
| Recovery / lease renewal | Separate watchdog per process | One lease manager |

### Concurrency cap

`forge.yaml → orchestration.max_concurrent` (optional, default uncapped). When set, the dispatch loop holds at most N in-flight workers; newly ready issues queue until a slot opens. Prevents rate-limit storms from large batches.

### Rate-limit backpressure

Pre-dispatch gate: if `gh api rate_limit` remaining < `FORGE_RATE_LIMIT_FLOOR` (default 200, overridable via `forge.yaml → orchestration.rate_limit_floor`), the dispatch loop pauses until the quota resets. Already-running workers continue unaffected.

### Related issues

- #1256 — durable engine umbrella (foundation)
- #1268 — `worktree-lifecycle.sh` (MERGED — isolation primitive)
- #1317 — economic self-governance (related backpressure at scheduler layer)
- #1247 — work-on.md call-site migration to worktree-lifecycle.sh (fast-follow)

---

## Milestone: Deterministic Pipeline v2

Active milestone tracking all work toward one-shot reliable task completion.

| # | Issue | Priority | Track |
|---|-------|----------|-------|
| #651 | Scripts layer architecture | P0 | Execution determinism |
| #652 | DevDocs redesign (parent tracker) | P1 | Knowledge determinism |
| #653 | Per-repo adaptive scripts (investigation) | P1 | Execution determinism |

**Core promise**: Task in → result out, one shot, no waste. No stalls, no reruns, no shortcuts, no overcomplication.
