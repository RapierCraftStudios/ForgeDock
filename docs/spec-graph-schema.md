<!--
SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Spec Knowledge Graph — Schema & Builder

The **spec knowledge graph** is a queryable, zero-dependency self-map of
ForgeDock's own command specs. It lets agents load only task-relevant specs and
run impact analysis on the pipeline's information flow ("which command writes
`FORGE:CONTRACT`? which commands read it?").

It is a native replication of code-graph tooling (codegraph,
codebase-memory-mcp) adapted to **prose specs** — no tree-sitter, SQLite, or MCP
dependency. The builder is a single Node `.mjs` artifact using Node built-ins
only (`fs`, `path`, `url`).

## Building the graph

```bash
node scripts/build-spec-graph.mjs            # writes .forgedock/graph/spec-graph.json
node scripts/build-spec-graph.mjs --stdout   # print to stdout (no file write)
node scripts/build-spec-graph.mjs --help     # full options
```

The builder is **idempotent**: all node/edge arrays are sorted by a stable
composite key and JSON is emitted with recursively sorted object keys, so
re-runs produce byte-identical output. It runs in well under 1s on the current
spec set (~90 nodes / ~120 edges, ~60ms).

Output is written to `.forgedock/graph/spec-graph.json` and is **gitignored by
default** (see `.gitignore`). This mirrors how per-repo adaptive scripts are
treated — opt in to commit the graph if you want it versioned.

## Output document

A single JSON document:

```jsonc
{
  "graph": {
    "schemaVersion": 1,
    "generator": "build-spec-graph.mjs",
    "root": ".",
    "builtFromHash": "716dae74…",  // sha256 of the scanned spec corpus
    "stats": {
      "nodes": 92,
      "edges": 120,
      "nodesByType": { "annotation": 30, "command": 35, "...": 0 },
      "edgesByType": { "WRITES": 28, "READS": 45, "...": 0 }
    },
    "nodes": [ /* sorted by id */ ],
    "edges": [ /* sorted by (from, type, to) */ ]
  }
}
```

It is `jq`-queryable. Examples:

```bash
GRAPH=.forgedock/graph/spec-graph.json

# What does work-on write?
jq -r '.graph.edges[] | select(.from=="cmd:work-on" and .type=="WRITES") | .to' "$GRAPH"

# Who reads FORGE:CONTRACT?
jq -r '.graph.edges[] | select(.type=="READS" and .to=="ann:FORGE:CONTRACT") | .from' "$GRAPH"

# Which commands transition workflow:merged?
jq -r '.graph.edges[] | select(.type=="TRANSITIONS" and .to=="label:workflow:merged") | .from' "$GRAPH"
```

### `builtFromHash` — input fingerprint

`graph.builtFromHash` is a **sha256 fingerprint of the input corpus** the graph
was built from: every `commands/**/*.md`, `scripts/*.sh`, and `devdocs/**/*.md`
file's repo-relative path + content, hashed in sorted order. It is **purely
input-derived** — no timestamps, mtimes, or absolute paths — so identical inputs
always produce the same hash and the emitted graph stays byte-identical
(idempotency is preserved).

It is the basis for **staleness detection without a daemon**. Recompute it
cheaply at any time with the builder's `--hash` mode (no full graph build):

```bash
node scripts/build-spec-graph.mjs --hash      # prints just the sha256, exits
```

If `node scripts/build-spec-graph.mjs --hash` differs from the persisted
graph's `builtFromHash`, the spec corpus changed since the graph was built — the
graph is stale. `graph-query.sh` performs exactly this comparison on every query
(see below).

## Querying the graph (`graph-query.sh`)

`scripts/graph-query.sh` is the consumer-facing query API over the graph, so
agents (and humans) don't hand-write `jq`. It is a **universal-tier**,
**read-only** script: `bash` + `jq`, with `node` used to recompute the staleness
fingerprint and to auto-build/rebuild the graph (to a temp file) when the
persisted JSON is absent or stale. No committed graph is required.

```bash
graph-query.sh <subcommand> <arg> [--human] [--graph <path>] [--strict-stale] [--no-stale-check]
```

