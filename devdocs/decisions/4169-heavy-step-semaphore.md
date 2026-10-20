---
issue: 4169
status: fresh
anchor: bin/lean/heavy.mjs
created: 2026-10-20
---

# ADR: gate heavy steps with a memory-reserving host semaphore, not whole lanes on load average

## Context

Lane admission and the builder governor used one predicate: free mem, free tmp and load average (`load/core > 4`). Load average lags by minutes and is phase-blind. A lane waiting on the API (most lane time; 29 `claude --print` processes used 36% CPU in total) was SIGSTOPped because other lanes ran `tsc` (~2 GB, 1 core each). Lanes flapped between paused and running, and the effective ceiling on the measured 4-core / 16 GB AlterLab host was about 6 lanes (#4169 baseline).

## Decision

- Two step classes. LLM phases are bounded only by the host lane cap (#4191) and account holds (#4190). Heavy steps (installs, type checks, linters, test runners, containers) take a slot of one host semaphore (`bin/lean/heavy.mjs`, `schedDir()/heavy.json`).
- The grant is sized by cost and live free memory: at most max(1, cores − 1) holders, and MemAvailable minus the 2 GB reservation of each step still ramping (< 60 s) must leave the step's 2 GB plus a 1 GB reserve. Swap is never free memory. Waiters are ordered by priority, then FIFO.
- Builder-run commands are gated by per-run PATH shims written after the toolchain shims, so the real binary of a heavy shim is the pinned toolchain one. Engine-side setup/precheck/split acquire directly. A waiting lane is a sleeping process: it adds no load, and `FORGE_HOST_PARALLELISM` is derived from live heavy holders, not live lanes.
- Load average becomes opt-in (`max_load_per_core`). The governor still pauses on the mem/tmp floors.
- Fail-open everywhere (registry unreadable, lock timeout, `max_wait_s`). A stuck semaphore must not stall the host.

## Rejected

- A prompt rule asking the builder to wrap heavy commands: unenforceable, and a grep-able fact belongs in a script (NORTHSTAR layer 3).
- Scanning /proc for heavy children and pausing them afterwards: it acts after the memory is already committed, and SIGSTOP keeps the RSS.
- cgroup quotas per lane: they cap one lane, not host-wide concurrency, and depend on systemd-run.
- Keeping load average with hysteresis: it still lags and still pauses LLM-only lanes.

## Follow-up

The live check that a 4-core host runs ≥ 20 LLM-phase lanes with ≤ 2–3 heavy steps and no flapping is post-deploy (R4). Read it from the batch report's `waits by phase` / `heavy queue` line.
