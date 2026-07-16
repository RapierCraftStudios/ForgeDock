# CI Integration — ForgeDock PR Review in GitHub Actions

This guide explains how to integrate ForgeDock's `/review-pr` pipeline into GitHub Actions so every PR gets automatic multi-domain AI review without requiring a manual Claude Code session.

<!-- publish trigger: bot-token merges do not fire path-filtered workflows -->

---

## What This Does

The `forgedock-review.yml` workflow template triggers on every pull request (opened, synchronized, or reopened) and runs ForgeDock's full review pipeline:

- Security, auth, billing, database, concurrency, frontend, API, performance, and infrastructure agents all review the PR diff
- Review findings are posted as comments on the PR
- Each finding becomes a tracked GitHub issue in your repository
- No human needs to remember to run `/review-pr` — it happens automatically

---

## Prerequisites

1. **Anthropic API key** — Claude Code runs against the Anthropic API. Get one at [console.anthropic.com](https://console.anthropic.com).
2. **ForgeDock installed** — The workflow installs ForgeDock automatically via `npx forgedock install` (install is always global, so commands are available system-wide in the runner).
3. **GitHub Actions enabled** — Standard for all public repos; enabled by default for private repos.

---

## Setup

### 1. Add the API key as a repository secret

In your repository: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (`sk-ant-...`) |

Never commit the API key to your repository. GitHub Actions masks secrets in logs, but only secrets stored via Settings are protected.

### 1a. Set the deploy-gate repository variable

If you use the `gate-marker-check` workflow (which enforces that every staging→main PR was reviewed by `/review-pr-staging` before merge), you must also set a **repository variable** that tells the gate which GitHub logins are authorized to post gate markers.

In your repository: **Settings → Secrets and variables → Actions → Variables → New repository variable**

| Name | Value |
|------|-------|
| `FORGE_TRUSTED_MARKER_AUTHORS` | Comma-separated list of GitHub logins authorized to run `/review-pr-staging` (e.g. `your-bot-login,your-personal-login`) |

**Why this is required**: The gate-marker-check workflow verifies that gate markers (`FORGE:GATE_PASS` / `FORGE:GATE_FAILURE`) were posted by a trusted author — not hand-typed by an external contributor. If this variable is unset or empty, the gate rejects every marker and blocks all staging→main PRs. The gate will fail immediately with setup instructions rather than waiting 30 minutes and producing a cryptic timeout error.

**What logins to include**: Add the GitHub login of the bot or user account that runs Claude Code sessions (the account that posts `/review-pr-staging` output). For automated CI setups this is typically the bot account; for manual runs it is your personal GitHub login.

### 2. Copy the workflow template

Copy `templates/workflows/forgedock-review.yml` from your ForgeDock installation to your repository:

```bash
# From your repository root
mkdir -p .github/workflows
cp "$(npx forgedock which-dir)/templates/workflows/forgedock-review.yml" .github/workflows/forgedock-review.yml
```

Or copy it manually — the file is in `~/.claude/commands/../templates/workflows/forgedock-review.yml` after running `npx forgedock install`.

### 3. Commit and push

```bash
git add .github/workflows/forgedock-review.yml
git commit -m "feat(ci): add ForgeDock automated PR review workflow"
git push
```

The workflow activates immediately. Open or synchronize any PR to trigger the first review.

---

## Security Model

### API key handling

The `ANTHROPIC_API_KEY` is passed exclusively via the `env:` block in the workflow YAML. It is never:
- Echoed to logs with `echo` or `printf`
- Passed as a CLI argument (visible in process lists)
- Written to disk during the workflow run

GitHub Actions masks the secret value in all log output automatically.

### GITHUB_TOKEN scope

The workflow uses the built-in `GITHUB_TOKEN`, which is:
- Automatically provided by GitHub Actions for every workflow run
- Scoped to the repository
- Revoked after the workflow run completes
- Constrained to `contents: read` and `pull-requests: write` by the `permissions:` block

No additional tokens or personal access tokens are required.

### Runner isolation

Each workflow run uses a fresh ephemeral GitHub-hosted runner (`ubuntu-latest`). The `--dangerously-skip-permissions` flag passed to Claude Code is safe in this context because:
- The runner is discarded after the job completes
- No persistent state is left behind
- The workflow's `permissions:` block constrains what the `GITHUB_TOKEN` can do

---

## Fork PR Limitation

**Pull requests from forks do not have access to repository secrets.**

This is a GitHub security restriction: a forked repository's PR cannot read secrets from the upstream repository's Settings. The `pull_request` event that triggers this workflow will have `ANTHROPIC_API_KEY` as an empty string for fork PRs, and the Claude Code step will fail silently or error.

### Option 1: Accept the limitation (recommended for open-source repos)

Leave the workflow as-is. Team members' PRs get reviewed automatically. External contributor PRs are reviewed manually when a maintainer runs `/review-pr` in Claude Code.

### Option 2: Use `pull_request_target` (advanced — security implications)

`pull_request_target` runs in the context of the base repository (not the fork), so secrets are available. However, it also runs untrusted code from the fork in a privileged context, which is a security risk if the workflow checks out and runs code from the fork.

If you use `pull_request_target`, you MUST:
1. Never check out the fork's code and run it
2. Scope what Claude Code can access carefully
3. Review the [GitHub security hardening guide for `pull_request_target`](https://securitylab.github.com/research/github-actions-preventing-pwn-requests/)

This is not recommended without understanding the security implications.

---

## `forgedock run` Execution Backend

This guide's `forgedock-review.yml` workflow invokes `/review-pr` directly via the `claude --print` CLI, so it always needs `ANTHROPIC_API_KEY` as shown above — the CLI itself authenticates against your Anthropic account.

Separately, `npx forgedock run <command>` (the standalone, non-Claude-Code command runner in `bin/runner.mjs`) has its own **backend selection**, independent of this CI workflow:

| Backend | When used | Credential needed |
|---------|-----------|--------------------|
| `cli` (via `--backend cli` or `FORGEDOCK_BACKEND=cli`) | Explicit, or auto-selected when a working `claude` CLI is detected on PATH | None — reuses the CLI's own authentication (Pro/Max OAuth or a CLI-managed key) |
| `api` (via `--backend api` or `FORGEDOCK_BACKEND=api`) | Explicit, or auto-selected fallback when `claude` is not detected | `ANTHROPIC_API_KEY` |
| `auto` (default) | No `--backend` / `FORGEDOCK_BACKEND` given | Prefers `cli`, falls back to `api` |

**When CI still needs `ANTHROPIC_API_KEY` for `forgedock run`**: CI runners generally do not have an interactively-authenticated `claude` CLI (no browser/OAuth flow available in a headless job), so `auto` detection will typically fall back to `api` there anyway. If your CI runner does install and log in the `claude` CLI (e.g. via a headless API-key-based login), you can force `--backend cli` to skip the SDK/API path entirely. Otherwise, keep `ANTHROPIC_API_KEY` configured as a repository secret (see Setup above) and either let `auto` fall back naturally or set `--backend api` / `FORGEDOCK_BACKEND=api` explicitly for a deterministic CI backend regardless of what happens to be on the runner's PATH.

`npx forgedock run <command> --dry-run` always reports which backend it resolved to, without making any network call or requiring a key either way.

---

## Customization

### Skip review for certain PRs

Add conditions to the `if:` field on the job:

```yaml
# Skip bot PRs and draft PRs
if: |
  github.actor != 'dependabot[bot]' &&
  github.actor != 'github-actions[bot]' &&
  github.event.pull_request.draft == false
```

### Target only certain branches

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches:
      - main
      - staging
      - 'milestone/**'
```

### Pass additional flags to /review-pr

The `claude --print` invocation accepts `/review-pr` arguments. For example, to skip auto-merge (default) or pass a custom flag:

```yaml
run: |
  claude --print "/review-pr $PR_NUMBER --model opus" \
    --dangerously-skip-permissions
```

### Enable commit status badge

Uncomment the `Set Commit Status` step in the workflow template to add a pass/fail badge to PRs. This uses the GitHub API via `actions/github-script` to post a commit status after the review completes.

---

## Troubleshooting

**Review job fails immediately with `ANTHROPIC_API_KEY not set`**
→ The secret is not configured. Go to Settings → Secrets and variables → Actions and add `ANTHROPIC_API_KEY`.

**Review passes but no comments appear on the PR**
→ Check that `permissions: pull-requests: write` is present in the workflow. Without it, the `gh` CLI calls from `/review-pr` will receive 403 errors.

**Fork PRs show empty `ANTHROPIC_API_KEY`**
→ Expected behavior. See the Fork PR Limitation section above.

**`claude: command not found`**
→ The `npm install -g @anthropic-ai/claude-code` step failed. Check the job logs. The `ubuntu-latest` runner includes Node.js but the global npm install may fail if the runner's Node version is too old. Ensure the `Set up Node.js` step runs first and targets Node.js 18+.

**`npx forgedock install` reports `command not found: forgedock`**
→ `npx forgedock install` runs the installer from npm. If it fails, verify the ForgeDock package name is correct: `npm show forgedock version` should return a version number.

**`claude: unknown flag --output-format` or similar unrecognized flag error**
→ Your local Claude Code installation is outdated. The `--output-format` flag is available in all recent versions of Claude Code. Run `npm update -g @anthropic-ai/claude-code` to update to the latest version. Note: the workflow template itself no longer passes `--output-format` (the flag was redundant — `--print` defaults to text output). If you copied the template before this fix, remove the `--output-format text` line from your workflow file.
