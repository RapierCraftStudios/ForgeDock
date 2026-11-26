# Gate inventory and proposal table: 2026-11-26 (phase 1 of #6083)

Phase 1 of the subtraction epic (#6083): inventory every blocking rule, attach what the register can measure, and propose
keep / advisory / delete. **Nothing is removed or demoted by this change.** The owner approves the cut list (product
decision) before phase 2 applies it and measures the release (#6084).

Spine kept by every option below: spec in (frozen requirements + acceptance), evidence out (tests/CI), trace (contract,
decisions, `FORGE:LANE_AUDIT` #6072, version).

## 1. Data and its coverage

Source: `node scripts/failure-census.mjs --repo RapierCraftStudios/ForgeDock --since 2026-11-20 --limit 60 --no-batches --json`
(read-only; the same method as [pipeline-failure-classes](2026-11-26-pipeline-failure-classes.md)).

| Measure | Value |
|---|---|
| Issues sampled (with comments, updated since 2026-11-20, newest 60) | 60 |
| Issues with at least one park | 15 |
| Parks (NEEDS_HUMAN/PARKED comments) | 36 (1 repeat of an identical row) |
| Base-syncs / conflicted files | 24 base-syncs; `devdocs/modules/lean.md` 12, `bin/lean/orchestrate.mjs` 8, `.forge/post-deploy-checks.json` 3 |
| Amendments filed | `add-deliverable` 50 (30 forced by another gate), `defer` 10, `amend-requirement` 8, `post-deploy` 2 |

Park classes in the sample: `ci_red` 12 (9 issues), `omission_narrowed` 10 (5), `other` 5 (3), `amendment_syntax` 3 (1),
`substitute_validate` 3 (1), `builder_blocked` 2 (1), `recurrence_design` 1 (1).

Coverage limits (read before trusting a number):
- The census classifies a park by its comment text into a **class**, not into a rule id. Parks are therefore attributed per
  class, and a class maps to one or several rules below. A per-rule park count needs the `kind` on each park row, which the
  comments do not carry in a stable form.
- No local batch logs exist on this host (`~/.forge/batches` absent), so deferral codes, resumes and cost per rule are
  **unmeasured** here. They are marked `n/m`. `release gates` (`bin/lean/release-gates.mjs`) records runs/fails/FB share/minutes
  for the deploy gates only, and no `.forge/gates.yaml` data was available in this sandbox.
- "True catch" (a park whose fix changed behaviour or prevented a revert) is not derivable from the comment text. It is
  marked `n/m` unless the rule is a direct test/CI failure (the failing run is itself the defect signal).
- The sample is one week (20-26 Nov), which includes the five-release burst described in the failure-classes dossier.

## 2. Inventory of blocking rules

Line numbers are on the base ref of this change. "Mode now" is from `ADVISORY_KINDS` / `ADVISORY_CODES`
(`bin/lean/conformance.mjs:2061-2070`): rows listed there are already reported, never blocking.

### 2.1 Conformance precheck (`precheck`, `bin/lean/conformance.mjs:1191`)

| ID | Kind | file:line | Mode now | Parks (class, sample) | True catches | Resumes / cost | Proposal |
|---|---|---|---|---|---|---|---|
| G1 | `check_unknown` | conformance.mjs:1197 | advisory | 0 | n/m | n/m | keep advisory |
| G2 | `e2e_placement` | conformance.mjs:1201 | block | 0 in sample | n/m | n/m | keep (stops spending resumes on a row the lane cannot produce; fails fast) |
| G3 | `ui_browser_unverified` | conformance.mjs:1206 | block | 0 in sample | n/m | n/m | keep, high-risk UI only |
| G4 | `scope_creep` | conformance.mjs:1210 | advisory | 0 (30 `add-deliverable` amendments forced by another gate) | n/m | n/m | keep advisory; consider deleting the file-list freeze (see 3) |
| G5 | `validate_command_invalid` | conformance.mjs:1216, 1238, 1239 | block | part of `substitute_validate` 3 | frozen command defect, not the change | n/m | advisory-to-repair: engine should probe at freeze and substitute, not park (#5749) |
| G6 | `substitute_unverified` | conformance.mjs:1217, 1222 | block | `substitute_validate` 3 (1 issue) | n/m | n/m | delete: a substitute is checked by running the same ids; the extra shape checks only park |
| G7 | `substitute_removed_path` | conformance.mjs:1219 | block | within `substitute_validate` | n/m | n/m | keep (guards against replacing a check by deleting its target) |
| G8 | `validate_failed` | conformance.mjs:1225, 1251 | block | `ci_red` 12 (9 issues) | yes: a failing validate is the defect signal | n/m | keep (spine: evidence out) |
| G9 | `validate_timeout` | conformance.mjs:1226, 1243 | env | 0 | none (host load) | n/m | keep as env, never a park of the change |
| G10 | `validate_missing` | conformance.mjs:1234 | block | n/m | none by itself | n/m | keep (no evidence, no merge) |
| G11 | `validate_env` | conformance.mjs:1248 | env | n/m | none (environment) | n/m | keep as env |
| G12 | `validate_drift` | conformance.mjs:1250 | block, base-sync recovery | n/m | none (stale artifact) | n/m | keep (mechanical recovery) |
| G13 | `requirement_unimplemented` | conformance.mjs:1261, 1264 | block | `omission_narrowed` 10 (5 issues) and "no status" rows | yes for real omissions; false parks when a deferred row is judged | n/m | keep (spine: requirements covered) |
| G14 | `untracked_deferral` | conformance.mjs:1263 | block | within `omission_narrowed` | n/m | n/m | advisory: the engine can file the typed amendment itself |
| G15 | `decision_unsuperseded` | conformance.mjs:1171 | block | 0 in sample | n/m | n/m | keep (interface decisions) |
| G16 | `repro_env` | conformance.mjs:1320 | env | n/m | none | n/m | keep as env |
| G17 | `repro_base_green` | conformance.mjs:1331 | block | n/m | yes (test does not fail on base) | n/m | keep (bug lanes) |
| G18 | `repro_red_green` | conformance.mjs:1333 | block | n/m | yes | n/m | keep (bug lanes) |
| G19 | `repro_mutation_survivor` / `mutation_survived` | conformance.mjs:1340, 2138 | block | n/m | n/m | n/m | advisory until a catch rate exists |
| G20 | `source_deliverable_untouched` | conformance.mjs:1355 | block | n/m | n/m | n/m | keep (a deliverable the diff never touched) |
| G21 | `hotspot_growth` | conformance.mjs:1387 | advisory | 0 | n/m | n/m | keep advisory |
| G22 | `e2e_row` (review row) | conformance.mjs:1731, 1734 | block | n/m | n/m | n/m | keep (no mocked e2e) |

### 2.2 Contract validation (`bin/lean/conformance.mjs`)

| ID | Rule | file:line | Mode now | Parks | True catches | Proposal |
|---|---|---|---|---|---|---|
| G23 | `test_plan.mock` / `.echo` / `.proof` / `.level` (and the rest of `TEST_PLAN_RULES`) | conformance.mjs:529-530 (rule ids), 532-534 (per-rule counts, `CONTRACT_INVALID_RULES` telemetry lean.mjs:2692) | block | n/m (telemetry exists per rule; not in comments) | n/m | advisory pending per-rule false-park rate from `CONTRACT_INVALID_RULES` |
| G24 | frozen file-list and guessed validate commands | contract freeze | block via G4/G5 | `add-deliverable` 50 amendments, 30 forced by another gate | none: the list is a guess | delete from the freeze: freeze requirements and acceptance only (issue step 3) |
| G25 | `amendment_invalid` | conformance.mjs:2062-2070 | advisory | `amendment_syntax` 3 (1 issue) | none | keep advisory |

### 2.3 CI gate (`bin/lean/ci-gate.mjs`)

| ID | Kind | file:line | Mode now | Parks | Proposal |
|---|---|---|---|---|---|
| G26 | `ci_budget_annotation_invalid` | ci-gate.mjs:144 | block | n/m | advisory |
| G27 | `ci_budget_unannotated` | ci-gate.mjs:145 | advisory | n/m | keep advisory |
| G28 | `ci_hygiene` | ci-gate.mjs:155 | block | n/m | keep (concurrency/timeout on new jobs) |
| G29 | `ci_budget_exceeded` | ci-gate.mjs:192, 193 | block when over a configured cap | n/m | keep (cap is configured) |

`bin/lean/ci-precheck.mjs` is not a blocking rule set: it selects the jobs to run locally (lines 114-128 only record `skipped`/`unrunnable`).

### 2.4 Other gates

| ID | Rule | file:line | Mode now | Proposal |
|---|---|---|---|---|
| G30 | `docs_missing` / `docs_link_broken` | docsgate.mjs:85, 94, 99 | advisory | keep advisory |
| G31 | `guard_broken` | guardgate.mjs:253 | block | keep (a regression guard that fails is a defect signal) |
| G32 | `design_spec_missing`, `visual_critique_*`, `visual_screenshots_missing` | design-gate.mjs:118-128 | block when the gate is configured | keep, repo opt-in |
| G33 | `page_*` metadata/sitemap/canonical/structured-data | pagegate.mjs (kinds at `ADVISORY_KINDS`) | advisory | keep advisory |
| G34 | review rows and env/sandbox guards (tool gap parks "Remote sandbox lacks `<tool>`") | `ENV_SIGNATURES` conformance.mjs:901; tool-gap recipes #6017/#6018 | env | keep as env; measured at ~36% of parks in the failure-classes dossier, owned by #6018/#6017 |
| G35 | Release gate catalogue | release-gates.mjs (`.forge/gates.yaml`) | block / demote on FB rate | keep; it is the one place with a per-gate false-block rate (#5583) |

## 3. Proposal summary (for owner approval; nothing applied)

| Proposal | Rules | Reason |
|---|---|---|
| **Keep (blocking)** | G2, G3, G7, G8, G10, G12, G13, G15, G17, G18, G20, G22, G28, G29, G31, G32, G35 | They fail on a real defect signal (failing run, missing evidence, unimplemented requirement) or are opt-in by repo config |
| **Keep (env, never a park of the change)** | G9, G11, G16, G34 | Infrastructure, not a defect of the lane |
| **Keep advisory (already)** | G1, G4, G21, G25, G27, G30, G33 | Already in `ADVISORY_KINDS`/`ADVISORY_CODES`; no new data argues for blocking |
| **Move to advisory** | G14, G19, G23, G26 | No measured catch; each parks or can be repaired by the engine |
| **Delete** | G6, G24 | G6 duplicates the run comparison; G24 (guessed file list) caused 30 forced `add-deliverable` amendments and has no catch |

Decision rule used: catches > parks keep; otherwise advisory; otherwise delete. Where a catch count is `n/m`, the proposal is
the conservative one (advisory, not delete) and phase 2 must collect the count before removal.

## 4. Open items for phase 2 (#6084)
- Add the rule `kind` to the park comment so the census attributes parks per rule instead of per class.
- Re-run the census on a host with `~/.forge/batches` to fill the `n/m` cells (resumes, cost, deferral codes).
- After owner approval: apply the cut list, then publish the replay-bench scorecard vs the previous release and a plain-agent baseline.
