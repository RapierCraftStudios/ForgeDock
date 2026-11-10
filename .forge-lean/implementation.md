### Approach
Verified the existing branch work against the frozen contract; it delivers R1-R5. R1b (PNG) is deferred by a typed amendment because it needs a rasterizer dependency.

### Changes
- bin/stats/card.mjs: buildCard, renderCardMarkdown, renderCardSvg (aggregate-only, escaped SVG, estimate label, attribution footer)
- bin/stats/index.mjs: --card/--week/--month/--include-repo-names/--public-repo/--out flags, HELP, readAttribution, dispatch reusing the existing crawl
- bin/stats/card.test.mjs: card tests incl. no titles/repo names by default, stubbed-gh runStats --card
- docs/STATS.md: documents --card, estimate constant, attribution, PNG not shipped

### Acceptance Criteria Status
- R1 ✅ bin/stats/card.mjs:15
- R1b deferred (PNG), docs/STATS.md
- R2 ✅ bin/stats/card.mjs:30
- R3 ✅ bin/stats/card.mjs:38, bin/stats/index.mjs readAttribution
- R4 ✅ bin/stats/index.mjs runStats card branch; bin/stats/card.test.mjs stubbed gh
- R5 ✅ bin/stats/card.test.mjs

### Verification
- V1 `node --test bin/stats/card.test.mjs bin/stats/stats.test.mjs`: exit 0 (78 pass). New card tests fail without card.mjs (module absent).
- `forgedock check`: PASS.

### Notes
No new env vars. No repo formatter is configured (base files also fail prettier), so none was applied. Footer follows forge.yaml branding.show_attribution (default on).

### Sibling-list follow-up
`card` (bin/stats) is not a member of the lists at bin/lean/batch.test.mjs:28 or bin/lean/execution.test.mjs:51: neither references stats modules (grep "stats" is empty); they test batch resume and execution config. Recorded in result.json not_members.
