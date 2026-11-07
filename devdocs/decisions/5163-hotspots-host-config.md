---
status: fresh
anchor: scripts/hotspots.sh
created: 2026-11-07
---

# ADR: the hotspot gate reads the host forge.yaml, not the worktree's

## Context

`forge.yaml` is often gitignored, so a lane worktree has none. `scripts/hotspots.sh` read only `./forge.yaml`, so in a lane it silently used defaults and ignored `maintenance.hotspot.exclude_globs` and `maintenance.generated_paths` (#5163).

## Choice

- `hotspots.sh` resolves its config as `--config`, then `$FORGE_CONFIG`, then `./forge.yaml`. This mirrors the `FORGE_CONFIG` handling in `review-prepare.sh`.
- The output gains `config_source` (the file read, or `null` when defaults were used). A missing `--config` path falls back to defaults; it is not a usage error.
- The lane (`bin/lean/lean.mjs` `hotspotsOf`) passes the main checkout's `forge.yaml` when it exists. When the script reports `config_source: null`, the lane records one `hotspot_config_missing` anomaly per run.

## Rejected

- Re-checking the file in JS: the script stays the only reader of the config.
- New `FORGE_CONFIG` plumbing through the engine: the main checkout already holds the resolved config (the remote entrypoint writes the pinned config there).
