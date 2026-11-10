<div align="center">

<img src="https://avatars.githubusercontent.com/in/4051319?s=200&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>An AI engineering team that ships to production.</strong><br/>
You describe what you want. ForgeDock plans it, builds it, reviews it, releases it, and keeps the receipts on GitHub.</p>

<p>Bring your own Claude Code subscription or API key. ForgeDock resells no compute.</p>

<a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
<a href="https://www.npmjs.com/package/forgedock"><img src="https://img.shields.io/npm/v/forgedock?color=cb3837&logo=npm" alt="npm" /></a>
<a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet" alt="Claude Code" /></a>
<a href="https://github.com/RapierCraftStudios/ForgeDock/stargazers"><img src="https://img.shields.io/github/stars/RapierCraftStudios/ForgeDock?style=social" alt="GitHub Stars" /></a>

<p>📖 <a href="https://rapiercraftstudios.github.io/ForgeDock/">Docs</a> · <a href="#try-it">Try it</a> · <a href="#in-production">In production</a> · <a href="#faq">FAQ</a></p>

</div>

<div align="center">

<!-- TODO: replace with the 60-90s time-lapse: one sentence typed → epic + sub-issues → lanes running → release merged -->
<img src="docs/demo.gif" alt="ForgeDock turning one feature request into an epic, parallel lanes and a merged release" width="900" />

</div>

## One sentence in, a shipped feature out

```
"Add team billing with per-seat invoices"
        │
        ▼
 epic + sub-issues, wired with dependencies      ← plan
        │
        ▼
 validate each one: real? already done? wrong?  ← rejects bad issues before any code
        │
        ▼
 parallel lanes: contract → build → review → CI ← one issue per lane, many at once
        │
        ▼
 release snapshot → staging review panel → merge ← security, concurrency, auth, regressions
        │
        ▼
 post-deploy checks, follow-ups filed           ← nothing silently dropped
```

Every step is a structured record on the issue or PR. Lanes survive crashes, later lanes read what earlier ones learned, and you can audit any change back to the sentence that asked for it.

## Why not just ask a coding agent?

A single agent session takes an issue as truth and starts typing. That works for small, well-specified changes. At scale it produces the same failures every time: building on a wrong premise, duplicating something that already exists, missing an integration point, shipping without anyone checking.

ForgeDock puts a fixed process around the model. The engine, not the model, decides the next step:

- **Validate first.** Is the issue real, still open, not already done? Wrong and duplicate issues are closed with evidence and no code.
- **Frozen contract.** Requirements are fixed before implementation, and review checks the diff against them.
- **Separate reviewer.** A different session reviews for unimplemented requirements and regressions. Fix rounds run fresh.
- **Release gate.** A panel of domain reviewers must pass the release before it reaches your default branch.

## In production

