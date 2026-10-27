### Approach
A pure module, `bin/lean/decisions.mjs`, holds the anchored decision record, the `<!-- FORGE:DECISION {json} -->` render and parse, a local index, anchor matching, staleness, supersession and the capped H-rows. The engine appends the rows at contract freeze, so the reviewer's existing preserve check enforces them. A `decision` amendment validates anchors against the base tree, posts the records and drops the superseded row. No LLM call and no prompt change.

### Changes
- bin/lean/decisions.mjs (new): record, marker, parse, fold (latest record per id wins), anchor glob match, `staleDecisions`, `historyRows` (cap 5, deterministic), `withDecisionRows`, `supersede`, index read/write, `recordDecisions`.
- bin/lean/conformance.mjs: `decision` amendment kind with anchor-exists validation (`baseFiles`); `supersedes` drops the preserve row; returns `decisions`.
- bin/lean/lean.mjs: `post` takes a target issue; freeze appends H-rows from the index; `amend()` posts decision records (one `git ls-tree` only when a decision amendment exists).
- bin/engine-cli.mjs, bin/forgedock.mjs: `forgedock decisions list [--stale] [--refresh]`.
- Tests: bin/lean/decisions.test.mjs (new), bin/lean/conformance.test.mjs.
- devdocs/modules/lean.md, devdocs/decisions/4695-anchored-decisions.md.
- bin/lean/prompts.mjs (D6) is intentionally unchanged: the implement prompt is at its token budget (lean.test.mjs fails with +1 line). The H-row text itself tells the builder how to amend, which fits "nothing added to the builder prompt beyond the contract rows".

### Acceptance Criteria Status
- R1 ✅ bin/lean/conformance.mjs (decision branch of applyAmendments), bin/lean/lean.mjs (amend(): recordDecisions), bin/lean/decisions.mjs (recordDecisions)
- R2 ✅ bin/lean/decisions.mjs (withDecisionRows), bin/lean/lean.mjs (freeze); a violation without supersedes remains the existing preserve_violated (conformance.mjs decide())
- R3 ✅ bin/lean/decisions.mjs (supersede, recordDecisions); test "recordDecisions posts…"
- R4 ✅ bin/engine-cli.mjs (decisionsFromCli --stale), bin/lean/decisions.mjs (staleDecisions)
- R5 ✅ no LLM, phase or prompt change
- R6 ✅ one index file read at freeze; contract object returned unchanged when no rows apply (test)
- R7 ✅ HISTORY_ROWS_MAX = 5 shared cap; anchors checked against a single ls-tree only when a decision amendment exists

### Verification
- V1 `node --test bin/lean/decisions.test.mjs bin/lean/conformance.test.mjs`: pass. The new tests fail without the fix (the module and amendment kind do not exist).
- V2 `node --test bin/lean/lean.test.mjs bin/lean/conformance.e2e.test.mjs`: pass.
- `forgedock check`: PASS. bin/tests/engine-cli.test.mjs: pass. No repo formatter is configured.

### Notes
- The index lives at ~/.forge/decisions/<repo>.json (env FORGEDOCK_DECISIONS_DIR overrides). Decisions posted from another host appear after `forgedock decisions list --refresh`; no gh call is made at freeze.
- Light lanes do not get H-rows (their contract is derived from the diff).
- #4694 (guards) can reuse `historyRows` and the cap.

## Sibling-list check
`decisions` (bin/lean) is not a member of the lists in checks, conformance.e2e, context (context-pack sources), execution(.e2e), fixround (MECHANICAL_KINDS) and heavy tests; recorded under `not_members` in result.json.

## Sibling-enumerating tests
decisions (bin/lean) is not a member of the lists in checks, conformance.e2e, context, execution(.e2e), fixround and heavy tests; recorded as not_members in result.json.

## Export collision fix
Renamed decisions.mjs readIndex/writeIndex to readDecisionIndex/writeDecisionIndex (guards.mjs already exports readIndex/writeIndex); references in lean.mjs, engine-cli.mjs and decisions.test.mjs updated. V1/V2 pass (618 tests).

### Verification
- V1 `node --test bin/lean/decisions.test.mjs bin/lean/conformance.test.mjs`: exit 0 (105 pass). New tests fail without the fix (the module and `decision` kind do not exist).
- V2 `node --test bin/lean/lean.test.mjs bin/lean/conformance.e2e.test.mjs`: exit 0 (513 pass), after merging staging (guards #4694 rows applied first, decision rows share the 5-row cap).
- `forgedock check`: PASS.

### Notes
No env vars added except the optional `FORGEDOCK_DECISIONS_DIR` for the index location. No prompt change.
