---
title: "ForgeDock Complete Command Reference"
description: "Complete reference for all ForgeDock slash commands for Claude Code. Usage, options, and examples for all 25+ commands covering the full AI development pipeline."
keywords: ["claude code slash commands", "claude code extensions", "claude code commands list", "forgedock commands", "ai development pipeline commands"]
---

# Complete Command Reference

ForgeDock installs 25+ slash commands into Claude Code. Each command is a detailed prompt spec that guides an AI agent through a specific phase of the development pipeline.

Install all commands with:

```bash
npx forgedock
```

After installation, every command is available as `/command-name` in any Claude Code session.

---

## Core Pipeline Commands

These are the commands you use most. They cover the full lifecycle from issue to merged PR.

---

### `/work-on`

**The main pipeline orchestrator.**

Runs the complete investigate → build → review → merge → close pipeline for a single GitHub issue.

```bash
/work-on 42           # Work on issue #42
/work-on next         # Pick the highest-priority open issue
```

**What it does**:
1. Reads the issue and all existing FORGE annotations
2. Determines the current pipeline phase (resumes if interrupted)
3. Investigates root cause with git blame and historical context
4. Architects the implementation plan
5. Builds the fix in an isolated git worktree
6. Runs a 14-category quality gate
7. Creates a PR and invokes `/review-pr --auto-merge`
8. Closes the issue and cleans up the worktree

**Branch naming**: `fix/{slug}-{number}` (bugs) or `feat/{slug}-{number}` (features)

**PR target**: `staging` (fast lane) or `milestone/{slug}` (feature lane, based on issue milestone)

---

### `/review-pr`

**Context-aware PR reviewer.**

Analyzes what a PR touches and spawns domain-specific review agents.

```bash
/review-pr 123                    # Review PR #123
/review-pr 123 --auto-merge       # Review and merge if all agents approve
/review-pr staging                # Review staging branch vs. main
```

**What it does**:
- Reads the PR diff and all associated FORGE annotations
- Spawns up to 9 domain agents (security, logic, frontend, backend, database, infrastructure, docs, tests, dependencies)
- Each agent posts a structured review with severity-rated findings
- Critical and HIGH findings become separate GitHub issues
- With `--auto-merge`: merges the PR if no blocking findings

---

### `/quality-gate`

**Pre-commit quality checker.**

Catches the defects a reviewer would flag — before the commit is made.

```bash
/quality-gate                     # Check current staged changes
/quality-gate --worktree /path    # Check a specific worktree
```

**14+ check categories**:
- Security (hardcoded credentials, injection risks)
- SQL safety (injection, unsafe queries)
- Auth model (missing auth checks, privilege escalation paths)
- Env var completeness (new vars not in .env.example)
- Frontend proxy wiring (direct backend calls from client code)
- Import validity (imports from non-existent modules)
- Type safety (type invariant violations)
- Deploy config (missing env vars in deploy chain)
- And more...

*Invoked automatically by `/work-on` — can also be run manually before committing.*

---

### `/orchestrate`

**Parallel multi-issue pipeline.**

Spawns sub-agents that each run the full `/work-on` pipeline in parallel.

```bash
/orchestrate milestone launch-campaign   # All issues in a milestone
/orchestrate #42 #43 #44                 # Specific issues
/orchestrate next 5                      # Top 5 priority issues
/orchestrate fast-lane                   # All staging-lane issues
/orchestrate P0                          # All P0 issues
```

Each sub-agent gets its own git worktree and GitHub issue thread. No interference between parallel agents.

---

### `/autopilot`

**Self-improvement cycle.**

Runs recon, triage, and optionally fixes top-priority issues automatically.

```bash
/autopilot                        # Recon + triage only
/autopilot --fix                  # Recon + triage + fix top issues
/autopilot --fix --limit 5        # Fix top 5 issues
/autopilot --recon-only           # Recon only, no triage
/autopilot --dry-run              # Show what would be done
```

---

## Investigation & Validation

---

### `/validate`

**Pre-build issue validation.**

Independently verifies whether a reported issue is actually a real problem before any code changes.

```bash
/validate 42                      # Validate issue #42
/validate "login button broken"   # Validate by description
```

Returns: CONFIRMED, PARTIAL, or INVALID with evidence.

---

### `/audit`

**Production issue tracer.**

Traces a production failure end-to-end through GitHub artifacts (commits, PRs, issues) and files an improvement issue.

```bash
/audit "payments 500 errors started after deploy"
/audit --issue 42                 # Trace based on existing issue
/audit --pr 123                   # Trace based on PR
```

---

### `/security-audit`

**Periodic security posture audit.**

Runs a 4-phase security checklist against repo files (not just diffs). Creates GitHub issues for confirmed findings.

```bash
/security-audit                   # All 4 phases
/security-audit --phase 1         # Specific phase
/security-audit --dry-run         # Show findings without creating issues
```

---

### `/qa-sweep`

**Full platform QA sweep.**

Auto-discovers pages and tests UI elements via browser automation. Creates GitHub issues for all findings.

```bash
/qa-sweep all                     # Full sweep
/qa-sweep dashboard               # Dashboard area only
/qa-sweep page /settings          # Specific route
/qa-sweep journey                 # Critical user journeys
/qa-sweep a11y                    # Accessibility only
```

---

## Issue & Milestone Management

---

### `/issue`

**Structured issue creator.**

Creates a well-structured GitHub issue with all sections the pipeline needs (Problem, Affected Files, Expected Behavior, Acceptance Criteria).

