# Autopilot Cron Mode — GitHub Actions Setup

Run [`/autopilot`](../commands/autopilot.md) on a schedule so your repo gets better while you sleep.

---

## Quick Start

1. **Copy the workflow template** into your repo:

   ```bash
   mkdir -p .github/workflows
   curl -o .github/workflows/forgedock-autopilot.yml \
     https://raw.githubusercontent.com/RapierCraftStudios/ForgeDock/milestone/developer-experience-distribution/templates/github-actions/forgedock-autopilot.yml
   ```

2. **Add your Anthropic API key** as a repository secret:
   - Go to: `Settings → Secrets and variables → Actions → New repository secret`
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key from [console.anthropic.com](https://console.anthropic.com)

3. **Commit the workflow file** — GitHub Actions picks it up automatically.

That's it. The workflow runs every Monday at 9 AM UTC in `recon` mode (safe, read-only).

---

## Modes

### `recon` (default — safe)

Runs [`/autopilot --recon-only`](../commands/autopilot.md):

- Pulls signals: production health, CI/CD, issue backlog, analytics
- Creates GitHub issues for findings
- **No branches, no PRs, no code changes**

This is the default for scheduled runs. Safe to enable immediately.

### `fix` (explicit opt-in)

Runs [`/autopilot --fix --limit N`](../commands/autopilot.md):

- Everything in `recon` mode, plus:
- Picks up the top N open issues and runs `/work-on` on each
- Creates branches and PRs targeting `staging` (never `main`)
- **Requires explicit selection** — not available on scheduled runs without editing the workflow

To enable `fix` mode on a scheduled run, edit the `Resolve autopilot arguments` step in the workflow and change the default `MODE` to `fix`.

To run `fix` mode on demand, use the **Run workflow** button on GitHub Actions and select `fix` from the mode dropdown.

---

## Permissions

The workflow requires these GitHub token permissions (already set in the template):

| Permission | Required for |
|------------|-------------|
| `contents: write` | Creating branches and pushing commits (`fix` mode) |
| `issues: write` | Creating and labeling issues (both modes) |
| `pull-requests: write` | Creating PRs (`fix` mode) |

`GITHUB_TOKEN` is provided automatically — no extra setup needed.

---

## Adjusting the Schedule

The default cron runs every Monday at 9 AM UTC. To change it, edit the `cron` line:

```yaml
on:
  schedule:
    - cron: '0 9 * * 1'   # Monday 9 AM UTC
    # - cron: '0 8 * * *'  # Daily at 8 AM UTC
    # - cron: '0 9 1 * *'  # Monthly on the 1st
```

Cron syntax: `minute hour day-of-month month day-of-week`. Use [crontab.guru](https://crontab.guru) to verify expressions.

---

## Changing the Fix Limit

The `limit` input controls how many issues are picked up per run in `fix` mode (default: 3). To change the default for manual runs, edit the `default` value under `inputs.limit` in the workflow file.

---

## Non-Interactive Confirmation Bypass

`/autopilot` Phase 4B normally requires interactive user confirmation before running `/work-on` on any issues. In GitHub Actions (a non-interactive environment), this gate is bypassed automatically when the `CI` environment variable is `true` — which is always the case in GHA.

**The `workflow_dispatch` mode input serves as the human opt-in.** When you select `fix` and click **Run workflow**, you are explicitly approving the fix run. For scheduled runs, the mode embedded in the workflow YAML is your standing approval.

This bypass is narrow: it only skips Phase 4B's interactive prompt. All other safety rules in `/autopilot` remain in force — `needs-human` issues are never picked up, milestone issues are excluded, and the `FIX_LIMIT` cap is always enforced.

---

## Cost Estimates

| Mode | Typical token usage | Approximate cost |
|------|--------------------|--------------------|
| `recon` | ~5,000–15,000 tokens | ~$0.02–$0.05/run |
| `fix` (1 issue) | ~50,000–150,000 tokens | ~$0.15–$0.45/run |
| `fix` (3 issues) | ~150,000–450,000 tokens | ~$0.45–$1.35/run |

Estimates based on `claude-sonnet-4` pricing ($3.00/M input, $15.00/M output). Actual usage varies by issue complexity and codebase size.

To control costs, keep `mode: recon` for scheduled runs and use `fix` mode only on demand.

---

## Frequently Asked Questions

**Will this merge code to `main`?**
No. `/autopilot` (and `/work-on`) never merge to `main`. All PRs target `staging` or a milestone branch. You deploy when ready.

**What if an autopilot run fails?**
The workflow exits with a non-zero status. GitHub sends a notification email (configurable). The run is logged in the Actions tab. No partial state is left — issues are only created after a full recon cycle.

**Can I run this in a private repo?**
Yes. `GITHUB_TOKEN` has full access to your repo. Only the Anthropic API key is external.

**Can I use this with Codex / OpenAI models?**
No. `/autopilot` requires Claude Code CLI, which runs Anthropic models. The `ANTHROPIC_API_KEY` is mandatory.

**What does `/autopilot` do if there are open P0 issues?**
It skips normal recon and immediately routes to `fix` mode targeting the P0 issues, regardless of the selected mode. P0 always takes priority.
