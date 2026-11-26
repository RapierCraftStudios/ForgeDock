# ForgeDock lane compute audit (2026-11-26)

Scope: read-only. Live sampling of host-B (3 samples, 10:35 / 10:38 / 10:42 UTC, plus a cgroup read at 10:44), router `/agents` + `/status`, batch logs, run logs, installed engine v1.67.0 code (`~/.local/lib/node_modules/forgedock`, cited below as `FD/`), host-A + host-B `usage-history.jsonl`.

Legend: **[M]** measured live, **[L]** measured from logs/history, **[I]** inferred/calculated.

Caveat on all live numbers: the 16-17 host-B lanes were all ~9-17 minutes old (started together ~10:27, post-upgrade burst), so they are weighted toward setup/early phases. Steady-state is lighter on CPU than the early minutes.

---

## 1. What a lane reserves vs what it uses

Reservation and caps (router `~/.config/computeshare/router.json`, `FD/bin/pool/router.mjs:268-275`, `FD/bin/pool/agent.mjs:508`):

| | CPU | Mem | Disk | Source |
|---|---|---|---|---|
| Reservation counted by placement (plain lane) | 0.25 | 0.4 GB | 3.5 GB fallback until >=3 `disk_hist` samples (host-B `disk_hist` is `{}`) | router.json `lane`; `agent.mjs:211-218` |
| Hard burst cap (`docker run`) | 4 cpus | 4 GiB RAM + 8 GiB swap, pids 4096 | none per lane | [M] `HostConfig` NanoCpus 4e9, Memory 4 GiB, MemorySwap 8 GiB |
| dind sidecar (only repos with `docker: true`, today tenant-B) | 0.1 | 0.2 GB reserved; caps 2 cpu / 3 GB / 2 GB swap, `--privileged` | own writable layer + shared `/work` volume | router.json `dind`; `agent.mjs:493` |
| Agent allowance, host-B | 12 cpu | 12 GB | - | `/etc/computeshare/agent.json` [M] |
| VM actually behind it, host-B | 20 threads | 17 GB | 1 TB, 17 GB used | [M] `nproc`, `free`, `df` |
| Per-agent lane ceiling (`pool limit`) | | | | `/agents`: host-B `used 16 / ceiling 12`, host-A `used 2 / ceiling null` [M] |

Reservations are already small (burst model). The reservation is not what limits parallelism; see section 5.

Actual use, live on host-B, 13-15 ForgeDock lanes [M]:

| Sample | Lanes | Sum CPU (docker stats) | Sum mem | Per-lane mem |
|---|---|---|---|---|
| 10:35 | 15 | 7.05 cores | 4.56 GB | 0.30 GB |
| 10:38 | 14 | 1.88 cores | 3.92 GB | 0.28 GB |
| 10:42 | 13 | 6.41 cores | 4.63 GB | 0.36 GB |

Per-lane cgroup read at 10:44, 13 lanes, ~17 min old [M]:
- Cumulative CPU 156-889 s each (mean 416 s) over ~1020 s = **0.41 core average**, vs 0.25 reserved, 4.0 cap.
- `memory.peak` 476-1994 MB (median ~650 MB, mean ~880 MB), vs 400 MB reserved, 4 GiB cap.
- `nr_throttled` 31-671 per lane: the 4-cpu burst cap is hit while 13 lanes overlap on 20 threads. Host load average 8.2 / 6.7 / 5.1.

Lifetime history (usage-history.jsonl, finished sandboxes with >=3 samples) [L]:

| Population | n | Duration med / p90 | CPU avg med / p75 / p90 | CPU peak med / p90 | Mem avg med | Mem peak med / p90 / max |
|---|---|---|---|---|---|---|
| host-A, plain lanes (all repos), Oct 24 - Nov 26 | 4508 | 13.8 / 40.3 min | 0.54 / 0.78 / 1.06 | 2.04 / 4.10 | 0.32 GB | 0.56 / 2.32 / 4.0 GB |
| host-A, consumer-repo-A-tagged | 143 | 6.6 / 21.6 | 0.83 / 1.23 / 1.56 | 2.4 / 3.99 | 0.62 | 1.57 / 2.52 / 4.0 |
| host-A, ForgeDock-tagged | 80 | 19.4 / 95.4 | 0.41 / 0.68 / 1.06 | 4.03 / 4.19 | 0.26 | 0.46 / 0.77 / 2.73 |
| host-A, docker (dind) lanes | 592 | 51.9 / 175 | 0.99 / 1.36 / 1.87 | 3.96 / 6.17 | 1.43 GB | 3.14 / 4.34 / 5.64 |
| host-B, lanes >=10 samples (Nov 4 + Nov 26) | 78 | 13.9 / 23.8 | 0.38 / 0.51 / 0.68 | p90 4.11 | 0.37 | 0.61 / 2.31 / 3.13 |

