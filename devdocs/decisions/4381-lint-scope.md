---
issue: 4381
status: fresh
anchor: scripts/ci-local/scoping.mjs
created: 2026-10-23
---

# ADR: lint is scoped to the changed packages; a configured typescript.lint wins

## Context

`bin/lean/checks.mjs` printed `turbo run lint --filter=...[base]`, and HOST_RULES tells the builder to run it.
`...[base]` is the changed packages plus every dependent, so a change to an upstream package linted almost the
whole repo (29+ min in one lane). A repo also had no way to supply its own lint: `checks.mjs` ignored
`verification.commands`, and validate read no `typescript.lint`.

## Choice

- `scopeMono` (`scripts/ci-local/scoping.mjs`): a `turbo run` whose tasks are all lint tasks (`lint`, `lint:*`,
  `*:lint`) gets `--filter=[base]`. Lint is per-file, so dependents cannot gain lint errors that need a local run;
  CI lints the whole PR. typecheck/test/build keep `...[base]`. ci-local's plan uses the same scoper and gets the same scope.
- `checks.mjs` reads `verification.commands.typescript.lint` only from the trusted forge.yaml copy. The resolution
  moved from `plan.mjs` `loadConfig` to `lib.mjs` `trustedForgeYaml` (forge#4040: a command we execute never comes
  from the PR's tree). It is parsed with yq (`parseYaml`); `parseForgeYaml` flattens 3-level keys.
- Only the `typescript.lint` slot is read. Python checks and the other slots keep today's discovery.

## Rejected

- Only a prompt rule: the over-wide command came from our own deterministic output, so the fix belongs in the scoper.
- nx `affected` for lint: it also includes dependents, but nx has no changed-only flag; changing it needs the project graph.
