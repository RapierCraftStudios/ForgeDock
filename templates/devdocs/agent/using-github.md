---
authority: required
scope: agent
applies_to: [work-on, review-pr, issue, orchestrate, quality-gate, cleanup]
---

# Using GitHub — Authoritative Conventions Reference

This document defines how agents and developers interact with GitHub in this project. These conventions ensure the ForgeDock pipeline functions correctly and that the issue/PR/branch graph remains navigable.

---

## Core Principle

**Issues are the unit of work.** Every change — bug fix, feature, refactor — starts as a GitHub issue and ends as a merged PR that closes it. No direct pushes to `main` or `staging`. No PRs without a linked issue (except hotfixes with explicit justification).

---

## GitHub CLI (`gh`) Usage

### Authentication

```bash
gh auth status          # verify authentication
gh auth login           # authenticate if needed
```

### Common Flags

All commands that target a specific repository use the `-R owner/repo` flag. In ForgeDock pipelines, this is resolved from `forge.yaml`:

```bash
GH_REPO=$(yq '.project.owner + "/" + .project.repo' forge.yaml)
GH_FLAG="-R $GH_REPO"

# Example usage
gh issue view 42 $GH_FLAG
gh pr list $GH_FLAG --state open
```

---

## Issue Conventions

### Creating Issues

Issues MUST have these four sections for pipeline compatibility:

```markdown
## Problem
{1-3 sentences — what is wrong or missing}

## Affected Files
{numbered list of file paths that need changes}

## Acceptance Criteria
- [ ] {specific, testable criterion}

## Expected Behavior
{what should happen after the fix/feature is implemented}
```

Use the `/issue` command to create issues — it reads code before writing, enforces structure, and checks for duplicates automatically.

### Title Format

```
{prefix}: {concise description}
{prefix}({scope}): {concise description}
```

| Prefix | Use for |
|--------|---------|
| `fix:` | Bug fixes |
| `feat:` | New features |
| `refactor:` | Code restructuring, no behavior change |
| `docs:` | Documentation changes |
| `chore:` | Maintenance (version bumps, CI config) |
| `investigate:` | Research/audit tasks |

**Max 80 characters.** Be specific: `fix(billing): division by zero when user credits reach 0` not `fix: billing bug`.

### Labels

**Priority labels** (required on all issues):

| Label | When to use |
|-------|------------|
| `priority:P0` | Production down, data loss, security vulnerability |
| `priority:P1` | Significant user-facing bug, deploy blocked |
| `priority:P2` | Minor bug, non-critical enhancement (default) |
| `priority:P3` | Cosmetic, nice-to-have, low-impact |

**Category labels** (required, one per issue):

`bug`, `enhancement`, `feature`, `refactor`, `docs`, `infra`, `performance`, `security`, `ux`, `dead-code`, `review-finding`, `audit-finding`

**Workflow labels** (managed by pipeline — do not set manually):

`workflow:investigating`, `workflow:ready-to-build`, `workflow:building`, `workflow:in-review`, `workflow:merged`, `workflow:invalid`, `workflow:decomposed`, `needs-human`

### Checking for Duplicates

Always check before creating:

```bash
gh issue list $GH_FLAG --state open --search "{keywords}" --limit 20 \
  --json number,title,labels --jq '.[] | "#\(.number) \(.title)"'

gh issue list $GH_FLAG --state closed --search "{keywords}" --limit 10 \
  --json number,title --jq '.[] | "#\(.number) [closed] \(.title)"'
```

---

## Branch Naming

### Conventions

| Type | Pattern | Example |
|------|---------|---------|
| Bug fix | `fix/{slug}-{issue_number}` | `fix/billing-zero-credits-42` |
| Feature | `feat/{slug}-{issue_number}` | `feat/dark-mode-toggle-58` |
| Fast lane (any) | `fix/` or `feat/` prefix | (same as above) |
| Feature lane | `feat/{slug}-{issue_number}` on `milestone/{slug}` branch | — |

**Slug rules**: lowercase, hyphenated, max 40 chars, derived from issue title.

### Source Branch Rules

| Lane | Issue has milestone? | Branch from |
|------|---------------------|------------|
| Fast | No | `origin/staging` |
| Feature | Yes | `origin/milestone/{slug}` |
| Review-finding | Has `Code branch: \`{branch}\`` in body | `origin/{branch}` |

### Git Worktrees

ForgeDock uses git worktrees for isolation. Each issue gets its own worktree:

```bash
WORKTREE_PATH="{repo_root}/.claude/worktrees/{branch}"
git worktree add "$WORKTREE_PATH" -b "{branch}" origin/{source_branch}
```

**Never work directly in the main repo checkout when a worktree exists.** All file reads, writes, and git operations for an active issue happen in the worktree.

