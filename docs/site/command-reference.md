---
title: "ForgeDock Complete Command Reference"
description: "Complete reference for all ForgeDock slash commands for Claude Code. Usage, options, and examples covering the full AI development pipeline."
keywords: ["claude code slash commands", "claude code extensions", "claude code commands list", "forgedock commands", "ai development pipeline commands"]
---

# Complete Command Reference

ForgeDock installs slash commands into Claude Code. Each command is a detailed prompt spec that guides an AI agent through a specific phase of the development pipeline.

Commands ship in two tiers:

- **Core** (default install) — the commands that cover the full pipeline: `work-on`, `issue`, `review-pr`, `quality-gate`, `orchestrate`, `forgedock-init`, and their sub-phases.
- **Extras** (opt-in) — analytics, audit, ops, and project-specific commands. Install with `--extras`.

```bash
npx forgedock              # Core tier only (default)
npx forgedock --extras     # Core + extras tier
```

After installation, every command is available as `/command-name` in any Claude Code session.

**New here?** You don't need to learn all of these at once. Start with the [Command Learning Path](./command-learning-path.md) — it tiers every command by when you need it, beginning with the three you'll use on Day 1.

---

## Core Loop

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

### `/issue`

**Structured issue creator.**

Creates a well-structured GitHub issue with all sections the pipeline needs (Problem, Affected Files, Expected Behavior, Acceptance Criteria).

```bash
/issue "The login button is misaligned on mobile Safari"
/issue "Add dark mode support to the dashboard"
```

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

#### `/test-gate`

**Acceptance verification gate.**

Deterministically verifies a staging→main bundle's acceptance criteria against running code before deploy.

```bash
/test-gate                        # Verify current staging
/test-gate --issue 42             # Verify acceptance criteria for issue #42
```

*Runs automatically as part of the deploy pipeline. Use manually to verify before triggering a deploy.*

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

#### `/milestone`

**Milestone manager.**

Creates, manages, and ships milestones — the top-level planning layer for feature development.

```bash
/milestone create "Q3 Auth Improvements"  # Create a new milestone
/milestone status                          # Current milestone status
/milestone ship q3-auth                    # Ship a milestone
/milestone sync q3-auth                    # Sync issues to board
```

---

## Observe & Recover

These commands implement the durable-state story: situational awareness, failure diagnosis, and crash-safe resume for pipeline runs.

---

#### `/pipeline-status`

**Pipeline-wide situational awareness.**

Groups open issues by workflow state, shows active PRs with age, flags stale items, and reports milestone progress. Fully read-only.

With the durable engine, also shows **engine lease state** for issues with a `FORGE:STATE` block — distinguishing `LEASED (agent, Nm left)` from `STALLED (lease expired Nm ago)`. Issues without engine state fall back to `updatedAt`-based staleness.

```bash
/pipeline-status                  # Full dashboard
/pipeline-status --stale-days 3   # Custom stale threshold
/pipeline-status --repo org/repo  # Specific repo
```

---

#### `/pipeline-resume`

**Context recovery after compaction.**

Finds the most recently active issue, reconstructs FORGE annotations, and re-enters the pipeline at the correct phase via `/work-on`.

```bash
/pipeline-resume                  # Auto-detect most recent issue
/pipeline-resume 610              # Resume specific issue
/pipeline-resume --all-stalled    # Fleet recovery: scan + re-dispatch all stalled issues
/pipeline-resume --all-stalled --dry-run  # List stalled issues without dispatching
```

The `--all-stalled` mode delegates to `npx forgedock resume-stalled`, which uses the engine's `scanStalls()` for ground-truth expired-lease detection rather than timestamp heuristics.

---

#### `/diagnose`

**Pipeline failure tracer.**

Traces a failed or stalled pipeline run — identifies which FORGE annotation is missing or malformed, pinpoints the failure phase, and suggests specific remediation steps.

```bash
/diagnose 42                      # Diagnose issue #42
/diagnose --stale                 # Find all stalled runs
```

---

#### `/explain`

**FORGE annotation translator.**

Produces a plain-English narrative of everything that happened on a GitHub issue — translates FORGE pipeline annotations into a human-readable summary for teammates and PMs who don't read raw annotations.

```bash
/explain 42                       # Explain what happened on issue #42
/explain 123 --pr                 # Explain a PR's review trail
```

---

#### `/replay`

**Read-only audit trail playback.**

Steps through a completed pipeline run phase by phase, showing each FORGE annotation with timestamps. Useful for understanding exactly what an agent did and when.

```bash
/replay 42                        # Replay issue #42 run
/replay 42 --phase build          # Replay only the build phase
```

---

#### `/changelog`

**Release notes generator.**

