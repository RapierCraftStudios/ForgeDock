# Test engine (`forgedock tests`, forge#5710)

Runs fewer tests per change without weakening the gate, and splits what does run evenly across runners. Everything is
off until `ci.tests.selection` is set, and nothing is skipped until a recorded shadow period proves the selection.

| Command | What it does |
|---|---|
| `forgedock tests select` | changed files -> the test files they can affect, with a reason per test |
| `forgedock tests shard` | test files -> N shards balanced by recorded durations; CI matrix JSON |
| `forgedock tests recall record` | after the run: were all failing tests inside the selection? one ledger line |
| `forgedock tests recall [status]`, `recall check` | graduation state and quarantined flaky tests; `check` exits 1 until graduated |

## Selection

`tests select [--base <ref> | --changed <file>... | --changed-from <file|->] [--full] [--json] [--out <file>]`.
Without `--changed*` the diff is `git diff <base>...HEAD` (`--base`, else `origin/$GITHUB_BASE_REF`).

A changed file selects, in this order:

1. nothing, when it matches `ci.tests.ignore`;
2. **everything**, when it matches a run-everything glob: dependency manifests and lockfiles (npm, pnpm, yarn, bun, poetry, uv, pip, pipenv, go, cargo), toolchain and test-runner config (`tsconfig*.json`, `jest.config.*`, `vitest.config.*`, `pytest.ini`, `tox.ini`, ...), CI files (`.github/**`, `forge.yaml`, `.forge/**`), `Dockerfile*`, compose files, `Makefile`, `.env*`, plus `ci.tests.run_all`;
3. the targets of every `ci.tests.suites` rule whose glob matches it;
4. itself, when it is a test file;
5. every test file that depends on it, directly or through other files:
   - JS/TS: `import`, `export ... from`, `require`, literal `import()`, `jest.mock` / `vi.mock`, `new URL(rel, import.meta.url)`; relative paths, workspace package names (`package.json` `name`) and `tsconfig`/`jsconfig` `baseUrl` + `paths` are resolved against the repo's files;
   - Python: `import a.b`, `from a.b import c`, relative imports, `importlib.import_module("...")`, `mock.patch("...")` targets, `pytest_plugins`; module roots are the repo root, `src/`, every directory with a `pyproject.toml` / `setup.py` / `setup.cfg` / `requirements*.txt`, and the importing file's own directories; every `conftest.py` above a test is a dependency of it;
   - both: a quoted repo path (`"docs/guide.md"`, `"fixtures/order.json"`) is a dependency, so a test that reads a file by path is selected when that file changes;
6. **everything**, when none of 3 to 5 produced a test (a file nothing imports, an unknown file type, a deleted source file). An empty diff also selects everything.

The graph is a cheap static scan (regular expressions, no parser, no package installed); it over-approximates on purpose. It cannot follow a computed import (`import(name)`), a dependency reached only at run time, or another language. The shadow recall ledger measures exactly that gap, and `ci.tests.suites` is the declared fix for it:

```yaml
ci:
  tests:
    selection: shadow
    suites:
      - "migrations/** db/*.sql => tests/integration/**"   # path globs => test-file globs
      - "deploy/** => @smoke"                                # a named suite the runner understands
      - "proto/** => *"                                      # everything
    ignore: ["**/*.md"]
```

A glob without `/` matches the basename in any directory; `**/` also matches no directory. Test files are `*.test.*`, `*.spec.*`, `__tests__/**` (JS/TS) and `test_*.py`, `*_test.py`, unless `ci.tests.test_globs` replaces the convention.

`--json` / `--out` print `{plan, config, selection, run_tests, run_suites, quarantined, graduation}`. `plan.run` is `all` or `selection`; `run_tests` is the list to hand to the runner (every test file unless `plan.run` is `selection`). When `plan.run` is `selection` and `run_tests` is empty (for example only ignored files changed), skip the test step: most runners run everything when given no file.

## Modes and graduation

