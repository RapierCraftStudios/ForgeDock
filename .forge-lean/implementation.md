### Approach
Pure card module summing the existing stats report groups into aggregates; `runStats --card` reuses the default buildReport crawl (no new fetch). Aggregate-only by default; repo name only with `--include-repo-names` (or `--public-repo`).

### Changes
- bin/stats/card.mjs: buildCard, renderCardSvg (XML-escaped), renderCardMarkdown.
- bin/stats/index.mjs: --card/--week/--month/--include-repo-names/--public-repo/--out parsing, HELP, dispatch, readAttribution (branding.show_attribution).
- bin/stats/card.test.mjs: aggregate, privacy, attribution, escaping, no-extra-gh-calls, flag validation tests.
- docs/STATS.md: `--card` section.

### Acceptance Criteria Status
- R1: ✅ bin/stats/card.mjs:17-40, bin/stats/index.mjs:436-449 (SVG + Markdown; PNG deferred as R1b in contract)
- R2: ✅ bin/stats/card.mjs:31-33
- R3: ✅ bin/stats/card.mjs:38,61
- R4: ✅ bin/stats/card.test.mjs (runStats --card, only crawl gh calls)
- R5: ✅ bin/stats/card.test.mjs (canary title/repo absent by default)

### Verification
- V1 `node --test bin/stats/card.test.mjs bin/stats/stats.test.mjs`: exit 0 (78 pass). New tests fail without the fix (card.mjs/flags absent).
- `forgedock check`: PASS. check-devdocs-freshness: OK.

### Notes
No new env vars or dependencies. Time saved uses documented constant 1.5h per merge, labelled an estimate. `--public-repo` is an extra opt-in flag that links the merged-PR history.

### Sibling lists
- card (bin/stats) is not a member of bin/lean/batch.test.mjs:28 or bin/lean/execution.test.mjs:51 lists; recorded in result.json not_members.
- Sibling-list check: `card` (bin/stats) is not a member of the lists in bin/lean/batch.test.mjs or bin/lean/execution.test.mjs; recorded under `not_members` in result.json.
- Amendments: the only amendment is the typed defer of R1b (PNG). No add-requirement is recorded; the reported R2b id is not in the contract or in result.json.
