### Approach
The `human` builder block gets an optional `remainder` list. When the lane ends on an owner step, each remainder item is filed as its own issue (no needs-human); only the owner-step issue keeps the label. Duplicate owner asks that are the issue's entire content are closed and linked, by strict normalized equality (no LLM).

### Changes
- bin/lean/lean.mjs: classifyBlock keeps a validated `remainder` (cap MAX_SUBISSUES). endBlocked files the remainder before needsHuman. needsHuman takes `ask` and `note` options, and calls the new `duplicateAskIssue` when registerAsk finds an existing entry. origin/staging was merged first.
- bin/lean/needs-human-premise.mjs: `onlyAsk` and `fileRemainder`, which is idempotent via a `FORGE:REMAINDER of=#N key=` marker.
- bin/lean/prompts.mjs: one line in BLOCK_RULES.
- bin/lean/lean.test.mjs, bin/lean/needs-human-premise.test.mjs: regression tests. The plan-prompt token caps went up by 50 (hotspot case 2050 to 2100) or 50 (1950 to 2000) for the added line.
- devdocs/modules/lean.md: documents the remainder block and the duplicate-ask closure.

### Acceptance Criteria Status
- R1 ✅ bin/lean/lean.mjs endBlocked human branch (fileRemainder call), bin/lean/needs-human-premise.mjs:fileRemainder
- R2 ✅ bin/lean/lean.mjs duplicateAskIssue, bin/lean/needs-human-premise.mjs:onlyAsk
- R3 ✅ bin/lean/lean.mjs endBlocked: the owner step still goes to needsHuman, the remainder issue is created without a label

### Verification
- V1 `node --test bin/lean/needs-human-premise.test.mjs bin/lean/lean.test.mjs bin/lean/decompose.test.mjs`: 533 pass, 0 fail. The new tests fail without the fix, because the helpers and the behaviour do not exist.
- V2 `node --test bin/tests/engine-cli.test.mjs`: pass.
- `forgedock check`: PASS. No repo formatter is configured. check-devdocs-freshness.sh: OK.

### Notes
- Closure compares the issue content with the builder summary or the full needs-human reason. Any extra content keeps the issue open and only links it.
- A failure to file the remainder ends the lane as engine-error, without the needs-human label.
