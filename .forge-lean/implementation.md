### Approach
At contract freeze the engine reads the local guards index once and appends up to 5 deterministic `H<n>` preserve rows for guards covering the deliverable paths. The reviewer's existing preserve skeleton picks them up unchanged.

### Changes
- bin/lean/guards.mjs: `historyPreserve` (pure selector: score 3 hunk file, 2 test file, 1 same directory; newest issue first; own issue skipped; cap 5), `withHistoryRows` (reads the index; returns the same contract when nothing applies; never throws), and `guardAfterMerge` now adds a posted guard to an existing local index.
- bin/lean/lean.mjs: `historyRows` applied at the full-lane and light-lane freeze before the hash; H ids added to `structure.decisions` (Decision sources line); a trajectory decision note.
- bin/lean/guards.test.mjs, bin/lean/lean.test.mjs: regression tests.

### Acceptance Criteria Status
- R1 ✅ bin/lean/guards.mjs:182 (withHistoryRows), bin/lean/lean.mjs freeze sites
- R2 ✅ guards.test.mjs "deterministic under input order, capped at 5"
- R3 ✅ lean.mjs recordStructure decisions; lean.test.mjs #4694 test asserts `K1 doc, K2 precedent, H1 guard`
- R4 ✅ withHistoryRows returns the same object with no index or no match; the test asserts identity
- R5 ✅ not-applicable: conformance.mjs:713 already creates a row per preserve id
- R6 deferred (#4695 not landed)
- R7 ✅ no LLM or prompt change
- R8 ✅ one file read, no git or network
- R9 ✅ cap 5, one-line rows
- R10 post-deploy

### Verification
- V1 `node --test bin/lean/guards.test.mjs`: pass (15)
- V2 `node --test bin/lean/lean.test.mjs bin/lean/conformance.test.mjs`: pass (582)
- The new lean.test.mjs test fails with lean.mjs reverted to base (fail 1).
- `forgedock check`: PASS. Devdocs freshness: OK. `checks.mjs` widened to the full suite (842 referencing files); I ran the targeted validates instead, per the host rules. No formatter is configured in package.json.

### Notes
Only the existing local index is extended after a merge; none is created from a single guard. Recency is issue number. lean.mjs grew by 2 lines net.

## Docs freshness fix
Added the "Engine-authored history preserve rows (#4694)" entry to devdocs/modules/lean.md.
