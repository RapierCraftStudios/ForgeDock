# Light-lane three-way benchmark (#4453)

This benchmark compares the light lane (#4450) with the full lean lane and with a plain single-session `claude -p` control. All three arms run on the same issue set, and each is graded by the **upstream oracle tests**: the test files of the real upstream fix, which fail on the base and pass on the fix. It reproduces the #4442 benchmark of 2026-10-22 and checks its acceptance targets.

- Harness: `scripts/bench-lightlane.mjs`
- Corpus: `docs/eval/corpus/lightlane-v1.json`. This is more-itertools @ `670b715` with upstream #1293, #1304 and #1308. Their fixes are PRs #1294, #1305 and #1309, and they were reported after the model's training cutoff.

## Prerequisites

- `python3`, `git`, `gh` (authenticated, with access to the sandbox repos), `claude` and `forgedock` on PATH. Use the ForgeDock release under test.
- Two **private sandbox repos**, one for the light arm and one for the full arm. Each needs the upstream history up to the base, so the base SHA exists in it:
  ```sh
  git clone https://github.com/more-itertools/more-itertools.git mi && cd mi
  git push git@github.com:<you>/mi-light.git 670b715b307adfe5d2fca08a87ca562cb8bfea2c:refs/heads/main
  git push git@github.com:<you>/mi-full.git  670b715b307adfe5d2fca08a87ca562cb8bfea2c:refs/heads/main
  ```
  If a sandbox is a squashed snapshot instead, set `arms.<arm>.base` in the run config to its base commit.
- A `forge.yaml` in each sandbox. The light arm sets `lean:` → `light:` → `mode: on`, and the full arm sets `mode: off`. Commit it on `main`; the harness diffs from the base, so this commit doesn't count as an arm change.
- The corpus issues filed in each sandbox, with the title and body taken verbatim from the corpus. Labels follow the #4442 setup: `bug`.
  ```sh
  jq -c '.issues[]' docs/eval/corpus/lightlane-v1.json | while read -r i; do
    gh issue create -R <you>/mi-light --title "$(jq -r .title <<<"$i")" --body "$(jq -r .body <<<"$i")" --label bug
  done
  ```

## Run config (`runcfg.json`, not committed)

```json
{
  "arms": {
    "light":   { "repo": "<you>/mi-light", "issues": { "lightlane-1293": 1, "lightlane-1304": 2, "lightlane-1308": 3 } },
    "full":    { "repo": "<you>/mi-full",  "issues": { "lightlane-1293": 1, "lightlane-1304": 2, "lightlane-1308": 3 } },
    "control": { "model": "claude-opus-5-5" }
  }
}
```

Optional per arm:
- `command`: argv prefix. The default is `["forgedock","run-issue"]`, or `["claude"]` for the control.
- `args`: extra arguments, for example `["--model","claude-opus-5-5"]` for a lane, or the permission flags your `claude` needs for the control.
- `clone_url` and `base` for the lane arms.

Use the same model in every arm, and no web tools.

## Steps

1. **Calibrate** the oracles. Every issue must report `red_on_base` and `green_on_fix`, otherwise the command exits 2:
   ```sh
   node scripts/bench-lightlane.mjs calibrate --corpus docs/eval/corpus/lightlane-v1.json
   ```
2. **Run** the arms. This takes about 10 minutes per arm per issue, runs sequentially, and appends one JSON row per arm and issue:
   ```sh
   node scripts/bench-lightlane.mjs run --corpus docs/eval/corpus/lightlane-v1.json --config runcfg.json --out rows.jsonl
   ```
   Use `--arms light,control` or `--issues lightlane-1304` to rerun part of the set. Use `--keep` to keep the scratch clones.
3. **Aggregate** the rows. This prints the metrics and targets, and exits 2 when a target fails:
   ```sh
   node scripts/bench-lightlane.mjs aggregate rows.jsonl
   ```
4. Post the aggregate JSON and the target table, plus `rows.jsonl`, on the measurement tracking issue. Note the ForgeDock version, the model and the date.

## What each metric means

| Field | Meaning |
|---|---|
| `cost_usd` | **True** cost. For the lanes, it is the run result's `cost_usd`: the sum of the #4407 per-session deltas, not the naive sum of running totals. For the control, it is `total_cost_usd`. |
| `wall_ms` | Lane wall time inside the engine (`wall_ms`, #4451). For the control, it is `duration_ms`. `harness_wall_ms` adds CLI start-up. |
| `model_ms` | Summed session time (`model_ms`, #4451). For the control, it is `duration_ms`, since the control is one session. |
| `oracle_pass` | The oracle command passes after the fix's test files are overlaid on the arm's head (`git checkout <fix_sha> -- tests/test_more.py`). |
| `suite_pass` | The repo's own suite (`suite_command`) passes on the arm's head, before the overlay. |
| `claimed_fix` | The arm reported success and its diff is non-empty. For the lanes, success is a `merged` or `ci-pending` terminal reason; for the control, it is exit 0 with `is_error: false`. |
| false fix | `claimed_fix` and not `oracle_pass`. |
| `api_shape` | `bin/lean/apishape.mjs` from the base to the arm's head (signature, sync↔async, generator↔function, removed or renamed public symbol). |
| undetected API shape | A light-arm row that finished light (`light: true`, no upgrade) although its diff changed the public API shape. |

## Targets (#4442)

| Target | Check |
|---|---|
| Light true cost ≤ 1.2× control | The cost sum of eligible light rows, divided by the control's cost on the same issues. |
| Light wall ≤ 1.3× model time | The `wall_ms` sum of eligible light rows, divided by their `model_ms` sum. |
| Light oracle pass rate ≥ control | Over all light rows. |
| Light false-fix rate ≤ control | Over all light rows. |
| 0 undetected public-API-shape changes | Over all light rows. |

"Eligible" means the row's `light_eligibility` (the run result's light-lane verdict) is `eligible`. A target is `null` when an arm it needs has no rows.

## Corpus notes

- Oracle commands are scoped to the test ids each fix PR added or changed. Class-wide commands would include tests that fail on the base for reasons unrelated to the issue.
- `lightlane-1293`: `670b715` is the merge parent of the fix, but the fix branch also carries the #1268/#1269 seekable `maxlen=0` value fix. On the base the oracle errors with `StopIteration`, so an arm passes only if it bounds memory and also keeps the peeked values.