```bash
/issue "The login button is misaligned on mobile Safari"
/issue "Add dark mode support to the dashboard"
```

---

### `/milestone`

**Milestone manager.**

Creates, manages, and ships milestones — the top-level planning layer for feature development.

```bash
/milestone create "Q3 Auth Improvements"  # Create a new milestone
/milestone status                          # Current milestone status
/milestone ship q3-auth                    # Ship a milestone
/milestone sync q3-auth                    # Sync issues to board
```

---

### `/cleanup`

**Repository hygiene sweep.**

Cleans up stale labels, missing workflow state, project board gaps, dangling worktrees, and orphaned branches.

```bash
/cleanup labels                   # Fix stale labels
/cleanup branches                 # Prune merged branches
/cleanup milestones               # Archive shipped milestones
/cleanup board                    # Fix project board gaps
/cleanup orphans                  # Remove dangling worktrees
/cleanup all                      # Everything
```

---

## Observability & Analytics

---

### `/analytics`

**Production analytics audit.**

Pulls analytics from multiple sources (GSC, Bing Webmaster, Clarity, Umami, Cloudflare, Stripe, GA4) and generates actionable GitHub issues.

```bash
/analytics                        # Full analytics audit
```

Trigger phrases: "check analytics", "look at prod analytics", "what's happening on the site", "check revenue".

---

### `/pipeline-health`

**Pipeline performance analyzer.**

Measures pipeline performance, correlates with prompt changes, and proposes improvements.

```bash
/pipeline-health                  # All repos
/pipeline-health my-app           # Specific repo
```

---

### `/forge-stats`

**Command size tracker.**

Tracks command file sizes, detects bloat, and compares against baselines.

```bash
/forge-stats                      # Current sizes
/forge-stats diff                 # Changes since baseline
/forge-stats baseline             # Set current as baseline
/forge-stats full                 # Full report
```

---

### `/geo-audit`

**GEO (Generative Engine Optimization) audit.**

Checks AI referral traffic and page compliance for AI search engines. Creates improvement issues.

```bash
/geo-audit                        # Full GEO audit
```

---

### `/audit-agents`

**Agent output analyzer.**

Audits agent outputs from an orchestration run — timeline analysis, stall detection, idle time breakdown.

```bash
/audit-agents latest              # Most recent run
/audit-agents {session-id}        # Specific session
/audit-agents {agent-id}          # Specific agent
```

---

## Operations & Deploy

---

### `/deploy-info`

**Pre-deploy diff.**

Shows what will deploy next — diff between staging and main with issue/PR summary, risk assessment, and deploy checklist.

```bash
/deploy-info                      # staging vs. main
/deploy-info staging              # Explicit staging
/deploy-info milestone/q3-auth    # Milestone branch
/deploy-info compare my-branch    # Custom comparison
```

---

### `/rollback`

**Revert PR creator.**

Creates a revert PR to roll back a shipped feature or fix that caused a production incident.

```bash
/rollback 123                     # Revert PR #123
/rollback last                    # Revert most recent deploy
```

---

### `/incident-response`

**P0 incident coordinator.**

Coordinates P0 incident response — hotfix validation, timeline reconstruction, and post-incident analysis.

```bash
/incident-response 42             # Respond to issue #42
/incident-response active         # Current active incident
/incident-response postmortem 42  # Post-incident analysis
```

---

## Configuration & Setup

---

### `/forgedock-init`

**Config generator.**

AI-powered `forge.yaml` generator — scans codebase, queries GitHub, and fills all sections interactively.

```bash
/forgedock-init                   # Generate forge.yaml
/forgedock-init --force           # Overwrite existing
/forgedock-init --section review  # Regenerate one section
```

---

### `/sync-ecosystem`

**Cross-repo sync.**

Detects API changes, syncs satellite repos, and publishes releases.

```bash
/sync-ecosystem check             # Check for changes
/sync-ecosystem auto              # Auto-sync
/sync-ecosystem status            # Current sync status
/sync-ecosystem publish           # Publish release
/sync-ecosystem {pr-number}       # Sync from PR
```

---

## Sub-Phase Commands

These are invoked automatically by `/work-on` but can also be run standalone.

| Command | Phase | Purpose |
|---------|-------|---------|
| `/work-on/investigate` | Phase 1 | Investigation only |
| `/work-on/build` | Phase 3 | Build only (requires investigation) |
| `/work-on/build/context` | Phase 3C.5 | Context gathering only |
| `/work-on/build/architect` | Phase 3C.6 | Architecture planning only |
| `/work-on/build/implement` | Phase 3F | Implementation only |
| `/work-on/build/validate` | Phase 3G | Quality gate only |
| `/work-on/review` | Phase 5 | Review only |
| `/work-on/close` | Phase 6 | Close & cleanup only |
| `/work-on/decompose` | Phase 2 | Decompose into sub-issues |
| `/review-pr-staging` | Staging | Review staging branch before deploy |

---

## Next Steps

- [Getting Started with ForgeDock in 5 Minutes](./getting-started.md) — install and run your first pipeline
- [How ForgeDock's Knowledge Graph Works](./how-it-works.md) — understand how commands share context
- [ForgeDock vs. Manual Claude Code Workflows](./vs-manual-workflows.md) — why structured commands beat ad-hoc prompting
- [The FORGE Annotation Protocol](./forge-annotation-protocol.md) — the protocol used by all pipeline commands
