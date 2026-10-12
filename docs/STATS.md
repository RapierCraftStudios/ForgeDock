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

## Sources

1. **GitHub (primary).** Issues, PRs and labels of the target repo, plus trusted `<!-- FORGE:TELEMETRY v1 -->` comments
   (`docs/TELEMETRY.md`). Only comments from OWNER/MEMBER/COLLABORATOR or a Bot are read (same predicate as
   `scripts/trusted-comments.sh`); `part=N` comments are concatenated and records are deduped on `eid`. All `gh` calls
   are argv-based. Needs an authenticated `gh`.
2. **Local cache (optional).** `~/.forge/stats-cache/<owner>_<repo>/cache.json` (`FORGE_STATS_CACHE_DIR`) holds what was
   fetched plus an `updated_at` watermark, so the next run only re-reads items updated since. It is safe to delete (the
   cost is one full re-fetch); a corrupt cache is treated as empty. `--refresh` ignores it, `--no-cache` never touches it.
3. **Local run logs (optional).** `~/.forge/runs/*.jsonl` (`FORGE_RUNS_DIR`) for runs that predate the engine's
   `phase_attempt` / `run_terminal` records. A run already present on GitHub is not counted twice. Only runs whose
   `RUN_START.repo` equals the target repo are used. `--no-local` skips them.

With no local state at all, `forgedock stats --repo <r>` reproduces the report from GitHub alone.

## Sections (per version and repo)

- **Cost**: cache-read tokens per issue (mean, median), per phase (mean over all runs, so phases add up to the per-issue
  mean), per merged issue, output tokens, USD where recorded.
- **Time**: p50 and p90 duration per phase and wall time per issue.
- **Flow**: merged %, needs-human %, remediation rate, outcome-code distribution (`docs/OUTCOME-CODES.md`).
- **Review funnel**: findings per review by severity, then ISSUE / NOTE / in-PR fix, plus `validated` and `false-positive` issues.
- **Gates**: block rate per gate (acceptance, diff size OVER, CI, liveness), malformed-check rate, COHESIVE and OVER counts.
- **Issue flow**: issues created by source (review-finding, pipeline bot, human), closed by kind, net flow, findings per merged issue.

Each group shows a delta against the previous version of the same repo and is flagged `low-n` below `--min-n`
(default 10 finished runs).

## Counting rules

They match `scripts/cost-report.sh`, so the two reports agree on the same logs: only finished runs count; hydrated runs
and runs with no usage events are excluded; tokens are cache-read tokens; `PHASE_ATTEMPT_USAGE` supersedes the cumulative
`PHASE_COMMIT` usage of the same phase. On GitHub a run is the set of `phase_attempt` records sharing a `run` id and it is
finished once a `run_terminal` record exists. Wall time covers one engine process; a resumed run is a separate run.

## Versions and n/a

Records carry `forge_version`. Records without one (older runs, issues with no telemetry) are placed by release time:
`--release-times FILE` (`<version> <epoch-seconds>` lines), else the git tags of the ForgeDock checkout, shown with a `~`
suffix; otherwise `unknown`. Anything that cannot be computed (no timestamps, no outcome codes, no records) prints `n/a`
instead of failing.

## Limits

Issues and PRs are listed by `updated_at`, so the first run on a large repo makes one comment request per item that has
comments. Telemetry comments are edited in place; if a cached item looks stale, run with `--refresh`.
