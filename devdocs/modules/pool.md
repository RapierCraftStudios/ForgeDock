---
module: pool
glob: "bin/pool/*"
authority: required
token_cost: 300
last_compacted: "2026-11-15"
---

# Module Dossier: bin/pool

Rolling per-module knowledge log. Hard cap: 150 lines.

## Entry 2026-11-15 — Environment snapshots (#5714)

- Design, failure modes and rejected options: `devdocs/decisions/5714-env-library.md`. User guide: `docs/ENV-LIBRARY.md`.
- Switch: forge.yaml `env.snapshots.enabled` (default false). The dispatcher (`bin/lean/sandbox-remote.mjs`) adds `spec.env_snapshots {enabled, ready, keep, max_age_days}` and the lane env from `laneEnvFor` (`FORGE_ENV_SNAPSHOTS=1`, `FORGE_ENV_ROOT=/cache/env`, `FORGE_ENV_PREFIX=/work/env`, `FORGE_ENV_LANE_TOOLS`, proxy variables). Off: neither is present.
- `bin/pool/agent.mjs`: `launch` adds `FORGE_ENV_IMAGE` (the lane image, part of the key) and, after the lane container started, calls `ensureEnv`: one helper container `cs-envbuild-<cache key>` (label `computeshare.env=1`, so the sandbox orphan reaper ignores it; `--rm`) per cache volume, at most every `ENV_ENSURE_GAP_MS` (5 min). Args come from the pure `envEnsureArgs`. It mounts only the repo's cache volume and runs `forgedock env ensure` (clone from `/cache/git/<slug>.git`, build if missing, stage, gc). Never awaited; a failure is a log line. Agent config: `env_build_cpus` (2), `env_build_mem_gb` (4).
- Mounts are unchanged: the store is `/cache/env`, on the volume that already holds `/cache/work/<id>` (#5696), so a claim is a rename. `bin/pool/warm.mjs` keeps `env_snapshots` in the stored warm spec.
- `pool/image/entrypoint.sh` writes the apt proxy file when `FORGE_APT_PROXY` is set. `pool/services/` holds the opt-in proxy and git-mirror compose file (not started by anything).
- Tests: `bin/tests/env-library.test.mjs`.

## Entry 2026-11-15 — CI runner events (#5688, parent #5687)

- `bin/pool/ci-events.mjs` validates and stores events pushed by CI runners; `bin/pool/router.mjs` exposes them.
  - `POST /ci/events` (auth class `ci`: a bearer from router config `ci_tokens[]`, or the fd token). The body is one event or an array of at most 200. The whole array is validated first, so one bad event stores nothing. Replies 202 `{accepted, seq}`.
  - `GET /ci/events?repo=&sha=|pr=&since=<seq>&wait=<s<=60>` (fd token only) long-polls and returns `{events, next}`. Resume with `since=next`.
- Event keys: `type` (`job_started|step_started|step_failed|test_failed|job_finished|runner_unhealthy`), required `repo`, `sha`, `run_id`, `job`, `ts`; optional `pr`, `step`, `exit_code`, `class`, `lines[]` (at most 40, each at most 500 chars), `test{id,file,line,message}`. A missing or malformed key is 400 naming it. Over the line or batch limits is 413. Unknown keys are dropped.
- Ingest stamps `received_at` and a global monotonic `seq` (restored from the NDJSON on restart).
- Memory is a circular ring per (repo, sha) holding 2000 events with a 24 h TTL. Disk is `<state_dir>/ci-events/<repo-key>.ndjson`, appended once per request per repo. It rotates to `<repo-key>.<YYYY-MM-DD>.ndjson` on a new UTC day, and the last 24 h are reloaded on start.
- Bench (`bin/pool/ci-events.test.mjs`): 10 000 events in batches of 200 ingest at well over 2000 events/s, with RSS growth under 50 MB (about 60k events/s and +14 MB on the dev host).
- The router is reached directly on :7710, so no ingress rule is involved.
- Classifier (#5690): `bin/lean/ci-classify.mjs` `classifyCiFailure({step,lines,test,flakes})` returns `{class,signature,downstream}` with `deterministic-setup`, `generated-artifact-stale` (both `downstream: true`), `infra` (`INFRA_SIGNATURES`), `flaky-suspect` (ledger `signature_hash` hit, only over a would-be `code`) and `code`. A test failure is never setup/stale. `createCiEvents` fills `class` on `step_failed`/`test_failed` events that carry lines or a test but no `class` (options `classify`, `flakes()`; the router passes no ledger yet). `failFastDecision(event, policy)` answers `cancel` only for downstream classes under `fail_fast: deterministic` (default `off`); cancelling is the subscriber's job, never the router's.

## Entry 2026-11-16 — agent bundle closure (1.61.0 outage)

The router ships agents only `AGENT_BUNDLE_PATHS` (`package.json`, `bin/pool`, `pool`; `router.mjs`, used by `sendBundle` for self-update and bootstrap). 1.61.0's `bin/pool/ci-events.mjs` statically imported `../lean/ci-classify.mjs`, so every self-updated agent crash-looped with `ERR_MODULE_NOT_FOUND` at import (Legion down ~2.5 h). Rule: nothing under `bin/pool` may statically import outside the bundle paths; router-only extras load with a dynamic import that tolerates `ERR_MODULE_NOT_FOUND` (ci-events: classify becomes null and events pass through unclassified). `bin/tests/pool-agent-bundle.test.mjs` unpacks exactly the bundle paths into an empty directory and imports `cli.mjs`, `agent.mjs`, `router.mjs` and `ci-events.mjs` there; it fails on the 1.61.0 code.

- **dind /work bind sources (#5738, 1.61.1 regression):** since #5696 the lane's `/work` is a symlink to `/cache/work/<id>`, and the private dockerd shares only the cache volume. The dind container now boots through `DIND_BOOT`, which makes the same `/work` symlink before `exec dind dockerd`, so `docker run -v /work/...` from a lane resolves to the checkout. Verified on Legion: the old boot gives an empty dir and the new boot reads the file. Any change to sandbox mounts needs this dind bind canary on a pool host before agents are upgraded.

## Entry 2026-11-21 — WSL host-disk admission (#5733)

- `bin/pool/health.mjs` `hostDiskFree` (WSL only: osrelease /microsoft/i; Lxss BasePath drive via reg.exe over the interop socket, else /mnt/c) feeds `host_disk_free_gb`/`host_disk_low` in agent `capacity()`; `launch` answers 503 `pool.disk_low` under `min_host_disk_free_gb` (25) or after `sandbox_disk_growth_gb` (3.5) × (active + 1), and the router skips `host_disk_low` agents with its own 503 `pool.disk_low`. It is a capacity deferral (lane `SANDBOX_CAPACITY`), never a failure; unreadable means no field and no gate.

## Entry 2026-11-22 — CI runner autoscaler (#5695)

- `bin/pool/ci-autoscale.mjs`: pure `admitRunner`, `planScale`, `runnerPriority`, `decisionRecord`, plus `createAutoscaler` (router side). Off unless router config `ci_autoscale.enabled`; with it off, lane sizing and placement are untouched.
- Demand: `POST /ci/workflow-job` (auth class `ci`, same tokens as `/ci/events`; the router is reached directly on :7710, so no ingress rule) takes a GitHub `workflow_job` payload (queued, in_progress, completed), keyed by the label in `ci_autoscale.labels`. A jobs-API poll (`ci_autoscale.repo`, every `poll_s`, default 300) is the fallback; queued entries the API no longer lists, and any entry over 6 h old, are dropped.
- Reconcile runs at the end of the router `tick` on the agent with the most MemAvailable. It plans starts and stops per label (`min` warm, `max` cap, size from `labels.<l>.size`, default 1 cpu / 2 GB), admitted in priority order deploy > release CI > lane > PR CI. A waiting lane holds ordinary PR CI. Start = `generate-jitconfig` then agent `POST /runners`; stop = agent `DELETE /runners/:name` for an idle runner above `max(min, queued)`.
- Floors (`ci_autoscale.floors`): `mem_available_gb` 3, `load_per_cpu` 0.8, `net_rx_mbps_max` (unset = off; deploy is exempt), and `lane_floor` `{cpus, mem_gb}` (default 2 / 3) of pool `cpus_free`/`mem_free_gb` that CI never takes. `windows: [{from,to,why}]` (ISO) are maintenance windows: no starts and no stops.
- `dry_run: true` logs every decision (`ci-autoscale {...}` with `inputs`) and starts nothing; the last 200 are kept on `router.autoscale().decisions`.
- Agent: `POST /runners` starts one `--ephemeral` runner container from a JIT config (`--rm`, 2 GB cap, label `computeshare.runner=1`, not `computeshare=1`, so the orphan reaper ignores it; the config goes in a 0600 env file, never argv). Runners count in `cpus_free`/`mem_free_gb` like a lane. `capacity()` adds `runners` and `net.rx_mbps` (host RX since the last call). Exited runners are forgotten by the reaper sweep.
- Deferred: per-job measured sizes and result reporting (need the AlterLab #40991 dataset endpoint), live acceptance numbers (queue wait, 14-day OOM, before/after CI wall time), and promotion of the flag (first cohort `alterlab-ci` only, 3 days of `dry_run` first).
