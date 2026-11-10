# 5317: delta-review proof comes from the launch manifest

Reviewer hand-off mistakes (short or wrong `Reviewed-SHA`, a launched name that differs from the `FORGE:REVIEW-AGENT` marker) each cost a full review round.

Decision: `forgedock review-staging` pre-dispatch writes `<PR>_review_manifest.json` (head, briefed domains) and generates the launched-agent file from it. `--post-reviewer <domain> --body-file F` writes the marker and full SHA from that manifest and refuses unlaunched domains. `scripts/review-staging-post.sh delivery` classifies each missing reviewer (stale SHA, no findings block, absent) and prints `REDISPATCH <domain>`, which `--finalize` relays so only that reviewer is re-run.

Unchanged: marker regexes, trust rules, the fail-closed panel guard (a shortfall still labels `review-degraded`) and the launched-file format.
