# Selftest

The engine's unit tests mock `gh`, git and the pool transport, so defects such as #4859 (`authorAssociation` is not a gh field), #4860 (issue body wiped to `FORGE:STATE`), #4817 and #4818 passed CI. `forgedock selftest` checks the real binaries.

```
forgedock selftest --static
forgedock selftest --live [--repo <owner/sandbox>] [--lang node|python] [--pr <staging->main PR>]
```

`--live` also runs the static check. The sandbox repo comes from `--repo` or `selftest.sandbox_repo` in forge.yaml ([CONFIG.md](CONFIG.md#selftest-optional)). Run it on the host or the pool, not in GitHub Actions. The exit code is non-zero and the output names the failed step.

## Static check

Every literal `gh issue|pr view|list --json a,b` field list in non-test `bin/**/*.mjs` must be a subset of the `JSON FIELDS` of `gh <cmd> --help` on this host. A violation is reported as `file:line`.

## Live steps

1. **create**: the fixture base files, then issues A and B (B has `**Depends on**: #A`), each a trivial change with a test that fails on the old code.
2. **add**: `orchestrate A --parallel 2`, then `orchestrate --add <id> B`; B must be added (not skipped or unreadable) and wait on A in the DAG.
3. **body**: after the add, after the resume and while waiting, each issue body must still contain its creation text (`FORGE:STATE` ignored).
4. **resume**: the orchestrate client is killed and `--resume`d; the live lane of A must be re-adopted, not launched again.
5. **merge**: both lanes merge; the PRs are `MERGED`, the issues closed with `workflow:merged`, and A merged before B.
6. **remote**: with `execution.mode` `remote` or `hybrid`, one lane runs remotely; the sandbox engine version must equal the CLI version and the lane must authenticate. Skipped (noted) when no pool is configured.
7. **cleanup**: always runs, even after a failure: the orchestrate client is stopped; the issues, PRs and branches are closed or deleted.

The first failing step stops the run.

## Release gate

With `--pr N`, the result is posted on the PR as `<!-- FORGE:SELFTEST result=pass|fail sha=<head> step=<failed step|none> -->`. `forgedock review-staging` reads the newest marker and refuses (`REVIEW_RESULT: status: BLOCKED`, nothing reviewed) unless it is a pass for the PR's current head. A push after the selftest makes the marker stale: re-run it.

Not yet wired: a nightly run through the schedd timer.
