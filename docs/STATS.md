<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# forgedock stats

A deterministic, version-over-version report. No model is involved: code reads records and counts them.

```bash
npx forgedock stats [--since <version|date>] [--repo <owner/repo>] [--json] [--refresh]
                    [--compact] [--no-local] [--no-cache] [--min-n N] [--release-times FILE]
```

`--repo` defaults to `project.owner`/`project.repo` in `forge.yaml`, else the `origin` remote. `--since 1.16.0` keeps
versions at or above it; `--since 2026-10-01` keeps activity on or after the date. `--compact` prints one row per
version (the table embedded in the staging review summary). `--json` is machine-readable.

`--since` also bounds the GitHub crawl: only issues and comments updated on or after the window start are read (a version
is resolved to its tag time minus one day; an unknown tag falls back to a full crawl and says so on stderr). Progress is
printed to stderr while crawling, so `--json` stdout stays parseable.

## Sources

1. **GitHub (primary).** Issues, PRs and labels of the target repo, plus trusted `<!-- FORGE:TELEMETRY v1 -->` comments
   (`docs/TELEMETRY.md`). Only comments from OWNER/MEMBER/COLLABORATOR or a Bot are read (same predicate as
   `scripts/trusted-comments.sh`); `part=N` comments are concatenated and records are deduped on `eid`. All `gh` calls
   are argv-based. Needs an authenticated `gh`.
2. **Local cache (optional).** `~/.forge/stats-cache/<owner>_<repo>/cache.json` (`FORGE_STATS_CACHE_DIR`) holds what was
   fetched, an `updated_at` watermark (the next run only re-reads items updated since) and a `coveredFrom` floor (the
   oldest window start crawled, so a later, wider `--since` crawls the uncovered gap instead of under-reporting). It is
   safe to delete (the cost is one full re-fetch); a corrupt cache is treated as empty. `--refresh` ignores it, `--no-cache` never touches it.
3. **Local run logs (optional).** `~/.forge/runs/*.jsonl` (`FORGE_RUNS_DIR`) for runs that predate the engine's
   `phase_attempt` / `run_terminal` records. A run already present on GitHub is not counted twice. Only runs whose
   `RUN_START.repo` equals the target repo are used. `--no-local` skips them.

With no local state at all, `forgedock stats --repo <r>` reproduces the report from GitHub alone.

## Efficiency (`--efficiency`, forge#4402)

```bash
npx forgedock stats --efficiency [--batch <id>] [--window 7d,30d] [--repo <owner/repo>] [--json]
```

Per batch (`--batch`, a dir under `~/.forge/batches`, `FORGEDOCK_BATCH_DIR`) and over trailing windows (`--window`,
default `7d,30d`: the union of the repo's batches whose `plan.created` falls in the window, where an issue in several
batches counts once with its latest row). The orchestrate batch report prints the same lines for the batch it just ran.
The code is in `bin/stats/efficiency.mjs`.

- **Cohort and cost to merge.** A merged issue counts every `RUN_START..RUN_TERMINAL` slice of its run log
  (`~/.forge/runs/<issue>.jsonl`) that started at or before its settle time (its latest batch `log.jsonl` row) and
  belongs to the repo. Earlier failed lanes from other batches or ad-hoc runs count too. Attempt cost is
  `cost_usd_delta`, else `cost_usd`.
- **$/merge, turns/merge, context/turn**: all-phase cost ÷ merged, with implement and review totals; implement turns ÷
  merged; implement cache-read ÷ implement turns. These are also split by size (the merging run's `turns.size`, else a
  `size:` label, else `unknown`) and by model (the implement attempt's `model`).
- **Retries/merge by cause.** For builder attempts, the trigger decides the cause:

  | Cause | Triggers |
  | --- | --- |
  | env | `ci_unavailable` |
  | engine | `timeout_restart`, `context_restart`, `budget_wrapup`, `recovery` |
  | code | `precheck`, `structure`, `docs`, `enumerating`, `sequence`, `ci_red`, `conformance`, `merge_ci`, `block_correction`, `contract_correction` |
  | review | `review` |

  `plan`, `build` and `verifier` are not retries. A lane rerun (every run slice of a merged issue but the last) counts
  by the code that ended it: `env.*` is env; `engine.*`, `run.*`, `followup.*`, `base.*`, `dependency.*` are engine;
  `ci.*`, `conformance.*`, `precheck.*`, `budget.*`, `builder.*`, `contract.*` are code; `review.*` is review; anything
  else is unknown.
- **No action**: rows parked by the pre-filter (`awaiting-promotion`, `awaiting-precondition`) and lanes that ended
  `builder.blocked` with `Builder is blocked (promotion)`, with their count and cost.
- **Issue quality vs. cost**: each merged issue's body is tagged `full` (a root-cause heading, a `file:line` and a
  fix/design/approach/proposal heading), `partial` (some of these) or `none`, and n, $/merge and turns/merge are
  compared per tag.
