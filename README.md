<div align="center">

<img src="https://avatars.githubusercontent.com/in/4051319?s=200&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>From GitHub issues to reviewed, tested, merged changes, autonomously.</strong></p>

<p>ForgeDock runs AI coding agents through validation, implementation, review, CI and merge, one issue per lane, many lanes in parallel. Every step is recorded on GitHub, so runs survive crashes, later agents build on earlier ones, and you can audit everything.</p>

<a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/v/forgedock?color=cb3837&logo=npm" alt="npm" /></a>
<a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet" alt="Claude Code" /></a>
<a href="https://github.com/RapierCraftStudios/ForgeDock/stargazers"><img src="https://img.shields.io/github/stars/RapierCraftStudios/ForgeDock?style=social" alt="GitHub Stars" /></a>

<p>📖 <a href="https://rapiercraftstudios.github.io/ForgeDock/">Documentation</a> · <a href="#try-it-in-30-seconds">Try it</a> · <a href="#the-evidence">Evidence</a> · <a href="#what-works-today">What works today</a></p>

</div>

<div align="center">

<img src="docs/demo.gif" alt="ForgeDock running several GitHub issues in parallel: lanes validate, build, review and merge, flipping workflow labels live" width="900" />

</div>

## What it does

You file issues. ForgeDock turns each one into a merged pull request:

```
issue → validate → plan (frozen contract) → implement → review → PR → CI → merge
```

- **One lane per issue, many in parallel.** `forgedock orchestrate` schedules a batch from the issues' `Depends on #N` lines, runs up to K lanes at once, and recovers the mechanical failures itself (CI red, merge conflicts, engine errors). It asks you only about product, spend, credentials and releases.
- **Durable.** Each lane records its state on the issue and in a crash-safe run log. Kill it, restart it, or lose the session: it resumes from what GitHub says, and two lanes never own the same issue.
- **Checked, not trusted.** Each change is held to a contract frozen before implementation. It must pass a separate review (which blocks on unimplemented requirements and regressions) and CI. On paths you mark as risky, the full contract-conformance gate also blocks. Before anything reaches your default branch, a staging review with a panel of domain reviewers (security, concurrency, auth, CLI, regression risk…) must post a gate marker.
- **GitHub is the memory.** Findings, decisions and trajectories are written as structured comments that later lanes read. Nothing lives only in a chat window.

ForgeDock orchestrates delivery. It does not replace the model: it runs on your Claude Code account and resells no compute.

## Try it in 30 seconds

