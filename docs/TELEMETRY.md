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
| `diff_size` | `scripts/diff-size.sh`; `work-on/build.md` B5.5 (final result) | `lines`, `excluded`, `threshold`, `result` = `OK` \| `OVER` \| `COHESIVE` (`OVERRIDDEN` from the B5.5 call site) |
| `acceptance_gate` | `work-on/build.md` B6.5 (`phase=build`); `scripts/review-acceptance-gate.sh` (`phase=review`) | `phase`, `verified`, `failed`, `malformed`, `deferred` |
| `finding_disposition` | `scripts/classify-finding.sh`, one per finding | `severity`, `confidence`, `agent`, `disposition` = `ISSUE` \| `NOTE` \| `INPR_FIX`, `reason` |
| `review_panel` | `review-pr.md` Phase 4 | `agents_selected`, `agents_completed`, `mode` = `FULL` \| `DELTA` \| `BASE_SYNC_ONLY` |
| `ci_gate` | `scripts/wait-ci-green.sh` | `result` = `PASS` \| `FAIL` \| `ERROR` \| `TIMEOUT`, `rc`, `checks` |
| `liveness` | `scripts/remediate-liveness.sh` | `decision` = `PROCEED` \| `DEFER` \| `EXHAUSTED`, `why` |

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