---

## PR Conventions

### Target Branch Rules

| Situation | PR Base |
|-----------|---------|
| Fast-lane issue (no milestone) | `staging` |
| Feature-lane issue (has milestone) | `milestone/{slug}` |
| **NEVER** | `main` |

`main` receives changes only through the staging review process (`/review-pr staging`).

### PR Body Structure

```markdown
## Summary
{1-3 sentences describing what changed and why}

## Changes
- {file or component}: {what changed}
- {file or component}: {what changed}

## Testing
- [ ] {test scenario 1}
- [ ] {test scenario 2}

---
Closes #{issue_number}
**Implementation branch**: `{branch}`
**Base**: `{pr_base}`
```

**`Closes #{N}` does not auto-close** for non-default-branch PRs. The pipeline explicitly closes the issue after merge.

### PR Title Format

```
{Fix|Feat|Refactor|Docs}: {description}
```

Capitalize the prefix. Match the issue prefix. Examples:
- `Fix: billing division by zero when user credits reach 0`
- `Feat: dark mode toggle for dashboard settings`

---

## Commit Conventions

### Format

```
{type}({scope}): {description} (#{issue_number})
```

| Field | Rules |
|-------|-------|
| `type` | `fix`, `feat`, `refactor`, `docs`, `chore`, `test` |
| `scope` | optional; component name in parentheses |
| `description` | imperative mood, lowercase, no period, under 72 chars |
| `#{issue_number}` | always reference the issue |

### Examples

```
fix(billing): prevent division by zero when user credits reach 0 (#42)
feat(dashboard): add dark mode toggle to settings page (#58)
refactor(api): extract pagination logic into shared utility (#71)
docs(config): document devdocs frontmatter authority field (#258)
chore: bump version to 1.2.0 [skip ci]
```

### Multi-line Commits

When more context is needed:

```
fix(api): handle null response from external payment provider (#99)

The Stripe webhook handler did not handle the case where the payment
provider returns a null payment_intent. Added null guard and fallback
to pending state with retry scheduling.
```

### Rules

- **Imperative mood**: "add" not "added", "fix" not "fixed"
- **No period** at the end
- **Under 72 characters** on the first line
- **Always reference the issue**: `(#{N})`
- **`[skip ci]`**: only for pure documentation or version bump commits

---

## Label Management

### Creating Missing Labels

```bash
gh label create "workflow:investigating" --color "1D76DB" -R $GH_REPO
gh label create "priority:P2" --color "FBCA04" -R $GH_REPO
gh label create "review-finding" --color "D93F0B" -R $GH_REPO
```

### Bulk Label Sync

Use `/cleanup` to sweep for stale labels, missing workflow states, and project board gaps.

---

## Project Board Integration

ForgeDock commands automatically update the GitHub Projects v2 board when `project_board` is configured in `forge.yaml`. Status moves through: Todo → In Progress → Done.

To manually add an issue to the board:

```bash
gh project item-add {project_number} --owner {owner} --url "{issue_url}"
```

---

## Common gh CLI Patterns

### View Issue with Comments

```bash
gh issue view {number} $GH_FLAG --json number,title,body,labels,state,comments
gh api repos/{GH_REPO}/issues/{number}/comments \
  --jq '.[] | {id: .id, author: .user.login, body: (.body | .[0:200])}'
```

### Find PRs for a Branch

```bash
gh pr list $GH_FLAG --head {branch} --json number,state,title
```

### Close Issue with Comment

```bash
gh issue close {number} $GH_FLAG \
  --comment "Closed: PR #{pr_number} merged to \`{base}\`. Closes #{number}."
```

### Merge PR

```bash
gh pr merge {pr_number} $GH_FLAG --merge --auto
```

### Check PR Status

```bash
gh pr view {pr_number} $GH_FLAG --json state,mergedAt,mergeable,mergeStateStatus \
  --jq '{state, mergedAt, mergeable, mergeStateStatus}'
```

### Edit Issue Labels

```bash
gh issue edit {number} $GH_FLAG \
  --add-label "workflow:building" \
  --remove-label "workflow:ready-to-build"
```

---

## Safety Rules

1. **Never push to `main` directly.** Even hotfixes go through a PR.
2. **Never force-push to shared branches** (`main`, `staging`, `milestone/*`) without explicit human approval.
3. **Never use `--no-verify`** to skip hooks unless explicitly asked.
4. **Always check mergeability** before posting a review verdict: `gh pr view {N} --json mergeable,mergeStateStatus`.
5. **Never create duplicate issues.** Check open AND closed issues before creating.
6. **Never fabricate file paths.** Verify with `git show origin/{branch}:{filepath}` before listing a file in an issue.
7. **Review findings are NOT merge blockers.** They become separate issues to fix later.
