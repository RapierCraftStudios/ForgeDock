---
module: pool
glob: "bin/pool/*"
authority: required
token_cost: 300
last_compacted: "2026-11-15"
---

# Module Dossier: bin/pool

Rolling per-module knowledge log. Hard cap: 150 lines.

## Entry 2026-11-24 — pool status table, owner pause/resume (#5885, parent #5857)

- `forgedock pool status` prints one row per host from router `GET /agents`: HOST, CPUS and MEM GB as used/borrowable/total (used = total - free; borrowable = `cpus_borrowable`/`mem_borrowable_gb` on weighted agents, else free), ACTIVE, THROTTLED, PAUSED (`no`, `owner`, `resize`, `yes`), REASON (owner pause, resize drain, idle gate, last drain). Unreachable agents show `unreachable: <error>`. The `<name>: transport <t>` lines follow. `--json` prints the raw `/agents` body as before.
- New `capacity()` fields (also on `/health`): `owner_paused` always; `idle_gate` (the `notIdle` reason or null), `throttled` (count of throttled active lanes) and `last_drain` `{reason, at, sandbox}` only on weighted agents (reservations or `idle_only`), so flat agents gain no priority fields. `paused` is now `cfg.paused || owner_paused`, so the router stops placing on an owner-paused host.
- `forgedock pool pause` / `resume` run on the host itself: they read agent.json (`--config`, default `/etc/computeshare/agent.json`) and call `POST /pause` / `POST /resume` on the agent's own listen address (127.0.0.1 when it binds 0.0.0.0) with the agent token, never through the router; works for outbound agents too. Pause refuses new launches with 503; running lanes finish. The flag is the file `owner-paused` beside agent.json (state dir when no config path), so it survives restarts; it is separate from the resize drain's `cfg.paused`, which a resize clears.
- Uninstall from the box is the installer's `--uninstall`, owned by #5883; not in the pool CLI. Tests: `bin/tests/pool-cli.test.mjs`, `bin/tests/computeshare.test.mjs` (#5885).

## Entry 2026-11-23 — Outbound-only agent transport (#5882, parent #5857)

- An agent enrolled without `url` (`POST /enroll` {token,name}) is stored `{name, transport:"poll", token}`; the router never dials it. `agentCall` (`bin/pool/router.mjs`) enqueues the request and awaits the reply (rejects at once when the agent has not polled for `poll_offline_s`, default 60, so callers answer 502 / `ok:false` in `capacities()`).
- Agent side (`startPoll`, `bin/pool/agent.mjs`, on when `outbound: true` in agent.json): `GET /agent/poll?wait=25` (router clamps to 55s; 204 on timeout; the poll is the heartbeat), runs the request on its own bearer-checked API via loopback, `POST /agent/reply/:rid`. Reconnect backoff 1s..30s. Queue is in memory (a router restart drops it).
- The local listener stays for the lanes' credential calls; `install-agent.sh` binds it to the docker bridge (`AGENT_LISTEN_HOST`, default 172.17.0.1) in outbound mode. `forgedock pool enroll --outbound` prints `OUTBOUND=1 install-agent-linux.sh ...`.
- Long-poll chosen over WebSocket: no stdlib WS server, no new dependency. Tests: `bin/tests/pool-outbound.test.mjs`.

## Entry 2026-11-22 — Priority classes, reservations, borrowing (#5856)

