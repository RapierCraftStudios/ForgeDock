---
issue: 4340
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-10-20
---

# ADR: the lean decompose path closes a parent only with decomposition.close_parent

## Context

#4337 made the lean (core) path close every decomposed parent as `not planned` right after decomposition. The 1.30.0 release review (PR #4340, REG-1 / BUG-3) found that this contradicted `decomposition.close_parent` (#3736). That key is documented as opt-in, default `false`, and the legacy decompose phase already honours it. Consumer repos that never opted in would have had their trackers closed, and that state lives on GitHub, so undoing it means reopening issues by hand.

## Decision

- `bin/engine-cli.mjs` `readCloseParent` reads `decomposition.close_parent`. Only the word `true` enables it. An absent key, any other value or an unreadable config is `false`.
- `runCore` takes `closeParent` (default `false`). The close step after the `FORGE:DECOMPOSED` trail and the `workflow:decomposed` label runs only when it is set. Everything #4337 added stays as it was: closed decomposed parents still gate dependents through their sub-issues, and a trusted revoke reopens the parent.
- ForgeDock's own `forge.yaml` already sets `close_parent: true`, so its trackers keep closing.

## Alternatives

- Make the lean default `true`. That was rejected because it silently changes consumer repos and contradicts the documented default.
