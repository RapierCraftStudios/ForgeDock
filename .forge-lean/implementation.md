### Approach
The branch already carried the full implementation; this session re-verified it against the frozen contract and added nothing new.

### Changes
- bin/stats/card.mjs: buildCard, Markdown and SVG renderers (aggregate-only, repo name opt-in, estimate label, attribution footer).
- bin/stats/index.mjs: --card/--week/--month/--include-repo-names/--public-repo/--out, HELP, readAttribution, dispatch after the existing crawl.
- bin/stats/card.test.mjs: regression tests incl. no titles/repo names by default.
- docs/STATS.md: card section (PNG not shipped).

### Acceptance Criteria Status
- R1 ✅ bin/stats/card.mjs:17-40
- R1b ⏸ deferred (PNG), documented docs/STATS.md
- R2 ✅ card.mjs:30-34, card.test.mjs:35-57
- R3 ✅ card.mjs:38, card.test.mjs:45
- R4 ✅ index.mjs runStats card branch; card.test.mjs:65
- R5 ✅ card.test.mjs:35

### Verification
- V1 node --test bin/stats/card.test.mjs bin/stats/stats.test.mjs: 78 pass, 0 fail. The card tests fail without the fix (card.mjs and the flags would not exist).
- scripts/check-devdocs-freshness.sh origin/staging: OK. forgedock check: PASS.
- No formatter config in the repo; none run.

### Notes
No env vars. No new dependency. Nothing new to commit: the implementation was already committed on the branch.

- Sibling-list check: `card` (bin/stats) is not a member of the lists at bin/lean/batch.test.mjs:28 or bin/lean/execution.test.mjs:51; recorded under `not_members` in result.json.