Averages are 3-8x below peaks, and peaks are 3-16x the reservation: a lane is a low-duty process with short CPU bursts (installs, test runs), so average-based reservation plus burst caps is the right model and is what is configured. It is also why 4-cpu caps on 16 overlapping lanes throttle (above).

host-A lifetime totals (5323 sandboxes with >=3 samples) [L]: 2640 slot-hours; 2290 core-hours actually used (avg), 9544 core-hours if you add up peaks; 2966 GB-h avg memory vs 5484 GB-h at peak.

Idle while waiting on the model [I from L]: model API time is 31% of lane wall (ForgeDock batch) and 55% (large Python/Next.js batch). During that time the lane holds a `claude` CLI process (~260-300 MB RSS, ~1-2% CPU) plus the engine node (~110 MB). Nothing else runs.

---

## 2. Where the CPU, RAM and disk go

### 2a. Processes, live (aggregated over 3 samples, per-process RSS from `docker exec ps`) [M]

| Process | Count live (13-15 lanes) | RSS each | Total RSS | Notes |
|---|---|---|---|---|
| `claude --print` (model call, one per in-flight call; up to 3 at once in a lane, e.g. init-enrich) | 6-10 | 260-310 MB | 1.35-2.67 GB (**~35-45% of all lane RAM**) | CPU ~1-2% while waiting; 8-30% for a few secs at start |
| `forgedock run-issue` engine (PID 1 of each container) | 13-15 | 100-137 MB | 1.45-1.67 GB (~33%) | CPU ~0.5%; always resident for the whole lane |
| `node --test` runners (builder/validate) | 8-11 | 55-180 MB | 0.59-0.82 GB | the only real CPU burners: 90-300% each while running |
| `gh api ...` (comment PATCHes, GraphQL issue reads) | 14-18 | 22-42 MB | 0.30-0.50 GB | one Go binary spawn per call; ~1 live per lane |
| bash/tee/sleep/head | ~100+ | tiny | <0.1 GB | |
| **zombies (`<defunct>`)** | **72-1408 per lane** | 0 | 0 | see below |
| dockerd / dind | 0 | - | - | none of the 16 live lanes use docker (ForgeDock repo has no `docker: true`) |
| git, npm/pnpm, tsc, eslint, language servers | ~0 | - | - | ForgeDock repo: no tsc/eslint; deps come from the shared cache (below). Not seen in any sample. |

Zombie leak [M]: container PID 1 is `node forgedock run-issue`, which does not reap orphaned children, and `docker run` has no `--init` (`FD/bin/pool/agent.mjs:508`). At 10:44 zombie counts were 72, 500, 717, 357, 542, **1408**, 349, 357, 361, 352, 223, 685, 706 (lane ages ~17 min; worst rate ~80 zombies/min). `--pids-limit` is 4096, so a lane that lives >~50 min at the worst rate hits the limit and fork fails; lanes can live up to `max_lifetime_s` = 6 h (host-B `agent.json` 21600). Zombies cost no RSS but eat PIDs and a little kernel memory. This is hygiene and a latent failure source, not a compute sink.

`--test-concurrency` seen in live runners: 1, 2, 5, 6 and **20** (lane 5844 at 10:35, `bin/lean/lean.test.mjs`). The engine derives worker counts from `cpus()` of the VM (20), not the container's 4-cpu quota or the lane's reservation (`FD/bin/lean/admission.mjs:12-16 hostParallelism`, `FD/bin/lean/lean.mjs:967 verifyParallelism`). Twenty workers x ~60-180 MB can spike a lane to 2 GB and trips the CFS throttle.

### 2b. Phases (what the lane actually does with its wall time) [L]

Batch b20261122-194452-2473210 (ForgeDock, 167 finished lanes with phase data, median wall 24.3 min, p90 49.8; wall excludes `queue_wait`):

