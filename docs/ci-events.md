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
