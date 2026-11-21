---
status: fresh
anchor: bin/lean/apiroles.mjs
created: 2026-11-21
---

# ADR: the reviewer and verifier can run as direct Messages API calls

## Context

Every reviewer and verifier call was a fresh headless `claude` session. A fresh session writes a ~37k-token baseline (tools, system prompt, settings) to cache before it reads the role's prompt. Review alone was about 26% of modelled spend, about 3 turns per attempt and about 80% of it cache writes. These roles are one reply parsed by the engine (`parseReview`, `parseVerifierFindings`); they need the prompt the engine already builds (issue, contract, rubric, row skeleton, diff) and, now and then, one more file.

Earlier attempts differ: #2385 added prompt caching to the generic `forgedock run` API backend (whole command specs, the builder loop) and #5347 targeted builder tool batching. Neither changed which backend the lane's one-shot roles use.

## Decision

`bin/lean/apiroles.mjs` wraps the lean CLI runner (`withApiRoles`, wired in `makeLeanIo`). A fresh, read-only `reviewer` or `verifier` call goes to `client.beta.messages.stream(...).finalMessage()` with:

- the role's model unchanged (`lean_reviewer_model`, default `claude-sonnet-5-5`; the verifier's picked model). A non-API id (an alias) stays on the CLI.
- a stable cached prefix: two read-only tools (`read_file` over git-tracked worktree files, confined after symlink resolution and size-bounded; `grep` = argv-only `git grep`), then the role's system prompt plus one note naming those tools, with a `cache_control` breakpoint. The engine's prompt follows; top-level automatic caching moves a second breakpoint along the tool loop.
- adaptive thinking (no `thinking` param), `output_config.effort: high`, no sampling params, `max_tokens` 64000 with streaming; `fallbacks: "default"` with beta `server-side-fallback-2026-07-01` on `claude-opus-5-5` / `claude-sonnet-5-5`.
- the reply text goes to the same parser, so the verdict format, the re-ask rules and the blocking semantics are the CLI path's. Structured outputs were not used: the repair re-ask asks for a subset of rows, and a strict schema would diverge from the rows the CLI path returns.

Opt-in: `engine.review_backend: cli|api|auto`, default `cli`. The API bills `ANTHROPIC_API_KEY` per token, while the CLI may run on a subscription login, so the default must not change who pays. As with `execution.agent_backend` (#4257), a forge.yaml `api`/`auto` also needs `FORGEDOCK_ALLOW_API_BACKEND=1` on the host; `FORGEDOCK_REVIEW_BACKEND` (host env) is itself the explicit choice.

Fallback: no key, no SDK, no host opt-in, an SDK error (typed: auth and not-found turn the path off for the process; rate limit, 5xx, connection, timeout fall back per call), `stop_reason: refusal`, `max_tokens`, an empty reply or an exhausted turn budget run the same call on the CLI. The result carries `apiFallback`; `attempt()` logs `API_ROLE_FALLBACK` and adds the API tokens already spent to that attempt. `PHASE_ATTEMPT_USAGE` gains `backend`; `cost_usd` is computed from usage at the served model's price, so API and CLI attempts stay comparable, and `baseline_tokens` is the first turn's context.

## Consequences

- With the setting on, a review attempt's first-turn context is the prompt plus a ~1-2k-token prefix instead of the ~37k CLI baseline; expected saving is most of the review share's cache writes (the issue estimates 35-45% of cost per merged issue across all one-shot roles).
- Contract correction and the enumerating/duplicate-check fixes still run as CLI sessions (they resume or write); a follow-up can move them.
- Before/after (fresh CLI sessions per merged issue, cache-write share) and the parity check on past PRs need live runs with the setting on; the tests check parity on fixtures with a fake client.
