# ForgeDock lane lifecycle + storage + network audit (2026-11-26, engine v1.67.0)
Legend: [M] measured live, [L] from batch logs (FD batch b20261122-194452-2473210 n=186 lanes; consumer-repo-A b20261117-081850-82242 n=675), [I] inferred from code.
FD = ~/.local/lib/node_modules/forgedock

## 1. Lifecycle (remote/pool lane)
| # | Stage | Code | Where | FD med/p90 | AL med/p90 | Disk/RAM | Failure seen | Cleanup |
|---|---|---|---|---|---|---|---|---|
| 1 | queue/admission | lean/orchestrate.mjs, admission.mjs | Arch | 530s / 11212s | 2141s / 72722s [L] | none | waits dominate wall | n/a |
| 2 | mirror seed (dispatcher bundle of Arch clone via router to agent) | lean/sandbox-remote.mjs:297-304, mirror-bundle.mjs, pool/router.mjs:338-355, pool/mirror-seed.mjs | Arch->router->agent | up-to-date: 1 GET /mirrors | same | 0 | 24 of 120 seeds fell back to GitHub (10 "mirrors HTTP 404", 14 "seed HTTP 422") [L] | .part files in agent seed dir |
| 3 | container launch | pool/agent.mjs:440-527 | agent host | in sandbox_start | | cap 4cpu/4GiB, no --init | zombies 72-1408/lane [M earlier audit], 0 on host-A at 14 min [M] | destroy() agent.mjs:558 |
| 4 | entrypoint checkout: `git clone --shared` from the per-repo bare mirror (or `--reference` + GitHub if unseeded) | pool/image/entrypoint.sh:60-95 | sandbox | folded into sandbox_start | | .git 1-6 MB (alternates) + a FULL working tree of /work/repo: 31 MB (FD) / 299 MB (AL) [M] | | rm -rf /cache/work/<id> |
| 5 | fetch lane | lean.mjs:1657 | sandbox->GitHub | 1s/2s | 2s/3s | | | |
| 6 | claim (labels, STARTED comment) | lean.mjs:1660 | sandbox->GitHub API | 10s/18s | 12s/20s | | total 153 min on AL batch | |
| 7 | resume_probe (gh pr list + ls-remote + salvage) | lean.mjs:1691 | sandbox->GitHub | 2s/4s | 3s/7s | | | |
| 8 | sparse_plan/git_worktree_add/sparse_checkout/worktree_add: SECOND checkout, `git worktree add` at repo/.claude/worktrees/lean-N | lean.mjs:1741-1816, lean/worktree.mjs | sandbox | 1s/2s + 1s/3s | 5s/14s + 6s/16s | FD 150 MB (31 unique), AL 1.3-3.0 GB (245-285 MB unique when deps hardlink) [M] | lock races (retry) | dir removed with /work/<id> |
| 9 | deps_install / depcache (hardlink from /cache/forge-depcache) | lean/depcache.mjs; entrypoint.sh:25-34 | sandbox | FD: not a phase (cache hit) | 244s / 735s, n=323/675 lanes, 1823 min total [L] | cold: lane unique 1.1 GB (AL, lane 41741 [M]); hit: ~245 MB | registry downloads, poetry fails | stores persist in cache volume |
| 10 | plan/contract/implement/validate/precheck | lean.mjs | sandbox+model API | plan 96s, implement 330s, precheck 143s (FD med) | 193s / 359s / 113s | claude CLI 270 MB per call | heavy_queue precheck FD 28s/358s | |
| 11 | review, fix, push, PR | lean.mjs:1141 push, 1101 salvage push | sandbox->GitHub | review 29s | 27s | | salvage branches forge-salvage/<issue>-<sha> | |
| 12 | ci_wait | | sandbox->GitHub | 417s/765s | 13s/24s | | 112 waits FD | |
| 13 | base_sync | | | 81s/470s | 176s/649s | | | |
| 14 | merge | | | 33s/431s | 33s/49s | | | |
| 15 | result/log return | sandbox-remote.mjs:256-262,322-326 | sandbox->agent->router->Arch | logs polled by cursor, result JSON + runLog | | | | agent wipes r.dir |
| 16 | teardown | agent.mjs:558-575 destroy(): docker rm, removeWorkDir, wipe, usage row; reap() 751; keep_exited_s 2h, disk-pressure 24h | agent | | | | exited kept up to 2h (0 exited on both hosts now [M]) | work sweep every 10 min (agent.mjs:771), cache sweep 1 h |
Totals: sandbox_start (steps 3-9 minus deps) median 26s FD / 35s AL, p90 50s / 59s [L]. Of this, claim is 40%, GitHub round trips (fetch+claim+probe) ~13s of 26s. Local git work (sparse+worktree) 2-11s.