| Subcommand            | Returns                                                            |
|-----------------------|-------------------------------------------------------------------|
| `readers <annotation>`| commands/specs that **READ** the annotation                       |
| `writers <annotation>`| commands/specs that **WRITE** (post) the annotation               |
| `impact  <node>`      | blast radius — everything transitively affected if `<node>` changes |
| `deps    <command>`   | a command's full input/output set, grouped by edge type           |
| `load-set <command>`  | minimal spec set to read for a command — the command plus its transitively reachable sub-phases (`CONTAINS`) and required devdocs (`REQUIRES`), as a flat list of repo-relative file paths |
| `search  <term>`      | substring lookup over node ids / names / paths                    |

Arguments are normalized, so all of these resolve to the same node:

```bash
graph-query.sh readers CONTRACT             # == readers FORGE:CONTRACT == readers ann:FORGE:CONTRACT
graph-query.sh deps work-on                 # == deps cmd:work-on
graph-query.sh deps work-on:build:implement # sub-phases use the Skill() `:`-delimited form
graph-query.sh load-set work-on             # == load-set cmd:work-on
graph-query.sh impact classify-lane.sh      # == impact script:classify-lane.sh
graph-query.sh impact workflow:merged       # == impact label:workflow:merged
```

`impact` is **transitive reverse-reachability**: it seeds at `<node>` and
collects every command that (directly or transitively) `READS`/`WRITES`/
`INVOKES`/`REQUIRES`/`CONTAINS` it, walking up parent commands via `CONTAINS`.
So `impact FORGE:CONTRACT` returns not only its direct readers/writers but also
the parent commands that contain them (e.g. `cmd:orchestrate`, `cmd:milestone`).

`load-set` is the **forward inverse of `impact`**: it seeds at `<command>` and
walks `CONTAINS` (sub-phases) and `REQUIRES` (devdocs) edges in the *forward*
direction to a fixpoint, then maps the reachable nodes to their repo-relative
file `path`s. The result is the **minimal spec set** an agent must read to run
that command — the command itself plus only the sub-phases and devdocs actually
reachable from it, never the full ~27-command corpus. It is the resolver that
powers selective spec loading (Phase 0 of `work-on`). `READS`/`WRITES`/
`TRANSITIONS`/`INVOKES` edges are *not* followed — annotations and labels have
no spec file, and scripts are resolved separately at invoke time. The walk shares
`impact`'s cycle-safe termination, so a self-referential `CONTAINS` edge cannot
loop forever.

### Output

Default output is **compact, agent-consumable JSON** — a JSON array for
`readers`/`writers`/`impact`/`search`, a JSON object keyed by edge type for
`deps`, and a sorted, de-duplicated JSON array of file paths for `load-set`.
Pass `--human` for an aligned table instead.

```bash
$ graph-query.sh writers FORGE:CONTRACT
["cmd:work-on","cmd:work-on:build"]

$ graph-query.sh deps work-on:build:implement
{"READS":["ann:FORGE:ARCHITECT","ann:FORGE:CONTEXT","ann:FORGE:CONTRACT","ann:FORGE:INVESTIGATOR"],"WRITES":["ann:FORGE:BUILDER"]}

$ graph-query.sh load-set work-on
["commands/review-pr.md","commands/work-on.md","commands/work-on/build.md","commands/work-on/build/architect.md","commands/work-on/build/context.md","commands/work-on/build/implement.md","commands/work-on/build/validate.md","commands/work-on/close.md","commands/work-on/decompose.md","commands/work-on/investigate.md","commands/work-on/review.md"]

$ graph-query.sh writers FORGE:CONTRACT --human
Specs that WRITE ann:FORGE:CONTRACT:
  cmd:work-on
  cmd:work-on:build
```

### Flags & behavior

- `--graph <path>` — query a specific graph JSON (default:
  `.forgedock/graph/spec-graph.json`). When the default path is absent (it is
  gitignored), the graph is **auto-built on the fly** via `build-spec-graph.mjs`
  into a temp file (cleaned up on exit).
- `--human` — render an aligned table instead of compact JSON.
- `--strict-stale` — do **not** auto-rebuild a stale persisted graph; error
  (exit 1) instead. Useful in CI to assert a committed graph is fresh.
- `--no-stale-check` — skip the staleness check entirely and query the persisted
  graph as-is, even if the spec corpus has changed.
- Exit codes: `0` on success, `1` on bad args, missing `jq`/`node`, an unknown
  node (the error suggests `graph-query.sh search <term>`), or a stale graph
  under `--strict-stale`.