<!-- DRAFT — owner approval needed for this paragraph -->
ForgeDock was built for one founder who does not write code. With it, that founder built and runs [AlterLab](https://alterlab.io), a production data platform with paying customers. Instructions to the system are short (median 8 words); everything else is lanes, reviews and releases.
<!-- /DRAFT -->

**AlterLab, last 30 days (2026-10-11 → 2026-11-10):**

| | |
|---|---|
| Pull requests merged | 2,498 |
| Issues completed | 2,358 |
| Model cost per completed issue | $1.54 mean, $1.08 median (API-equivalent, lane runs only) |
| Issues closed before any code (invalid, duplicate or superseded) | 1,036 |
| Production defects traced to a pipeline lane | 8, about 3 per 1,000 merged PRs ([how we counted](docs/eval/hotfix-audit-2026-11.md)) |

We publish the defect count because a pipeline that hides its failures can't be trusted. Each of those eight is traced to its cause and has a fix tracked in public ([#5283](https://github.com/RapierCraftStudios/ForgeDock/issues/5283), [#5284](https://github.com/RapierCraftStudios/ForgeDock/issues/5284), [#5285](https://github.com/RapierCraftStudios/ForgeDock/issues/5285)).

**ForgeDock builds ForgeDock**, in public. Recount any of it:

```bash
gh api -X GET search/issues -f q="repo:RapierCraftStudios/ForgeDock is:pr is:merged merged:>=2026-10-11" --jq .total_count
```

Runs you can read end to end:
- [#952](https://github.com/RapierCraftStudios/ForgeDock/issues/952): the pipeline closed its own proposal as invalid, with receipts. The work had shipped weeks earlier. No code written.
- [#1172](https://github.com/RapierCraftStudios/ForgeDock/issues/1172): review found an API-key exfiltration path; fixed in 18 minutes with regression tests. A later review found a bypass ([#1243](https://github.com/RapierCraftStudios/ForgeDock/issues/1243)).
- [#4442](https://github.com/RapierCraftStudios/ForgeDock/issues/4442): one feature split into six dependent sub-issues, built in dependency order.
- [#4468](https://github.com/RapierCraftStudios/ForgeDock/issues/4468): the release panel stopped a change that would have let a bot-authored issue run a command on the operator's host.

## Try it

**Needs:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (subscription or `ANTHROPIC_API_KEY`), [GitHub CLI](https://cli.github.com/) (authenticated), Node.js ≥ 18.

```bash
npx forgedock demo     # throwaway repo, the whole pipeline end to end, about 10 minutes
```

On your own repo:

```bash
npm install -g forgedock
forgedock                                  # checks your setup, writes a forge.yaml for you to review
forgedock run-issue 42                     # one issue, start to merge
forgedock orchestrate 41 42 43 --parallel 3
```

Inside Claude Code: `/work-on 42`, `/orchestrate`, or just describe a feature and ask for issues with `/issue`.

## FAQ

**Doesn't it just generate its own work?**
Part of its work is follow-ups it files on itself: review findings and deferred items. That is deliberate: a finding becomes a tracked issue instead of a silent gap. It is also measured, so you can see the split between work you asked for and work the pipeline found, and cut what isn't worth it. <!-- TODO: link the measured split once the scorecard lands -->

**Will it overcomplicate a one-line change?**
A one-session light lane for small issues is available as opt-in (`light.mode: on`; it ships in `shadow`). The validation step still runs, because "small and obvious" issues are often already done or wrong.

**What goes wrong?**
Lanes fail, and how they fail matters. Each ends with a typed outcome (`ci.red`, `base.conflict`, `needs-human`…). Mechanical failures retry on their own; the rest wait for you with the evidence attached. Production defects still happen; see the numbers above.

**What does it cost?**
Your own Claude usage. `forgedock stats --efficiency` reports cost per merge, turns and retries by cause.

**What stays with a human?**
Product direction, spend, credentials, customer-facing actions and promotion to production are escalated, never decided by an agent.

## What works today

| | |
|---|---|
| Runtime | Claude Code (CLI or subscription). OpenCode with [documented limits](docs/OPENCODE.md). |
| Forge | GitHub (issues, PRs, labels, Actions). |
| Branching | Lanes merge into staging (or `milestone/*`); a reviewed release promotes staging to the default branch. |
| Releases | `forgedock release`: a reviewed release job. Snapshot releases (`release.mode: snapshot`), host preflight before paid CI and Actions-minutes budgeting are on staging and not yet released ([#5279](https://github.com/RapierCraftStudios/ForgeDock/issues/5279)). |

Deeper: [How it works](docs/site/how-it-works.md) · [GitHub is your agents' memory](docs/site/github-is-the-memory.md) · [Configuration](docs/CONFIG.md) · [Outcome codes](docs/OUTCOME-CODES.md) · [Comparison](docs/comparison.md)

## For companies

The core is AGPL-3.0 and stays that way. A [commercial license](COMMERCIAL-LICENSE.md) is available for proprietary use, and an org-wide layer is in development with design partners. See [ForgeDock for companies](docs/site/for-companies.md) or write to [support@rapiercraftstudios.com](mailto:support@rapiercraftstudios.com).

<sub>ForgeDock is unrelated to ForgeRock's identity platform. Using it? <a href="https://github.com/RapierCraftStudios/ForgeDock/stargazers">A star</a> is the whole marketing budget.</sub>
