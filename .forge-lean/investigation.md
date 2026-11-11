forge-stamp: issue=5428 contract=-
**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: medium (process gate missing; public pages ship without design, SEO/ICP or GEO review)
**Task Type**: feature

### What Was Claimed
Any diff that adds or changes a user-facing route must be blocked unless it has an approved FORGE:DESIGN_SPEC, an SEO intent/ICP brief and a GEO brief in the contract, passes deterministic CI checks (sitemap, metadata, canonical, structured data, link resolution, no raw-JSON/null-sample rendering), and gets `design` + `seo-geo` review domains and a /review-pr-staging block. Config lives in forge.yaml `pages:`, on by default for app repos.

### What We Found
- No page gate exists: `grep -rn "pages:\|pagegate\|seo" bin/lean` finds nothing; `DOMAINS` is `api, auth, database, docs, frontend, infra` (bin/lean/review-trigger.mjs:50 region), no `design`/`seo-geo`.
- FORGE:DESIGN_SPEC is only produced/consumed by /design (commands/design.md:39-41, docs/spec/forge-protocol-v1.md:630); nothing in bin/lean reads it, so #5330 routing is advisory.
- The #5419 docs gate is the exact precedent: bin/lean/docsgate.mjs (parseDocsConfig, userFacingSurfaces, docsFailures), wired at bin/lean/lean.mjs (`docsConfig` option, `docsFailures` beside `routeFailures`, `precheck({docsFailures})` at conformance.mjs:961 region), bin/engine-cli.mjs:568-571 (`readEnvConfig` -> `docsConfig`), prompts.mjs `docsPlanNote`/`DOMAIN_CHECKS.docs`, commands/review-pr-staging.md Phase 1G, docs/CONFIG.md, forge.yaml.example:936.
- Contract validation is `validateContract(c, issueText, {repro})` (conformance.mjs:457), called at lean.mjs:1908/1986/1996 with a correction loop (`contractCorrectionPrompt`); it is the place for the contract-time brief check.
- Route detection helper: routecheck.mjs:15 `routePathOf` handles only route handlers; page files need `app/**/page.*` (docsgate.mjs PAGE_RE) plus `pages.routes` globs.

### Root Cause
The pipeline has no deterministic notion of a "public page" diff and no contract fields/checks for design, SEO or GEO. #5330 only adds routing text, and #5419 covers docs only.

### Affected Files
New bin/lean/pagegate.mjs (+ test); bin/lean/conformance.mjs (validateContract, precheck); bin/lean/lean.mjs; bin/engine-cli.mjs; bin/lean/prompts.mjs; bin/lean/review-trigger.mjs; commands/review-pr-staging.md; commands/review-pr.md; docs/CONFIG.md; forge.yaml.example; devdocs/modules/lean.md.

### Sibling Sweep
Same "advisory, not enforced" class: #5330 design routing, #5419 docs (already enforced). `topology.route_reachability` (routecheck.mjs) is handler-only and does not see pages. No ingress route or prod_parity surface is added (engine-side gate only).

### History
#5419 (52125bf9, e73ec10b) added the docs gate this mirrors; #5330 open (design routing, needs-human); #5087 route reachability. No prior page gate.

### Recommendation
One lane, ~12 files (<25 files / 1500 lines, no split). Mirror docsgate.mjs: a repo-agnostic `pagegate.mjs`, forge.yaml `pages:` (`routes`, `icp_doc`, `require`, `sitemap`, `metadata_patterns`, `forbid_patterns`, `lint`), off when no routes/app pages detected and `pages.enabled: false`; default on only when the repo has Next `app/**/page.*` files. Contract-time: validateContract requires `page_gate` {design_spec, seo, geo} when a deliverable is a page. Lane-time: precheck blocks `page_missing_*` (sitemap, metadata, canonical, structured data, forbidden patterns, internal links) with 0 LLM calls. Design approval is checked by the engine via a FORGE:DESIGN_SPEC comment on the issue (via io.gh), shipped as blocking only under `require: [design]`. Visual check at 390/1440 is a required PR-body/result attachment (`page_gate.screenshots`), verified present, not rendered, in-lane. GSC baseline/measure-by date are contract fields; the measurement itself is a post-deploy/owner item (deferred).

### Related Issues
#5330, #5419, #5087; AlterLab #40527, #40261.