### Staleness detection (no daemon)

ForgeDock targets non-coders, so there is **no file-watcher daemon**. Staleness
is detected **pull-based, on query**:

1. When a query uses a **persisted** graph (the default
   `.forgedock/graph/spec-graph.json`, or an explicit `--graph <path>`),
   `graph-query.sh` recomputes the current corpus fingerprint via
   `build-spec-graph.mjs --hash` and compares it to the graph's stored
   `builtFromHash`.
2. **Match** → the persisted graph is used as-is. The no-change path is a single
   cheap hash compare — no rebuild, no perceptible latency, no background
   process.
3. **Mismatch** (or a graph predating `builtFromHash`) → the graph is stale. By
   default a `stale-graph` banner is printed to **stderr** and the graph is
   transparently **rebuilt** for this query; **stdout stays pure JSON**. With
   `--strict-stale` the query errors instead; with `--no-stale-check` the check
   is skipped.
4. When **no persisted graph exists** (the common case — the graph is
   gitignored), `graph-query.sh` auto-builds a fresh graph to a temp file. A
   freshly built graph is current by construction, so no staleness check runs.

This means editing any `commands/*.md` (or `scripts/*.sh` / `devdocs/**`) is
detected on the next query and the rebuild produces a fresh hash — with no daemon
and no cost on the no-change path.

### Optional: rebuild-on-commit hook

For contributors who choose to keep a **committed** graph in sync, an **opt-in**
git pre-commit hook ships at `.githooks/pre-commit`. It is never auto-installed.
Enable it with:

```bash
git config core.hooksPath .githooks
```

When enabled, the hook rebuilds `.forgedock/graph/spec-graph.json` and stages it
**only if** (a) a persisted graph already exists and (b) the commit stages a file
under `commands/`, `scripts/`, or `devdocs/`. If no persisted graph exists (the
default), the hook is a no-op. It never blocks a commit on rebuild failure.

## Validating the graph (`validate-spec-graph.sh`)

`scripts/validate-spec-graph.sh` is the **self-consistency validator** over the
graph. It catches drift that is invisible in the ~1.2 MB prose corpus and is
wired into `quality-gate` (the `FORGE_GRAPH` domain) so it runs whenever
`commands/*.md` or `scripts/*` files change. Like `graph-query.sh`, it is a
**universal-tier**, **read-only** script (`bash` + `jq`, `node` only for the
on-the-fly auto-build) that auto-builds the graph when the gitignored JSON is
absent — no committed graph is required.

```bash
validate-spec-graph.sh [--soft] [--graph <path>] [--root <dir>] [--quiet] [--json]
```

It performs three checks, partitioned by severity:

| Check                     | Severity     | Detects                                                                 |
|---------------------------|--------------|-------------------------------------------------------------------------|
| **Orphan annotations**    | SOFT (warn)  | a `FORGE:*` marker WRITTEN but never READ, or READ but never WRITTEN     |
| **Dangling cross-refs**   | HARD (fail)  | a `Skill(skill="X")` whose target is no real command/sub-phase node      |
| **Broken transitions**    | HARD (fail)  | a `workflow:*` label set by **no** command (no `--add-label` edge)        |

Inline doc-scaffolding markers (`FORGE:DISPATCHER`, `FORGE:PHASE_COMPLETE`,
`FORGE:TYPE`, …) legitimately have neither a WRITES nor a READS edge — they
annotate the spec prose itself and are never posted via `gh ... comment`. They
are reported as **INFO** (via a curated allowlist in the script), never as
orphans. A non-allowlisted isolated marker is surfaced as SOFT so new
scaffolding gets triaged.

**Why dangling refs are scanned from prose, not edges**: the builder *drops*
unresolved `Skill()`/script/devdoc references (it only emits an edge when the
target resolves to a real node — see `if (nodes.has(targetId))` in
`build-spec-graph.mjs`). So a dangling reference never appears as a graph edge.
The validator therefore scans `commands/**/*.md` for `Skill(skill="X")`
directly and cross-checks each `X` against the command/sub-phase node set. Only
the structured `Skill()` form is checked — loose `.sh`/filename mentions in
prose are illustrative and are intentionally not flagged.

### Flags & exit codes

