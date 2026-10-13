---
module: orchestrate
glob: "commands/orchestrate*"
authority: required
token_cost: 400
last_compacted: "2026-07-08"
---

# Module Dossier: commands/orchestrate.md

Rolling per-module knowledge log. Each entry is 3–5 lines with a citation.
Hard cap: 150 lines. Entries are appended by close.md Phase C1.7 after each
PR that touches this module. When the file exceeds 150 lines, oldest entries
are compacted into the Summary block below (LLM compaction, in-run).

## Summary

`commands/orchestrate.md` is the parallel multi-issue dispatcher. Key
invariants: Step 4B.7 merged-PR lookup must use issue URL match not bare body
search; the Agent tool is NEVER allowed (use Skill or Task only); batch P3
review findings are grouped by domain before dispatch; background dispatch is
behind a feature gate; stall detection uses FORGE:HEARTBEAT timestamps.

Known failure modes (compacted from historical findings):
- Wrong PR in Step 4B.7: bare body search `--search "${NUM} in:body"` resolves
  wrong PR when multiple issues share a number substring. Use URL match or
  `in:title` scoped search (fixed #1634).
- Agent tool bypass: orchestrate.md has `allowed-tools` that excludes Agent.
  Review agents that use Agent instead of Skill bypass phase protocols
  (see architecture.md Known Pipeline Weaknesses #1383).
- Batch context truncation: CHURN_CONTEXT literal backslash-n in multi-hotspot
  PRs squishes agent prompts; use proper newlines in template strings (#1202).
- Background dispatch gate: background mode is feature-gated; always check gate
  before activating (#1251/#1434).
- FORGE:HEARTBEAT required: stall detector reads heartbeat timestamps; any
  long-running orchestrate phase must post heartbeats (#740).

## Entry 2026-07-08 — feat(memory): module dossiers (#1733)

PR #1733 introduced the module dossier system. `commands/orchestrate.md` was
NOT changed in this PR — this entry seeds the dossier from historical findings.
Key gotcha: Step 4B.7 wrong-PR resolution and Agent-tool bypass are the two
most common regression sites. Cite: #1634, #1383, #1202.

## Entry 2026-07-17 — Fix: quote GH_REPO placeholder in phase-3-dependency.md Layer 1 call site (#2502)

PR #2526 fixed a quoting inconsistency in `commands/orchestrate/phase-3-dependency.md:81`:
`-R {GH_REPO}` was unquoted while the adjacent `"$NUM"` was quoted. Fixed to
`-R "{GH_REPO}"`. Sibling-pattern sweep confirmed unquoted `-R {GH_REPO}` is
still the prevailing convention across the rest of `commands/` — this fix was
intentionally scoped to just this one call site, not a repo-wide requoting
pass. Cite: #2502, PR #2526, PR #2500 (source finding).

## Entry 2026-07-18 — Fix: printf trailing newline in repair guard comment bodies (#2598)

PR #2605 touched `commands/orchestrate/phase-4-execution.md`. See FORGE:BUILDER comment on issue #2598 for full change list.
Key gotcha recorded: `printf '%s\n' "..."` always appends a trailing newline the original inline `--body "..."` string did not have; when staging a body-file for byte-for-byte content parity with a prior inline `--body` argument, use `printf '%s'` (no `\n`) instead. Introduced by #2584/PR #2594's mktemp+--body-file refactor of the Step 4C repair guard.
Cite: #2598, PR #2605.

## Entry 2026-10-07 — Fix: anchor phase-trail markers to comment start (#3181)

PR #3238 touched `orchestrate`. See FORGE:BUILDER comment on issue #3181 for full change list.
Key gotcha recorded: phase-trail F/R marker matches must anchor with startswith, not contains, so quoted markers cannot forge a release.
Cite: #3181 / PR #3238.

## Entry 2026-10-08 — Fix: orchestrator login for trail-marker trust matches posting identity (#3205)

PR #3252 touched `orchestrate`. See FORGE:BUILDER comment on issue #3205 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3205 / PR #3252.

## Entry 2026-10-08 — Fix: orchestrate merged hold writes needs-human label before escalation comment (#3223)

PR #3290 touched `orchestrate`. See FORGE:BUILDER comment on issue #3223 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3223 / PR #3290.

## Entry 2026-10-08 — Fix: orchestrate phase-1-resolve references nonexistent planP3Batches/summarizeP3BatchPlan (#3259)

PR #3294 touched `orchestrate`. See FORGE:BUILDER comment on issue #3259 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3259 / PR #3294.

## Entry 2026-10-08 — Fix: harden orchestrate wake-path release with verified label removal and DRY_RUN guard (#3245)

PR #3281 touched `orchestrate`. See FORGE:BUILDER comment on issue #3245 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3245 / PR #3281.

## Entry 2026-10-08 — Fix: orchestrated workers stall on forked phase completion notifications (#3253)

PR #3299 touched `orchestrate`. See FORGE:BUILDER comment on issue #3253 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3253 / PR #3299.

## Entry 2026-10-08 — Fix: orchestrate wake sweep GATING_PREDS_RAW fail-closed on gh api failure (#3233)

PR #3317 touched `orchestrate`. See FORGE:BUILDER comment on issue #3233 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3233 / PR #3317.

## Entry 2026-10-08 — Fix: add .catch handler to batch-plan dynamic import in orchestrate phase-1 (#3296)

PR #3338 touched `orchestrate`. See FORGE:BUILDER comment on issue #3296 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3296 / PR #3338.

## Entry 2026-10-08 — Fix: verify REREVIEW_DISPATCHED marker write after re-review dispatch (#3411)

PR #3417 touched `orchestrate`. See FORGE:BUILDER comment on issue #3411 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3411 / PR #3417.

## Entry 2026-10-08 — Fix: anchor and trust-filter FORGE:REMEDIATION single-attempt guard marker (#3412)

PR #3422 touched `orchestrate`. See FORGE:BUILDER comment on issue #3412 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3412 / PR #3422.

## Entry 2026-10-08 — Fix: re-review handoff can dispatch duplicate review-pr --auto-merge runs (#3413)

PR #3426 touched `orchestrate`. See FORGE:BUILDER comment on issue #3413 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3413 / PR #3426.

## Entry 2026-10-09 — Fix: re-review claim lease liveness (orchestrate STALE detection) (#3428)

PR #3458 touched `orchestrate`. See FORGE:BUILDER comment on issue #3428 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3428 / PR #3458.

## Entry 2026-10-09 — Fix: re-review earliest-claim ordering depends on implicit API row order (#3429)

PR #3464 touched `orchestrate`. See FORGE:BUILDER comment on issue #3429 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3429 / PR #3464.

## Entry 2026-10-10 — Feat: autonomous merge-only base sync when a PR conflicts with its base (#3496)

PR #3513 touched `orchestrate`. See FORGE:BUILDER comment on issue #3496 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3496 / PR #3513.

## Entry 2026-10-10 — Fix: release re-review claim only after the outcome is settled (#3486)

PR #3552 touched `orchestrate`. See FORGE:BUILDER comment on issue #3486 for full change list.
Key gotcha recorded: re-review claim release must follow outcome settlement (Outcome: SETTLED), else a crash strands the issue.
Cite: #3486 / PR #3552.

## Entry 2026-10-10 — Fix: re-review Step 2 never echoes CLAIM_ID, so own-claim check cannot fire (#3472)

PR #3582 touched `orchestrate`. See FORGE:BUILDER comment on issue #3472 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3472 / PR #3582.

## Entry 2026-10-10 — Fix: helper resolvers (classify-finding / amplification-breaker / extract-affected-files) no longer resolve from $PWD (#3483)

PR #3584 touched `orchestrate`. See FORGE:BUILDER comment on issue #3483 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3483 / PR #3584.

## Entry 2026-10-10 — Fix: exclude workflow:remediating from in-flight filters (review finding — PR #3563) (#3564)

PR #3580 touched `orchestrate`. See FORGE:BUILDER comment on issue #3564 for full change list.
Cite: #3564 / PR #3580.

## Entry 2026-10-10 — Fix: PENDING_DECISIONS queue has no dequeue; stale entries presented (review finding — PR #3507) (#3508)

PR #3614 touched `orchestrate`. See FORGE:BUILDER comment on issue #3508 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3508 / PR #3614.

## Entry 2026-10-11 — Fix: review-pr resolves helper scripts from FORGE_ROOT, not cwd-relative paths (#3596)

PR #3675 touched `orchestrate`. See FORGE:BUILDER comment on issue #3596 for full change list.
Key gotcha recorded: helper scripts must resolve from FORGE_ROOT, never cwd-relative paths after PR checkout.
Cite: #3596 / PR #3675.

## Entry 2026-10-11 — Fix: amplification breaker re-trip never re-enqueues its PENDING_DECISIONS entry (#3621)

PR #3683 touched `orchestrate`. See FORGE:BUILDER comment on issue #3621 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3621 / PR #3683.

## Entry 2026-10-11 — Fix: enqueue_breaker_decision declared in the three breaker trip-site fences (#3690)

PR #3692 touched `orchestrate`. See FORGE:BUILDER comment on issue #3690 for full change list.
Key gotcha recorded: breaker helper must be re-declared per fence (fresh shell per Bash call); `check-spec-bash.sh --fence-funcs` now guards cross-fence function calls.
Cite: #3690 / PR #3692.

## Entry 2026-10-11 — Fix: Layer-1 body-fallback file edges serialize issues whose PRs never touch the file (#3697)

PR #3707 touched `orchestrate`. See FORGE:BUILDER comment on issue #3697 for full change list.
Key gotcha recorded: soft (body-fallback) edges release early only when predecessor PR exists and `gh pr diff` succeeds with no overlap; no PR / error => HOLD, never DROP.
Cite: #3697 / PR #3707.

## Entry 2026-10-11 — convert remaining specs to shared bootstrap stub (#3781)

PR #3794 touched `orchestrate`. See FORGE:BUILDER comment on issue #3781 for full change list.
Cite: #3781 / PR #3794.

## Entry 2026-10-11 — Fix: forge_resolve prefers the running plugin root over newer cache and stale FORGE_HOME (#3801)

PR #3804 touched `orchestrate` (resolver stub line in orchestrate phase specs). See FORGE:BUILDER comment on issue #3801 for full change list.
Key gotcha recorded: the stub sets FORGE_SOURCED_ROOT to the loader-substituted plugin root; forge-resolve.sh must rank it above FORGE_HOME and the newest cache.
Cite: #3801 / PR #3804.

## Entry 2026-10-12 — Feat: close decomposed parents once all sub-issues are done (#3736)

PR #3879 touched `orchestrate`. See FORGE:BUILDER comment on issue #3736 for full change list.
Key gotcha recorded: (update this entry by editing `modules/orchestrate.md` in a follow-up PR if the change revealed a new failure mode).
Cite: #3736 / PR #3879.

## Entry 2026-10-12 — Fix: orchestrate claims-board issues are never closed after batch completion (#3699)

PR #3885 touched `orchestrate`. See FORGE:BUILDER comment on issue #3699 for full change list.
Key gotcha recorded: the claims board must be closed by the batch itself (phase-5) and swept by /cleanup for crashed batches.
Cite: #3699 / PR #3885.

## Entry 2026-10-12 — Fix: Rule 9 over-blocks ref-only git verbs used by cleanup specs (#3873)

PR #3912 touched `orchestrate` (commands/orchestrate/phase-4-execution.md). See FORGE:BUILDER comment on issue #3873 for full change list.
Cite: #3873 / PR #3912.

## Entry 2026-10-13 — fix: base-conflict BLOCKED strands issue (#3516)

PR #4047 touched `orchestrate`. See FORGE:BUILDER comment on issue #3516 for full change list.
Cite: #3516 / PR #4047.
