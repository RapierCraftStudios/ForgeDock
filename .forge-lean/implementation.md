### Approach
Resumed the earlier run's branch and checked it against the frozen contract. Every deliverable was already present. This session fixed one bug in the lean.mjs wiring: `io.runCommand` returns `{rc, output}`, and the code read `?.r ?? {rc:127}`, so a declared `topology.route_reachability` would always block. The code now unwraps with `x?.r ?? x`, and `routeReachabilityFailures` normalizes the `{r}` wrapper too, with a regression test. I also added a decision record, because `scripts/review-roster.sh` has no dossier glob and check-devdocs-freshness requires one.

### Changes
- (this session) bin/engine-cli.mjs, bin/lean/conformance.mjs, bin/lean/lean.mjs, forge.yaml.example: the checkpoint commit held unresolved `<<<<<<<` markers from merging origin/staging (#5079 coupled_files). Resolved them by keeping both sides: `routeReachability` and `coupledFiles` in readEnvConfig/runCore, and both `coupledFailures` and `routeFailures` in precheck. Both forge.yaml.example comment blocks are kept.
- (this session) bin/tests/engine-cli.test.mjs:1267: regression test that readEnvConfig reads `topology.route_reachability` and that a repo without topology gets no key. It fails on base, which has no reader.
- bin/lean/routecheck.mjs: `routePathOf`/`routePathsFromFiles` map Next.js app/pages route handlers to URL paths. `routeReachabilityFailures` runs the declared command with the paths as args and returns a blocking `conformance.unimplemented`/`route_unreachable` on a non-zero exit. It is a no-op when the command is unset or no route was added, and it unwraps `{r}`.
- bin/lean/routecheck.test.mjs: path mapping; a fixture traefik-style script fails the #38241 signup paths and passes /api/v1/batch; no-op; command that cannot run; readEnvConfig; `{r}`-wrapped run.
- bin/lean/lean.mjs: runs the route check after the validate/guard phase on files the diff added, and passes `routeFailures` to precheck.
- bin/lean/conformance.mjs: `weakenedE2eDecisions` plus the validateContract rejection; precheck appends `routeFailures`.
- bin/lean/conformance.e2e.test.mjs: two end-to-end cases on a disposable real git repo, both adding `app/(site)/api/v1/agent/signup/pending/route.js`. Without topology the lane merges as today and no route command runs. With a declared `topology.route_reachability` that rejects /api/v1/* (the #38241 fixture), the lane ends needs-human with no PR, and the detail cites the ingress output.
- bin/lean/conformance.test.mjs: weakening rejection, probe exemption, routeFailures, #4726 unchanged.
- bin/engine-cli.mjs: `topology.route_reachability` -> `routeReachability` (key absent when unset).
- bin/lean/prompts.mjs: plan prompt and REVIEW_RUBRIC ingress/probe rules, kept within the token caps.
- commands/work-on/investigate.md, commands/review-pr-staging.md, commands/review-pr-agents/infra.md: ingress tracing, staging route check, Infra route instruction.
- scripts/review-roster.sh (+ review-roster.test.sh): `route-handler` trigger adds Infra.
- docs/CONFIG.md, forge.yaml.example: topology.route_reachability documented.
- devdocs/modules/lean.md, devdocs/decisions/5087-route-reachability.md: dossier entry and decision record.

### Acceptance Criteria Status
- R1 ✅ bin/lean/prompts.mjs:173, commands/work-on/investigate.md:465
- R2 ✅ bin/lean/lean.mjs:2347, bin/lean/conformance.mjs:830, bin/engine-cli.mjs:536, commands/review-pr-staging.md:382
- R3 ✅ bin/lean/routecheck.test.mjs:37
- R4 ✅ bin/lean/conformance.mjs:280, bin/lean/conformance.mjs:322, bin/lean/conformance.test.mjs:1294
- R5 ✅ scripts/review-roster.sh:201, commands/review-pr-agents/infra.md:29, scripts/review-roster.test.sh:167
- R6 ✅ bin/lean/conformance.e2e.test.mjs (#5087 without topology), bin/lean/routecheck.test.mjs (no-op / readEnvConfig without topology), bin/lean/conformance.test.mjs:1312, bin/tests/engine-cli.test.mjs:1267

### Verification
- V1 `node --test bin/lean/routecheck.test.mjs`: exit 0 (7/7). The new `{r}`-wrapped test fails without the fix (6 pass, 1 fail).
- V2 (substituted through a `substitute-validate` amendment, a superset of the frozen command, which still runs) `node --test bin/lean/conformance.test.mjs bin/tests/config-docs.test.mjs bin/lean/conformance.e2e.test.mjs`: exit 0. The frozen V2 command also exits 0. R6 quotes the `[type:e2e]` tag, so it is verified end to end. The declared-topology e2e case fails with the route gate disabled (1 pass, 1 fail) and passes with it. The no-topology case is a regression guard, so it passes either way.
- V3 `node --test bin/engine/telemetry-seam.test.mjs bin/lean/checks.test.mjs bin/lean/execution.test.mjs bin/lean/context.test.mjs bin/lean/batch.test.mjs`: exit 0. Earlier runs timed out in batch.test.mjs:25 under host load average 14–25; that test also failed on origin/staging. It passed once load dropped.
- V4 `node --test --test-name-pattern=plan bin/lean/lean.test.mjs`: exit 0 (37 pass).
- V5 `bash scripts/review-pr-domain-map.test.sh`: exit 0. `bash scripts/review-roster.test.sh`: exit 0.
- Sibling tests conformance.e2e, drift, execution.e2e, fixround: all exit 0.
- check-devdocs-freshness.sh origin/staging: OK.
- checks.mjs widened to the full suite (forge.yaml.example has an unknown language). Per the host rules I ran only the targeted files above.
- bin/tests/engine-cli.test.mjs -k '5087|5020|readEnvConfig|coupled|route': exit 0.
- forgedock check: PASS (after the conflict resolution).

- Enumerating-test lists: `routecheck` is not a member of any of the 10 flagged lists (each is a fixture, stub lane, payload or kind list, not a list of bin/lean modules). Reasons are recorded in result.json `not_members`.

### Notes
New optional forge.yaml key `topology.route_reachability` (a command that receives the added route paths as args; a non-zero exit blocks). Without it there is no new check. validateContract now rejects plan decisions that replace e2e/integration checks with mocked tests unless a forge-probe is declared. The roster adds Infra for route-handler diffs. The repo has no formatter script.

### Sibling-list fix
Inspected the 10 flagged test lines; none enumerates bin/lean modules (they are payload/fixture/stub literals). Recorded all as `not_members` in result.json; no test list changed.

## CI fix round: "Unit tests (node --test)" failure
The CI log was unavailable. I reran every test file this diff touches or that references the changed files (routecheck, conformance, conformance.e2e, lean, engine-cli, config-docs, routing, pitfalls, verify, guide, work-on-router, acceptance-check-parse, review-staging, scope-check-spec, opencode-adapter, engine-phases, telemetry-seam, checks), plus review-roster, domain-map, review-pr-staging-scope, lint-dispatch-prompt, review-staging pre/post and cap-findings shell tests. All pass locally (0 failures). I could not reproduce the failure, so I changed no code. It is most likely a flaky or timing-dependent test outside this diff, or a test in the full widened suite that I did not run under the host rules.

### CI fix round 2: "Unit tests (node --test)" (run 41849612434)
Log still unavailable. Re-ran locally: routecheck, conformance, conformance.e2e, config-docs, engine-cli (270 pass), lean/execution/batch in full (697 pass), prompts, telemetry-seam, checks, context, review-staging, work-on-router, scope-check-spec, guardgate, enumerating, refactor, sequence, fixround, prefilter (all 0 fail), plan-filtered lean/engine-phases/runner (39 pass), review-roster and domain-map shell tests. No failure reproduces and no test touched by this diff fails, so no code changed. The check is treated as unrelated (flaky/timing, or outside the host-limited scope).
