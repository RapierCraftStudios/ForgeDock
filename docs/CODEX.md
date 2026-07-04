# Codex Support

Forge now has an additive Codex-native install path. The goal is to preserve Forge behavior without regressing the existing Claude setup.

## Architecture

Shared source:
- `commands/**/*.md` remains the workflow spec for both runtimes

Claude wrapper:
- `install.sh` symlinks command files into the current project directory by default; pass `--global` to install into `~/.claude/commands/` for all projects

Codex wrapper:
- `install-codex.sh` generates namespaced skills in `~/.codex/skills`
- each installed skill adapts one shared command spec for Codex-native execution
- if a matching repo-local skill exists under `.agents/skills/<command>/SKILL.md`, the installer points the installed wrapper at that repo-local adapter instead of the generic wrapper

This is intentionally a wrapper architecture, not a duplicate command tree.

## Install

From the repo root:

```bash
./install-codex.sh
```

The installer creates:
- `~/.codex/skills/forge/SKILL.md`
- `~/.codex/skills/forge-*/SKILL.md` for each command file under `commands/`, excluding internal catalog files that are read on demand

It does not overwrite unrelated global Codex skills.

## Skill Naming

Command files map to installed Codex skill names using:
- `forge-` prefix
- `/` replaced by `-`
- `.md` removed

Examples:

| Shared command spec | Installed Codex skill |
|---|---|
| `commands/work-on.md` | `forge-work-on` |
| `commands/review-pr.md` | `forge-review-pr` |
| `commands/orchestrate.md` | `forge-orchestrate` |
| `commands/work-on/investigate.md` | `forge-work-on-investigate` |
| `commands/work-on/build/context.md` | `forge-work-on-build-context` |

`commands/review-pr-agents.md` is excluded because it is a read-on-demand catalog, not a standalone entrypoint.

## How the Adapter Works

Each generated skill instructs Codex to:
- read the shared command spec from `commands/`
- translate Claude-specific workflow assumptions into Codex-native tools
- preserve GitHub labels, structured comments, worktree conventions, and workflow sequencing
- continue with the closest Codex-native execution path when a Claude-only affordance does not exist

Translation rules:
- Claude slash command invocation -> installed `forge-*` skill
- `Skill("x")` -> corresponding `forge-*` skill when available, otherwise direct continuation from the referenced source file
- `Agent(...)` / `Task(...)` -> Codex sub-agents when the source workflow genuinely benefits from orchestration
- `Bash`, `Read`, `Grep`, `Glob` -> Codex shell/file tools with `gh`, `git`, `rg`, `sed`, `find`, and repo scripts
- `WebFetch` -> web tooling or API calls via `gh` / `curl`

When a repo-local adapter exists under `.agents/skills/`, it becomes authoritative for that command in this repo. Use that layer for repo-specific overrides such as:
- different default GitHub repo resolution
- Codex-native worktree roots
- Forge-specific review heuristics
- best-effort handling of project-board steps that may be project-specific upstream

## Trust and Global Config

Codex may require the repo directory to be trusted in `~/.codex/config.toml`.

If Forge is not already trusted, add a project entry like:

```toml
[projects."/absolute/path/to/forge"]
trust_level = "trusted"
```

The installer does not modify global trust settings automatically.

## Conformance Verification

The Codex adapter produces and consumes the same FORGE annotation wire format as the Claude Code path. `scripts/conformance-check.mjs` validates annotation output from any producer (Claude Code, Codex, Cursor, or fixtures) against the FORGE Annotation Protocol v1.0 (`docs/spec/forge-protocol-v1.md`).

### Running the check

Pipe real or fixture-captured Codex-adapter-produced FORGE comments into the script:

```bash
# Validate a fixture file containing FORGE annotation blocks
node scripts/conformance-check.mjs docs/spec/fixtures/codex-adapter-annotations.md

# Validate live annotations from a merged PR (replace 1234 with the PR number)
gh api repos/RapierCraftStudios/ForgeDock/issues/1234/comments \
  --jq '[.[].body]' \
  | node scripts/conformance-check.mjs -

# Validate all comments on recent merged PRs (last 10)
gh pr list -R RapierCraftStudios/ForgeDock --state merged --limit 10 --json number \
  --jq '.[].number' | while read pr; do
    gh api "repos/RapierCraftStudios/ForgeDock/issues/$pr/comments" \
      --jq '[.[].body]'
done | node scripts/conformance-check.mjs -
```

Exit code 0 = all annotations conform. Exit code 1 = violations found (see output for details). Unrecognized annotation types are tolerated per spec §7.2 (WARN, not FAIL).

### Re-running when the adapter changes

Run the conformance check any time `.agents/skills/` adapter files are modified or after a new release of the spec. Conformance gaps found must be documented as follow-up GitHub issues (findings become issues per repo convention), not silently patched inline.

### Verified implementation claim

The Codex adapter path (`.agents/skills/*/SKILL.md` + `commands/*.md`) is a proven second implementation of the FORGE Annotation Protocol. Both the Claude Code path and the Codex adapter path produce annotations that pass `scripts/conformance-check.mjs`. See `docs/spec/forge-protocol-v1.md` Section 11 for the vendor-neutrality acknowledgement.

## Usage Notes

- Use the installed `forge` skill as the overview/router entrypoint.
- Use command-specific skills such as `forge-work-on` or `forge-review-pr` when the task is already clear.
- Keep `CLAUDE.md` and `AGENTS.md` aligned; Claude and Codex can differ at the wrapper layer, but not on Forge workflow invariants.
- For workflow paths that have repo-local adapters, prefer those adapters over the generic generated behavior.