- `spec.priority` is `reserved | normal | borrow` (default `normal`; anything else is 400). Lanes send `borrow` (`bin/lean/sandbox-remote.mjs`). Agent config: `reservations: [{name, cpus, mem_gb}]`, `idle_only`, optional `idle_max_owner_load_per_core` (0.5), `idle_min_free_mem_gb` (4), `cpu_shares` ({reserved 4096, normal 1024, borrow 128, throttled 2}), `drain_grace_s` (20), `cores`.
- Admission (`admit` in `bin/pool/agent.mjs`): reserved is admitted up to its reservation whatever borrow/lanes use (503 `pool.reservation_full` past it, 400 for an unknown name); it skips the live-load gate. Reclaim order: every borrower is throttled (`docker update --cpu-shares 2`), then the newest borrowers are SIGTERMed (the lane checkpoints and reports `run.interrupted`, so the router/dispatcher reschedules it), SIGKILL after `drain_grace_s`, only as many as cpu and memory need. `normal` only gets space outside every reservation. `borrow` gets any physical headroom, i.e. reserved-but-idle space.
- A reservation is idle when no reserved sandbox holds it; usage inside a running reserved sandbox is not lent (rejected for now: live-usage borrowing, needs `memory.high` which the docker CLI does not expose).
- `idle_only`: borrow is admitted only while owner load per core (host load minus this agent's own sandboxes' sampled cpu) is under the floor and free memory above it (503 `pool.not_idle`). Each `reap()` throttles borrowed lanes when the owner is busy, drains one per pass if that did not help, and lifts the throttle when idle and no reserved sandbox runs.
- Weights (`--cpu-shares`) and the new `/capacity` fields (`cpus_free_unreserved`, `mem_free_unreserved_gb`, `cpus_borrowable`, `mem_borrowable_gb`, `reservations[]`, `idle_only`) appear only when `reservations` or `idle_only` is configured; other agents are byte-identical to before. The router (`fitsPriority`/`headroom`) places reserved on the host holding the reservation, normal on unreserved headroom, borrow preferring free non-reserved capacity.
- One agent per docker daemon: `reap()` removes any labelled container not in its own store, so reservations live inside the single agent.
- `forgedock pool enroll --agent-url http://127.0.0.1:<port>` prints a Linux install command with `AGENT_URL` set (SSH-tunnel hosts).
- Tests: `bin/tests/computeshare.test.mjs` (`#5856`).

## Entry 2026-11-23 — lane disk cap, prune, fstrim, sparse VHD (#5884)

- `bin/pool/disk.mjs` (pure, dependency-free): `laneDiskUsedGb`, `planDiskCap` (ok|prune|full), `fstrimDue`, `runFstrim` (never throws). Keys: `lane_disk_cap_gb` (unset = off, `/capacity` byte-identical), `disk_prune_at_pct` (80), `fstrim_interval_s` (6 h), `fstrim`, `docker_root`.
- `launch` answers 503 `pool.disk_cap` at the cap; the router skips `disk_capped` agents and defers with the same code. From the threshold `reap()` runs label-scoped `containerPrune`/`imagePrune` (`docker.mjs`, #5881 scoping), builder prune and `cacheSweep`, then fstrim.
- Installer: `.wslconfig` `[experimental] sparseVhd=true` plus `wsl --manage --set-sparse` (reverted with the backup on uninstall); Linux enables `fstrim.timer` best effort. Tests: `bin/tests/pool-disk-cap.test.mjs`.

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

## Entry 2026-11-22 — cache volume hygiene (#5757)

- `bin/pool/cache-sweep.mjs`: pure `planCacheCap` (oldest-first, live work dirs never chosen) and `planIdleEviction` (last use known, idle, unreferenced, not never-evict); `sweepVolume` runs in a lane-image container (`docker.sweepCache`, 10 min timeout, source passed via env) and ages out uv/npm/pip/poetry, forge-depcache, env entries, prunes pnpm, `git gc --auto`.
- `agent.mjs` `cacheSweep` runs from `reap()` every `cache_sweep_interval_s`; failures land in `/capacity` `cache_sweep_error` (also work-dir sweep/destroy failures), sizes in `cache_volumes`. Volumes are created with label `computeshare.cache=1` (`docker.createVolume`); `gc.mjs` reports them, never reclaims (`forgedock.owner=1` stays the only reclaim label). Entrypoint writes `/cache/.last-used`.
