# Gate Telemetry

Gate scripts record their decisions as structured events so gate block rates, finding funnels and malformed-check
counts can be measured without re-reading comments with a model. GitHub is the source of truth: records are written
by code (never by a model) into a `FORGE:TELEMETRY` comment, and everything can be rebuilt from the GitHub API alone.
Local files are only a cache.

## Where records live

- One `<!-- FORGE:TELEMETRY v1 -->` comment per issue, or per PR for review-side events (`review_panel`,
  `finding_disposition`, `ci_gate` go to the PR when one is known, everything else to the issue).
- The comment is edited in place. The records are JSONL inside a fenced `jsonl` block.
- Near 60,000 characters (GitHub's limit is 65,536) a new `<!-- FORGE:TELEMETRY v1 part=N -->` comment is started.
- Written with the pipeline's own `gh` token. Readers must take only comments that pass `scripts/trusted-comments.sh`
  (OWNER/MEMBER/COLLABORATOR, or a Bot author); the emitter itself only edits trusted telemetry comments.
- If a write fails the record is appended to `~/.forge/telemetry-buffer/<owner>_<repo>__<number>.jsonl` and flushed
  with the next emit for the same target, from any machine that touches the issue. Lines already present in the
  comment are not written twice. Deleting the buffer loses only records that never reached GitHub.

## Record shape

```json
{"v":1,"ts":"2026-10-11T19:38:54Z","forge_version":"1.16.1","repo":"o/r","issue":5,"pr":null,"run":null,"phase":null,"event":"diff_size","lines":10}
```

`issue`, `pr`, `run` and `phase` come from `FORGE_ISSUE`, `FORGE_PR`, `FORGE_RUN` and `FORGE_PHASE` (null when unset);
`repo` from `FORGE_REPO`, else the `origin` remote. A record with no repo or no numeric issue/PR has no destination and
is dropped. Payload keys are `[A-Za-z0-9_]+` and cannot shadow the shared keys; integers and `true`/`false` are typed.

## Event catalogue

| Event | Emitted by | Payload |
|-------|-----------|---------|
| `diff_size` | `scripts/diff-size.sh`; `work-on/build.md` B5.5 (final result) | `lines`, `excluded`, `ws_lines`, `review_weight`, `modules`, `result`; the script emits the legacy `threshold` and `OK` \| `OVER` \| `COHESIVE`, the B5.5 call site emits the final `result` = `OK` \| `EXTENDED_REVIEW` \| `SCOPE_FLAGGED` \| `OVERRIDDEN` plus `estimate` (plan), `actual` (whitespace-insensitive lines), `scope` = `ok` \| `out_of_plan` \| `no_baseline` and `review_depth` = `STANDARD` \| `EXTENDED` (calibration inputs, forge#3862) |
| `acceptance_gate` | `work-on/build.md` B6.5 (`phase=build`); `scripts/review-acceptance-gate.sh` (`phase=review`) | `phase`, `verified`, `failed`, `malformed`, `deferred` |
| `finding_disposition` | `scripts/classify-finding.sh`, one per finding | `severity`, `confidence`, `agent`, `scope` = `introduced` \| `pre-existing` \| `unknown` (from the diff; `unknown` when not supplied), `disposition` = `ISSUE` \| `NOTE` \| `INPR_FIX` (also MEDIUM LIKELY when `scope=introduced`), `reason` |
| `review_panel` | `review-pr.md` Phase 4 | `agents_selected`, `agents_completed`, `mode` = `FULL` \| `DELTA` \| `BASE_SYNC_ONLY` |
| `ci_gate` | `scripts/wait-ci-green.sh` | `result` = `PASS` \| `FAIL` \| `ERROR` \| `TIMEOUT` \| `RATE_LIMITED` (rc 4: GitHub throttled or briefly unavailable for the whole window; retryable, never a verdict), `rc`, `checks` |
| `ci_pending_wait` | the engine (`bin/engine/telemetry-seam.mjs`, one per finished CI-pending wait at the merge gate; `phase` = `review` \| `remediate`) | `pr`, `minutes_waited`, `result` = `green` \| `red` \| `error` \| `timeout`, `polls` (CI reads made), `rate_limit_sleeps` (polls that were rate-limited plus sleeps until the budget reset) |
| `liveness` | `scripts/remediate-liveness.sh` | `decision` = `PROCEED` \| `DEFER` \| `EXHAUSTED`, `why` |
| `phase_attempt` | the engine (`bin/engine/telemetry-seam.mjs`, one per phase attempt; `phase` = the phase id) | `attempt`, `model`, `turns`, `duration_ms`, `cost_usd`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` (any value the runner did not report is omitted) |
| `run_terminal` | the engine (`terminate()`, one per run segment) | `reason` (terminal reason), `code` (see `docs/OUTCOME-CODES.md`), `wall_ms` (this engine process, start to terminal) |

The engine records carry `run` = `r_<issue>_<start epoch seconds>` (one per `forgedock run-issue` process) so `forgedock stats`
(`docs/STATS.md`) can group the attempts of a run and tell a finished run from an unfinished one. They are the GitHub-side
source for Cost, Time and outcome codes (`run` is per process, but stats count one run per issue, last wins): without them a fresh machine can rebuild only the gate and review sections.

The classifier and the scripts emit only when a destination is known: callers export `FORGE_ISSUE` and/or `FORGE_PR`
(`review-pr.md` exports them before classifying; the other scripts default `FORGE_REPO`/`FORGE_ISSUE`/`FORGE_PR` from
their own arguments).

## Guarantees

- Never fails or alters the caller: `forge_emit` always returns 0, runs in a subshell with all output discarded, bounds
  each `gh` call to 30 seconds, and gate stdout and exit codes are identical with it on or off.
- `FORGE_TELEMETRY=off` makes every emit a no-op (the test runner sets it so suites never touch `~/.forge`).
- Emitters: `scripts/lib/telemetry.sh` (`forge_emit <event> key=value...`, also runnable as
  `bash scripts/lib/telemetry.sh <event> key=value...`) and `bin/engine/telemetry.mjs` (`emit(event, payload)`),
  with the same record shape.

## Privacy note

Records contain ids, counts and codes only: never comment bodies, issue text, file contents, diffs or secrets. Values
are restricted to `A-Za-z0-9 _.:/#@+=,-` (anything else becomes `_`) and truncated to 200 characters, so a value
cannot carry markup, backticks or newlines into the comment. Treat the comment as public to anyone who can read the
issue or PR.
