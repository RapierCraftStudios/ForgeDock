---
status: fresh
anchor: bin/lean/validate-catalog.mjs
created: 2026-11-21
---

# ADR: frozen pytest commands run in the env the repo's CI runs them in

## Context

Lanes froze validate and repro commands under a bare interpreter (`python -m pytest shared/...`, `.venv/bin/python -m pytest ...`). The repo's CI ran the same test paths from a service directory through its own env (`working-directory: services/worker` + `poetry run pytest ../../shared`). On the lane, the test modules failed to import. The failure was then read as a missing host capability (`shared` taken for a tool) and the lane bounced between hosts, or a builder session was spent before anyone saw the import error.

## Decision

- At contract freeze, `deriveTestEnvMap` parses the repo's CI text (the `validate.catalog` sources, default `.github/workflows/ci.yml` + `scripts/ci-local.sh`) with no LLM call. Each `poetry run` / `uv run` pytest line, with its step's `working-directory:` or an inline `cd X &&`, becomes `{dir, runner, paths}`.
- `rewriteToCiEnv` runs after `rewriteSubprojectVenv`. It rewrites a validate or `repro_test` command that runs a mapped path under a bare interpreter, or under a `.venv` that does not exist, to `cd <dir> && <runner> pytest <dir-relative paths>`. With no map entry, a missing `.venv` next to a `poetry.lock` / `uv.lock` falls back to that runner. Commands already using `poetry run` / `uv run`, venvs that resolve and unmapped commands stay byte-identical. The freeze records each rewrite as a decision.
- `preflightValidates` runs each pytest command once with `--collect-only` on the base worktree. An `ImportError` / `ModuleNotFoundError` is a `python-module` miss (source `collect`). It goes to the single contract correction before the implement builder.
- `declaredEnv` ignores a name that is a tracked repo directory, so `shared` is never a host tool and never `env.tool_missing`.

## Consequences

- A test path the repo's CI covers runs where CI runs it, without a builder correction. The depcache already gives services an in-project venv.
- A test path no CI line covers keeps its command. If it cannot import, the collect-only preflight catches it at freeze.
- The parser reads line-level YAML/shell text. A `working-directory` built from an expression (`${{ ... }}`) or an absolute `cd` is skipped, never guessed.

## Rejected

- **An LLM mapping test paths to envs.** CI text is the repo's own truth (NORTHSTAR non-negotiable 6) and can be parsed deterministically. A model guess can drift from it and costs a call per freeze.
- **Linking or copying a service venv into `shared/`.** depcache refuses to walk workspace links (#5819, `bin/lean/depcache.mjs`), and a link would make `shared/` import whichever service's deps were linked last. Wrapping the command in the service env matches what CI does.