Auto-generates release notes from merged PRs and `FORGE:TRAJECTORY` annotations, grouped by conventional commit type. Produces a diff-accurate, human-readable changelog with no manual curation.

```bash
/changelog                        # Notes since last release
/changelog v1.2.0..v1.3.0        # Specific version range
/changelog --milestone q3-auth    # Milestone-scoped notes
```

---

## Ops

Commands for production operations, incident response, and keeping the repo healthy.

---

#### `/deploy-info`

**Pre-deploy diff.**

Shows what will deploy next — diff between staging and main with issue/PR summary, risk assessment, and deploy checklist.

```bash
/deploy-info                      # staging vs. main
/deploy-info staging              # Explicit staging
/deploy-info milestone/q3-auth    # Milestone branch
/deploy-info compare my-branch    # Custom comparison
```

---

### `/deploy-pr`

**PR ship orchestrator.**

Ships a branch to its deploy target — detects or creates the PR, runs CI fixing via `/fix-ci`, runs the review gate via `/review-pr`, merges after both pass, and returns a structured result. Designed to be invoked by `/autopilot` as part of the autonomous deploy loop.

```bash
/deploy-pr staging                           # Ship staging → main
/deploy-pr milestone/my-feature              # Ship milestone → staging
/deploy-pr feat/my-branch --target staging   # Ship any branch → staging
/deploy-pr staging --dry-run                 # Simulate without merging
/deploy-pr staging --issue 1234              # Reference parent issue in PR body
```

**Branch routing**: `staging` → `main` (Deploy), `milestone/*` → `staging` (Ship), other → `staging` (Merge). Never force-merges. Returns `{ pr, source, target, status, ci_fixes, review_findings }`.

---

### `/fix-ci`

**Automated CI failure resolution loop.**

Diagnoses CI failures on a PR, applies targeted fixes, pushes new commits, and loops until green or max attempts reached. Invoked automatically by `/deploy-pr` as the CI gate step; can also be run directly.

```bash
/fix-ci 123                       # Fix CI on PR #123
/fix-ci 123 --max-attempts 5      # Allow up to 5 fix iterations
/fix-ci 123 --repo owner/repo     # Explicit repo
```

Returns `{ pr, status, attempts, fixes_applied }`.

---

#### `/rollback`

**Revert PR creator.**

Creates a revert PR to roll back a shipped feature or fix that caused a production incident.

```bash
/rollback 123                     # Revert PR #123
/rollback last                    # Revert most recent deploy
```

---

#### `/incident-response`

**P0 incident coordinator.**

Coordinates P0 incident response — hotfix validation, timeline reconstruction, and post-incident analysis.

```bash
/incident-response 42             # Respond to issue #42
/incident-response active         # Current active incident
/incident-response postmortem 42  # Post-incident analysis
```

---

#### `/security-audit`

**Periodic security posture audit.**

Runs a 4-phase security checklist against repo files (not just diffs). Creates GitHub issues for confirmed findings.

```bash
/security-audit                   # All 4 phases
/security-audit --phase 1         # Specific phase
/security-audit --dry-run         # Show findings without creating issues
```

---

#### `/autopilot`

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

#### `/signal-planner`

**Closed-loop production signal to verified resolution.**

Converts a production, analytics, or incident signal into a dependency-ordered issue DAG, executes via `/orchestrate`, then verifies the originating signal is resolved. Event-driven companion to `/autopilot`.

```bash
/signal-planner --geo                         # GEO signal → issues → verify
/signal-planner --metric "p95_latency 2000"   # Latency signal
/signal-planner --incident 42                 # Issue-originated signal
/signal-planner --dry-run                     # Show DAG without executing
/signal-planner --max-issues 5                # Cap spawned issues
```

*Applies to: projects with production signals (analytics, incidents, metrics) configured in `forge.yaml`.*

---

#### `/cleanup`

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

### `/recover-orphans`

**Pipeline orphan recovery.**

Scans for issues stuck in intermediate workflow states (building, investigating, in-review) where the agent died mid-pipeline. Diagnoses each orphan's actual GitHub state and applies the appropriate recovery action — re-entering the pipeline via `/work-on` or `/review-pr`.

```bash
/recover-orphans                  # Scan and recover all orphans
/recover-orphans --dry-run        # Show orphans without recovering
/recover-orphans --since 24       # Only orphans stalled > 24 hours
/recover-orphans --issue 42       # Recover a specific issue
```

---

#### `/pipeline-health`

**Pipeline performance analyzer.**

Measures pipeline performance, correlates with prompt changes, and proposes improvements.

```bash
/pipeline-health                  # All repos
/pipeline-health my-app           # Specific repo
```

---

## Investigation & Validation

---

#### `/validate`

**Pre-build issue validation.**

