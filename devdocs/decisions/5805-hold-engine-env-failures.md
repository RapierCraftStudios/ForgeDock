---
status: fresh
anchor: bin/lean/orchestrate.mjs
created: 2026-11-21
---

# ADR: engine/env-caused failures are held by signature and re-admitted on an engine or env change

## Context

The batch runner relaunched every `engine-error` once, even when the error was deterministic (the relaunch hit the same message seconds later), then ended the issue terminal. A first `env.tool_missing` on the host either ended terminal or a recovery re-ran on a host that still lacked the tool. Either way, once the engine or host was fixed, every affected issue needed a manual `forgedock orchestrate --requeue`, although nothing about the issue itself was wrong.

## Decision

- `orchestrate()` takes `envHold: {version(), envFingerprint(), missingTools(tools)}` (the CLI passes it; off when absent, and under the test seams).
- An engine-error's signature is `code|first message line` with times, hex ids and numbers normalised. A relaunch that fails with the same signature is held, and that `version|signature` is marked deterministic: another issue hitting it on the same engine version is held without a relaunch. A different message keeps the old behaviour (final `engine-error`).
- `env.tool_missing` is held instead of ended or recovered when the run already ran on the host that lacks the tool (#5592), when a recovery repeated the same failure (#5232, also `env.repro_unrunnable`), or when the recovery would run on the host and `missingTools` still reports the tool. The #5423 remote retry is unchanged.
- A held row is `outcome: "held"` with `envHold: {kind, sig, version, env, tools?, since}`. Its dependents are held behind it (`HOLD_ROOT` includes `held`), the existing #5162 mechanism, and `releaseHeld` re-admits both like `--requeue`.
- `watchEnvHolds` runs every 30s, and at once on a resume and when nothing else runs. An installed-version change, a batch env fingerprint change (`--set-env`) or a probe that finds every missing tool re-admits the issue. The tool trigger fires once per issue and signature, so a probe that disagrees with the lane can't loop. An issue closed or merged outside the batch stops being waited on.
- The batch stays open while a hold is under 24h old. The daemon's upgrade handover resumes it on the new version, and the first pass re-admits. After 24h the row stays `held` (resumable, `--requeue`).

## Consequences

- No blind relaunch of a repeat engine-error, no recovery lane while the host still lacks the tool, and no manual requeue after a reinstall, `--set-env` or tool install.
- Issue-caused outcomes (needs-human recoverable and human codes, ci-pending, budget) are untouched.
- The tool probe only finds executables on the lanes' PATH. A missing module (Python or Node) waits for an engine or env change instead.
- A batch whose only remaining work is held stays hosted for up to 24h. `--cancel` ends it.