| Class | Hours | Share of wall | Notes |
|---|---|---|---|
| Model API time (plan, implement, fix, review, contract) | 22.3 | **31.2%** | remote; lane idle |
| GitHub wait: `ci_wait` | 15.1 | **21.1%** | median 459 s, p90 781 s per lane; sandbox kept, near-zero CPU |
| Local `precheck` (whole-repo shell tests) | 7.7 | **10.7%** | median 166 s, p90 413 s per lane |
| Session non-model in implement (builder's own tool execution: tests, edits) | 7.6 | 10.5% | |
| Session non-model in fix | 4.3 | 6.0% | |
| Local implement (no model_ms recorded) | 3.5 | 4.9% | |
| Session non-model in plan | 2.3 | 3.2% | |
| GitHub wait: `merge` | 2.2 | 3.0% | |
| `sandbox_start` | 2.1 | 3.0% | median 27 s, p90 51 s; `claim` step median 10.4 s / p90 17.8 s dominates |
| `validate` | 1.6 | 2.2% | |
| `base_sync` | 1.4 | 2.0% | median 69 s, p90 465 s |
| other | ~1.5 | ~2% | |

Batch b20261117-081850-82242 (large Python/Next.js repo, 674 lanes, 796 h wall, median 15.3 min, p90 48.8): model 55.5%, precheck 11.8%, plan non-model 9.3%, merge wait 7.2%, implement non-model 4.8%, **deps_install 3.8% (30.4 h; median 244 s, p90 735 s)**, sandbox_start 1.0%, ci_wait 1.4%.

Queue wait (not in wall): sum 179.8 h for 164 ForgeDock lanes (median 364 s, p90 11,948 s) and 4,560 h for 674 lanes in the large-repo batch (median 2154 s, p90 72,722 s). Queueing, not execution, dominates the elapsed time of a batch.

Per-phase median / p90 (ForgeDock batch, seconds): queue_wait 364 / 11948; sandbox_start 27 / 51; plan 104 / 223; implement 364 / 1382; precheck 166 / 413; review 29 / 89; fix 170 / 1149; ci_wait 459 / 781; merge 33 / 304; base_sync 69 / 465; contract 43 / 62; validate 0 / 50.

### 2c. Setup, deps, precheck, reruns from `~/.forge/runs/*.jsonl` [L]

ForgeDock repo (461 lane logs):
- `DEPS_PREPARED`: 384 hits (median 0.7 s, p90 4.8 s), 94 `miss-installed` (median 13.6 s, p90 56 s). The shared per-repo cache volume (`/cache/forge-depcache`, lockfile-keyed) works: 80% hit. `LANE_SETUP_TIMING deps` sum 0.58 h over 187 lanes.
- `pack_compile` median 15.8 s, p90 58.5 s (0.92 h total), `hotspots` 0.4 s / 9 s, `context_pack` 5 s, `heavy_shims` 2.2 s: setup is small.
- **Precheck runs the same 11 whole-repo shell checks every round regardless of the diff** (`PRECHECK_COMMANDS`, 331 rounds, 254 lanes): per-lane total median 149 s, p90 483 s, **14.8 h total**. Top four = 12.9 h (87%):

| Command | Total | Median | p90 |
|---|---|---|---|
| `bash scripts/verify-phase-trail.test.sh` | 4.05 h | 32 s | 94 s |
| `bash scripts/classify-finding.test.sh` | 3.92 h | 28 s | 97 s |
| `bash scripts/lint-dispatch-prompt.test.sh` | 3.13 h | 26 s | 71 s |
| `bash scripts/check-command-side-effects.sh` | 1.75 h | 14.5 s | 35 s |
| `bash scripts/forge-root.test.sh` | 1.09 h | 9 s | 26 s |

  These are "learned" commands; the test map only filters mapped commands (`FD/bin/lean/lean.mjs:2862-2867`, `FD/bin/lean/precheck.mjs:150 planPrecheck`), unmapped ones always run (comment at lean.mjs:2863: "unmapped ones always run (#4315)").
- Reruns: `VALIDATE_RERUN` 106 events, precheck rounds median 1, p90 2 (up to 4 in the large repo).
- `CI_PRECHECK_PLAN` last event: `unrunnable ... yq not found` inside the lane (the CI-derived plan is silently skipped in the sandbox).
- `LANE_PAUSED reason "host over ceiling"`: **1057** events in ForgeDock lane logs, **5143** in the large repo's (`FD/bin/lean/lean.mjs:1187`). Paused lanes keep their slot but do nothing.
- `DEPS_PREPARED` count is per ecosystem per lane.

Large Python/Next.js repo (1610 lane logs):
- `LANE_SETUP_TIMING deps` median **121 s**, p90 **567 s**, sum 66.6 h over 949 lanes; `env_setup` median 63 s, p90 277 s, sum 28.5 h; `pack_compile` median 36 s, p90 92 s.
- `DEPS_PREPARED`: poetry hit 3959 (median 3.3 s), poetry `miss-installed` 1997 (median 13 s, p90 50 s), **poetry `failed` 1041** (median 13.9 s, p90 174 s), npm hit 628 (8 s), npm `miss-installed` 264 (median **153 s**, p90 333 s), npm `failed` 28 (median 518 s, p90 1028 s), `materialize-fallback` 30 (up to 1.6 M ms). Roughly one in three installs is a cold install; ~15% of poetry attempts fail and are paid for anyway.
- Precheck is one `consumer-repo-a-lane-checks.sh` call: median 6.4 s but p90 **429 s**, 26.9 h total over 881 runs; precheck rounds p90 4.
- Same `LANE_PAUSED` storm: 5143 pause events.

### 2d. Disk [M unless marked]

| Item | host-B | host-A |
|---|---|---|
| Lane image `forgedock-lane:1.67.0` | 1.82 GB, shared by overlay (not per lane); 1.46.0 image still present 1.81 GB | `1.66.0` 1.82 GB + `-t4bef...` 2.01 GB + `fd-prebuild:1.64-1.66` 1.82 GB x3 + `computeshare-lane:1` 1.8 GB + dind 527 MB: **images 8.06 GB, 4.5 GB reclaimable** |
| Container writable layers | 1.66 GB for 13 lanes (~128 MB each at ~17 min; was 556 MB for 15 at ~8 min, so ~7 MB/min/lane) | 180 kB (idle) |
| Sandbox dir (`/var/lib/computeshare/sandboxes/<id>`) | 16 KB each | `sandbox_disk_mb {}` (idle) |
| Per-repo cache volume `cs-cache-<repo>` (worktrees + depcache + git mirror) | `/cache/work` 800 MB for ~14 sparse worktrees (~57 MB each); depcache 780 MB; git mirror 154 MB. 3 volumes, 6.3 GB total, 4.8 GB reclaimable | 13 volumes, **40.9 GB, 28.4 GB reclaimable**; forgedock volume 14.4 GB with ~100 `repo-xxxx` depcache entries of 0.1-0.2 GB |
| Host disk | 1 TB, 17 GB used, 940 GB free | C: 192 GB free (`host_disk_free_gb`), growth 1.4 GB/h |
| Exited sandboxes kept | 0 of 13 non-Up | 2 containers (idle) |

Disk per ForgeDock lane is about 60 MB worktree + ~130 MB writable layer: negligible. It is not what limits lanes on either host today. For the large Python/Next.js repo it is bigger (depcache snapshots per lockfile), but still below the reservation.

Disk guard (installed `FD/bin/pool/agent.mjs:209-218`): host free minus the sum of every running lane's reservation (p90 of that repo's recorded `diskPeakMb`, fallback `sandbox_disk_growth_gb` = 3.5 GB) must stay above the floor (`host_disk_floor_gb`, default 25 GB). On host-A: (192 - 25) / 3.5 = **47 lanes**. On host-B: ~260. On host-B `disk_hist` is `{}`, so the 3.5 GB fallback applies to every lane (about 60x the measured need for ForgeDock), but is not binding.

