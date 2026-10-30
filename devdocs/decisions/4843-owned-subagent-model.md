---
issue: 4843
status: fresh
anchor: bin/lean/effects.mjs
created: 2026-10-31
---

# ADR: ForgeDock owns the subagent model of the sessions it launches

## Context

The main session's model is owned by `--model`. Subagents were not owned. An operator `settings.json` `env` of `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` overrode every subagent, including the #4391 explorer that ForgeDock defines with `model: haiku`. A stream-json trace showed its turns on Sonnet. A child env var cannot undo this, because settings `env` wins over the process env. Only a `--settings` flag does. forge.yaml `agents.subagent_model` was shown by the session-start hook but never read by the lean engine.

## Choice

- **One `--settings` per lean session** (`leanSettingsFlags`, built in `makeLeanRunner`). Its `env` has two entries:
  - `CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0"`, so a ForgeDock-defined agent's own `model` wins.
  - `CLAUDE_CODE_SUBAGENT_MODEL` set to forge.yaml `agents.subagent_model` (sanitized), the default for agents without a model. When unset it is `""`, which gives Claude's own default.
- Verified by probe: with FORCE=0 set through `--settings`, the explorer ran on Haiku while an agent without a model ran on the configured default.
- **The re-read hooks (#4456) are merged into the same object**, not a second `--settings`.
- **`makeLeanIo` reads the config once**, through `readSubagentModel()` at the process cwd like every other engine-cli reader. So all 11 call sites (lanes, prefilter, gates) are covered without plumbing.

## Rejected

- **Exporting the env vars into the child env.** Settings env overrides them, as the probe showed.
- **Writing the operator's settings.json.** It's not ForgeDock's file, and it would change their interactive sessions too.
- **Pinning `--model` on every subagent definition only.** That doesn't help while FORCE=1 is ambient, and it does nothing for built-in agents.
