---
issue: 4507
status: fresh
anchor: bin/lean/retry.mjs
created: 2026-10-23
---

# ADR: each lean run gets its own gh HTTP cache; a gh parse error retries once on a fresh cache

## Context

Concurrent lanes on one host shared `~/.cache/gh`. Two lanes caching the same gh query at once tore the entry (`{{"data":…`), and from then on every `gh pr merge` on the host failed with `invalid character '{' looking for beginning of object key string`. The merge catch treated that as fatal and ended each lane as `engine-error`, even when the PR was mergeable or had in fact merged.

## Choice

- `makeGhCache` (`bin/lean/effects.mjs`) gives every engine gh call of a run its own `XDG_CACHE_HOME` under the run tmp dir. That dir is removed with the run. The env is set on the gh child only, so agent sessions and other tools keep their caches. gh 2.97 has no `GH_CACHE_DIR` or `GH_NO_CACHE`; it reads `XDG_CACHE_HOME`.
- `ghCacheRetry` (`bin/lean/retry.mjs`): on `GH_PARSE_RE` (gh failing to parse its own JSON cache or YAML config), reset to a fresh cache dir and retry once. `GH_PARSE_RE` is part of `MERGE_TRANSIENT_RE`, so a merge that still fails goes through the bounded #4113 backoff and ends `deferred merge.transient`.
- A merge error first reads `gh pr view --json state`. If the PR is MERGED, the lane records merged. An unreadable state counts as not merged.
- `scripts/refresh-bot-token.sh` runs `gh auth login/logout` in a staging `GH_CONFIG_DIR` inside the config dir, then renames `hosts.yml` into place.

## Rejected

- Purging the shared `~/.cache/gh` on a parse error. It races the other lanes, which is the original defect.
- Setting `XDG_CACHE_HOME` in the agent session env. It would move the cache of every tool the agent runs (pip, npm, …).
