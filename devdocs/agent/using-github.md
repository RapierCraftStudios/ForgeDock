---
authority: required
scope: agent
applies_to: [work-on, review-pr, issue, orchestrate, quality-gate, cleanup]
domain: github
last_validated: "2026-06-15"
version: "1.0.15"
---

# Using GitHub — ForgeDock Repository Conventions

Authoritative reference for how agents and contributors interact with GitHub in the **ForgeDock** repository specifically. These conventions ensure the ForgeDock pipeline functions correctly when dogfooding itself.

---

## Repository Identity

| Field | Value |
|-------|-------|
| Owner | `RapierCraftStudios` |
| Repo | `forgedock` |
| Full name | `RapierCraftStudios/forgedock` |
| GH_FLAG | `-R RapierCraftStudios/forgedock` |
| Default branch | `main` |
| Staging branch | `staging` |

```bash
GH_REPO="RapierCraftStudios/forgedock"
GH_FLAG="-R RapierCraftStudios/forgedock"
```

---

## Branch Naming

### Conventions

| Type | Pattern | Example |
|------|---------|---------|
| Bug fix | `fix/{slug}-{issue_number}` | `fix/gh-api-jq-arg-broken-pattern-688` |
| Feature | `feat/{slug}-{issue_number}` | `feat/devdocs-self-dogfooding-676` |
| Fast lane (any) | `fix/` or `feat/` prefix, branch from `staging` | — |
| Feature lane | `feat/{slug}-{issue_number}`, branch from `milestone/{slug}` | — |

**Slug rules**: lowercase, hyphenated, max 40 chars, derived from issue title keywords.

### Source Branch Rules

| Lane | Issue has milestone? | Branch from |
|------|---------------------|------------|
| Fast | No | `origin/staging` |
| Feature | Yes | `origin/milestone/{slug}` |
| Review-finding with `Code branch` in body | Yes | `origin/{code_branch}` |

### Active Milestone Branches

| Milestone | Branch | Status |
|-----------|--------|--------|
| Deterministic Pipeline v2 | `milestone/deterministic-pipeline-v2` | Active |
| Onboarding TUI | `milestone/onboarding-tui` | Paused |

---

## PR Conventions

### Target Branch Rules

| Situation | PR Base |
|-----------|---------|
| Fast-lane issue (no milestone) | `staging` |
| Feature-lane issue (has milestone) | `milestone/{slug}` — e.g. `milestone/deterministic-pipeline-v2` |
| **NEVER** | `main` |

`main` receives changes only through the staging review process (`/review-pr staging`).

### PR Title Format

```
{Fix|Feat|Refactor|Docs|Chore}: {description}
```

Examples:
- `Feat: DevDocs self-dogfooding — scaffold own devdocs/ with v2 schema`
- `Fix: gh api --jq --arg broken pattern in review-pr.md and review-pr-agents.md`

### PR Body Structure

```markdown
## Summary
{1-3 sentences describing what changed and why}

## Changes
- {file or component}: {what changed}

## Testing
- [ ] {test scenario}

---
Closes #{issue_number}
**Implementation branch**: `{branch}`
**Base**: `{pr_base}`
```

**`Closes #{N}` does not auto-close** for non-default-branch PRs. The pipeline explicitly closes the issue after merge.

---

## Commit Conventions

### Format

```
{type}({scope}): {description} (#{issue_number})
```

| Field | Rules |
|-------|-------|
| `type` | `fix`, `feat`, `refactor`, `docs`, `chore`, `test` |
| `scope` | optional; component name in parentheses — e.g. `(devdocs)`, `(work-on)`, `(scripts)`, `(bin)` |
| `description` | imperative mood, lowercase, no period, under 72 chars |
| `#{issue_number}` | always reference the issue |

### Examples (ForgeDock-specific)

```
feat(devdocs): scaffold own devdocs/ with v2 frontmatter (#676)
fix(work-on): detect and delete partial investigator comment (#689)
refactor(scripts): extract lane routing into classify-lane.sh (#669)
docs(devdocs): update milestone tracking table — remove closed issues (#676)
chore: bump version to 1.0.15 [skip ci]
```

### Rules