### 2e. Cost of a docker-in-docker sidecar [L for host-A history, I for fixed overhead]

host-B and host-A currently run no dind lanes (idle host-A, host-B lanes are ForgeDock). From host-A history (5323 sandboxes):

| | n | Slot-hours | Core-hours (avg) | Mem GB-hours (avg) |
|---|---|---|---|---|
| plain lanes | 4731 | 1700 | 1096 | 873 |
| docker/dind lanes | 592 (11%) | 941 (36%) | 1194 (52%) | **2093 (70%)** |

A dind lane lives 52 min median (p90 175) vs 13.8 min, uses 1.43 GB average memory (peak 3.1 median, 4.3 p90, 5.6 max) vs 0.32 GB, i.e. roughly 15x the GB-minutes of a plain lane. The fixed cost of the sidecar itself (dockerd + containerd idle, 527 MB image, `--privileged`, separate writable layer, `/work` volume per lane) was **not measured** (no dind lane running); typical idle dockerd is ~100-200 MB RSS [I]. The reservation is only 0.1 cpu / 0.2 GB for the sidecar while the observed average of a docker lane is 1.43 GB, so dind lanes are under-reserved by ~5x and over-commit the host; the burst model hides it until memory is short.

---

## 3. Required vs wasted

| Item | Verdict | Evidence |
|---|---|---|
| Model wait (31% / 55% of wall) | Required (it is the product). Only cost to the host is the `claude` CLI RSS 270 MB per in-flight call | [L][M] |
| CI wait (21% of ForgeDock wall) with the sandbox, engine and lease held | Waste of slot, not of CPU. Lane count ceiling and `max_remote` treat it as a full lane | `ci_wait` 15.1 h / 71.6 h; `FD/bin/pool/router.mjs:291-306 lanesOn` counts every `fdrsbx-` sandbox |
| Merge wait + hold + base_sync idle | Same (3% + 2%) | |
| Whole-repo precheck shell tests regardless of diff (ForgeDock: 14.8 h, 11% of wall, ~1 core each) | **Waste** for diffs that do not touch `scripts/` or the checked areas; they are also rerun on round 2 | `PRECHECK_COMMANDS` |
| Cold dependency installs (large repo: ~1 in 3; poetry 1041 failures; npm cold median 153 s, p90 333 s) | **Waste**: the shared lockfile-keyed cache exists and works at 80% for ForgeDock; misses/failures are paid per lane | `DEPS_PREPARED` |
| Per-lane `deps` + `env_setup` on large repo: median 121 s + 63 s, p90 567 s + 277 s; 95 h total over 949 lanes | Mostly waste (should be a cache hit/snapshot) | `LANE_SETUP_TIMING` |
| Lanes pausing on "host over ceiling" 1057 / 5143 times | Waste: lanes already admitted then stall; slot held, no work | lean.mjs:1187 |
| `deferred sandbox.capacity` re-queues: 2972 of 3784 batch-log rows (79%), 940 in one recent window across 25 issues, each retried every 60 s | Dispatcher churn on Arch (schedd ~13.6% CPU avg, 258 MB RSS), no sandbox cost | `log.jsonl`, `efficiency.json` |
| Test worker counts sized from the VM's 20 threads inside a 4-cpu-capped container | Waste/instability: `--test-concurrency=20` seen live; 31-671 CFS throttle events per lane | live |
| Zombie accumulation (PID 1 not reaping, no `--init`) | Latent failure; pids-limit 4096 reachable in ~50 min worst case | live |
| Per-lane dind sidecar | Required only for repos whose tests need containers (tenant-B), but it makes those lanes ~15x heavier than plain lanes, under-reserved ~5x | host-A history |
| Keeping exited sandboxes (`keep_exited_s` 2 h; `keep_disk_pressure_s` 24 h) | Not a problem right now: 0 exited on host-B, 2 idle on host-A | [M] |
| Lane image 1.8 GB and old image versions on host-A (4.5 GB reclaimable) and old cache volumes (28 GB reclaimable) | Cleanup, not a parallelism limit | [M] |
| `claude` CLI spawn per call (~270 MB RSS, up to 3 in one lane) | Required for the current architecture; it is the single biggest RAM line | [M] |
| Many `gh` Go-binary spawns (14-18 at once, 22-42 MB each) | Minor (0.3-0.5 GB total) | [M] |

