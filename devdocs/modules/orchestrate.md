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
