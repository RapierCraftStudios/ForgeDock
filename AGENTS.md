# ForgeDock Agent Guide

## What this repository is

ForgeDock is a workflow-spec repository and CLI for autonomous software delivery. It is not an application service. The authoritative workflow source is `commands/**/*.md`; runtime adapters for Claude Code, Codex, OpenCode, and Pi must wrap those specs rather than fork them.

The durable system of record is GitHub:

- Issues and pull requests hold state and machine-readable `FORGE:*` annotations.
- `workflow:*` labels represent the pipeline state.
- Branches, PRs, comments, and trajectory receipts provide recovery and audit history.

Read `README.md`, `docs/CODEX.md`, `docs/PI.md`, and the relevant command spec before making workflow changes.

## Repository map

- `commands/` — shared workflow specifications; change this first when behavior changes.
- `commands/work-on/`, `commands/orchestrate/`, and other nested directories — phase specifications loaded by parent commands.
- `.agents/skills/` — repo-local Codex adapters and Forge-specific overrides.
- `pi/extensions/` — Pi-native tools and command integration.
- `bin/` — Node.js CLI, runner, durable engine, hooks, and tests.
- `scripts/` — shell and Node verification, annotation, graph, and maintenance utilities.
- `docs/`, `devdocs/` — user documentation, protocol specifications, architecture, and decisions.
- `packages/protocol/` — published FORGE annotation protocol package.
- `install*.sh`, `update.sh` — runtime installers; keep them non-destructive.
- `forge.yaml`, `forge-invariants.yaml` — repository and workflow configuration.

## Non-negotiable invariants

1. Treat `commands/**/*.md` as the shared source of truth.
2. Preserve workflow labels, structured `FORGE:*` comments, branch conventions, and routing-loop continuation.
3. Translate runtime-specific mechanisms instead of removing phases: Claude `Skill`/`Agent`/`Task` map to the corresponding native command or isolated sub-agent behavior.
4. GitHub state wins during recovery. Do not silently re-run, skip, or mark a phase complete when its durable state is ambiguous; fail closed to `needs-human` or a blocked state.
5. Builders do not approve their own work. Keep quality gates and review as separate stages.
6. Do not overwrite unrelated user-owned global Claude, Codex, OpenCode, or Pi configuration.
7. Keep `AGENTS.md`, `docs/CODEX.md`, `docs/PI.md`, and other runtime adapters aligned when runtime behavior changes.
8. Do not edit generated installation output or `.forgedock/` run logs/temp files as part of normal source changes.

## Development workflow

1. Inspect the relevant command spec, adapter, tests, and recent decisions before editing.
2. Make the smallest coherent change. Preserve established Markdown structure and annotation examples.
3. For command changes, check all nested `Skill(...)`, `Agent(...)`, and `Task(...)` references and their runtime mappings.
4. For installer changes, verify namespacing, idempotence, path handling, and that unrelated global entries are preserved.
5. Add or update focused tests and documentation for behavior changes.
6. Review the diff for stale paths, broken links, missed changelog entries, and accidental generated files.
7. Use conventional commits such as `fix(command): ...` or `feat(engine): ...`; contributors must sign off commits with `git commit -s` (see `CONTRIBUTING.md`).

## Validation

Requirements: Node.js 18+ and GitHub CLI (`gh`) where live GitHub behavior is involved.

### GitHub authentication

For ForgeDock GitHub operations, authenticate `gh` through the token refresh script rather than manually storing or pasting tokens:

```bash
scripts/refresh-bot-token.sh
# or: scripts/refresh-bot-token.sh --personal
```

The script signs a short-lived GitHub App token with `FORGEDOCK_APP_PEM`, exchanges it for an installation token, and runs `gh auth login --with-token`. The token lasts approximately one hour, so refresh it when `gh` reports authentication or permission failures. Never commit the PEM, expose tokens in logs, or use a real private key in fixtures. Use normal `gh auth login` only when the workflow explicitly requires a human account.

Run the full test suite before submitting a substantial change:

```bash
npm test
```

Useful targeted checks:

```bash
node --test bin/tests/<relevant-test>.test.mjs
bash -n install.sh install-codex.sh install-opencode.sh install-pi.sh update.sh
bash scripts/check-command-docs-drift.sh
bash scripts/check-command-side-effects.sh
node scripts/conformance-check.mjs <fixture-or-comment-file>
```

For documentation-site changes, also run:

```bash
npm run docs:build
```

Do not claim live GitHub, installer, or orchestration validation unless it was actually run. Prefer fixtures and dry runs when credentials, network access, or external repositories are unavailable.

## Documentation and licensing

- Workflow semantics belong in `commands/`; explanatory material belongs in `docs/` or `devdocs/`.
- Update relevant docs and changelog material for user-visible behavior changes.
- Follow the SPDX header rules in `CONTRIBUTING.md` for new source and Markdown files.
- The project is AGPL-3.0-or-later; do not introduce dependencies or content with incompatible licensing.
- Avoid emojis in new code or documentation unless the surrounding file already uses them.

## Security and review

Treat installer code, shell scripts, GitHub API calls, token handling, worktree lifecycle, subprocess execution, and state transitions as security-sensitive. Validate inputs, avoid leaking secrets, use safe quoting, and preserve fail-closed behavior. For security-sensitive work, follow `commands/security-audit.md` and `SECURITY.md`.

When reviewing changes, report only evidence-based findings with file/line references and severity. Check state-machine correctness, protocol conformance, runtime parity, installer safety, shell portability, and documentation alignment. Real review findings should enter the normal issue/pipeline process rather than being silently patched around.

## Runtime-specific guidance

- **Claude Code:** `install.sh` installs shared commands globally under `~/.claude/commands/`.
- **Codex:** `install-codex.sh` installs namespaced `forge-*` skills under `~/.codex/skills`; repo-local `.agents/skills/` adapters take precedence.
- **OpenCode:** use `install-opencode.sh` and preserve its exact ForgeDock-managed migration boundaries.
- **Pi:** `install-pi.sh` installs the package; use the native `forge_orchestrate` and `forge_subagent` tools when the shared spec requires orchestration or fresh-context review.

Never make a runtime adapter the sole source of a workflow rule that should apply to every supported runtime.
