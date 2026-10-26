---
issue: 4491
status: fresh
anchor: bin/stats/efficiency.mjs
created: 2026-10-25
---

# Decision: a deploy-pivot A/B in `stats --efficiency`, matched on full-shape lanes per size

## Context

#4410 shipped the builder tool-batching rule and its telemetry. #4456 added the re-read nudge. Each deferred its outcome
targets (fewer turns/merge, lower implement wall at equal merge/conformance rates; calls/turn p50 > 1.5; fewer re-reads)
as "post-deploy" to the next issue, ending at #4491. Both changes shipped in v1.32.0 (tag 2026-10-23T16:11:40Z). The
targets were still never measured, because the tooling could not measure them:

- `--efficiency` dropped the attempts' `duration_ms`, so it had no implement wall.
- It had only trailing windows ending now, with no before/after split.
- It had no merge or conformance rate per scope.
- The per-issue GitHub crawl had no off switch and took more than 280 s per repo.
- `--repo` matched batch plans case-sensitively, so `rapiercraftstudios/forgedock` found 0 batches.

## Choice

- **Pivot A/B by batch `plan.created`:** `--compare <date|version>` splits the repo's batches into post = [pivot, now]
  and pre = the same span ending just before the pivot, so the two cohorts are equally long. It reuses the `--window`
  row and settle logic (one cohort definition) and resolves a version to its exact tag time.
- **Matched cohort:** the comparison is repeated on full-shape merged lanes per size bucket present on both sides. Light
  lanes (#4452) cut turns/merge on their own, and merged rows with no run log carry 0 turns, so the unmatched delta mixes
  the lane mix into any prompt or tool change.
- **New per-scope figures:** implement wall p50 (summed implement `duration_ms`), merge rate (merged ÷ rows), and
  conformance pass (last `CONFORMANCE` verdict of each row that has one).
- **`--offline`:** passes `gh=null`, which `computeScope` already handles, so the A/B needs only local run logs.
- **Case-insensitive `--repo`** in `--efficiency` and `--pool`. Run logs are read under the plans' spelling.

## Rejected

- **Matching individual issues by hand.** It is not reproducible, and NORTHSTAR asks for deterministic, fact-based
  matching. The size bucket and lane shape are already logged facts.
- **A trailing-window-only comparison** (7d before the tag vs since). The two windows are unequally long and have to be
  scripted outside the tool. That is how the investigation measured, and why it could not be rerun.

## Measured results (pivot v1.32.0, `--offline`, 1.8 days each side, run 2026-10-25)

ForgeDock (pre 7 batches, post 3):

```
compare pre: n=52 turns/merge 51.4, implement wall p50 9.2 min, calls/turn p50 1.02, re-reads/merge 2.00, merge rate 84%, conformance pass 73%
compare post: n=25 turns/merge 9.4, implement wall p50 8.9 min, calls/turn p50 1.02, re-reads/merge 2.33, merge rate 64%, conformance pass 50%
compare delta: turns/merge -42.0, implement wall p50 -0.4 min, calls/turn p50 0.00, re-reads/merge +0.33, merge rate -20 pts, conformance pass -23 pts
compare matched L: pre n=3 post n=3; delta turns/merge -10.0, implement wall p50 +5.5 min, calls/turn p50 0.00, re-reads/merge +0.33
compare matched M: pre n=10 post n=2; delta turns/merge -16.5, implement wall p50 -1.7 min, calls/turn p50 0.00, re-reads/merge -0.90
compare matched unknown: pre n=38 post n=1; delta turns/merge +10.4, implement wall p50 +19.8 min, calls/turn p50 n/a, re-reads/merge n/a
```

causedeck (pre 11 batches, post 21):

```
compare pre: n=23 turns/merge 91.6, implement wall p50 13.3 min, calls/turn p50 1.02, re-reads/merge 0.25, merge rate 47%, conformance pass 54%
compare post: n=31 turns/merge 18.1, implement wall p50 11.7 min, calls/turn p50 1.02, re-reads/merge 1.71, merge rate 41%, conformance pass 44%
compare delta: turns/merge -73.5, implement wall p50 -1.6 min, calls/turn p50 0.00, re-reads/merge +1.46, merge rate -6 pts, conformance pass -10 pts
compare matched L: pre n=4 post n=6; delta turns/merge +26.7, implement wall p50 +1.4 min, calls/turn p50 0.00, re-reads/merge +1.42
```

AlterLab (pre 18 batches, post 6):

```
compare pre: n=117 turns/merge 79.3, implement wall p50 18.1 min, calls/turn p50 1.04, re-reads/merge 4.21, merge rate 60%, conformance pass 70%
compare post: n=4 turns/merge 30.0, implement wall p50 5.5 min, calls/turn p50 1.04, re-reads/merge 6.00, merge rate 57%, conformance pass 100%
compare delta: turns/merge -49.3, implement wall p50 -12.6 min, calls/turn p50 0.00, re-reads/merge +1.79, merge rate -3 pts, conformance pass +30 pts
compare matched L: pre n=15 post n=1; delta turns/merge +10.8, implement wall p50 -14.8 min, calls/turn p50 0.00, re-reads/merge +0.47
```

Reading: the large unmatched turns/merge drop is mostly lane mix (light lanes). The matched cohorts are small (post n of
1 to 6 per bucket) and point both ways, and merge and conformance rates are not equal across the pivot on ForgeDock and
causedeck. The R4 claim ("fewer turns, lower wall at equal rates") is therefore not shown yet. The instrument is now in
place to rerun it as post-pivot batches accumulate:
`forgedock stats --efficiency --compare v1.32.0 --offline --repo <r>`.

## Deferred as behaviour work (R5, R6)

- **Calls/turn p50 > 1.5 (R5):** implement-session calls/turn p50 is 1.00 both before (n=139) and after (n=354) v1.32.0;
  p90 is 1.08 and the max is 1.33. Raw transcripts confirm the metric (`bin/lean/toolstats.mjs`, `bin/runner.mjs`). The
  #4410 prompt rule did not change builder batching, so moving it needs a different mechanism or a revised target.
- **Re-reads drop (R6):** re-reads/merge went ForgeDock 2.00 → 2.33, causedeck 0.25 → 1.71 and AlterLab 4.21 → 6.00; the
  per-session mean went 0.48 → 0.54. The nudge does fire (its text is in 68 of the 300 most recent lane transcripts) but
  does not reduce re-reads. A stronger intervention is separate work.

Both are measured and unmet. Re-deferring them as "post-deploy" a third time would be a gate that never resolves
(NORTHSTAR non-negotiable 4), so they are deferred as behaviour work, to be judged on this A/B.