- **Imperative mood**: "add" not "added", "fix" not "fixed"
- **No period** at the end
- **Under 72 characters** on the first line
- **Always reference the issue**: `(#{N})`
- **`[skip ci]`**: only for pure documentation or version bump commits

---

## Issue Conventions

### Mandatory Sections

Issues MUST have these four sections for pipeline compatibility:

```markdown
## Problem
{what is wrong or missing}

## Affected Files
{numbered list of file paths that need changes}

## Acceptance Criteria
- [ ] {specific, testable criterion}

## Expected Behavior
{what should happen after the fix/feature is implemented}
```

### Title Format

```
{prefix}({scope}): {concise description}
```

| Prefix | Use for |
|--------|---------|
| `fix:` | Bug fixes |
| `feat:` | New features |
| `refactor:` | Code restructuring, no behavior change |
| `docs:` | Documentation changes |
| `chore:` | Maintenance (version bumps, CI config) |
| `investigate:` | Research/audit tasks that produce findings as output |

**Max 80 characters.** Be specific.

### Labels

**Priority labels** (required on all issues):

| Label | When to use |
|-------|------------|
| `priority:P0` | Pipeline broken, data loss, security vulnerability |
| `priority:P1` | Significant failure, milestone blocked |
| `priority:P2` | Minor issue, non-critical enhancement (default) |
| `priority:P3` | Cosmetic, nice-to-have |

**Category labels** (one per issue):

`bug`, `enhancement`, `feature`, `refactor`, `docs`, `infra`, `performance`, `security`, `ux`, `dead-code`, `review-finding`, `audit-finding`

**Workflow labels** (managed by pipeline — do not set manually):

`workflow:investigating`, `workflow:ready-to-build`, `workflow:building`, `workflow:in-review`, `workflow:merged`, `workflow:invalid`, `workflow:decomposed`, `needs-human`

---

## Git Worktrees

ForgeDock uses git worktrees for isolation. Each issue gets its own worktree under `.claude/worktrees/`:

```bash
WORKTREE_BASE="$(yq '.paths.worktree_base' forge.yaml)"
BRANCH="feat/{slug}-{issue_number}"
WORKTREE_PATH="${WORKTREE_BASE}/${BRANCH}"
git worktree add "$WORKTREE_PATH" -b "$BRANCH" "origin/{source_branch}"
```

**Never work directly in the main repo checkout when a worktree exists.** All file reads, writes, and git operations for an active issue happen in the worktree.

---

## npm Package Publishing

ForgeDock publishes to npm automatically on push to `main` when these paths change:

- `commands/`
- `bin/`
- `docs/`
- `scripts/`
- `package.json`

CI handles version bumps with `[skip ci]` in the commit message to prevent loops. **Never manually bump version** — let CI handle it.

---

## Common gh CLI Patterns

```bash
# View issue with comments
gh issue view {N} -R RapierCraftStudios/forgedock --json number,title,body,labels,state,comments,milestone

# List open issues by priority
gh issue list -R RapierCraftStudios/forgedock --state open --json number,title,labels \
  --jq 'sort_by(.labels[].name) | .[] | "#\(.number) \(.title)"'

# List milestone issues
gh issue list -R RapierCraftStudios/forgedock \
  --milestone "Deterministic Pipeline v2" --state open \
  --json number,title,labels

# Find PRs for a branch
gh pr list -R RapierCraftStudios/forgedock --head feat/676-devdocs-self-dogfooding --json number,state,title

# Close issue with comment
gh issue close {N} -R RapierCraftStudios/forgedock \
  --comment "Closed: PR #{pr_number} merged to \`{base}\`. Closes #{N}."
```

---

## Safety Rules

1. **Never push to `main` directly.** Even hotfixes go through a PR.
2. **Never force-push to shared branches** (`main`, `staging`, `milestone/*`).
3. **Never use `--no-verify`** to skip hooks unless explicitly asked.
4. **Never create duplicate issues.** Check open AND closed issues before creating.
5. **Review findings are NOT merge blockers.** They become separate issues.
6. **Issues, not inline fixes.** Any bug or improvement found during work → create a GitHub issue, never silently fix it in scope.
