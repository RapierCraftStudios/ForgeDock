---
issue: 4318
status: fresh
anchor: bin/lean/orchestrate.mjs
created: 2026-10-20
---

# ADR: the batch-exit relabel runs on throw and signal; test-map rejects flag families and write targets; one GraphQL link stamp

## Context

The delta passes of the 1.30.0 staging review (#4314) found 13 LOW residuals in the batch runner, the pre-filter, the test-map allowlist, check merging, the context-pack stamp and the outcome-code docs.

## Decision

- **Relabel on any exit.** `orchestrate` runs the relabel of queued recoveries once per process: on a normal exit, on an exception out of the loop (then it rethrows), and through `onExit(fn)`. A foreground `runBatch` awaits that `fn` from its SIGINT/SIGTERM handler, then exits 128+signo. This copies the lane handler. Daemon batches install no handler: they resume when the daemon restarts. A SIGKILL can't be handled; the next resume relabels.
- **Relabel results.** `relabelNeedsHuman` returns one of three results. `"skipped"` means the issue is closed or holds a live FORGE:STATE lease. The runner never holds a lease, so a live one belongs to another actor. `"failed"` means the label add failed; the runner records nothing and posts no comment, so a resume retries. `true` means the label went on first and the comment second; a failed comment keeps the label. A non-final attempt's relabel carries the full persisted reason.
- **Pre-filter identity.** The own identity is `gh api user`, falling back to `gh api app` for the slug. A batch retries an unresolved lookup once.
- **test-map: deny by form.** test-map rejects these forms rather than keeping a per-tool allowlist of flags:
  - any quote;
  - fixer, snapshot and write-target flag families: `--fix*`, `--write*`, `--w`, `--update*`, `--snapshot-update*`, `-u` on JS runners, go `-o`/`-exec`, tsc `--outDir`, pytest `--junitxml`/`--basetemp`;
  - any absolute or `..` path;
  - tox/nox packaging envs in any spelling.

  `-w` names a workspace on npm and pnpm. A per-tool allowlist of flags would drop ordinary read-only checks (`pytest -k`, `--cov`, `go test -race -run`). It would also duplicate each tool's whole flag surface, while the command allowlist (#4300) already decides which tools run.
- **New mapped forms.** `uv run python -m`, `python3.N -m`, `npx --yes`, `pnpm --filter`, `npm -w`, `make -C DIR` (DIR becomes the entry cwd), `cargo +TC`, `cargo fmt --check`, the values of gradle `--tests` and maven `-pl`, and `./x.test.sh` / `bash -x x.test.sh`.
- **Check dedupe and total cap.** Pre-PR checks dedupe on a canonical key: `<pm> run test` = `<pm> test`, the `npx [--yes]` prefix dropped, and `cd . &&` dropped. One round has a total budget, `verify.precheck_total_seconds` (default 1800). A command gets what is left of it, and commands over budget are skipped as an anomaly, not a failure, because CI stays the gate.
- **Link stamp.** The link stamp is one GraphQL call: the states of up to 100 referenced numbers (the highest are kept) plus the issue's own cross-reference/connected timeline count. A body with no references still makes no call and keeps the old key.

## Closed with a reason

- `cargo clippy --fix`: already rejected by the #4316 fixer rule; now covered by a test.
- `mvn clean test` and `./gradlew clean test`: stay unmapped. `clean` deletes build output, and the learned commands cover them.

## Alternatives

- Per-tool default-deny flag sets: rejected for the reasons above.
- A batch-runner lease of its own, so that "another actor" means any other holder: a new lease writer for one best-effort comment.
