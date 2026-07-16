/**
 * cli-spawn-shared.mjs — shared constants for `claude` CLI `spawnSync`
 * invocations across the codebase.
 *
 * Extracted (issue #2032) to stop `maxBuffer: 50 * 1024 * 1024` from
 * drifting independently at each spawn call site (bin/runner.mjs's
 * `runCliBackend` and `run_bash`, bin/init-enrich-cli.mjs's `enrich()`) —
 * all three invoke the same local `claude` CLI and should share one
 * default rather than three copies of the same magic number.
 *
 * Isolated: imports no external modules, so it is safe to import from any
 * module without creating a cycle.
 */

/**
 * Default `maxBuffer` (bytes) for a `spawnSync` call against the local
 * `claude` CLI. 50 MB comfortably covers a full headless response (stdout)
 * plus any diagnostic stderr without risking silent truncation.
 *
 * `bin/runner.mjs`'s `run_bash` tool handler additionally allows this
 * default to be overridden per-call via `FORGEDOCK_MAX_BUFFER_BYTES` — that
 * override logic lives in `runner.mjs` itself; this constant is only the
 * shared *default*.
 */
export const DEFAULT_SPAWN_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
