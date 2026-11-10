### Approach
Verified the prior commits against the contract; pure card module, parseArgs/runStats dispatch reusing the existing crawl, docs. PNG is deferred (R1b) via amendment.
### Changes
- bin/stats/card.mjs: buildCard, renderCardSvg, renderCardMarkdown
- bin/stats/index.mjs: --card/--week/--month/--include-repo-names/--public-repo/--out, readAttribution, dispatch
- bin/stats/card.test.mjs: aggregates, privacy canaries, attribution, escaping, public-repo link, flag validation, runStats call check
- docs/STATS.md: --card section
### Acceptance Criteria Status
- R1 ✅ card.mjs:17-37, index.mjs runStats card branch
- R1b deferred by amendment (PNG needs a rasterizer dependency)
- R2 ✅ card.mjs:30-31
- R3 ✅ card.mjs:35, index.mjs readAttribution
- R4 ✅ card.test.mjs runStats test
- R5 ✅ card.test.mjs "defaults expose no issue titles"
### Verification
- V1 node --test bin/stats/card.test.mjs bin/stats/stats.test.mjs: exit 0 (78 pass); the new tests fail without card.mjs. forgedock check: PASS. Devdocs freshness: OK.
### Notes
No new env vars. No repo formatter is configured, so none was run.
### Sibling-list check
bin/stats/card is not a member of the lists flagged at bin/lean/batch.test.mjs:28 and bin/lean/execution.test.mjs:51: neither enumerates stats modules (recorded in result.json not_members).
