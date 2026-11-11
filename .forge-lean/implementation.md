forge-stamp: issue=5428 contract=f92e5c678bd6
### Approach
Mirror the #5419 docs gate: a pure repo-agnostic module `bin/lean/pagegate.mjs`, config parsed in `readEnvConfig`, a contract-time check in `validateContract` and lane-time rows in `precheck`. 0 LLM calls.

### Changes
- bin/lean/pagegate.mjs (+ pagegate.test.mjs): `parsePagesConfig`, `pageFiles`, `contractBriefProblems`, `pageFailures`, `designSpecApproved`.
- bin/lean/conformance.mjs: `validateContract({pages})` appends brief problems; `precheck({pageFailures})`.
- bin/lean/lean.mjs: `pagesConfig` option, plan note, contract validation, `pageFailures` beside docs, domains.
- bin/engine-cli.mjs: `pagesConfig` from forge.yaml `pages:`, default on if the repo tracks `app/**/page.*`.
- bin/lean/prompts.mjs: `pagePlanNote`, `DOMAIN_CHECKS.design` and `["seo-geo"]`.
- bin/lean/review-trigger.mjs: `design`/`seo-geo` domains via `pathDomains({pages})`.
- commands/review-pr-staging.md (1H), commands/review-pr.md, docs/CONFIG.md, forge.yaml.example, devdocs/modules/lean.md; conformance.test.mjs wiring test.

### Acceptance Criteria Status
- R1 ✅ pagegate.mjs:1-10, lean.mjs precheck wiring
- R2 ✅ pagegate.mjs `designSpecApproved`/`page_design_missing`
- R3 ✅ pagegate.mjs `page_visual_missing` (390/1440 screenshot refs in result)
- R4 ✅ pagegate.mjs `contractBriefProblems` (intent, icp, icp_doc)
- R5 ✅ same (title/h1/meta/structured_data/links)
- R6 ✅ same (gsc_baseline, measure_by)
- R7 ✅ same (geo.surfaces, agent_question)
- R8 ✅ `page_sitemap/metadata/canonical/structured_data_missing`
- R9 ✅ `page_link_broken`
- R10 ✅ `page_forbidden_pattern`, `pages.lint`
- R11 ✅ review-trigger.mjs, prompts.mjs, review-pr-staging.md 1H, review-pr.md
- R12 ✅ engine-cli.mjs readEnvConfig, docs/CONFIG.md, forge.yaml.example
- R13 ✅ pagegate.test.mjs "replay at contract time" and "replay at CI"

### Verification
- V1 `node --test bin/lean/pagegate.test.mjs docsgate.test.mjs conformance.test.mjs` pass (with V2 together: 241 pass, 0 fail); new tests fail without the module (import missing).
- V2 review-trigger.test.mjs pass.
- V3 `node --check` on pagegate, lean, engine-cli: ok.
- `forgedock check`: PASS. No formatter is configured in this repo.

### Notes
Off for repos without Next page files. GSC baseline capture/measurement is owner work (decision K4); screenshots are checked as references, not rendered. A generated sitemap is justified via `page_gate.sitemap_justification`.

### Enumerating-test follow-up
Seven tests flagged as listing siblings of `pagegate` (telemetry-seam, batch-health, batch, checks, ci-budget, conformance.e2e, drift). None contains a list of gate modules; `pagegate` is not a member of any. Recorded under `not_members` in result.json.

Reverted stray 'pagegate' edits to bin/auth/app-token.test.mjs and bin/lean/context.test.mjs (no such symbol/source).
