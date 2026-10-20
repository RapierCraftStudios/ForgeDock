---
issue: 4161
status: fresh
anchor: bin/lean/drift.mjs
created: 2026-10-20
---

# Decision: milestone drift summed from merged lanes, recomputed from git, filed from a template

## Context

Each lane is reviewed against its own contract, so drift across a milestone stays invisible until `/review-pr-staging` runs at deploy time. Examples: one app→domain import pair growing across six PRs, a package growing past 10k lines, a pattern copied by later lanes. The merged lanes already compute the structure delta (#4165). Nothing totals it.

## Choice

- **Summary:** the lane result carries the merge-time `structure` record. `orchestrate` folds it, keyed by PR, into a `<!-- FORGE:DRIFT {json} -->` block in the GitHub milestone description. GitHub stays the register, a resume reads the summary back, and the text around the block is untouched.
- **Facts from git:** `scripts/milestone-drift.sh` reruns `structure-delta.sh` and one `git diff --numstat` from the fork point to the milestone head. The report is therefore exact even when a lane merged outside orchestrate. The summary only adds the PRs behind each pair.
- **Filing:** with `orchestrate.drift` thresholds, it files one issue per crossing (value greater than threshold) in the milestone. The body is a template with the numbers, files and PRs. Issues are deduplicated by a `FORGE:DRIFT:<slug>:<kind>:<key>` marker against the milestone's open issues, plus the markers filed earlier in the same process.
- **Hold:** `block_dispatch` is opt-in and holds only same-milestone queued issues whose Affected Files sit under a flagged package dir. The flags are in memory, so a resumed batch rebuilds them on the next merge.

## Rejected

- **A tracker issue comment for the summary.** That needs a tracker issue per milestone. The milestone description already exists and is where FORGE:MILESTONE_INDEX lives.
- **An LLM-written issue body.** The template carries every fact, and NORTHSTAR's deterministic-first rule applies.
- **Running review-pr-staging's cross-PR panel in milestone-diff mode.** That is a full LLM panel per checkpoint.
- **Churn (`lines × commits_90d`) here.** The scope comment asks to reuse `scripts/hotspots.sh` (#4195), which has not landed. Reimplementing it would fork that logic.

## Cost

- 0 LLM calls.
- Per merged milestone lane: +2 gh calls (milestone list GET and description PATCH; no PATCH when the PR is already folded).
- With thresholds: also 2 `git fetch`, one local script run (about 1 s), and one `gh issue list` plus one create per new crossing, only when something crosses.
- Staging lanes: 0.
