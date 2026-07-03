# Durable Execution Engine — Design Spec

**Date:** 2026-07-03
**Status:** Approved design, ready for implementation planning
**Tracking:** #1256 (keystone), epic #1320 (five foundations of autonomy)
**Scope of this spec:** the durable engine **core** only — phase state machine, run-log, resume, and orchestrator integration for **headless / orchestrated** runs. Verification, learning, economics, and provenance (#1315–#1319) are separate specs that build on this substrate.

---

## 1. Motivation

The pipeline today is a **prose-driven state machine**. `work-on.md` describes a linear walk (Phase 0→7) whose only continuation mechanism is imperative text ("do NOT stop"), and its subcommands reference a numbered state router that `work-on.md` never implements (#1308). Phase transitions therefore depend on an LLM *choosing* not to emit `end_turn` at a Skill-return boundary. This produces the recurring failure classes:

- **review→close stalls** (~half of runs merge the PR but leave the issue open).
- **quality-gate→3H stalls.**
- **"Prompt is too long" deaths** mid-run (#1305), patched with a self-counted "≥20 Skill calls" heuristic.
- **Lossy state** — GitHub prose comments are the de-facto database; resume re-parses them.
- **Blind observability** — progress is inferred from JSONL output files, which are 0-byte on Windows (#1307).

The insight that makes a fix cheap: **`bin/runner.mjs` already owns the Anthropic tool-use loop** (issue #1151). ForgeDock is not locked inside Claude Code's opaque agent loop — it drives its own loop. So the work is not "adopt a runtime from scratch," it is "make the loop we already own durable."

## 2. Goals / Non-goals

**Goals**
- Phase transitions are decided by **deterministic code**, never by an LLM's choice to continue.
- A run survives crash / kill / compaction / rate-limit and **resumes from the last committed phase** in a fresh context.
- State is **machine-readable and shared**, so any machine or the orchestrator can resume and observe a run.
- Eliminate the stall and "prompt too long" classes structurally, not with prose.

**Non-goals (explicitly out; each is its own spec / increment)**
- The interactive Claude Code `/work-on` path (a later increment adopts the same core via hooks).
- Per-turn / mid-phase durability (this spec is **per-phase** granularity).
- The verification gate, learning memory, economic governance, provenance (#1315–#1319).
- Full per-command parity for the standalone runtime (#1151 follow-up).

## 3. Locked decisions

These were settled during design and are not open:

1. **Durability granularity: per-phase.** The engine checkpoints each pipeline *phase*. A mid-phase crash re-runs that one phase (idempotently). Per-turn durability is rejected as over-complex (partial file edits / half-made commits).
2. **State authority: hybrid (local hot + GitHub mirror), GitHub wins on divergence.** A local append-only run-log is the crash-safe hot path; a structured `FORGE:STATE` block on the issue is the durable shared mirror. On conflict the GitHub mirror is authoritative and invalidates the local cache.
3. **First surface: headless / orchestrated.** The engine drives runs through `runner.mjs` — where autonomy matters most and there is no human to un-stick a stall. Interactive Claude Code adopts the same core later.
4. **`FORGE:STATE` is a compact index, not self-describing.** It carries the resume pointer (phase, `committed[]`, branch, pr, version, lease) — **not** the rich per-phase outputs. Rich outputs live in the existing `FORGE:INVESTIGATOR` / `ARCHITECT` / etc. structured comments (which the engine writes anyway). A fresh-clone resume reads the index for *where*, then reads those comments for *content*. This avoids duplicating data and preserves human-readable artifacts.

## 4. Architecture

Five components, each with one responsibility and a clean seam so the interactive path can later slot in as a second execution adapter.

| Component | File | Responsibility |
|---|---|---|
| **Phase state machine** | `bin/engine/phases.mjs` | Declarative table encoding the canonical phase sequence (today's prose in `work-on.md`). Each entry: `id`, `entryCondition(state)`, `command` (spec to run), `terminal?`, `reconcile(state)`. |
| **Engine loop** | `bin/engine.mjs` | The durable driver. Loads state, picks the next phase deterministically, invokes the phase, commits, handles failure. |
| **LLM-execution adapter** | `bin/runner.mjs` *(existing)* | Runs one phase = one bounded `runCommand()` with a **fresh context window**. Loop unchanged; new caller. |
| **Run-log store** | `bin/engine/runlog.mjs` | Append-only `.forge/runs/{issue}.jsonl`. Crash-safe local hot path. |
| **GitHub adapter (projector)** | `bin/engine/projector.mjs` | Reads/writes the `FORGE:STATE` block; manages the lease. Durable shared mirror + data source for `forgedock watch` (#1312). |

The engine core (`phases`, `engine`, `runlog`, `projector`) is runtime-agnostic; `runner.mjs` is the LLM adapter; the projector is the GitHub adapter.

### Engine loop (shape)

```
state = load(issue)                       // local log → else FORGE:STATE → else fresh
while (next = pickPhase(state)) {          // ENGINE decides; never the LLM
  if (next.terminal) break
  reconcile(state, next)                   // make re-entry safe (idempotency)
  result = runner.runCommand(next.command, ctx(state))   // fresh context per phase
  switch (result.status) {
    case 'committed': commit(state, next, result.outputs); break   // append log + mirror
    case 'failed':    if (attempts(next) < maxAttempts) retry; else block(state, next); break
    case 'blocked':   terminate(state, 'needs-human', result.detail); return
  }
}                                          // no event on crash → next run drops + re-runs
```

## 5. State model

### 5.1 Run-log (`.forge/runs/{issue}.jsonl`)

Append-only, one JSON event per line. `seq` is a monotonic per-issue version counter.

```jsonc
{"seq":1,"event":"RUN_START","issue":42,"run":"r_a1","lane":"staging","baseSha":"9ea38…"}
{"seq":2,"event":"PHASE_START","phase":"investigate"}
{"seq":3,"event":"PHASE_COMMIT","phase":"investigate","outputs":{"verdict":"CONFIRMED","decompose":false}}
{"seq":4,"event":"PHASE_START","phase":"build"}
{"seq":5,"event":"PHASE_FAILED","phase":"build","attempt":1,"reason":"tsc error"}
{"seq":6,"event":"PHASE_START","phase":"build"}
{"seq":7,"event":"PHASE_COMMIT","phase":"build","outputs":{"branch":"fix/pay-42","headSha":"…","skipped":false}}
{"seq":8,"event":"RUN_TERMINAL","reason":"merged"}
```

Events: `RUN_START`, `PHASE_START`, `PHASE_COMMIT`, `PHASE_FAILED`, `RUN_TERMINAL`.

**The commit rule (the entire durability story):** a phase is *committed* iff a `PHASE_COMMIT` follows its latest `PHASE_START`. A `PHASE_START` with no following `PHASE_COMMIT` = a crashed / in-flight phase → **dropped and re-run**.

**Corruption tolerance:** a crash mid-write leaves a truncated final line; the reader ignores any final line that does not parse as complete JSON.

### 5.2 GitHub mirror (`FORGE:STATE`)

One machine-readable HTML-comment block the projector **overwrites in place** (not appends) after each `PHASE_COMMIT`:

```html
<!-- FORGE:STATE
{"v":7,"run":"r_a1","phase":"review","committed":["investigate","context","architect","build"],
 "branch":"fix/pay-42","pr":null,"lane":"staging","terminal":false,
 "lease":{"by":"agent_7","until":"2026-07-03T04:10Z"}}
-->
```

`v` mirrors the run-log `seq` at last commit — the shared version used for divergence detection. It carries the **compact index only** (see locked decision 4).

### 5.3 Resume + divergence (`GitHub wins`)

```
onStart(issue):
  local  = readRunLog(issue)          // absent on fresh clone / other machine
  remote = projector.read(issue)      // FORGE:STATE, may be absent
  state  = reconcile(local, remote)

reconcile(local, remote):
  if !remote: return local ?? fresh
  if !local:  return hydrateFromRemote(remote)          // fresh clone / other machine
  if remote.v > local.lastSeq: return hydrateFromRemote(remote)   // advanced elsewhere → GitHub wins, discard local
  if remote.v < local.lastSeq: projector.write(fromLocal(local)); return local  // we crashed pre-mirror → re-mirror, keep local
  return local                                          // in sync
```

`hydrateFromRemote` reconstructs working state from the compact index plus, where a phase's rich outputs are needed downstream, the existing `FORGE:*` structured comments on the issue.

## 6. Deterministic transitions & idempotency

**`pickPhase(state)`** = the first phase in the `phases.mjs` table whose `entryCondition(state)` holds and whose `id` is not in `state.committed`. If none qualify or a terminal condition holds → terminal. No LLM involvement — this is the fix for the stall class.

**`phase.reconcile(state)`** runs *before* the LLM on every entry, because a dropped phase re-runs and must be safe to re-enter:

- `build.reconcile`: branch already exists and is ahead of base → resume rather than re-create.
- `review.reconcile`: a PR already exists for the branch → adopt it, do not open a second.
- `close.reconcile`: PR already merged → proceed straight to close steps.

These leverage the existing `FORGE:*` markers and `gh` queries; the engine makes idempotency a required step rather than an ad-hoc convention.

## 7. Failure policy

Each phase returns a typed result; the engine acts on the **type** (replacing prose "try again / do not stop"):

| Result | Meaning | Engine action |
|---|---|---|
| `committed` | phase produced outputs | write `PHASE_COMMIT`, advance |
| `failed` | transient (rate-limit, network, `gh` timeout, context-budget hit mid-phase) | `PHASE_FAILED`; retry same phase with backoff up to `maxAttempts` (default 3); on exhaustion → treat as `blocked` |
| `blocked` | deterministic human-needed (gate failed after loop, contract wrong, ancestry violation, push rejected) | `RUN_TERMINAL{needs-human}`, set label via projector, **stop visibly** |
| *(no event)* | crash / kill / compaction | next run drops the uncommitted `PHASE_START` and re-runs the phase |

**Visible skips (closes #1306):** a phase that no-ops (e.g. missing `verification.commands`) must emit `outputs:{skipped:true, which:"typecheck"}` into its `PHASE_COMMIT` and `FORGE:STATE`. A skip is surfaced (PR body / trajectory / review verdict), never a silent pass.

**"Prompt too long" (dissolves #1305):** fresh context per phase removes the dominant cause. If a *single* phase still exhausts context mid-run, it is a `failed` attempt whose `reconcile` resumes from committed artifacts on retry. Note honestly: an oversized single-phase input (e.g. a 10k-line review diff) remains the review phase's own concern — the engine bounds it (`runner` tool-result caps + iteration budget) but does not shrink it; that is the verification/review spec's responsibility.

## 8. Concurrency & orchestrator integration

**Lease.** `FORGE:STATE.lease = {by: agentId, until: ts}` is written on `RUN_START`, renewed on each `PHASE_COMMIT`, released on `RUN_TERMINAL`. On start, if a live lease held by another agent exists, the caller defers. Because GitHub wins on divergence, the lease is authoritative — two agents cannot both work one issue. This replaces the orchestrator's fuzzy "already in progress" label heuristic with a race-safe primitive.

**`/orchestrate` becomes a thin driver:**
- Decomposes into the wave/DAG (unchanged), then calls `engine.run(issue)` per issue.
- Watches `FORGE:STATE` per issue for progress — which also feeds `forgedock watch` (#1312) and removes any dependence on JSONL output files (killing the Windows-blind audit problem #1307 for orchestrated runs).
- **Exact stall detection:** a lease whose `until` expired on a non-terminal state = a dead agent → re-spawn `engine.run(issue)`, which resumes from the last `PHASE_COMMIT`. This replaces "resume up to 3× with nagging."
- File-overlap serialization remains the orchestrator's responsibility (unchanged), aided by the engine's `baseSha`/branch tracking.

## 9. Testing strategy

Correctness of a durable engine is won in tests. `runner.mjs` already lazy-imports the SDK and separates pure helpers, so the engine is tested with a **fake `runCommand`** that returns scripted phase outputs — no live LLM.

- **State-machine units** (`bin/tests/phases.test.mjs`, `engine.test.mjs`): table-driven `pickPhase` over crafted states; `reconcile` across all divergence cases (local-only, remote-only, remote-ahead, local-ahead, in-sync); the commit-detection rule.
- **Crash-injection harness** (the durability proof): run the engine against the fake runner, kill after each phase boundary *and* mid-phase, assert resume lands on the correct phase with no double-PR / double-commit.
- **Run-log** (`runlog.test.mjs`): append/read/replay; truncated-final-line tolerance.
- **Projector** (`projector.test.mjs`): `FORGE:STATE` serialize/parse round-trip; overwrite-in-place; lease acquire / renew / expire against a mocked `gh`.
- **Per-phase `reconcile`** idempotency tests (build resumes, review adopts existing PR, close handles already-merged).

## 10. Open implementation-time decision (defer to the plan)

Whether the engine runs concurrent issues as **separate processes** (matches today's background-agent model; strong isolation) or an **in-process worker pool** (one place to observe; shared rate-limit backpressure). Recommendation: **in-process pool + a git worktree per issue** for filesystem isolation (worktrees are already the pattern). Decide during planning.

## 11. Relationship to existing code & the epic

- **Reuses:** `runner.mjs` (`runCommand`, tool handlers, result caps, lazy SDK) as the unmodified LLM adapter; the `work-on` phase sequence as the seed for `phases.mjs`; the existing `FORGE:*` structured comments as rich-output storage; git worktrees for isolation.
- **Retires / fixes:** the phantom numbered-state router (#1308), the "≥20 Skill calls" heuristic and "prompt too long" deaths (#1305), silent verification skips (#1306), and — for orchestrated runs — the JSONL-based audit blindness (#1307).
- **Enables (as substrate, not in scope):** the run-log's structured `outputs` and `FORGE:STATE` are deliberately the foundation for verification (#1315), learning memory (#1316), economics (#1317), and provenance (#1318).

## 12. Definition of done

- A headless `engine.run(issue)` drives an issue through the full phase sequence with the engine deciding every transition.
- Killing the process at any phase boundary or mid-phase resumes correctly on the next run, with no duplicated PRs/commits (crash-injection suite green).
- A fresh clone / second machine resumes a run from `FORGE:STATE` alone.
- `/orchestrate` drives issues via `engine.run`, coordinates via the lease, and detects/recovers stalls via lease expiry.
- Skipped verification is visible on the PR; a `blocked` result stops the run with `needs-human`, never silently.
- Unit + crash-injection + projector/lease test suites pass with a mocked runner and mocked `gh`.
