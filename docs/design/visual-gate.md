# Visual gate at `review-pr-staging` (forge#5330, forge#5369)

Opt-in per repo through forge.yaml `design.routes` (see [`docs/CONFIG.md`](../CONFIG.md) `design`). With `design.routes` unset the gate is skipped and the review behaves as before. This is Phase 1I of `commands/review-pr-staging.md`. It is the same gate the lane precheck runs (`bin/lean/design-gate.mjs` `visualGate`); `scripts/visual-gate.mjs` is a thin CLI over it, so there is one implementation.

## Procedure

1. List the bundle's routes. `git diff --name-only origin/$DEFAULT_BRANCH...origin/$STAGING_BRANCH > "$FILES"`, then `node "$FORGE_ROOT/scripts/visual-gate.mjs" --list --files-file "$FILES" --root .`. The JSON names every new or changed user-visible route (`design.routes` minus `design.exclude`) and the `viewports` (default 390 and 1440). No routes: `Visual gate: PASS (no routes)`.
2. Resolve each route's spec. Find the issue that added it (the merged PR's `Closes #N`); it has a spec when a non-draft `FORGE:DESIGN_SPEC` comment or the `design.spec_label` label (default `design:approved`) exists. Write `{"<route>": true|false}` to `$SPECS`.
3. Render and critique. Render each route at every viewport with the Playwright MCP (read-only; `design.directions_param` selects a variant), save screenshots as `$RUNTMP/visual/<route>-<width>.png`, and run the `design-render-critique-loop` skill against the route's spec, one iteration, for the verdict `PASS`, `ITERATE` or `BUDGET-EXHAUSTED`. Write `{"<route>": {"screenshots": [...], "verdict": "..."}}` to `$EVIDENCE`. With no browser, record that and leave the route out: with `design.require_visual_check: true` the missing evidence is a finding. A review reports, it never edits the page.
4. Judge. `node "$FORGE_ROOT/scripts/visual-gate.mjs" --files-file "$FILES" --root . --specs-json "$SPECS" --evidence "$EVIDENCE" --comment` prints the `FORGE:VISUAL_GATE` comment (route, file, screenshot paths, critique verdict, findings); post it on the staging PR. Exit codes: `0` PASS, ADVISORY or SKIP; `1` FAIL.

## Findings

| Kind | Meaning |
| --- | --- |
| `design_spec_missing` | a page entry with no approved design spec |
| `visual_screenshots_missing` | no screenshot at one of the `viewports` |
| `visual_critique_missing` | no render-critique verdict for the route |
| `visual_critique_failed` | a verdict other than `PASS`, or the deterministic source critique found an empty or label-only box, placeholder copy or a null sample, or a text-only page (an `h1` with no component, media or background) |

With `design.gate: blocking` every finding is a BLOCKER (`Visual: <route> <kind>`) and the review posts `FORGE:GATE_FAILURE`. With `advisory` the same findings are reported and the gate never fails.

## Regression fixture

`bin/lean/design-gate.test.mjs` and `bin/lean/visual-gate.test.mjs` hold the fixture from the 2026-11-09 Hands pages: a plain-text hero (`h1` and prose), empty Needs/Evidence/Action boxes and a bare "Get access" link. A bundle adding it fails the gate; a page with a component hero, filled cards and a real button passes.
