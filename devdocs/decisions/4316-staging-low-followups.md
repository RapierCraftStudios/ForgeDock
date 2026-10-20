---
issue: 4316
status: fresh
anchor: scripts/test-map.sh
created: 2026-10-20
---

# ADR: workflow checks reject redirects and fixers outright; the context-pack key tracks linked-issue states

## Context

The 1.30.0 staging review (#4314) found that `test-map.sh` mapped workflow steps that write files: redirects, process substitution, extra make targets and fixer flags. The engine runs those steps before a PR. The review also found that a cached context pack could show a linked issue as open after it had closed, and that `review-prepare.sh` echoed raw code-index stderr that can name repo files.

## Decision

- `check_cmd` rejects any `<` or `>` and any `$GITHUB_` reference, in the same way it already rejects `;`, `|` and `&`. It does not parse redirection forms: a real check never needs one. Fixers are dropped by flag (`--fix`, `--write`, `-w`) and by tool form (`black`, `ruff format`, `gofmt` and `prettier` without their read-only flag). `skip_cmd` is removed because the allowlist subsumes it.
- The context-pack cache key adds a hash of `number:state` for the issues the body references (parent, Depends on, `#N`). Timeline cross-refs stay with the gather, which already reads the timeline. With no references the key is unchanged, so existing caches stay valid.
- `review-prepare.sh` shows the repo root as `<repo>`, strips control characters and caps each stderr line at 200 chars. The tail stays at 20 lines so a failure is still diagnosable.

## Alternatives

- Validate a cache hit by re-reading every linked issue after the hit: same call count, but the key would no longer describe what it caches.
- Parse shell redirection precisely (allow `2>&1`): more code for no real check that needs it.