- **Acceptance (7d after promotion)**: from trusted `FORGE:PROBE` comments (#4399). An issue whose first record is
  under 7 days old is pending. After that it passes when every record within 7 days of the first one passed. The
  first record is the observed promotion, because a probe runs only once the fix is on the default branch.

Limits: logs written before #4362 carry no trigger, so implement attempts beyond the plan and build calls count as
`unknown`. Logs written before #4407 sum running session totals. Lanes run outside a batch are in no window. `gh` (for
merged issues only) is the one network call; when it fails, quality and acceptance print `n/a` with the reason.

## Explorer A/B (`--explore-ab`, forge#4418)

Compares lanes run with forge.yaml `lean.explore: on` against `off` (#4391), from the local run logs only (no GitHub
crawl). Every RUN_START slice of each log counts, so re-running an issue with the other mode adds a second lane.

- Rows per size bucket (`S`, `M`, `L` from the lane's turn record, else `unsized`) and mode: n, mean builder (plan +
  build) turns, mean builder `cache_read_input_tokens`, merge rate (merged / finished) and conformance rate (lanes that
  reached review with no conformance/review fix round and no shadow would-block, over reviewed; same as `--tiers`).
- A paired table restricted to issues with a finished lane in both modes.
- Finished lanes without an `explore` tag (before #4391) are counted and left out.

`--json` prints the same data as `query.explore_ab`.

## Sections (per version and repo)

- **Cost**: cache-read tokens per issue (mean, median), per phase (mean over all runs, so phases add up to the per-issue
  mean), per merged issue, output tokens, USD where recorded.
- **Time**: p50 and p90 duration per phase and wall time per issue.
- **Flow**: merged %, needs-human %, remediation rate, outcome-code distribution (`docs/OUTCOME-CODES.md`), and the
  **first-pass rate** (#4362): the share of lanes that reached the build (a `build` attempt, or the `timeout_restart` of
  one) with no rework attempt after it, with the count (`k/n lanes`) and how many lanes are `unknown` (their attempts
  carry no `trigger`: logs written before the field). Rework triggers: `precheck`, `structure`, `docs`, `enumerating`,
  `sequence`, `ci_red`, `conformance`, `review`, `merge_ci` (`bin/lean/fixround.mjs` `REWORK_TRIGGERS`); a timeout
  restart, a base-sync `recovery`, a `ci_unavailable` fallback or a `block_correction` does not break first pass.
- **Rework by trigger** (#4362): count and USD of the builder (`implement`) attempts with a rework trigger, per trigger,
  plus a total. Attempts without a `trigger` are counted as `unknown`, never dropped. JSON also carries every builder
  attempt by trigger (`rework.attempts`).
- **Review funnel**: findings per review by severity, then ISSUE / NOTE / in-PR fix, plus `validated` and `false-positive` issues.
- **Gates**: block rate per gate (acceptance, diff size OVER, CI, liveness), malformed-check rate, COHESIVE and OVER counts.
- **Issue flow**: issues created by source (review-finding, pipeline bot, human), closed by kind, net flow, findings per merged issue.

Each group shows a delta against the previous version of the same repo and is flagged `low-n` below `--min-n`
(default 10 finished runs).

## Counting rules

They match `scripts/cost-report.sh`, so the two reports agree on the same logs: only finished runs count; hydrated runs
and runs with no usage events are excluded; tokens are cache-read tokens; `PHASE_ATTEMPT_USAGE` supersedes the cumulative
`PHASE_COMMIT` usage of the same phase. On GitHub a run is the set of `phase_attempt` records sharing a `run` id and it is
finished once a `run_terminal` record exists. On GitHub stats count one run per issue: the latest by start timestamp wins and earlier attempts (for example before a
`--retry`) are discarded, as in `scripts/cost-report.sh`. Wall time covers the winning engine process only.

## Versions and n/a

Records carry `forge_version`. Records without one (older runs, issues with no telemetry) are placed by release time:
`--release-times FILE` (`<version> <epoch-seconds>` lines), else the git tags of the ForgeDock checkout, shown with a `~`
suffix; otherwise `unknown`. Anything that cannot be computed (no timestamps, no outcome codes, no records) prints `n/a`
instead of failing.

## Limits

Comments are read from the repo-wide `issues/comments?since=` endpoint (a few paginated calls); only issues with a trusted
telemetry comment in the window get their full comment list re-read (6 in parallel, backing off when the API rate limit is
low). A run with no `--since` and no cache still walks the whole history once. Telemetry comments are edited in place, which
the comment window catches; if a cached item still looks stale, run with `--refresh`.
