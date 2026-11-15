# CI events and the pre-flight fast lane

## `forgedock ci preflight` (#5691)

Cheap deterministic checks that fail in seconds, before the 20–36 min suites start. No LLM, no network. Exit 1 only when a check fails; a check whose tool or config is absent is skipped with a reason.

| Check | Fails when | Skipped when |
|---|---|---|
| `workflow-lint` | `actionlint` reports an error; without it, a syntax scan of `.github/workflows/*.yml` (tab indent, unterminated quote, unbalanced flow bracket) | no workflow files |
| `lockfile:<pnpm\|npm\|uv\|poetry>` | `pnpm install --frozen-lockfile --lockfile-only`, `npm ci --dry-run`, `uv lock --check` or `poetry check --lock` exits non-zero | no lockfile, or the tool is not on PATH |
| `generated` | a generator command fails, or `git diff --exit-code` on its declared paths shows a change | `ci.preflight.generated` not set |
| `env-drift` | a workflow `env:` key set from `secrets.*`/`vars.*` is missing from `.env.example` | no `.env.example` or no such keys |
| `tools` | a tool in `ci.preflight.tools` is not on PATH | `ci.preflight.tools` not set |

The total budget is 60 s (`ci.preflight.timeout_s`); a check starting after it is skipped. `--json` prints `{ok, budgetMs, elapsedMs, checks[]}`.

### forge.yaml

```yaml
ci:
  preflight:
    timeout_s: 60
    tools:
      - actionlint
    generated:
      - pnpm run gen:sdk :: packages/sdk/src
```

A `generated` entry is `<command> :: <path> [<path>...]`. The one-level forge.yaml parser flattens `ci.preflight.*` under `ci`, so `ci.generated`, `ci.tools` and `ci.timeout_s` are the keys read. Without them only the auto-detected checks run.

### Job 0 workflow snippet

```yaml
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx forgedock ci preflight
        env:
          FORGE_CI_EVENTS_URL: ${{ vars.FORGE_CI_EVENTS_URL }} # optional
  tests:
    needs: preflight
```

### Events

With `FORGE_CI_EVENTS_URL` set (the router's `POST /ci/events`, #5688), each failed check is POSTed as a best-effort `step_failed` event `{type, step: "preflight:<check>", class: "deterministic-setup", reason, repo, sha}`. A delivery error never changes the exit code. The GitHub check status stays the source of truth for merge gating.

## Runner-side emitter (#5689)

`forgedock ci-step` and `forgedock ci-hook` stream step and test failures to the router while a job runs, so a failure is visible in seconds instead of after the log zip is downloaded. Delivery is best effort: the CI result stays the source of truth.

| Env var | Meaning |
|---|---|
| `FORGEDOCK_CI_EVENTS_URL` | the router's `POST /ci/events` URL (`FORGE_CI_EVENTS_URL` is read as a fallback). Unset: nothing is posted. |
| `FORGEDOCK_CI_TOKEN` | bearer token (a router `ci_tokens[]` entry), sent as `Authorization: Bearer`. |

The events take `repo`, `sha`, `run_id`, `job` and the PR number (from `refs/pull/<n>/merge`) from `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GITHUB_RUN_ID`, `GITHUB_JOB` and `GITHUB_REF`.

### Wrapping a step

```yaml
      - run: npx forgedock ci-step --name unit -- pnpm test
        env:
          FORGEDOCK_CI_EVENTS_URL: ${{ vars.FORGEDOCK_CI_EVENTS_URL }}
          FORGEDOCK_CI_TOKEN: ${{ secrets.FORGEDOCK_CI_TOKEN }}
```

`ci-step --name <step> -- <cmd...>` runs the command with its stdout, stderr and exit code passed through unchanged (a signal exits `128+signal`). It posts `step_started`, then on a non-zero exit `step_failed` with `exit_code` and up to 40 lines: the first 40 matching error/fail/Traceback/assert, else the last 40. While the command runs, pytest (`FAILED path::id - msg` plus `path:line: AssertionError`) and vitest/jest (`FAIL path > name` plus `❯ file:line`) output yields one `test_failed` per failing test `{id, file, line, message}`, posted as the line appears. A failed post prints one warning, stops further posts and adds under 2 s.

### Self-hosted runner hooks

Set `ACTIONS_RUNNER_HOOK_JOB_STARTED="npx forgedock ci-hook job-started"` and `ACTIONS_RUNNER_HOOK_JOB_COMPLETED="npx forgedock ci-hook job-completed"` in the runner's environment (or `.env`), together with the two variables above. They post `job_started` and `job_finished`, and always exit 0; with the URL unset they do nothing.

## Runner health (#5693)

`forgedock ci runner-health` checks the self-hosted runner services on this host and posts a `runner_unhealthy` event (`class: infra`, `step` = `stuck-run`, `service-down`, `orphan-container`, `low-disk` or `low-memory`, the reason in `lines`) per finding, using the same `FORGEDOCK_CI_EVENTS_URL` / `FORGEDOCK_CI_TOKEN` as the emitter. It exits 1 on any finding.

| forge.yaml `ci` key | Meaning |
|---|---|
| `repo` | repo whose runners to check (else `--repo`, else `GITHUB_REPOSITORY`; without one the stuck-run check is skipped) |
| `services[]` | systemd units of the runners, e.g. `actions.runner.<owner>-<repo>.<name>.service` |
| `min_disk_gb` | free-disk floor, default 10 |
| `recover` | the timer unit passes `--recover` |
| `job_timeout_min` | container age that counts as orphaned, default 360 |

`--recover` restarts only the affected runner's service and removes only orphaned containers; without it the plan is printed and nothing is changed. A service is restarted at most once per 10 minutes. `forgedock ci runner-health --print-units` prints a oneshot service and a timer that runs it every 2 minutes; install them with `systemctl enable --now`.
