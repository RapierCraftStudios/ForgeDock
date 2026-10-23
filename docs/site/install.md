# Install

Everything you need to install ForgeDock and keep it up to date. For a first run, `npx forgedock demo` needs no setup beyond the requirements below.

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [OpenCode](https://opencode.ai/) · [GitHub CLI](https://cli.github.com/) (authenticated) · Node.js ≥ 18.

```bash
npx forgedock # checks your environment, installs commands into ~/.claude/commands/ (available in every Claude Code session on this machine), detects your repo, and hands you a reviewed forge.yaml
```

For OpenCode, install namespaced native commands without changing your provider
or user-owned settings. When migrating an older ForgeDock adapter, it removes
only exact ForgeDock-managed legacy entries from `opencode.json`:

```bash
npx forgedock opencode install
# restart OpenCode, then: /forge/work-on <issue>
```

See [OpenCode support](../OPENCODE.md) for architecture, token-loading rules,
current parity boundaries, and lifecycle commands.

**Install is always global**, to `~/.claude/commands/`. `--global` is still accepted on the command line for backward compatibility but has no effect — there's no other install location to opt out of.

> **Want engine-mode dispatch?** `npx forgedock` is transient — the `forgedock` binary isn't persisted in PATH after install. `/orchestrate` and `/autopilot` use agent dispatch mode by default, which is fully functional. To enable engine-mode dispatch (`forgedock run-issue`) with its durable phase table and fail-closed review gate, run `npm install -g forgedock` instead.

One command does everything: it checks your environment, installs the slash commands into Claude Code, detects your repo (owner, branches, paths), and hands you a single annotated `forge.yaml` to review — press Enter to accept. Run `npx forgedock init` any time afterward to re-generate the config only.

Installing also registers a SessionStart hook, so every Claude Code session
in a forge-managed directory starts already knowing ForgeDock runs it.
Per-directory control: `npx forgedock enable` / `disable` / `status`.

Then just open Claude Code and run `/work-on <issue>`.

> **Cost:** ForgeDock is free and open-source. It orchestrates sessions on **your** Claude account — no compute resold, no per-task markup. A typical `/work-on` run on a straightforward bug costs about what a 15–20 minute manual Claude Code session does.

<details>
<summary><strong>Other install options & commands</strong></summary>

**Claude Code plugin marketplace** (Claude Code v2.1.143+):

```
/plugin marketplace add RapierCraftStudios/ForgeDock
/plugin install forgedock@forgedock
```

Commands then appear as `/forgedock:work-on`, etc. You still run `npx forgedock init` to generate `forge.yaml`.

**Headless / CI:** the pipeline also runs outside Claude Code. `npx forgedock run work-on <issue> --dry-run` previews the assembled prompt and tool plan. `npx forgedock run` picks an execution backend automatically (`--backend auto`, the default): if the Claude Code CLI (`claude`) is installed and already authenticated (Pro/Max subscription or a CLI-managed key), it drives the command through that — **no separate `ANTHROPIC_API_KEY` required**. It never falls back to the paid Anthropic API implicitly: without a CLI it fails with `CLI_BACKEND_UNAVAILABLE` unless the owner opted in (forge.yaml `execution.agent_backend: api` plus `FORGEDOCK_ALLOW_API_BACKEND=1`; see [CONFIG.md](../CONFIG.md#execution-optional)). Force either path explicitly with `--backend cli` / `--backend api` (or `FORGEDOCK_BACKEND=cli|api`) — the API backend is what CI environments without an interactive `claude` login should use. `npx forgedock run-issue <issue>` executes the same command specs on the durable engine (event-sourced run log, leases, crash-safe resume).

**Brand-new project?** `/bootstrap "<idea>"` (or `npx forgedock bootstrap "<idea>" --dry-run` to preview) turns an idea into a validated, milestone-ordered GitHub backlog that `/orchestrate` can build. See [Start a New Project with ForgeDock](start-a-new-project.md).

**Explicit install command:**

```bash
npx forgedock install           # installs into ~/.claude/commands/
npx forgedock install --global  # same thing — --global is accepted but is a no-op
```

**Maintenance:**

```bash
npx forgedock update      # relink commands + refresh the SessionStart hook
npx forgedock enable      # turn ForgeDock on for this directory
npx forgedock disable     # turn ForgeDock off for this directory
npx forgedock status      # show ForgeDock's state for this directory
npx forgedock doctor      # installation health check with fix hints
npx forgedock report      # 30-day pipeline impact receipts (--md for Markdown, --json for scripting)
npx forgedock uninstall   # remove commands, the hook, and tracked copies
npx forgedock help        # show everything
```

> Running `npx forgedock` from *inside* this repo uses the local working tree. From your own project, use `npx forgedock@latest` to pin the published release.

</details>

<details>
<summary><strong>A note on install location</strong></summary>

ForgeDock briefly experimented with a project-scoped-by-default install mode. It was backed out after causing a "split-brain" bug (`detect` assumed project-scoped while the installer still wrote globally — [#1589](https://github.com/RapierCraftStudios/ForgeDock/issues/1589)), so every version you'd realistically install today only ever writes to `~/.claude/commands/`. `--global` is still accepted as a flag for old scripts/muscle memory, but it changes nothing.

If you're carrying an older `--global` habit in scripts or CI, it's harmless to leave it — `npx forgedock --global` and `npx forgedock` do exactly the same thing.

</details>

**After upgrading**: run `npx forgedock labels setup` once per repo. Repos created before the `workflow:remediating` state (forge#3541) lack that label; the pipeline now creates it on demand (best-effort), but the setup command is the supported way to sync all labels.



