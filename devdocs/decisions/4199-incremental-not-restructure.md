---
issue: 4199
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-10-20
---

# Decision: amend #4199. Adopt its parts incrementally; no restructure of the lean path

## Context

#4199 proposed replacing the lean lane (one builder session for plan and implement, then an LLM conformance review) with milestone **Design** → per-issue **Fill** → deterministic **Verify** → risk-triggered **Judge**. Its motivation came from measured waste on two target repos: under 50% first-pass yield, 45–75% second reviewer runs, and $4–7 per run.

## Choice

**Amend.** The operator rule: no structural change that can't be undone in order to get back to current throughput. Each useful part of #4199 ships on the current path behind config, defaulting to today's behaviour, and is kept only if measurement shows it helps:

| #4199 part | Shipped as | Default |
|---|---|---|
| Verify (typed deterministic result, can be a required check) | #4270: `forgedock/verify` check run reporting the existing gates | off |
| Bugs start from a failing repro test | #4271: `repro_test` in the bug contract when testable | prefer, `off` restores today |
| Test map + facts file | #4272: `.forge/test-map.json`, `.forge/repo-facts.json` feeding #4240's pre-PR checks | optional caches |
| Judge only on risk triggers | #4273: deterministic review trigger | shadow; `enforce` only after ≥30 shadow runs |

**Design → Fill (milestone design PR, slot issues, owned files) is not adopted.** It may be piloted on one code-heavy milestone, against a baseline milestone, only after #4270–#4273 have run, using #4199's own success bar: ≥90% first-pass yield, with cost per merged issue and drift no worse than baseline.

## Why not the restructure

- **Not reversible.** It removes investigate, plan and review as separate stages, and replaces per-issue contracts with milestone slots. Reverting would mean rebuilding the current path.
- **ForgeDock's own work is mostly specs, workflows and docs,** where "make these failing tests pass" has no natural contract.
- **File ownership turns overlap into a queue.** Most lanes on 2026-10-19/20 touched `bin/lean/lean.mjs` or `bin/lean/orchestrate.mjs`, so owned files would have run them one at a time.
- **Most work arrives one issue at a time, not as milestones.** In the 2026-10-19/20 run (57 issues), there were no milestone issues at all.
- **One design session concentrates the risk.** A weak or wrong acceptance-test set spreads to every slot.
- **It adds a human approval step per milestone,** against the hands-off direction in #4267.
- **Its waste measurements predate fixes that removed much of that waste:** #4188, #4205, #4216 and #4240. The stalls on 2026-10-19/20 were CI-gate failures (#4240), base-sync conflicts (#4266) and an edit mid-run (#4188), and the restructure fixes none of these.

## Rejected

- **Accept as written.** For the reasons above.
- **Reject outright.** Deterministic verification over LLM review matches the #4149 replay A/B result (reviewer caught 0 real bugs; property checks did), so its parts are worth building.
