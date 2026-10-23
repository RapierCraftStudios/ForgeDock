---
issue: 4395
status: fresh
anchor: bin/lean/lean.mjs
created: 2026-10-23
---

# ADR: lane profile — no auto-memory, a slim lane instruction file instead of CLAUDE.md

## Context

Every lane turn re-reads a fixed baseline: the system prompt, the repo's CLAUDE.md and the operator's auto-memory index. On AlterLab the memory index is about 85 lines that no lane needs. The lean runner (`bin/lean/effects.mjs` `makeLeanRunner`) only removed MCP servers and slash commands (#4065/#4081). Nothing measured the baseline.

## Choice

- **Switches:** every core LLM session gets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. With forge.yaml `engine.lane_instructions` it also gets `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, and the file text is appended to fresh tool-using sessions. Both are env switches set in `lean.mjs` `callRunner`, so validate commands (`laneEnv()`) never see them, and older CLIs ignore them.
- **Where the file is read:** from the lane worktree at the lane base, not the operator's checkout. The hard rules are versioned with the repo they govern (NORTHSTAR 3 and 6).
- **Bad file:** a missing, absolute, `..`, empty or over-16 KB file falls back to CLAUDE.md with an anomaly. A lane never runs without its hard rules.
- **Baseline measurement:** the first stream assistant message's context (input + cache read + cache creation), reusing #4390's per-message usage. Recorded as `baseline_tokens` and `lane_profile` on `PHASE_ATTEMPT_USAGE` and in `phase_attempt` telemetry. It costs no LLM call. Resumed sessions report none, because their first turn carries history.

## Rejected

- **`--setting-sources project,local`:** it drops user settings, and with them ForgeDock's user-scope PreToolUse/SubagentStop hooks (`bin/runner.mjs` `buildMinimalSessionFlags`).
- **`--bare`:** it skips all hooks and changes auth.
- **Byte counts of CLAUDE.md as the baseline:** an estimate, blind to the system prompt, the tools and memory. The first-turn usage is measured.
- **Shipping a default lane file:** the hard rules are the target repo's truth. Opt-in per repo; the before/after comparison runs on real lanes after deploy.
