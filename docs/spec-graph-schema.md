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

## Querying the graph (`graph-query.sh`)

`scripts/graph-query.sh` is the consumer-facing query API over the graph, so
agents (and humans) don't hand-write `jq`. It is a **universal-tier**,
**read-only** script: `bash` + `jq`, with `node` only used to auto-build the
graph when the (gitignored) JSON is absent. No committed graph is required.

```bash
graph-query.sh <subcommand> <arg> [--human] [--graph <path>]
```

| Subcommand            | Returns                                                            |
|-----------------------|-------------------------------------------------------------------|
| `readers <annotation>`| commands/specs that **READ** the annotation                       |
| `writers <annotation>`| commands/specs that **WRITE** (post) the annotation               |
| `impact  <node>`      | blast radius — everything transitively affected if `<node>` changes |
| `deps    <command>`   | a command's full input/output set, grouped by edge type           |
| `search  <term>`      | substring lookup over node ids / names / paths                    |

Arguments are normalized, so all of these resolve to the same node:

```bash
graph-query.sh readers CONTRACT             # == readers FORGE:CONTRACT == readers ann:FORGE:CONTRACT
graph-query.sh deps work-on                 # == deps cmd:work-on
graph-query.sh deps work-on:build:implement # sub-phases use the Skill() `:`-delimited form
graph-query.sh impact classify-lane.sh      # == impact script:classify-lane.sh
graph-query.sh impact workflow:merged       # == impact label:workflow:merged
```

`impact` is **transitive reverse-reachability**: it seeds at `<node>` and
collects every command that (directly or transitively) `READS`/`WRITES`/
`INVOKES`/`REQUIRES`/`CONTAINS` it, walking up parent commands via `CONTAINS`.
So `impact FORGE:CONTRACT` returns not only its direct readers/writers but also
the parent commands that contain them (e.g. `cmd:orchestrate`, `cmd:milestone`).

### Output

Default output is **compact, agent-consumable JSON** — a JSON array for
`readers`/`writers`/`impact`/`search`, and a JSON object keyed by edge type for
`deps`. Pass `--human` for an aligned table instead.

```bash
$ graph-query.sh writers FORGE:CONTRACT
["cmd:work-on","cmd:work-on:build"]

$ graph-query.sh deps work-on:build:implement
{"READS":["ann:FORGE:ARCHITECT","ann:FORGE:CONTEXT","ann:FORGE:CONTRACT","ann:FORGE:INVESTIGATOR"],"WRITES":["ann:FORGE:BUILDER"]}

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
- Exit codes: `0` on success, `1` on bad args, missing `jq`/`node`, or an
  unknown node (the error suggests `graph-query.sh search <term>`).

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

On every run the builder asserts two acceptance spot-checks and exits non-zero
if either fails:

1. `work-on` **WRITES** `FORGE:TRAJECTORY`.
2. `review-pr` **READS** `FORGE:CONTRACT`.

## Adding new node or edge types

Extend `commandNodeFromPath()` / the node-discovery passes for new node types,
and add a new heuristic block in the per-line loop of `build()` for new edge
types. Keep all output sorted to preserve idempotency, and add a self-check
assertion for any new invariant.
