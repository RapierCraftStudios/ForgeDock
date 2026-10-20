---
issue: 4297
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-10-20
---

# ADR: engine-written records are not trusted input; absence is not success

## Context

The 1.29.0 staging review (#4291) found that each new surface trusted a record the engine writes but others can edit or forge. A linked issue's `FORGE:STATE` is in an issue body anyone can write. The bot's `FORGE:CONTEXT` comment re-entered the quotable issue text. The builder could write the `.forge/test-map.json` whose commands the engine runs. It also found that "nothing ran" was reported as success: the `forgedock/verify` check with zero gates passed, and a recovery lane that did not merge left `needs-human` removed.

## Decision

- Context pack: only values matching the outcome-code charset (`^[a-z][a-z0-9_.-]{0,63}$`) are read from `FORGE:STATE` (`context.mjs` `codeOf`). This is checked again at compile time, so cached facts are covered too. Timeline cross-references from another repo are skipped.
- Contract quotes: `issueText` drops comments starting `<!-- FORGE:`, the same rule `scopeText` uses.
- Test map: read with `git show <base>:.forge/test-map.json` (`testmap.mjs` `readTestMapAtRef`), else the operator's main checkout, never the lane worktree. `scripts/test-map.sh` drops steps whose job id, job name, step name or command matches deploy/publish/release/push/secret. A `run:` block ends at the `run` key's column.
- `verifyReport`: gates carry `ran`. Only gates that ran count, and with none the conclusion is `neutral` ("no gates ran").
- Recovery: if a lane removed `needs-human` and ends anything but `merged`, it re-applies the label with a recovery-evidence `FORGE:NEEDS_HUMAN` comment.

## Alternatives

- An enum of known outcome codes: new codes would be silently dropped. The charset blocks the injection vector (newlines, markup, length) without that coupling.
- Dropping the main-checkout test map too: test-map.sh writes it there by default, it is outside the builder's worktree, and dropping it would remove the feature for repos that do not commit the map.
- An allow-list of check step names for workflow steps: custom check scripts have no type label to allow.