| `ci.tests.selection` | Effect |
|---|---|
| `off` (default) | nothing is computed; `tests select` says run everything; `recall record` records nothing |
| `shadow` | the selection is computed and recorded; the full suite runs |
| `enforce` | the runner gets only the selection, **after graduation**. Before it, enforce is refused: the effective mode stays `shadow` and the output says why |

Graduation: the last `graduate_after` (50) full-suite runs under the current selection config all had 100% failure recall (every failing test file was inside the selection), and at least `graduate_min_failing` (1) of them was a subset selection that contained a real failure. A miss, a failure no test file could be named for, or a change to `suites` / `run_all` / `ignore` / `test_globs` restarts the count, also after graduation, which sends `enforce` back to shadow.

The full suite always runs on a scheduled run (`GITHUB_EVENT_NAME=schedule`), on a `ci.tests.full_branches` branch as head or PR base (default `main`, `master`, `release/**`) and with `--full`. Keep measuring after graduation: on the nightly run pass `--base <previous nightly sha>` so the day's diff has a real selection to check against the full result.

`tests recall record --selection <file from select --out> [--report <file>]... [--failed <test>]...` reads the failing tests from JUnit XML or TAP reports (or `--failed`), and appends one line to the ledger. It always exits 0: the suite's own result is the gate. The ledger is a JSONL file at `ci.tests.recall_ledger`, else `$FORGEDOCK_TESTS_LEDGER`, else `~/.forge/tests/<owner>__<repo>/recall.jsonl` (`FORGEDOCK_TESTS_DIR`): outside the checkout, so a change under test cannot edit its own record. On ephemeral runners, restore and save that file with the CI cache or point it at a persistent volume.

## Sharding

`tests shard [--shards <n> | --target-seconds <s>] [--max-shards <n>] [--report <file>]... [--from <selection.json>] [--ecosystem js|python] [--json | --matrix]`.

Durations come from earlier reports: JUnit XML (pytest, jest, vitest: per-file seconds are the sum of the cases), TAP, or a `{"<file>": seconds}` JSON map. Files are placed longest first onto the least-loaded shard (greedy LPT). A file without a recorded duration gets the median; with no history at all the split is by file count. `--target-seconds` derives the shard count (`ceil(total / target)`) and lists every file that alone exceeds the target: no file split can shorten those, they need to be broken up or moved off the critical path.

`--matrix` prints `{"include":[{"shard":1,"total":4,"files":"a b c"}, ...]}` for a GitHub Actions matrix (`fromJSON`). Paths with spaces need `--json` and their own quoting.

Limit: `node --test` on Node 22 writes a file location only for failing tests (TAP) and none in its JUnit reporter, so its reports attribute failures but not durations; use a `{file: seconds}` map for it.

## Flaky quarantine

A test file that failed and later passed on the same commit is a flip (`release-flakes.mjs` `detectSameShaFlip`). One that flipped `quarantine_after` (3) times inside `quarantine_window_days` (14) is listed as quarantined by `tests select` and `tests recall`. It is still run. `ci.tests.quarantine`: `report` (default) keeps it blocking; `non-blocking` is the repo's opt-in to let the runner treat its failure as a warning, never for an unskippable class (`migration`, `security`, `rollback`, `backup-restore`, `secrets` as a path segment); `off` lists nothing.

## Workflow sketch

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    outputs: { matrix: "${{ steps.shard.outputs.matrix }}" }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: npx forgedock tests select --out selection.json
      - id: shard
        run: echo "matrix=$(npx forgedock tests shard --from selection.json --target-seconds 240 --max-shards 8 --report durations.json --matrix)" >> "$GITHUB_OUTPUT"
  test:
    needs: plan
    strategy: { matrix: "${{ fromJSON(needs.plan.outputs.matrix) }}", fail-fast: false }
    steps:
      - run: <test runner> ${{ matrix.files }}        # writes junit-${{ matrix.shard }}.xml
  recall:
    needs: test
    if: always()
    steps:
      - run: npx forgedock tests recall record --selection selection.json --report junit-1.xml --report junit-2.xml
```