---

## 4. Dispatcher / GitHub [M unless marked]

- `gh api rate_limit` on Arch (the bot installation token shared with the lanes): core 1,373 used of 15,000 in the current hour window (35 min in, i.e. ~2,360/h = 16%); GraphQL 730 of 10,000 (~760/h = 7.6%). That is with ~16 lanes plus the Arch dispatcher on the same installation. Linear extrapolation [I]: ~150 core calls per lane per hour, so core budget saturates at ~100 lanes, secondary content-creation limits earlier. Comments per issue in the current window: #5990 118, #5979 78, #5988 45, #5749 44, #6017 44.
- `attemptsPerMerged` 20.33 and `merged` 6 in the efficiency window (`efficiency.json`): most lane attempts end in requeue/defer, not merge.
- Arch itself: `forgedock-schedd` 13.6% CPU avg, 258 MB RSS; router 100 MB, 0.1% CPU; load average 2.0 on 4 threads with several Claude sessions. The dispatcher is not the limiter at ~18 lanes.
- Slot idle causes (`~/.forge/batches/b20261122-194452-2473210/efficiency.json`, 2059.7 slot-minutes idle): operator hold 34%, **auth-pause 17%** (Claude accounts paused), **capacity 11%**, breaker 6%. Achieved concurrency 15.31 of 18 (`maxRemote` 18 in `execution`; forge.yaml still says 21; the live `execution` file wins) = 85%.

