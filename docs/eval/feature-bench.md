# Feature benchmark (forge#5341)

The lane benchmark ([lightlane-bench.md](lightlane-bench.md)) grades one issue at a time. This one grades a whole feature: a spec goes
in, an app comes out, and hidden journey tests decide how much of it works.

## Specs

`docs/eval/feature-specs/<id>/` holds `spec.md` (the only thing an arm sees) and `journeys/*.mjs` (the oracle, never shown to an arm).
A journey is a script that exits 0 on a pass and reads the app checkout from `BENCH_APP`. Shipped: `crud-auth` (accounts and per-user
notes). Planned: a CLI with a plugin registry, a two-service queue pipeline, a small web app.

## Arms

| Arm | What runs |
|---|---|
| `full` | `arms.full.steps` (default: `forgedock bootstrap`, `orchestrate`, `release` on the sandbox repo; `{repo}`, `{spec}`, `{result}` are filled in), then a clone of the repo |
| `control` | one bare `claude -p <spec> --output-format json --model <model>` session in an empty directory |

```json
{"arms": {"full": {"repo": "acme/sandbox"}, "control": {"model": "claude-opus-5-5"}}}
```

## Run

```
node scripts/bench-feature.mjs run --spec docs/eval/feature-specs/crud-auth --config cfg.json --out rows.jsonl
node scripts/bench-feature.mjs aggregate rows.jsonl [--previous last-scorecard.json]
```

Row: `journeys_passed`, `journeys_total`, `cost_usd`, `wall_ms`, `interventions`, `terminal`. The scorecard has per-arm metrics, the target
`full_journeys_ge_control` and `regression` (the full arm's journey pass rate fell below `--previous`). Exit 2 on a failed target or a regression.

## Per-release scorecard and the promotion gate

Publish the `aggregate` output for each release next to the lane benchmark (`docs/eval/`). A default-flag promotion that affects
milestone lanes must first pass `scoreboardGate({ bench, board })` (`bin/stats/scoreboard.mjs`): the latest scorecard has no
regression, and the shipped milestone's journeys (`forgedock stats --milestone <id>`) are not red. Real arm runs cost money and are never part of CI.

## Baselines

`forgedock stats --milestone <id|title> --repo <owner/repo>` records the scoreboard of a shipped milestone (journey status at ship,
first merge to first green journey, defects after the last child by class, rework share, interventions).
