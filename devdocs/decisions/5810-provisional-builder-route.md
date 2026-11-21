---
status: fresh
anchor: bin/lean/routing.mjs
created: 2026-11-21
---

# ADR: route the builder tier before the first session

## Context

The builder model tier was chosen at `BUILDER_ROUTE`, after `CONTRACT_FROZEN`. Every session before it (investigation, plan, contract corrections, light build) ran on the top-tier default. On a sample of three lanes these pre-route sessions were about 90% of builder spend, while routing then picked the mid tier for two of the three.

## Decision

Before the first builder session the lane computes a provisional route (`provisionalRoute` in `bin/lean/routing.mjs`) from what the issue already says: the title, the labels and the file paths the body names. It reuses `routeBuilder`'s classes and risk detection. The top tier is kept for a risk word in the title (except the common prose words session/token), a risk label, a risk or declared `review.risk_paths` path, a `size:L` label, more than two named code files, or a prior attempt (resume, salvage, recovery). Everything else, including issues that name no files (class `unscoped`), starts on the mid tier. `BUILDER_PREROUTE` records the class, tier, model and reason.

After the contract, `routeBuilder` still decides the build tier from the deliverables. `floorRoute` keeps a provisional `risk` class on the top tier (no downgrade below risk policy) and adds `pre_tier`, `pre_class`, `change` and `floor` to `BUILDER_ROUTE`. An upgrade only changes the model of later calls. The build resumes the plan session, so no pre-contract work runs twice.

## Consequences

Most pre-contract spend moves to the mid tier. Lanes the contract later routes to the top tier have their plan on the mid tier: the build and every fix round still run on top, and a failed validate round still escalates. `lean.builder_routing: off` keeps every call on the top model, as before. A risk-looking title on a docs-only contract now builds on the top tier, where it used to build on mid.