---

## 5. What limits parallelism today

Layers, in the order they bite (installed code):

1. **Batch cap**: `execution.max_remote` = 18 (`~/.forge/batches/<id>/execution`; forge.yaml 21). `FD/bin/lean/orchestrate.mjs:828`, `remoteCapped` at :435. Achieved 15.3/18.
2. **Closed-loop K** (`FD/bin/lean/concurrency.mjs`): ceiling = K; halves on any `pool.*` refusal (host_load, host_mem, projected_peak, disk), +1 per observation while MemAvail > 6 GB and load < 1.0 and no refusal for 5 min; refused lanes held 5 min. Log shows climb 0 -> 6 with `factor "disk"` at 09:52, so recovery after a halving is slow (+1 per sample).
3. **Per-agent lane ceiling** (`pool limit <agent> --lanes N`): host-B 12 (`/agents` `lanes {used 16, ceiling 12}`), host-A none. `FD/bin/pool/router.mjs:291-306` (counts every sandbox with id prefix `fdrsbx-`, including ones waiting on CI), enforced at `router.mjs:~388`. This is the binding limit on host-B; the VM has headroom (measured: 4-4.7 GB of 12 allowed used, 1.9-7 of 12 cores used, MemAvailable 13.3 GB).
4. **Agent admission** (`FD/bin/pool/agent.mjs:421-436`):
   - Reservation: `cpus_free >= 0.25` and `mem_free >= 0.4` GB per lane -> 12/0.4 = **30 lanes** by memory, 48 by CPU.
   - Projected peak (#5858): `max(reservation, p75 cpu_avg)` and `max(reservation, p90 mem_peak_gb)` over the repo's last 20 finished sandboxes (>=3 samples, `agent.mjs:170-175 estimateFor`). Today the tagged ForgeDock rows give ~0.5 cpu / 0.41 GB, i.e. about 23-29 lanes. **Risk**: rows without a `repo` tag (older Nov 4 host-B history) are ignored; a single polluted window (mem_peak p90 2.3 GB as in the host-A all-repo history) would put the cap at 12 / 2.3 = ~5 lanes on a 12 GB allowance.
   - Live load gate (`live()`): `load_per_core` max 2 and MemAvailable floor; skipped only for reserved-priority.
   - `host_mem_floor_gb` 4 (`agent.mjs:237`), `host_disk_floor_gb` 25 + 3.5 GB/lane (`:209-218`, host-A = 47 lanes; host-B ~260), optional `lane_disk_cap_gb`.
5. **Hardware measured**: host-B 12 cpu / 12 GB allowed (VM 20 threads, 17 GB), host-A 16 cpu / 19 GB allowed (VM 16 / 20.5 GB). Steady 0.33 GB and 0.41 core per lane [M], peak median 0.65 GB: host-B fits ~29 lanes by CPU average, ~36 by memory average, ~18 by peak memory; host-A ~35 / ~55 / ~29.
6. **Sandbox start**: 27 s median (claim 10.4 s) = 3% of wall; docker launch is not limiting. Router launch round-trip to a poll-transport agent can time out (`/agents` showed host-B "agent did not answer in time" and host-A `aborted due to timeout` at 10:3x), which turns into `sandbox.unreachable`/`capacity` deferrals (230 + 2972 in the batch).
7. **Non-compute limits that currently cost more slots than hardware**: operator hold 34%, auth-pause 17%, breaker 6% of idle slot-minutes. Claude account quota is the real fleet ceiling at high lane counts (not measured here).

Effective lane limit today: **~18** configured (max_remote), **12** on host-B by ceiling (plus whatever host-A takes, up to 30), observed **15-16 running**. Hardware could carry roughly 24-29 on host-B and ~30+ on host-A with today's lane weight.

---

## 6. Ranked recommendations (estimated lanes-per-host gain and where)

Baseline for estimates: one 12 cpu / 12 GB allowance holds ~29 lanes by average CPU / ~18 by peak memory today; the configured ceiling is 12.

| # | Change | Estimated gain | Where (installed `FD/` paths; same files in repo `bin/`) |
|---|---|---|---|
| 1 | **Raise the host-B ceiling** to ~24 and host-A to ~30 (`forgedock pool limit host-B --lanes 24`), keep `host_mem_floor_gb` 4 and the live-load gate as the brake. Config only. Watch `nr_throttled`. | **2x on host-B** (12 -> 24) immediately; +40-60% of fleet lanes | `FD/bin/pool/router.mjs:291-306`, `cli.mjs:184` |
| 2 | **Phase-aware slot accounting**: do not count a lane toward `max_lanes`/`max_remote`/K while it is in `ci_wait`, `merge`, `hold` or auth-pause (it holds ~110 MB, 0 CPU). The agent/lane already knows its phase (`LANE_PAUSED` events, phase timing). Report an `idle` flag in lane lease renewals and have `lanesOn` ignore idle lanes (cap idle ones separately, e.g. 2x). | ForgeDock: ci_wait 21% + merge 3% = **~24-30% more concurrent active lanes** at the same host load | `router.mjs:291-306 lanesOn/atCeiling`; `agent.mjs` lease renew path; `FD/bin/lean/orchestrate.mjs:435,828` for `max_remote` |
| 3 | **Targeted precheck for the ForgeDock repo**: map the 11 shell checks to path globs in the test map (the top 4 are 87% of the 14.8 h) so they only run when `scripts/`, `commands/` etc. change; run learned-unmapped commands once, not on round 2. | -10% lane wall and ~25-35% of ForgeDock lane CPU -> **+20-30% lanes** CPU-wise; also cuts p90 | `FD/bin/lean/lean.mjs:2862-2867`, `FD/bin/lean/precheck.mjs:150 planPrecheck`; repo `forge.yaml`/test map |
| 4 | **Size in-lane worker counts from the container quota, not the VM**: read `/sys/fs/cgroup/cpu.max` (or pass `FORGE_HOST_PARALLELISM` = reserved/burst cpus from the agent env) so test runners use 2-4 workers, not 20. Also pass `FORGE_HEAVY_MAX`. | Removes the 2 GB test spikes and most of the 31-671 throttle events; makes #1 safe: +10-20% effective capacity | `FD/bin/lean/admission.mjs:12-16 hostParallelism`, `lean.mjs:967 verifyParallelism`, `heavy.mjs:11,107-113`; `agent.mjs` env block (~:470) |
| 5 | **Add `--init`** to the lane `docker run` (and dind) so PID 1 reaps children. Optionally lower per-lane `--pids-limit` pressure. | Stability only; prevents the ~50 min pid-exhaustion failure; no lane gain but fewer unexplained `engine-error` | `FD/bin/pool/agent.mjs:508` (and `:493`) |
| 6 | **Large-repo dependency path**: pre-publish depcache snapshots on main push / on lockfile change and use warm sandboxes (`execution.warm_sandboxes`, `FD/bin/pool/warm.mjs`, `lean/execution.mjs:150`); skip retries of a deterministic `failed`; `env_setup` snapshot (env_snapshots). 1997+1041+264 miss/failed events cost ~66.6 h `deps` + 28.5 h `env_setup`. | Large-repo lane local time -2 to -9 min (median 3 min, p90 14 min); about -15-25% lane wall, lanes-per-host +15-25% for that repo | `FD/bin/lean/depcache.mjs`, `lean.mjs:1860-1912`, `FD/pool/image/entrypoint.sh` warm priming |
| 7 | **Reserve dind lanes by measurement**: `estimateFor` already exists but only raises the plain-lane slice; give docker lanes a separate repo estimate (history: 1.43 GB avg / 3.1 GB peak / 1.0 core) and stop under-reserving (0.1 cpu / 0.2 GB). Consider one shared rootless dockerd per host with per-lane namespaces/networks for repos that only need `docker compose` of a DB. | Prevents host OOM when several docker lanes overlap; shared daemon would cut that repo's per-lane mem ~2-3x [I] | `router.mjs:268-275 sizeFor`, `agent.mjs:170 estimateFor`, `:493`; `pool/image` |
| 8 | **Fix the estimator's input hygiene**: tag every `usage-history` row with `repo` (older rows have `null` and are skipped) and use per-lane-class windows, so one 3 GB outlier does not collapse the cap to ~5 lanes. Also seed `disk_hist` so the 3.5 GB fallback does not apply (60x too high for ForgeDock; host-A cap 47 lanes is derived from it). | Avoids an unexplained cliff; host-A +10-20 lanes before the disk guard binds | `agent.mjs:170-175,209-218`, `usageRows()` |
| 9 | **Reduce lane pause/re-queue churn**: lanes pause (`LANE_PAUSED host over ceiling`, 1057/5143 events) after admission and capacity deferrals retry every 60 s (2972 rows). Use the closed-loop K as the only throttle and back off exponentially per issue; reject early with `retryAfter` instead of re-polling. | Frees Arch dispatcher CPU (schedd 13.6%) and removes 79% of batch-log rows; modest lane gain (+5%) | `FD/bin/lean/capwait.mjs`, `concurrency.mjs`, `lean.mjs:1187` |
| 10 | **Hygiene**: prune old lane images (4.5 GB reclaimable on host-A), old volumes (28 GB reclaimable), shorten `keep_exited_s` when disk is tight; cap writable-layer growth (128 MB/lane in 17 min, ~7 MB/min). | Disk only; makes #1 safe on host-A's shared C: drive | `agent.mjs:116 keepExitedMs`, `cache-sweep.mjs` |
| 11 (structural) | **Cut the per-call `claude` CLI footprint** (~270 MB, 35-45% of lane RAM) by serializing the 2-3 parallel sessions per lane (init-enrich fan-out) or reusing a warm session. | Memory/lane -20-30% -> +25% lanes if memory-bound | `FD/bin/lean/effects.mjs:138-151`, `lean.mjs` explore/enrich steps |

Combined estimate, 12 cpu / 12 GB host [I]: #1 (config) + #4 (parallelism) get host-B from 12-16 lanes to ~24-28; #2 + #3 + #9 then give another ~40-60% of **concurrently active** work for the same hardware (since 24-30% of lane time is CI/merge wait and 10% is redundant precheck); so ~35-45 lanes counted against the ceiling on host-B alone, ~50-60 on host-A. At that scale GitHub core API (~150 calls/lane/h, 15,000/h limit) and Claude account quota become the limits, not compute.

---

## 7. What was measured live vs inferred

**Measured live (host-B, 3 samples + cgroup read):** docker stats per lane (CPU, RSS, PIDs), full process tree with RSS per process, per-lane cgroup CPU seconds, memory.peak, throttle counts, zombie counts and PID-1 command, container `HostConfig` caps, `docker system df`, volume/worktree/depcache sizes, VM nproc/RAM/disk, `agent.json`, `usage-history.jsonl`; host-A: images, volumes, `usage-history.jsonl` (5,624 rows), `/status` + `/agents` from router; Arch: schedd/router RSS and CPU, GitHub rate limits.

**Measured from logs:** phase medians/p90 and time shares (two batch logs), setup/deps/precheck timing and counts (run logs), `efficiency.json` idle causes.

**Inferred or not measured:** dind sidecar fixed overhead (no dind lane was running); host-A live behaviour (idle during upgrade); steady-state vs startup CPU (lanes sampled were 9-17 min old); gains in section 6 (arithmetic from the above, not experiments); the ~100-lane GitHub saturation (linear extrapolation); the cause of the 10.4 s `claim` step; which share of `deferred sandbox.capacity` came from ceiling vs memory vs transport timeouts (the log detail is only "HTTP 503").

Repo checkout at `~/Projects/forgedock` (HEAD 8176d2d1) has an older `bin/pool/agent.mjs` (460 lines, no disk guard, no `estimateFor`); all line references above are to the installed 1.67.0 bundle, which is what the pool agents run (`forgedock-lane:1.67.0` image seen live).

Helper scripts used (all read-only, in the scratchpad): `wslrun.sh`, `m2.sh/m3.sh/m7.sh/m8.sh`, `ph.mjs`, `cls.mjs`, `runs.mjs`, `agg.mjs`; raw samples `live1.txt`-`live4.txt`, `usage-mrd.jsonl`, `usage-leg.jsonl`.
