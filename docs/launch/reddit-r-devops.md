# Reddit Post — r/devops

## Subreddit Profile

- **Community**: ~1.5M members, DevOps engineers, SREs, platform engineers
- **Culture**: Pragmatic and skeptical. Values reliability, observability, and automation that actually works in production. Allergic to "revolutionary" claims. Wants to know: does it work at scale, what breaks it, what's the blast radius?
- **Best post styles**: Automation walkthroughs, pipeline architecture, real-world reliability stories, honest post-mortems
- **Avoid**: Startup marketing language, vague AI capability claims, anything that glosses over failure modes

---

## Post Title

```
AI agents that read your GitHub issues and autonomously open PRs — the pipeline architecture behind it
```

---

## Post Body

> **Target length**: ~1000–1400 characters (r/devops wants the mechanism and the reliability story)
> **Tone**: Engineering-first, pragmatic. Lead with the pipeline architecture. Acknowledge failure modes.
> **URL**: https://github.com/RapierCraftStudios/ForgeDock

---

```
Here's the pipeline we built: GitHub issue → AI agent investigates → builds fix → runs quality checks → 9-agent PR review → opens PR. Human reviews and merges.

The reliability problem was agent amnesia. Every new session the agent re-investigated root causes it had already traced, re-made decisions it had already documented, missed context that prior sessions had surfaced. Without persistent memory, "autonomous" meant "needs constant supervision to not repeat mistakes."

The architecture: every pipeline stage writes machine-readable HTML annotations to the GitHub issue. FORGE:INVESTIGATOR records root cause with file:line references. FORGE:CONTEXT surfaces known failure patterns for the affected module, mined from closed issues in the same domain. FORGE:ARCHITECT produces a typed implementation plan with all call sites traced before any code is written. The next agent session reads these annotations via `gh` CLI before doing anything.

GitHub is the state store. `gh` is the query interface. No external memory service, no vector DB, no embedding pipeline. The annotations are structured content in GitHub comments — append-only, auditable, queryable.

Quality gate runs 14+ check domains before the PR opens: security, auth, SQL safety, migration safety, env var consistency, frontend proxy paths, database config. Review phase uses 9 domain-specific agents (concurrency, billing integrity, auth, database migrations, infrastructure). Review findings become new GitHub issues — they don't block the merge.

After 20,000+ issues on production codebases, the main reliability improvement: false positive rate in review agents dropped from 44% to <10% as closed-issue history accumulated. The pipeline learns.

install: npx forgedock (25 markdown command specs, no runtime server)
```

---

## Launch Timing

- **Post 3–4 days after HN** — r/devops audience appreciates substance over recency; let the HN discussion build
- **Best windows**: Tuesday–Thursday, 9am–1pm ET
- **Good pairing**: r/programming on the same day (complementary audiences)

---

## Engagement Strategy

- r/devops culture rewards honest failure-mode discussion — don't oversell reliability
- Lead with the quality gate and review agent architecture — these are the parts DevOps engineers care about most
- Be specific about what the pipeline does and doesn't handle (it doesn't deploy, it doesn't manage infrastructure — it's the PR creation pipeline, not the CD pipeline)
- If asked about integration with existing CI/CD: the pipeline produces a PR, the existing CI/CD handles the rest. It's complementary, not replacement.
- Have concrete answers about blast radius and rollback

---

## Pre-Drafted Comment Responses

### "How does this interact with existing CI/CD pipelines?"

> ForgeDock produces a PR — your existing CI/CD pipeline takes it from there. The quality gate and review agents run before the PR is opened; once the PR exists, it goes through whatever CI checks you have (tests, linting, build verification). ForgeDock is the "issue to reviewed PR" pipeline; CD from PR to production is your existing workflow. They're complementary. The only touchpoint is the PR creation — same interface as a human developer opening a PR.

### "What happens when the AI makes a bad deployment change?"

> The quality gate explicitly checks for high-risk infrastructure changes: Dockerfile modifications, env var additions, service restarts, volume permission changes. Each flagged change gets annotated in the commit with `[restart: service]` markers and a hard-blocker item in the testing checklist. The 9-agent review includes an infrastructure agent specifically for deployment-related changes. Nothing auto-merges; a human reviews every PR. If something still gets through, the review finding becomes a new issue that gets fixed in the next cycle.

### "What's the blast radius if the agent writes broken code?"

> The PR is the blast radius boundary. The agent can't deploy, can't push to main directly, can't merge its own PRs. The worst case is a PR that fails CI checks — which your existing CI will catch. The review agents catch most logic errors before CI even runs. If a bad PR gets merged by a human who approved it, that's the same blast radius as any PR merge. The audit trail (FORGE annotations on the issue) makes root cause analysis fast: you can see exactly why the agent made the change it made.

### "Does this work with monorepos or multi-service architectures?"

> The pipeline operates at the issue level — it reads the affected files listed in the issue and the investigation report, traces callers within those files, and scopes the change accordingly. For multi-service architectures, the `forge.yaml` config supports a multi-repo setup with satellite repos and per-repo staging branches. Each service/repo gets its own pipeline configuration. The quality gate does cross-service checks for env var consistency and proxy path alignment, but the build scope stays scoped to the issue.