- `--soft` — warn-only mode: HARD findings are still reported, but the exit code
  is forced to `0`. Used when first wiring into CI so the documented baseline
  orphans/refs do not break the build before triage. `quality-gate` invokes the
  validator with `--soft` and re-surfaces any `[HARD]` line as a HIGH finding.
- `--graph <path>` — validate a specific graph JSON (default
  `.forgedock/graph/spec-graph.json`, auto-built when absent).
- `--root <dir>` — repo root to scan for `Skill()` refs and to auto-build from.
- `--quiet` — print only the summary line. `--json` — emit findings as a single
  JSON object (`{summary:{hard,soft,info}, findings:[{severity,class,message}]}`).
- Exit codes: `0` when there are no HARD findings (or `--soft`); `1` on a HARD
  inconsistency, bad args, or a missing dependency. Output is deterministic
  (findings sorted by severity → class → message), so re-runs are byte-stable.

## Node types

| `type`       | `id` shape                       | Source                                  |
|--------------|----------------------------------|-----------------------------------------|
| `command`    | `cmd:<name>`                     | top-level `commands/<name>.md`          |
| `sub-phase`  | `cmd:<a>:<b>[:<c>]`              | nested `commands/<a>/<b>[/<c>].md`      |
| `annotation` | `ann:FORGE:<NAME>`               | distinct `FORGE:*` HTML-comment marker  |
| `label`      | `label:workflow:<name>`          | distinct `workflow:*` label             |
| `script`     | `script:<file>.sh`               | `scripts/*.sh` file on disk             |
| `devdoc`     | `devdoc:devdocs/<path>.md`       | `devdocs/**/*.md` reference doc          |

Sub-phase names use the same `:`-delimited convention as `Skill(skill="...")`
targets, so `commands/work-on/build/implement.md` → `cmd:work-on:build:implement`.

Every node carries `id`, `type`, `name`; file-backed nodes also carry `path`
(repo-relative).

## Edge types

All edges originate from a `command` or `sub-phase` node.

| `type`        | Target      | Meaning                                              |
|---------------|-------------|------------------------------------------------------|
| `WRITES`      | annotation  | command **posts** the FORGE annotation                |
| `READS`       | annotation  | command **consumes** the FORGE annotation             |
| `TRANSITIONS` | label       | command **sets** the workflow label                   |
| `CONTAINS`    | sub-phase   | parent → nested phase (directory) or `Skill()` invoke |
| `INVOKES`     | script      | command runs a `scripts/*.sh` file                    |
| `REQUIRES`    | devdoc      | command **must read** a devdoc (authority: required)  |

Each edge carries `from`, `type`, `to`, and an `evidence` object with the
source `file`/`line` (and `via`/`authority` where relevant).

## Extraction heuristics

The builder regex-scans each `commands/**/*.md` line by line:

- **WRITES** — line matches `gh (issue|pr) comment ... --body` and a
  `<!-- FORGE:X -->` marker appears in the body portion (same line or the
  immediately following line, since `--body` blocks often wrap). This captures
  the *posting* form only.
- **READS** — line matches `contains("FORGE:X")` (the jq-select consume form) or
  prose `read[s]/re-read the FORGE:X` (the narrative consume form).
- **TRANSITIONS** — line matches `--add-label "...workflow:X..."`. A single
  `--add-label` may carry a comma-separated list; each label becomes an edge.
- **CONTAINS** — two sources: (a) directory nesting (`cmd:work-on` →
  `cmd:work-on:build` → `cmd:work-on:build:implement`), and (b)
  `Skill(skill="X")` invocations where `X` resolves to a known command/sub-phase
  node.
- **INVOKES** — any `*.sh` token in the spec that matches a real `scripts/*.sh`
  filename on disk. Tokens that don't correspond to a real script are ignored.
- **REQUIRES** — a line that references a `devdocs/*.md` path **and** carries a
  requirement verb (`Read` / `required` / `must` / `before`), with
  `authority: "required"`.

### WRITES vs READS — false-positive handling

The hardest distinction is **WRITES vs READS** of the same annotation. The
distinguishing signal is the surrounding command, not the marker itself:

- A spec that says *post* `<!-- FORGE:BUILDER -->` (via `gh ... comment --body`)
  **writes** it.
- A spec that says *read* the `FORGE:CONTRACT` (via `contains("FORGE:CONTRACT")`
  or "read the FORGE:CONTRACT") **reads** it.