**Needs:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (subscription or `ANTHROPIC_API_KEY`) · [GitHub CLI](https://cli.github.com/) (authenticated) · Node.js ≥ 18.

```bash
npx forgedock demo     # creates a throwaway repo and runs the pipeline end to end
```

To use it on your own repo:

```bash
npm install -g forgedock      # the CLI and the durable engine
forgedock                     # checks your environment, installs the commands, writes a forge.yaml for you to review
forgedock run-issue 42        # one issue, start to merge
forgedock orchestrate 41 42 43 --parallel 3    # a batch, scheduled from its Depends-on lines
```

Inside Claude Code the same flows are `/work-on 42` and `/orchestrate`. All install options (plugin marketplace, OpenCode, headless/CI) are in [Install](docs/site/install.md).

## The evidence

**ForgeDock is built with ForgeDock.** Every number below is from this repository's public history and you can recount it.

| Last 30 days (2026-09-24 → 2026-10-23) | |
|---|---|
| Issues filed / closed | 800 / 784 |
| Pull requests merged | 613 |
| Issues that are the pipeline's own review findings | 396 (about half) |
| Issue opened → merged and closed, median | 2 h 19 min (p25 55 min, p75 10 h; 475 issues) |
| **Since 2026-06-04:** PRs merged / releases | 1,961 / 85 |

```bash
gh api -X GET search/issues -f q="repo:RapierCraftStudios/ForgeDock is:pr is:merged merged:2026-09-24..2026-10-23" --jq .total_count
```

**Runs you can open and read end to end:**

- [#1230](https://github.com/RapierCraftStudios/ForgeDock/issues/1230): the staging review found dead code in a feature shipped three hours earlier, then review caught a bug in the fix itself. 30 minutes from issue to merge.
- [#1172](https://github.com/RapierCraftStudios/ForgeDock/issues/1172): review found an `ANTHROPIC_API_KEY` exfiltration path in the headless runner; fixed in 18 minutes with regression tests. A later review found a bypass of that fix ([#1243](https://github.com/RapierCraftStudios/ForgeDock/issues/1243)).
- [#952](https://github.com/RapierCraftStudios/ForgeDock/issues/952): the pipeline closed its own proposal as invalid, with receipts: the work had shipped weeks earlier. No code written.
- [#4442](https://github.com/RapierCraftStudios/ForgeDock/issues/4442): a large feature split into six dependent sub-issues ([#4448](https://github.com/RapierCraftStudios/ForgeDock/issues/4448)–[#4453](https://github.com/RapierCraftStudios/ForgeDock/issues/4453)) that the batch runner built in dependency order.

### What the gates caught

The staging review runs before every release. The releases of 2026-10-22 and 2026-10-23 alone stopped these defects before they shipped. Each was found by a reviewer, filed, fixed by a lane and re-verified:

| Caught | What would have shipped |
|---|---|
| [#4465](https://github.com/RapierCraftStudios/ForgeDock/issues/4465) (HIGH) | Merge-conflict resolution silently dropped a lane's edits to any file named like `404-page.tsx`, then skipped tests and re-review |
| [#4468](https://github.com/RapierCraftStudios/ForgeDock/issues/4468) (HIGH) | The acceptance probe could run a command quoted inside a bot-authored issue on the operator's host |
| [#4470](https://github.com/RapierCraftStudios/ForgeDock/issues/4470) | The open-findings release gate passed when every GitHub read failed |
| [#4501](https://github.com/RapierCraftStudios/ForgeDock/pull/4501) (HIGH) | Issues reopened after a merge (e.g. by a failed production probe) were skipped forever |
| [#4516](https://github.com/RapierCraftStudios/ForgeDock/pull/4516) | A dependency-parser fix turned prose like "see #99" into blocking edges |

### What still goes wrong

Lanes fail. What matters is how they fail. A lane that cannot finish ends with a typed outcome (`ci.red`, `base.conflict`, `budget.exceeded`, `needs-human`…). Mechanical ones are retried automatically, and the rest wait for a person with the evidence attached. Open bugs are public, for example a lane whose checkpoint push is rejected ([#4505](https://github.com/RapierCraftStudios/ForgeDock/issues/4505)) and a dependency-line regex that backtracks on long whitespace ([#4517](https://github.com/RapierCraftStudios/ForgeDock/issues/4517)). Outcome codes are documented in [OUTCOME-CODES](docs/OUTCOME-CODES.md).

## How it works

**A lane** takes one issue through a fixed sequence. The engine, not the model, decides the next step:

1. **Validate:** is the issue real and still open work? Already fixed or invalid issues are closed with evidence and no code.
2. **Plan:** the builder proposes requirements, and the engine freezes them as a contract.
3. **Implement:** one builder session in an isolated worktree, which checks itself with the repo's own commands.
4. **Review:** a separate reviewer checks the diff against the contract and looks for regressions. Fix rounds run in a fresh, narrow session.
5. **PR, CI, merge:** the lane waits for the required checks, syncs with the base branch if it moved, and merges. Deferred items become tracked follow-up issues instead of silent gaps.

**A batch** (`forgedock orchestrate`) is a scheduler over lanes. It reads `Depends on #N` edges, keeps K lanes busy, shares slots across repos on the host, holds admissions when an account hits its usage limit, and survives restarts: lanes are detached processes and a daemon re-adopts them.

**A release** promotes staging to your default branch only after the staging review posts a `FORGE:GATE_PASS` marker that CI checks.

Deeper: [How it works](docs/site/how-it-works.md) · [GitHub is your agents' memory](docs/site/github-is-the-memory.md) · [FORGE annotation protocol](docs/spec/forge-protocol-v1.md) · [Architecture](docs/site/architecture.md)

## What works today

| | Status |
|---|---|
| Runtime | Claude Code (CLI or subscription). OpenCode is supported with [documented parity limits](docs/OPENCODE.md). |
| Forge | GitHub only (issues, PRs, labels, Actions). |
| Branching | Lanes merge into a staging branch (or `milestone/*`); a reviewed release promotes staging to the default branch. |
| Runtime test gate | Runs your configured integration tests before a release; it reports SKIP until you configure `verification.integration_tests`. |
| Light lane (one-session mode for small issues) | Ships in `shadow` mode: it records what it would do. Known gaps to close before enabling are tracked in [#4502](https://github.com/RapierCraftStudios/ForgeDock/issues/4502). |
| Human decisions | Product direction, spend, credentials, customer-facing actions and releases are always escalated, never decided by an agent. |
| Cost | Runs on your Claude account. `forgedock stats --efficiency` reports $/merge, turns/merge and retries by cause. |

## Docs

- [Getting started](docs/site/getting-started.md) · [Install](docs/site/install.md) · [Configuration](docs/CONFIG.md) · [Command reference](docs/site/command-reference.md)
- [Troubleshooting & recovery](docs/site/troubleshooting.md) · [Outcome codes](docs/OUTCOME-CODES.md) · [Stats](docs/STATS.md)
- [Start a new project](docs/site/start-a-new-project.md) · [Comparison with other approaches](docs/comparison.md) · [Release eval scorecards](docs/eval/README.md)

## For companies

The core is AGPL-3.0 and stays that way. A [commercial license](COMMERCIAL-LICENSE.md) is available for proprietary use, and an org-wide fleet layer is in development with design partners. See [ForgeDock for companies](docs/site/for-companies.md) or write to [support@rapiercraftstudios.com](mailto:support@rapiercraftstudios.com).

**Contributing:** PRs welcome, with conventional commits (`fix(scope):`, `feat(scope):`). **License:** [AGPL-3.0](LICENSE).

<sub>ForgeDock is unrelated to ForgeRock's identity platform. Using it? <a href="https://github.com/RapierCraftStudios/ForgeDock/stargazers">A star</a> is the whole marketing budget.</sub>
