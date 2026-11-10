# Selftest

The engine's unit tests mock `gh`, git and the pool transport, so defects such as #4859 (`authorAssociation` is not a gh field), #4860 (issue body wiped to `FORGE:STATE`), #4817 and #4818 passed CI. `forgedock selftest` checks the real binaries.

```
forgedock selftest --static
forgedock selftest --live [--repo <owner/sandbox>] [--lang node|python] [--pr <staging->main PR>]
forgedock selftest --journey [--repo <owner/sandbox>] [--pr <N>] [--update-snapshots]
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

With `--pr N`, the PR head is read before the run (from `--release-repo`, else the current repo), and the result is posted on the PR as `<!-- FORGE:SELFTEST result=pass|fail sha=<head> step=<failed step|none> -->`. When forge.yaml sets `selftest.sandbox_repo`, `forgedock review-staging` reads the newest marker and refuses (`REVIEW_RESULT: status: BLOCKED`, nothing reviewed) unless it is a pass for the PR's current head. Only markers from trusted commenters count (maintainer association, a GitHub App bot, or `FORGE_TRAIL_TRUSTED_LOGINS`), and only when the marker leads the comment. A push after the selftest makes the marker stale: re-run it. The harness refuses a sandbox repo that is the project repo (forge.yaml `project`) or the release repo. Without `selftest.sandbox_repo` the gate is skipped and the CLI prints `SELFTEST: skipped` on stderr.

## Nightly run

Off by default. Set `selftest.nightly_interval_hours` (see [CONFIG.md](CONFIG.md#selftest-optional)) and the schedd daemon starts `selftest --live --nightly-report <repo>` on the host, as a detached process, once that many hours have passed since that repo's last run (last run time cached per repo in `selftest-nightly-<owner>_<repo>.json` under the sched dir). The daemon never runs the harness itself, so a long run never holds its other sweeps. It never runs on GitHub Actions. A failing run, including one that cannot start (for example no `selftest.sandbox_repo`, step `config`) or a harness crash, files one issue titled `selftest --live failed at step <step> (nightly)` carrying `<!-- FORGE:SELFTEST_NIGHTLY -->`; the next failure edits that open issue instead of filing another. A passing run writes nothing. The issue lives in the repo schedd resolves for the working directory, and the sandbox repo must be set by `selftest.sandbox_repo`.

## New-user journey

`forgedock selftest --journey` (#5305) checks what a first-time user sees, which the mocked unit tests and `--live` do not. Run it on the host before each release, never in GitHub Actions.

1. **Clean environment**: `npm pack`, then `npx --package <tarball> forgedock` in a container holding only Node and git (`docker run --rm`, image `node:22`, override with `FORGE_JOURNEY_IMAGE`; without Docker, a throwaway HOME and a PATH of only node, git and the shell basics). It runs the bare command (the not-ready output), `help`, `doctor` and an unknown command. It fails on: success wording on a machine without gh and Claude Code (steps `banner`), a doctor that exits 0 or does not name the missing tools (`doctor`), raw runtime error text (`errors`), placeholder values in a `forge.yaml` it wrote (`files`), and a CLI that does not start.
2. **Sandbox repo**: needs `gh` authenticated and Claude Code; otherwise skipped with a note. In a fresh directory it runs `demo --repo <sandbox>` (`setup`), `doctor` (must exit 0), and `demo --run` (`first-merge`), then requires a PR merged after the start. It prints the time to first merged PR and every prompt shown, and always removes the directory and closes the issues it opened.
3. **Snapshots**: the scrubbed output (ANSI, paths, versions and timings removed) is compared with `bin/tests/fixtures/journey-snapshots/*.txt` (`banner`, `help`, `doctor`, `errors`, and `not-ready` for exit codes and the files written). A wording change fails with the file and line; review it and run with `--update-snapshots` to accept it, so the change shows in the diff.

The sandbox repo comes from `--repo` or `selftest.sandbox_repo`; the harness refuses the project repo and the release repo. With `--pr N` the result is posted on the release PR as `<!-- FORGE:JOURNEY result=pass|fail sha=<head> step=<failed step|none> ttfm=<seconds|na> -->`, next to the review's `GATE_PASS`. It is a separate marker from `FORGE:SELFTEST` and is informational: `review-staging` does not read it.