## 2. Repo storage per host [M]
Design: ONE bare mirror per repo per host (in the per-repo cache volume cs-cache-<slug>, /cache/git/<slug>.git), plus per-lane `git clone --shared` (alternates, .git only 1-6 MB) and then a second `git worktree add` for the working tree. So the owner's intent (one full object store per host, light lanes) is IMPLEMENTED for objects, but each lane carries TWO checkouts.
| Host/repo | mirror | depcache (shared) | per-lane unique | per-lane apparent |
|---|---|---|---|---|
| host-B consumer-repo-A | 387 MB, 10 packs | 3.6 GB (2.76 GB snapshot + 0.93 GB stores) | .git 4 MB + redundant clone checkout 299 MB + wt unique 282 MB = ~585 MB | 3.3 GB (du), 1.5 GB web + 1.4 GB services in wt |
| host-B ForgeDock | 162 MB, 6 packs | 788 MB | .git 2 MB + clone checkout 31 MB + wt unique 31 MB = ~64 MB | 181 MB |
| host-A consumer-repo-A (7 lanes) | 353 MB, 24 packs | 2.1 GB | 245 MB (hardlink hit) up to ~1.4 GB (lane 41741: only 138 MB shared, cold/copy) + 299 MB clone | 1.26-1.6 GB |
| host-B spectracut | 1.3 MB | 503 MB | | |
| host-A tenant-C vol | | 16.4 GB cache (/cache/tenant-C) | | |
- Dependency trees: node_modules/.venv are hardlinked from forge-depcache (link counts 2-4, same fs ext4, worktree under /cache/work so no EXDEV, #5696) [M]. Shared bytes AL ~2.7 GB per lane on hit. NOT per-lane copies, except on a miss (1.1 GB unique observed).
- 3 volumes per host are fully separate (each repo has its own volume): pool-wide dedup across repos is nil, but there is exactly one mirror per repo per host. Mirrors accumulate packs (host-A AL 24 packs) because seed/fetch adds packs and only `gc --auto` runs (cache-sweep.mjs:101).
- Waste: the clone checkout at /work/repo is never used for work (the lane runs in the worktree) -- 299 MB per AL lane, 31 MB per FD lane. Two checkouts per lane is the one real duplication.

## 3. Cleanup [M/I]
- Merge: lane ends, agent destroy() removes container, /cache/work/<id> (clone + worktree + hardlinks), result dir; mirror and depcache stay. No orphan work dirs found on host-A [M]; host-B has `cs-depcache-prune-auto` leftover dir (1 MB, 24 min old) [M].
- Failure/relaunch: lane branch + forge-salvage/* pushed to GitHub (lean.mjs:1141); worktree salvage refs refs/forge/salvage live in the lane clone and die with it. Disk pressure keeps worktree 24 h (agent.mjs:117, 566).
- Host loss: lease expiry (agent.mjs:755) then destroy; orphan containers removed by label (agent.mjs:765). Router seedPick cache keyed by sandbox id 30 min.
- Leaks seen earlier: zombies (no --init, agent.mjs:508), exited sandboxes, orphaned lane scopes (not reproduced now: 0 exited, 0 orphan work dirs [M]).

## 4. Network map
| Hop | What | Bytes / frequency |
|---|---|---|
| Arch -> router -> agent: mirror seed | `git bundle` from Arch's own clone, 384 KB raw chunks (512 KB agent cap, 768 KB base64 router cap), per LANE launch | 120 seed attempts in 791 batch dirs: 56 "up to date, nothing sent" (only 2 small GETs), 19 incremental bundles total 313 KB (max 80 KB), 0 full bundles, 24 fell back to GitHub [L]. A full seed of a missing mirror would be the whole repo (AL ~353 MB = ~27 min at 220 KB/s) [I] |
| seed target mismatch | router seedAgent (router.mjs:338) picks by most free CPU keyed to sandbox id; launch() placement is separate | seed may land on host A while lane runs on B; the 404 fallbacks are consistent with that or an old agent [I] |
| repo_source (execution.mjs:149) | github: nothing from Arch, sandbox fetches from GitHub; dispatcher: Arch bundle, fails the lane on error (pool.seed_failed); auto (default): dispatcher then fall back | |
| sandbox -> GitHub git | entrypoint fetch of mirror (3 x 90s retries), lane fetch 1-2s, push of branch | deltas only [I]; mirror skipped when seeded and lane ref present |
| sandbox -> GitHub API | gh issue/pr/labels/comments: claim 10-12s alone | dozens of calls per lane; each `gh` spawn also asks the agent for a token (TTL 120 s, agent.mjs:CRED_TTL) which the agent fetches from the router (hourly) |
| sandbox -> registries | depcache miss: npm/pnpm/uv/poetry; AL cold installs 323 of 675 lanes, median 244 s, p90 735 s; FD ~80% hit [L] | |
| sandbox -> agent -> router -> Arch | lane.log by cursor (pullLogs, sandbox-remote.mjs:257), result JSON + run log (:322), relay for host wrappers (cs-relay) | text only; no repo/worktree streaming back. Patches/commits go to GitHub, not Arch [I] |
| Arch -> sandbox | forge.yaml as env (CS_FORGE_YAML_B64) | KBs |
Slow link (host-A ~220 KB/s): incremental seeds (<80 KB) cost <1 s; any full seed or large delta serializes through the router with 120 s per chunk call and 3 retries and no whole-seed deadline seen; failing falls back to GitHub in auto. Claim/fetch/probe are many small API calls, so latency (not bandwidth) sets the ~13 s GitHub share of sandbox_start [I/L]. Not measured live: actual slow-link failures.

## 5. Verdicts
sound: bare mirror + alternates clone; depcache hardlinks; work-dir teardown; lease reaper.
wasteful: second (clone) checkout per lane; claim (10 s of GitHub writes before any work); cold AL installs (244 s median x 323 lanes); mirror seed on every launch even when up to date.
fragile: seed host != run host; auto fallback hides 20% seed failures; no --init; mirror packs not repacked.

## 6. Ranked fixes (fewest steps/hops first)
1. Delete the clone checkout: `git clone --shared --no-checkout` (or `-n`) in entrypoint.sh:62 and :83, create the worktree from it; saves 299 MB/AL lane, 31 MB/FD lane and ~1-3 s. Better: let lean use the clone directly (skip `git worktree add`, lean.mjs:1816).
2. Make the agent own the mirror: remove the Arch->router->agent seed (mirror-bundle.mjs, router seedAgent) for hosts with GitHub access; agent keeps the mirror fresh with `git fetch` (entrypoint.sh already does it). Removes 3 hops, the 404/422 fallbacks and a failure mode; set repo_source github default. Gain: lane start -0 to 2 s, big reliability. Keep dispatcher mode only for a link-starved host.
3. Pre-warm depcache per lockfile on main push (depcache.mjs, warm.mjs); AL 244 s median, 1823 min across 323 lanes.
4. Move claim off the critical path (lean.mjs:1660): run label+comment in parallel with worktree setup; -8 to -10 s per lane.
5. `--init` on docker run (agent.mjs:508) to stop zombies.
6. Weekly `git repack -ad` + bitmap of mirrors (cache-sweep.mjs:101), host-A AL has 24 packs.
7. Cache lane tokens in the sandbox instead of one agent call per gh spawn (fewer hops).
Minimal local-only lane: agent keeps mirror + depcache; lane = `git fetch` delta, `git worktree add` (no clone checkout), hardlink deps, work, `git push`; GitHub API and model only. Stages 2, 4(checkout), duplicated worktree and the token hop disappear.
Not measured: fetch bytes per lane, slow-link failures, the 404 cause.
