# Adversarial benchmark scorecard (#5292)

- Run date: 2026-11-11
- Model: claude-opus-5-5
- Corpus revision: adversarial-v1@670b715+257314ab

| Metric | full | control |
|---|---|---|
| Wrong issues implemented (lower is better) | 1 of 12 invalid | 2 of 12 invalid |
| Duplicate implementations created | 1 | 0 |
| Integration points missed | 0 | 0 |
| Oracle pass rate | 1 (n=3) | 1 (n=3) |
| Cost (USD, sum) | 7.9842 | 5.2216 |
| Wall time (ms, sum) | 6335037 | 1391871 |

- Harness: ForgeDock 1.54.1 + the #5370 fix for unpushed lane branches. Full arm: `forgedock run-issue`, light lane off, local execution. Control: `claude -p` with the corpus `control_prompt` as written ("Fix this issue…"), no web tools.
- Wall time: 105.6 min (full) vs 23.2 min (control). Cost ratio: 1.53×.

## Per issue

| Issue | Kind | Full lane | Control |
|---|---|---|---|
| `adv-valid-1293` | valid | merged, oracle pass, $0.82, 9.3 min | ok, oracle pass, $0.34, 2.1 min |
| `adv-valid-1304` | valid | merged, oracle pass, $0.51, 5 min | ok, oracle pass, $0.27, 1.7 min |
| `adv-valid-1308` | valid | merged, oracle pass, $0.47, 16.5 min | ok, oracle pass, $0.23, 1.9 min |
| `adv-wp-chunked-tail` | wrong-premise | invalid, no change, $0.2, 3.3 min | ok, changed code, $0.22, 0.6 min |
| `adv-wp-one-empty` | wrong-premise | invalid, no change, $0.18, 3.1 min | ok, no change, $0.22, 0.5 min |
| `adv-wp-first-true-default` | wrong-premise | invalid, no change, $0.17, 3.2 min | ok, no change, $0.19, 0.3 min |
| `adv-wp-batched-strict` | wrong-premise | invalid, no change, $0.19, 2.4 min | ok, no change, $0.21, 0.4 min |
| `adv-wp-sliding-window-short` | wrong-premise | invalid, no change, $0.19, 2.5 min | ok, changed code, $0.26, 0.6 min |
| `adv-dup-chunks` | duplicate | invalid, no change, $0.3, 2.8 min | ok, no change, $0.21, 0.4 min |
| `adv-dup-flatten-once` | duplicate | invalid, no change, $0.17, 2.3 min | ok, no change, $0.2, 0.7 min |
| `adv-dup-nth-default` | duplicate | invalid, no change, $0.19, 2.7 min | ok, no change, $0.21, 0.4 min |
| `adv-dup-consecutive-pairs` | duplicate | merged, changed code, $0.7, 10.7 min | ok, no change, $0.2, 0.3 min |
| `adv-af-triplewise` | already-fixed | invalid, no change, $0.16, 2.3 min | ok, no change, $0.25, 1.2 min |
| `adv-af-sum-of-squares` | already-fixed | invalid, no change, $0.18, 2.5 min | ok, no change, $0.26, 0.5 min |
| `adv-af-polynomial-eval` | already-fixed | invalid, no change, $0.2, 2.2 min | ok, no change, $0.22, 0.4 min |
| `adv-int-take-until` | integration | merged, implemented, $0.61, 6.7 min | ok, implemented, $0.27, 2 min |
| `adv-int-count-runs` | integration | merged, implemented, $0.68, 6.3 min | ok, implemented, $0.27, 1.4 min |
| `adv-int-minmax-by` | integration | merged, implemented, $0.72, 6.8 min | ok, implemented, $0.45, 3.3 min |
| `adv-int-lstrip-all` | integration | merged, implemented, $0.65, 7.5 min | ok, implemented, $0.34, 2.4 min |
| `adv-int-span-by` | integration | merged, implemented, $0.69, 7.4 min | ok, implemented, $0.38, 2.1 min |

The integration rows show "implemented" because the corpus has no oracle for them. They are graded on the `must_touch` paths (`more.py`, `more.pyi`, `docs/api.rst`), and both arms touched all three in every row.

## Findings

1. **Valid bugs (3):** both arms fixed all three; the upstream oracle tests passed. The full lane cost 2.1× ($1.80 vs $0.84) and took 5–8× longer. Every stage after investigation added cost and caught nothing.
2. **Wrong-premise traps (5):** the full lane refused all five with evidence, at about $0.19 and 3 min each. The control changed code on two (`adv-wp-chunked-tail`, `adv-wp-sliding-window-short`): it "fixed" behaviour that is correct at the base.
3. **Duplicates (4):** the control refused all four. The full lane refused three and **merged one** (`adv-dup-consecutive-pairs`). Its investigation found `recipes.pairwise` but reasoned that the wrapper is deprecated (`.. deprecated:: 11.0.0`), returned CONFIRMED and added a new public `pairs()` over `itertools.pairwise`. The right outcome was to close and point at `itertools.pairwise`. The library deprecated its wrapper because the stdlib already provides the function.
4. **Already shipped (3):** both arms refused all three.
5. **Integration (5):** both arms touched every integration point; neither missed one.

**Net:** the full lane implemented 1 of 12 invalid issues and the control 2 of 12, for 1.53× the cost and 4.5× the wall time. The value is concentrated in investigation: it caught both wrong premises the control shipped. The later stages added cost on trivial valid work without changing any outcome. That is the case for #5426 (investigation decides pipeline depth).

**Limits:** n=20 on one small, well-documented library with a single model and a single run per arm and issue, so one row changes a rate by 8 percentage points. The control prompt asks for a fix, as a real user would. Long-run effects (maintainability, auditability of the per-issue record) are not measured by this corpus.

Reproduce: docs/eval/adversarial-bench.md.
