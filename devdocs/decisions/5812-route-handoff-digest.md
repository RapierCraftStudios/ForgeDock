---
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-11-21
---

# ADR: the routed builder starts from a digest, not the planning transcript

## Context

After `BUILDER_ROUTE` the build resumed the planning session (`--resume <sessionId>`), so its first turn carried the whole pre-route transcript: the plan prompt, the context pack, the investigation and every file planning read. One lane hit `CONTEXT_CEILING` (120,518 of 120,000 tokens) 4 turns after routing, and the restart rebuilt about 96k tokens of cache. Cache reads averaged about 50k tokens per turn (1.4M over 26 turns). Auto-memory is already off by default (`memory-off` profile), so the per-turn weight that remains is the inherited transcript, the context pack inside it included.

## Decision

- The runner reports `endTokens`, the last assistant turn's context, next to `baselineTokens`. `lean.mjs` records it, with the files planning read and its "Build reads:" reply, for the plan session and its corrections.
- At the build, `routeHandoff()` (`ceiling.mjs`) compares the plan session's `endTokens` with `engine.route_handoff_tokens` (default 40000, capped at half the lane's ceiling). Above the bound the build starts a fresh session from the implement prompt plus `routeDigestPrompt()`: deliverables, contract decisions, open (non-deliver) requirements, files planning read, its build reads, and the branch state from `restartFacts()`. The digest is capped at 32 KB (about 8k tokens). The contract and the investigation stay on disk as the authority.
- At or under the bound, with no size reported (non-stream path), or with the setting at 0, the build resumes the planning session as before. A small plan's cache is cheaper to reuse than to rebuild.
- Each build logs `ROUTE_HANDOFF` (`mode`, `plan_tokens`, `bound`, `digest_bytes`, `pack_bytes`, `lane_profile`). With `baseline_tokens` on the build attempt, this gives the before and after tokens per lane.
- The context pack is not re-sent to a digest build. Only its file list reaches the build (`buildOpeningNote`), which is the trim it can take without losing what the contract needs.

## Consequences

- On the sample lane the build opens at about the session baseline plus up to 8k digest tokens, not about 96k. The inherited transcript that caused the sample's post-route restart is gone. A live lane has not measured this yet; `ROUTE_HANDOFF` and `baseline_tokens` will show it.
- A digest build re-reads the contract, the investigation and the files it edits. That is a few turns of reads against a transcript that every turn re-read.
- `engine.route_handoff_tokens: 0` restores the old resume behaviour.
