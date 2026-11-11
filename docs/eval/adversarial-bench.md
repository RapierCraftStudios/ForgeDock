# Adversarial benchmark: full lane vs bare agent (#5292)

This benchmark checks the claim that a fixed process beats a bare agent session when the issues are not all valid. The corpus has 20 issues over more-itertools at `670b715`. Of these, 12 must **not** be implemented, and 5 only pass if the change reaches a second integration point.

- Harness: `scripts/bench-adversarial.mjs`. It is a sibling of `scripts/bench-lightlane.mjs` (#4453) and reuses its arm runner, so the arms are run and costed the same way.
- Corpus: `docs/eval/corpus/adversarial-v1.json`
- Arms: `full` (`forgedock run-issue` with the light lane off) and `control` (a plain `claude -p` session).

## Corpus

| Kind | Count | Correct outcome | What a bad arm does |
|---|---|---|---|
| `valid` | 3 | Implement; the upstream fix tests (oracle) pass | Fails the oracle |
| `wrong-premise` | 5 | Close with evidence: the behaviour reported as broken is correct at the base | Implements a change anyway (a *wrong issue implemented*) |
| `duplicate` | 4 | Close with evidence: the feature exists | Adds a second function (a *duplicate implementation*) |
| `already-fixed` | 3 | Close with evidence: it already ships at the base | Implements it again |
| `integration` | 5 | Implement in `more.py` and also touch `more.pyi` and `docs/api.rst` | Skips a file (an *integration point missed*) |

Each invalid issue has `evidence: {file, pattern}`. The pattern must match the file at the base commit. `calibrate` checks this.

## Prerequisites and run config

Same as `docs/eval/lightlane-bench.md`: `python3`, `git`, `gh`, `claude` and `forgedock` on PATH, plus one **private sandbox repo** for the full arm. The base SHA must exist in it, and its `forge.yaml` sets `lean:` → `light:` → `mode: off`. File the corpus issues in the sandbox with the title and body taken verbatim from the corpus:

```sh
jq -c '.issues[]' docs/eval/corpus/adversarial-v1.json | while read -r i; do
  gh issue create -R <you>/mi-full --title "$(jq -r .title <<<"$i")" --body "$(jq -r .body <<<"$i")"
done
```

`runcfg.json` (not committed) maps each corpus id to its sandbox issue number for `full`, and sets the model for `control`:

```json
{ "arms": { "full": { "repo": "<you>/mi-full", "issues": { "adv-valid-1293": 1, "adv-wp-chunked-tail": 2 } }, "control": { "model": "claude-opus-5-5" } } }
```

List every corpus id under `full.issues` (20 entries). Use the same model in both arms and no web tools.

## Steps

```sh
# 1. The corpus shape (20 issues, at least 5 invalid) and its evidence at the base
node scripts/bench-adversarial.mjs validate  --corpus docs/eval/corpus/adversarial-v1.json
node scripts/bench-adversarial.mjs calibrate --corpus docs/eval/corpus/adversarial-v1.json
# 2. Run both arms (sequential; appends one graded JSON row per arm and issue)
node scripts/bench-adversarial.mjs run --corpus docs/eval/corpus/adversarial-v1.json --config runcfg.json --out rows.jsonl
# 3. Aggregate into the published scorecard
node scripts/bench-adversarial.mjs aggregate rows.jsonl --corpus docs/eval/corpus/adversarial-v1.json \
  --model claude-opus-5-5 --date YYYY-MM-DD --scorecard docs/eval/published/adversarial-YYYY-MM-DD.md
```

Use `--arms control` or `--issues id,id` to rerun part of the set, and `--keep` to keep the scratch clones.

## Metrics (per arm)

| Metric | Definition |
|---|---|
| Wrong issues implemented | Rows of kind `wrong-premise`, `duplicate` or `already-fixed` where the arm claimed a fix (a merged or ci-pending lane, or a control that exited cleanly) with a non-empty diff. Lower is better. |
| Duplicate implementations created | A `duplicate` row that claimed a fix and whose diff adds a line matching one of the issue's `forbid_new_defs` patterns. |
| Integration points missed | For each `integration` row, the number of `must_touch` paths absent from the diff against the base. |
| Oracle pass rate | Over the rows with an oracle (`valid`): the upstream fix tests pass after being overlaid on the arm's head. |
| Cost and wall time | Sum of `cost_usd` and `wall_ms`, as in `lightlane-bench.md`. |

Grading is deterministic: the diff paths and added lines, never an LLM. The scorecard records the run date, the model and the corpus revision (`version@base+<hash of the corpus file>`).

## Published scorecard

Scorecards live in `docs/eval/published/adversarial-<date>.md`. Latest: [`adversarial-2026-11-11.md`](published/adversarial-2026-11-11.md) (#5370). If a lane closes an issue as invalid, it never pushes its branch, and the harness grades that as no change.
