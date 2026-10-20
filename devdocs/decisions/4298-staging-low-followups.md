---
issue: 4298
status: fresh
anchor: bin/lean/conformance.mjs
created: 2026-10-20
---

# ADR: hidden HTML comments are not issue scope; the CI gate ignores forgedock/verify everywhere

## Context

The 1.29.0 staging review (#4291) left two open choices.

- SEC-5: `scopeText` cuts every HTML comment, so an edit that only changes a hidden comment does not move the scope hash, and `ISSUE_EDITED` does not fire for it.
- BUG-3: the lean path passes `--ignore-check forgedock/verify` to `scripts/wait-ci-green.sh`, but the legacy engine, `review-finalize.sh` and the spec CI gates do not. A failing report-only check therefore turned only those gates red.

## Decision

- HTML comments are not scope. GitHub does not render them, so they are not what a human reads as the issue. The engine's own annotations are HTML comments too. Quote validation still uses the full text, so the behaviour is unchanged and is now documented in `scopeText` and covered by a test.
- `wait-ci-green.sh` starts its ignore list with `forgedock/verify`, and `--ignore-check` appends to it. The check is report-only by design: requiring it is the repository's branch-protection choice, and branch protection still enforces it. When `verify.check_run` is off the check does not exist, so ignoring it is a no-op.

## Alternatives

- Hash human HTML comments into the scope: invisible edits would re-plan frozen contracts, and the change would need a marker allow-list to keep the engine's own writes out.
- Pass `--ignore-check forgedock/verify` from every caller: the callers are spread over a JS engine, a script and bash blocks in four specs, and each new caller would have to remember the flag.
