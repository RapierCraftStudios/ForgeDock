# OpenCode Support

ForgeDock has a native OpenCode control plane for the two load-bearing pipeline
entrypoints:

```text
/forge/work-on <issue>
/forge/orchestrate <query>
```

The controller is deterministic code. It does not load the Claude-oriented
`commands/work-on.md`, `commands/orchestrate.md`, or orchestration phase prose.
Each issue phase runs in a fresh root OpenCode session using a compact native
phase card under `runtimes/opencode/work-on/`.

Other ForgeDock commands continue to use thin OpenCode command/skill adapters
around shared semantic workflow specs. Claude keeps its existing engine, and
Claude Code and Codex installation paths are unchanged.

## Install

```bash
npx forgedock opencode install
```

Install the optional command tier with:

```bash
npx forgedock opencode install --extras
```

To test an unmerged linked worktree without resolving back to its main checkout,
use `--forge-home <candidate-worktree>`. This flag affects only the adapter
source for that install.

Restart OpenCode after install or update. The installer writes only managed
files under OpenCode's config directory and records them in
`forgedock/manifest.json`.

Installation does not add or modify user-owned OpenCode settings. During a
proven legacy migration, install and uninstall may rewrite `opencode.json` only
to remove exact ForgeDock-owned entries; migration does not
rewrite `opencode.jsonc`, and customized commands are preserved.

## Usage

```text
/forge/work-on 967
/forge/work-on 967 --lane staging --model provider/model
/forge/work-on 967 --dry-run

/forge/orchestrate 967 968 --dry-run
/forge/orchestrate milestone checkout-v2
/forge/orchestrate milestone checkout-v2 --confirm
/forge/orchestrate --resume <batch-id> --confirm
```

`work-on --dry-run` resolves the repository, issue, lane, branch, worktree, and
phase-card byte budget without creating sessions or mutating GitHub/git.

`orchestrate` always compiles and persists a plan before dispatch. Without
`--confirm` or `--auto`, it returns `confirmation-required` and performs no
pipeline mutation. Authorization can be supplied on the same query or by
resuming the reported batch ID.

Useful native flags:

| Flag | Applies to | Purpose |
|---|---|---|
| `--lane <branch>` | both | Explicit non-production PR base |
| `--repo <owner/repo>` | both | Must match the current checkout |
| `--model <provider/model>` | both | Explicit OpenCode provider/model |
| `--variant <name>` | both | Provider model variant |
| `--max-attempts <1-10>` | both | Per-phase attempt budget |
| `--dry-run` | both | Resolve/plan only; no mutation |
| `--keep-worktree` | work-on | Retain a merged issue worktree |
| `--max-concurrent <1-64>` | orchestrate | Batch worker cap |
| `--keep-worktrees` | orchestrate | Retain merged worktrees |
| `--resume <batch-id>` | orchestrate | Resume a persisted batch |

## Architecture

```text
OpenCode /forge/work-on
  -> compact generated command
  -> ForgeDock plugin custom tool
  -> bin/opencode/control.mjs
  -> durable bin/engine.mjs phase state machine
  -> fresh OpenCode root session per phase
  -> runtimes/opencode/work-on/<phase>.md
  -> GitHub/git outcome reconciliation

OpenCode /forge/orchestrate
  -> compact generated command
  -> ForgeDock plugin custom tool
  -> deterministic snapshot/preflight plan
  -> persisted batch event log
  -> serialized Promise scheduler
  -> concurrent runNativeWorkOn() workers
```

The host plugin client executes phase sessions directly. It does not create a
model-owned parent scheduler, use `task(background=true)`, inject synthetic
child-completion prompts, invoke `opencode run`, or fall back to Claude CLI or
the Anthropic API.

Every phase attempt:

1. Creates a fresh root OpenCode session with no `parentID`.
2. Disables `task`, `skill`, and recursive ForgeDock controller tools.
3. Runs exactly one native phase card.
4. Records session identity and normalized usage in the local run log.
5. Re-reads GitHub/git through the existing phase detector.
6. Commits the phase only when durable external state proves completion.