Documentation scaffolding markers — inline `<!-- FORGE:PHASE_COMPLETE -->` and
`<!-- FORGE:DISPATCHER -->` HTML comments used to annotate the spec prose itself
— are **not** counted as WRITES, because they never appear inside a
`gh ... comment --body` posting. They still get `annotation` nodes (they are
real markers in the corpus) but produce no spurious WRITES edges. This guard is
verified by the builder's self-check.

## Self-check

On every run the builder asserts three acceptance spot-checks and exits non-zero
if any fails:

1. `work-on` **WRITES** `FORGE:TRAJECTORY`.
2. `review-pr` **READS** `FORGE:CONTRACT`.
3. `builtFromHash` is present and is a 64-char sha256 hex digest.

## Adding new node or edge types

Extend `commandNodeFromPath()` / the node-discovery passes for new node types,
and add a new heuristic block in the per-line loop of `build()` for new edge
types. Keep all output sorted to preserve idempotency, and add a self-check
assertion for any new invariant.

## Open-core boundary

The graph is **open-core, CLI-side, local-only**. The builder, store, and query
tools (`build-spec-graph.mjs`, `graph-query.sh`, `validate-spec-graph.sh`) are
AGPL code in this repo; they run entirely on-disk and emit a structured JSON
artifact (`.forgedock/graph/spec-graph.json`, gitignored by default).

That JSON is the boundary. The Platform's L1 observability dashboard *renders*
the graph as a pipeline self-map (runs, timelines, stall detection) — that
visualization is the **commercial value-add**. The Platform consumes the emitted
JSON; it never imports, embeds, vendors, or links the AGPL builder/query code
(see `devdocs/project/architecture.md` → Boundary Rules). The CLI does not know
or care whether the Platform exists — emitting the JSON is the entire contract.

## Optional context hook (deferred — off by default)

A future opt-in Claude Code `PreToolUse` hook can use the graph to inject
"relevant specs per graph" as context when an agent greps `commands/`, mirroring
codegraph's `PreToolUse` pattern. It would shell out to
`graph-query.sh load-set <command>` (or `readers`/`deps`) and surface the
task-relevant spec set instead of letting the agent load blindly.

**Decision: deferred — not shipped in this milestone.** It must be:

- **Opt-in, off by default** — gated behind an explicit setting (e.g. a
  `hooks.spec_graph_context` flag in `forge.yaml` or the user's Claude Code
  settings), so the graph imposes nothing on users who do not enable it.
- **Non-blocking** — a `PreToolUse` hook that only *adds* context and never
  rejects a tool call; a missing or stale graph degrades to a no-op.
- **CLI-side** — the hook reads the local JSON via the AGPL query scripts; it
  introduces no Platform dependency.

Shipping the wiring is deferred because no hook-infrastructure layer exists in
the repo yet; this section is the spec that a later issue implements against.

## Nested-Command Decomposition and the Graph

The spec graph's `walk()` function (in `build-spec-graph.mjs`) and the
`load-set` query together enable the nested-command decomposition pattern. A
brief summary is given here; the full naming convention, decomposition criteria,
and token-saving effect are documented in
**`docs/spec/forge-protocol-v1.md` § 10 (Nested-Command Decomposition
Pattern)**.

**How nested specs become graph nodes**: `walk()` recursively discovers every
`commands/**/*.md` file at any depth. Each file is registered as a `cmd:` node
whose id follows the Skill() colon-delimited form (`cmd:work-on:build:context`
for `commands/work-on/build/context.md`). `CONTAINS` edges are inferred when a
parent spec references a child via `Skill(skill="<name>", ...)`.

**How `load-set` exploits decomposition**: `load-set <command>` seeds at the
command's node and walks `CONTAINS` and `REQUIRES` edges forward. A decomposed
command like `work-on` returns only the 11 files its execution graph actually
reaches — not the full ~44-spec corpus. Sub-specs that belong to `work-on/build/`
but are only invoked under specific conditions (e.g., `context.md` is skipped for
TRIVIAL tasks) can be added or removed from the reachable set by updating the
`CONTAINS` edges in the parent spec, without changing the query logic.

**Token-saving measurement**: See
`docs/articles/command-decomposition-token-savings.md` for before/after token
counts for `/review-pr` and `/orchestrate` following their spec decompositions
in #1271 and #1272.
