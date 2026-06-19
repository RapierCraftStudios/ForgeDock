---
authority: required
scope: project
applies_to: [work-on, review-pr, issue, orchestrate, quality-gate, autopilot]
domain: architecture
last_validated: "2026-06-19"
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

### Third-Party MCP Dependencies

External tools that ForgeDock configures or launches as separate processes over the MCP protocol are governed by the same data-contract rule — they do **not** introduce AGPL contamination, regardless of their own license.

**Playwright MCP** ([`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)) is the canonical example:

| Property | Value |
|----------|-------|
| License | Apache-2.0 |
| Runtime boundary | Separate process, launched independently |
| Integration contract | MCP protocol only (tool calls, structured JSON responses) |
| Code coupling | None in ForgeDock's usage — we never import, vendor, or statically link it (the package does expose an importable JS API, but ForgeDock does not use it) |
| AGPL contamination | **No** — data contract only |
| Platform side | May consume emitted metrics (screenshots, console events, perf traces) for observability |

**Decision rule**: If a tool (a) runs as a separate process, (b) communicates exclusively over the MCP protocol, and (c) is never imported or vendored into this repo's codebase — it is AGPL-safe to configure, launch, and depend on, regardless of its own license.

### What Lives Where

| Feature | Repo | Why |
|---------|------|-----|
| Pipeline commands (`/work-on`, `/orchestrate`, etc.) | ForgeDock (this repo) | Core product, AGPL |
| Deterministic scripts (lane routing, validation) | ForgeDock (this repo) | Core execution, AGPL |
| Observability dashboard | Platform | Commercial value-add |
| Billing / license management | Platform | Commercial |
| Hosted script API (faster, validated, versioned) | Platform | Commercial premium |
| Token efficiency analytics | Platform | Commercial value-add |
| Website / marketing | Platform | Commercial |

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

## Known Pipeline Weaknesses (Active Issues)

These are systemic problems being actively addressed:

### Agent Compliance (#639)
Agents hallucinate branch names and routing targets despite explicit spec instructions. The LLM "reasons" its way around deterministic rules. **Root cause**: prose instructions are suggestions, not constraints. **Fix**: Scripts layer (#651) — extract deterministic operations into executable scripts.

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
4. `setup-worktree.sh` — deterministic worktree creation
5. `post-annotation.sh` — FORGE annotation posting with format validation

**Per-repo adaptive scripts** (#653) — generated by ForgeDock over time for each project:
- Encode project-specific patterns (branch names, label schemes, test locations, commit style)
- Live in `.forgedock/scripts/`, `.gitignore`d by default
- Replace repeated per-session re-discovery with cached operational knowledge
- User can opt-in to committing them to the repo

**Measured token savings** (from #673 — based on 5 representative ForgeDock sessions):

| Operation | Baseline (rediscovery) | With adaptive scripts | Saving |
|-----------|------------------------|----------------------|--------|
| forge.yaml full read | ~1,050 tokens | ~100 tokens (learned: section only) | ~950 |
| Branch name determination | ~350 tokens (gh + LLM inference) | ~170 tokens (branch-targets.sh) | ~180 |
| Commit style detection | ~200 tokens (git log + LLM) | ~100 tokens (format-commit.sh) | ~100 |
| Test command discovery | ~400 tokens (package.json + grep) | ~80 tokens (run-tests.sh) | ~320 |
| Test location + label discovery | ~550 tokens | ~0 discovery¹ | ~550 |
| **Session total** | **~2,550 tokens** | **~450 tokens** | **~2,100 tokens** |

¹ The prose-discovery calls for test locations and label schemes are eliminated (replaced by `find-tests.sh` and `label-map.sh`). Script execution costs (~80–100 tokens each) are already included in the ~450 session total above — they are not additive.

Savings range: 1,200 tokens (simple fast-lane issues) to 3,500 tokens (complex multi-file builds).
At claude-sonnet-4-5 pricing ($3.00/M tokens): ~$0.0063/session saved, ~$1.89/month per repo at 300 sessions/month.

The primary value is **reliability**, not cost: scripts eliminate LLM inference from deterministic operations. An agent running `branch-targets.sh` cannot hallucinate the branch name (see #639 — hallucinated `milestone/project-agnostic` caused 6-day pipeline misrouting).

Full methodology and data: `docs/articles/per-repo-adaptive-scripts-token-savings.md`

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

## Milestone: Deterministic Pipeline v2

Active milestone tracking all work toward one-shot reliable task completion.

| # | Issue | Priority | Track |
|---|-------|----------|-------|
| #651 | Scripts layer architecture | P0 | Execution determinism |
| #652 | DevDocs redesign (parent tracker) | P1 | Knowledge determinism |
| #653 | Per-repo adaptive scripts (investigation) | P1 | Execution determinism |

**Core promise**: Task in → result out, one shot, no waste. No stalls, no reruns, no shortcuts, no overcomplication.
