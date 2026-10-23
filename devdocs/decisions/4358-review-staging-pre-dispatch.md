---
issue: 4358
status: fresh
anchor: scripts/review-staging-pre.sh
created: 2026-10-21
---

# ADR: the staging->main review pre-dispatch is a script plus a CLI

## Context

A staging->main review meant an agent ran `commands/review-pr-staging.md` by hand. It awk-extracted the Phase -1, 0A and 0B.1 fences, substituted `{GH_REPO}`/NONCE, carried state through `$_SD` files, then built every reviewer prompt from the persona templates. Phase 0C was already one call to `scripts/review-prepare.sh` (#3838).

## Decision

- `scripts/review-staging-pre.sh` has three subcommands. `bundle` computes the 0A bundle PR set. `gate` runs the open review-finding gate. `scope` runs the 0B.1 bundle scope. The spec's `# BEGIN`/`# END` blocks are copied byte-identically (`{GH_REPO}` -> `$GH_REPO`), and `scripts/review-staging-pre.test.sh` fails if they drift before #4359 retargets the spec. It writes the same `$_SD` files as the spec, plus a `<PR>_scope.json` twin of `scope.env`.
- `bin/review-staging.mjs` (`forgedock review-staging [<PR>] [--thorough] [--json]`) runs these steps in order:
  1. Route marker.
  2. Bundle.
  3. Gate. It stops on a block.
  4. Scope. A failure widens to full.
  5. `review-prepare.sh --no-delta --build-gate advisory`. It stops on BLOCKED.
  6. The roster, taken from `ctx.roster`, which `review-roster.sh` computed inside prepare.
  7. One brief per roster domain under `$_SD/review-staging-<PR>/`, rendered from `protocols.md` + persona with single-pass placeholder substitution.
  8. A manifest of `DISPATCH <domain> <brief>` lines.
- Child scripts run with `FORGEDOCK_HOME` set to the CLI's own install root, so helpers never come from the repo under review.
- Briefs cover only persona domains. The spec-owned panel is material-change, bug hunters, code-quality and regression-risk. It has no persona template and is still dispatched per the spec, which #4359 reduces.

## Alternatives

- Re-implementing the gate and scope in Node was rejected. It would be a second, untested copy of fail-open logic that #4359 retargets to scripts anyway.
- Calling `review-roster.sh` a second time was rejected, because the result could disagree with the slices prepare cut.