Assistant text and provider finish reasons are advisory. If a provider response
fails after a GitHub marker landed, reconciliation accepts the durable marker.
If every attempt fails at the runtime layer without a marker, the issue ends at
`workflow:engine-error`, not `needs-human`.

## Isolation

The generated plugin exposes two small tools, `forge_work_on` and
`forge_orchestrate`. It does not globally change:

- `subagent_depth`;
- built-in agent task permissions;
- the user's shell selection;
- the background-subagent process flag; or
- `FORGE_RUNTIME` for unrelated sessions.

Native phase session IDs are tracked in memory. Shell environment shaping and
recursive-controller guards apply only to those sessions. Main-workflow skill
wrappers (`work-on/**` and `orchestrate/**`) are no longer installed, removing
their metadata and preventing the old prompt controller from being selected.
The scoped worker environment includes `FORGE_RUNTIME=opencode`; the native
controller does not depend on legacy helper copies under `~/.opencode/scripts`.

Manifest v2 upgrades trust a valid managed v1 manifest long enough to remove
its obsolete ForgeDock-owned wrappers. User-owned files, including a custom
skill at the old `skills/work-on/SKILL.md` path, are preserved.

## Worktrees

Build work is isolated under:

```text
<repo>/.opencode/worktrees/<branch-with-slashes-normalized>
```

The controller reuses an existing worktree already attached to the issue branch
and refuses to overwrite a conflicting path. It removes only an OpenCode-owned
worktree whose branch is verified merged into the selected lane. Failed,
cancelled, gated, and `--keep-worktree` runs retain work for inspection/resume.

## Orchestration

The scheduler currently admits deterministic, single-repository queries handled
by `bin/orchestrate-preflight.mjs`, including literal issue sets, milestones,
`fast-lane`, `next N`, priorities, and no-milestone selection.

It enforces:

- explicit confirmation before first dispatch;
- one concurrency semaphore for the batch;
- explicit, same-file, and database dependency edges;
- external-dependency verification;
- immediate successor dispatch after each completed predecessor;
- no dispatch after a failed/gated predecessor;
- append-only batch events with truncated-tail repair;
- cancellation propagation to active phase sessions; and
- resume from persisted per-issue terminal results.

Unsupported multi-repository and explicit deep-semantic planning queries fail
closed with an actionable error. They do not fall back to the large shared
orchestration prompt.

Batch artifacts live under:

```text
~/.forge/batches/<owner_repo>/<batch-id>/plan.json
~/.forge/batches/<owner_repo>/<batch-id>/events.jsonl
```

Per-issue logs are repository-scoped under:

```text
~/.forge/runs/<owner_repo>/<issue>.jsonl
```

## Cancellation And Resume

A normal OpenCode tool cancellation aborts active phase sessions, appends
`RUN_INTERRUPTED`, clears the issue lease, and leaves the engine state
non-terminal. Re-running `work-on` resumes from the last GitHub-committed phase.

After a hard process or machine crash, GitHub state remains authoritative. A
new invocation resumes after the prior best-effort lease expires; it does not
continue an opaque model conversation.

## Lifecycle

```bash
npx forgedock opencode status
npx forgedock opencode install
npx forgedock opencode install --extras
npx forgedock opencode uninstall
```

`npx forgedock update` refreshes an already-installed adapter while preserving
its core/extras tier. Install and uninstall do not rewrite `opencode.jsonc` and
may remove legacy `opencode.json` entries only when their exact managed
ownership contract is proven.

Default managed locations:

```text
~/.config/opencode/
  commands/forge/*.md
  skills/<non-native-workflow>/SKILL.md
  plugins/forgedock.js
  forgedock/manifest.json
```

`XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR` are honored. npm/npx installs copy
the required `bin/`, `commands/`, `runtimes/`, `scripts/`, and `templates/`
payload into stable `~/.forge` storage before generating the adapter.

## Verification

Use [`OPENCODE-NATIVE-ACCEPTANCE.md`](OPENCODE-NATIVE-ACCEPTANCE.md) for the
pre-staging automated, disposable-repository, cancellation/resume, token, and
Claude non-regression gates.