Independently verifies whether a reported issue is actually a real problem before any code changes.

```bash
/validate 42                      # Validate issue #42
/validate "login button broken"   # Validate by description
```

Returns: CONFIRMED, PARTIAL, or INVALID with evidence.

---

#### `/audit`

**Production issue tracer.**

Traces a production failure end-to-end through GitHub artifacts (commits, PRs, issues) and files an improvement issue.

```bash
/audit "payments 500 errors started after deploy"
/audit --issue 42                 # Trace based on existing issue
/audit --pr 123                   # Trace based on PR
```

---

#### `/scope`

**Pre-flight complexity estimator.**

Estimates issue complexity before running `/work-on` — surfaces affected files, blast radius, risk flags, and a decomposition recommendation. Strictly read-only; nothing is written to GitHub.

```bash
/scope 42                         # Estimate issue #42
/scope 42 --repo owner/repo       # Explicit repo
```

---

#### `/diagnose`

See [Observe & Recover > `/diagnose`](#diagnose) above.

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

#### `/adopt`

**Repo bootstrap & backlog triage.**

Onboards an existing repo into the ForgeDock pipeline — scans open issues, classifies them, applies category and priority labels, suggests a starter milestone, and ranks the best `/work-on` first candidates. Run once after `npx forgedock init` + `/forgedock-init` to make a legacy backlog pipeline-ready.

```bash
/adopt                            # Triage current repo
/adopt --dry-run                  # Preview without writing labels
/adopt --milestone                # Also create a starter milestone
/adopt --limit 20                 # Cap issues triaged
```

---

#### `/sync-ecosystem`

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

## Advanced Pipeline Tuning

---

#### `/optimize`

**Adaptive script generator.**

Analyzes the repo and generates per-repo adaptive scripts from learned patterns, git history, and existing configuration — making repeated pipeline work faster over time.

```bash
/optimize                         # Analyze and generate scripts
/optimize --dry-run               # Preview recommendations
```

---

#### `/ci-audit`

**Stack-aware CI gap detection.**

Audits the project's GitHub Actions workflows against its declared tech stack and files issues for missing config-validation checks — ensuring CI enforces the right deterministic validators (e.g., `traefik validate`, `nginx -t`) for each stack component.

```bash
/ci-audit                         # Full CI gap audit
/ci-audit --dry-run               # Show gaps without creating issues
```

---

#### `/compat-audit`

**Claude Code compatibility report.**

Produces a point-in-time advisory report showing whether the installed Claude Code version is current and which ForgeDock features may behave differently on the current runtime.

```bash
/compat-audit                     # Check current version
/compat-audit --refresh           # Force refresh of breakpoints registry
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
| `/work-on/remediate` | Phase 0A.1 | Remediate a `needs-human` PR: fix findings, re-review, re-gate (`/work-on <pr> --remediate`) |
| `/review-pr-agents` | PR review | Agent catalog router read by `/review-pr` during dispatch (not user-invokable directly) |

`/review-pr` (core) reads the following per-persona and shared-protocol templates from `commands/review-pr-agents/` at runtime during Phase 3C dispatch. They ship as part of every install alongside `/review-pr` — not user-invokable directly.

| Command | Phase | Purpose |
|---------|-------|---------|
| `/review-pr-agents/protocols` | Phase 3C | Shared Evidence-Based/Structured-Findings/Input-Scoping protocols read before every persona template |
| `/review-pr-agents/security` | Phase 3C | General security & quality scan (always runs) |
| `/review-pr-agents/auth` | Phase 3C | Auth conventions auditor (AUTH domain) |
| `/review-pr-agents/billing` | Phase 3C | Billing/payments auditor (BILLING domain) |
| `/review-pr-agents/concurrency` | Phase 3C | Concurrency/locking auditor (CONCURRENCY domain) |
| `/review-pr-agents/database` | Phase 3C | Database/migration auditor (DATABASE domain) |
| `/review-pr-agents/frontend` | Phase 3C | Frontend conventions auditor (FRONTEND domain) |
| `/review-pr-agents/infra` | Phase 3C | Infra/deploy auditor (INFRA domain) |
| `/review-pr-agents/api` | Phase 3C | API/SDK contract auditor (API domain) |
| `/review-pr-agents/scraper` | Phase 3C | Scraping/anti-bot auditor (SCRAPING domain) |

`/orchestrate` (core) reads the following phase files from `commands/orchestrate/` at runtime. They ship as part of every install alongside `/orchestrate` — not user-invokable directly.

| Command | Phase | Purpose |
|---------|-------|---------|
| `/orchestrate/config` | Phase 0 | Hard rules, config resolution, multi-repo support — read first |
| `/orchestrate/phase-1-resolve` | Phase 1 | Resolve the issue set from input |
| `/orchestrate/phase-2-triage` | Phase 2 | Investigation-first triage, Wave 0 |
| `/orchestrate/phase-2.5-synthesis` | Phase 2.5 | Investigation synthesis and deconfliction |
| `/orchestrate/phase-3-dependency` | Phase 3 | Dependency analysis, DAG construction, execution plan |
| `/orchestrate/phase-4-execution` | Phase 4 | Streaming DAG execution, agent dispatch, stall detection |
| `/orchestrate/phase-5-cleanup` | Phase 5 | Post-batch cleanup sweep and agent audit |
| `/orchestrate/phase-6-report` | Phase 6 | Consolidated report and pipeline summary |
| `/orchestrate/safety` | Reference | Safety rules and examples |

---

## Extras / Project-Specific

These commands are in the **extras tier** — not installed by default. Install them with `npx forgedock --extras`.

The following extras target **web-property and analytics workflows** specifically. They are useful for teams running a public web property with analytics platforms (GSC, GA4, Umami, Cloudflare, Stripe, Clarity) wired up in `forge.yaml`. If your project is not a web property or does not have those integrations configured, these commands will have nothing to act on.

---

#### `/analytics`

**Production analytics audit.**

Pulls analytics from multiple sources (GSC, Bing Webmaster, Clarity, Umami, Cloudflare, Stripe, GA4) and generates actionable GitHub issues.

```bash
/analytics                        # Full analytics audit
```

Trigger phrases: "check analytics", "look at prod analytics", "what's happening on the site", "check revenue".

*Applies to: web properties with analytics configured in `forge.yaml`.*

---

#### `/qa-sweep`

**Full platform QA sweep.**

Auto-discovers pages and tests UI elements via browser automation (requires Playwright MCP). Creates GitHub issues for all findings.

```bash
/qa-sweep all                     # Full sweep
/qa-sweep dashboard               # Dashboard area only
/qa-sweep page /settings          # Specific route
/qa-sweep journey                 # Critical user journeys
/qa-sweep a11y                    # Accessibility only
```

*Applies to: web applications. Requires `claude mcp add playwright npx @playwright/mcp@latest`.*

---

#### `/geo-audit`

**GEO (Generative Engine Optimization) audit.**

Checks AI referral traffic and page compliance for AI search engines. Creates improvement issues.

```bash
/geo-audit                        # Full GEO audit
```

*Applies to: public web properties targeting AI search traffic.*

---

#### `/audit-agents`

**Agent output analyzer.**

Audits agent outputs from an orchestration run — timeline analysis, stall detection, idle time breakdown. Useful for diagnosing inefficiency in large `/orchestrate` runs.

```bash
/audit-agents latest              # Most recent run
/audit-agents {session-id}        # Specific session
/audit-agents {agent-id}          # Specific agent
```

*Applies to: teams running large parallel orchestrations who want per-agent performance breakdowns.*

---

---

### `npx forgedock report`

**Pipeline impact receipts for your repo.**

Reads `forge.yaml` for `project.owner/repo` and queries GitHub to produce a 30-day (default) summary of pipeline-driven activity: issues closed, share with FORGE annotations, median and p90 open→close time, merged PR count and issue-link rate, defects caught by review, and machine-filed intent share.

```bash
npx forgedock report               # Terminal summary (default 30 days)
npx forgedock report --days 7      # Last 7 days
npx forgedock report --md          # Paste-ready Markdown block (standups, reports)
npx forgedock report --json        # Raw JSON for scripting
npx forgedock report --md --quiet  # Markdown without the fleet pointer footer
```

Requires an authenticated `gh` CLI and a `forge.yaml` with `project.owner` and `project.repo` set. Degrades gracefully: unauthenticated `gh` and missing `forge.yaml` produce actionable error messages. A repo with no ForgeDock history shows a "run /work-on on your first issue" pointer instead of an empty table.

Counts sourced from `gh issue list` / `gh pr list` at the 500-item limit are labeled approximate (`~`), consistent with the honesty convention used in the README.

*This is the local, single-repo seed of the [fleet dashboard](https://forgedock.com/fleet) — the same numbers, one repo, free.*

---

## Next Steps

- [Command Learning Path](./command-learning-path.md) — which commands to learn first, tiered by when you need them
- [Getting Started with ForgeDock in 5 Minutes](./getting-started.md) — install and run your first pipeline
- [How ForgeDock's Knowledge Graph Works](./how-it-works.md) — understand how commands share context
- [ForgeDock vs. Manual Claude Code Workflows](./vs-manual-workflows.md) — why structured commands beat ad-hoc prompting
- [The FORGE Annotation Protocol](./forge-annotation-protocol.md) — the protocol used by all pipeline commands
