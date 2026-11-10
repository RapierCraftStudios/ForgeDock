# Production hotfix audit, AlterLab, 2026-10-11 → 2026-11-10

This is the count behind the README's "production defects traced to a pipeline lane" line. AlterLab is a private repository, so the PR and issue numbers below are AlterLab-internal references and are not linked.

## Method

1. Every run of AlterLab's emergency hotfix workflow in the window (30 runs) was grouped by branch into 19 efforts, then merged into 17 incidents where several branches fixed one problem.
2. Each incident was classified as a **defect fix**, **not a defect** (credential rotation, workflow noise, feature delivery) or a **restore** caused by the hotfix process itself.
3. For each defect, the introducing change was found from issue bodies, FORGE annotations, PR descriptions and `git log -S` / `git blame` on the fixed lines.
4. Origin was decided from branch naming (`feat|fix/issue-N-lean`) and FORGE pipeline annotations. The GitHub App author alone was not treated as proof, because interactive sessions on that host also push as the App.

## Result

| Kind | Count |
|---|---|
| Real production defects | 12 |
| Not a defect (credential rotation, zero-job workflow noise) | 3 |
| Restores caused by the hotfix process | 2 |

Origin of the 12 defects:

| Origin | Count |
|---|---|
| ForgeDock lane | 8 |
| Hand-built in an interactive session | 2 |
| Pre-existing (8 months old) or external vendor behaviour | 2 |

Same window: 2,498 merged PRs, so lane-originated production defects ≈ 8 / 2,498 ≈ **3.2 per 1,000 merged PRs**. Two of the eight are inferred from branch naming only (medium confidence); the other six are confirmed from FORGE records.

## What the eight lane defects had in common

| Pattern | Defects | Tracked |
|---|---|---|
| Conformance review ran in shadow mode (it said "would pass" on one of them); feature→staging merges run no CI in this repo by policy | 6 merged in one 2-day burst | [#5283](https://github.com/RapierCraftStudios/ForgeDock/issues/5283) |
| The checks never exercised a production-only difference: rendering runtime mode, ingress routing, database role/ownership, environment-file scope | 4 | [#5284](https://github.com/RapierCraftStudios/ForgeDock/issues/5284) (extends #5087, which covered ingress routing) |
| Shipped enabled while live acceptance was deferred; UI changes tested only with mocks or jsdom | 2 lane + 2 hand-built | [#5285](https://github.com/RapierCraftStudios/ForgeDock/issues/5285) |

The hotfix workflow itself also caused noise: successful hotfixes ended red because a final step could not open a backport PR. That is a repository setting issue in AlterLab, not a pipeline defect, and it is tracked there.

## Caveats

- One repository, one month. This is a production data point, not a benchmark.
- "Defect" means it needed a production hotfix. Bugs fixed through the normal release path are not counted here; neither are defects the release review caught before shipping.
- Cost figures in the README are API-equivalent lane costs from each issue's recorded `cost` line (375 of the latest 400 completed issues carried one); orchestration and release-review sessions are not included.
