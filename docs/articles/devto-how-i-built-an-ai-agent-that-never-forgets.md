---
title: "How I Built an AI Agent That Never Forgets"
description: "AI coding agents forget everything between sessions. Here's how I used GitHub as a knowledge graph to give them persistent, structured memory — and the surprising insight that made it work."
tags: ["ai", "github", "productivity", "opensource"]
cover_image: # Add social preview image URL (see issue #543)
canonical_url: https://github.com/RapierCraftStudios/ForgeDock
published: false
---

<!-- DEMO GIF PLACEHOLDER: Insert demo GIF here once issue #542 is complete -->
<!-- Suggested: zero-to-PR speedrun showing /work-on running the full pipeline -->

I've been running AI coding agents on production codebases for about a year. The workflow is genuinely useful — but there's a problem that kept surfacing no matter which model or tool I used.

Every session starts from scratch.

---

## The Problem

My agent doesn't know what it fixed yesterday. It doesn't know that the function it's about to touch was shaped by a nasty race condition discovered in PR #891 six months ago. It doesn't know that three other files use the same pattern and will need the same fix. It doesn't know that the last time someone tried this approach, it caused a production incident for a specific class of users.

Context window isn't the bottleneck. **Memory is.**

When a conversation ends or a context compaction happens, everything the agent learned — every hypothesis it tested, every file it read, every connection it made — is gone. The next agent starts from a blank slate. The investigation gets repeated. The same mistakes get made. There's no institutional knowledge.

This isn't an AI limitation. It's a systems design problem. And once I framed it that way, the solution became obvious.

---

## The Failed Approaches

I tried the obvious fixes first.

**Long CLAUDE.md files** — I kept adding to my project instructions until they were 3,000 words of context. It helped with conventions but didn't solve the knowledge gap. CLAUDE.md is static. It doesn't know which specific files have been touched, what bugs were found in module X last week, or what architectural decision was made in PR #342 and why. It's a README for the agent, not a memory system.

**Massive context windows** — Just feeding the agent more files to read. This works for small, well-scoped tasks. It breaks down at scale: too much noise, too many tokens, and still no ability to recall *prior decisions* made by *prior agents*. A 200k token context window doesn't help you remember what you decided three sessions ago if that decision isn't written down somewhere the next agent will read.

**RAG over the codebase** — Vector databases of code snippets. Better than nothing, but it retrieves *what the code looks like*, not *why it looks that way*. The investigative context — the root cause analysis, the rejected approaches, the cross-file impact assessment — isn't in the code. It's in the conversation that led to the code. And that conversation disappeared when the session ended.

---

## The Insight

Here's the thing I kept overlooking: GitHub already stores everything an agent needs to know.

Issues document what went wrong and why. Pull requests record what changed and link back to the issue that prompted it. Commit messages reference both. `git blame` traces any line of code back to the PR that introduced it, and from there to the issue that motivated it. Cross-references are built in.

GitHub is already a knowledge graph. It's just not structured for AI agents to query efficiently.

The insight that changed everything: **make the knowledge machine-readable at write time.** Instead of having agents try to parse human-written issue comments after the fact, have every pipeline stage write structured, machine-readable annotations *as it works*. Then the next agent — in the next session, on a completely different task — can query those annotations and get exactly the structured context it needs.

Not "read all the comments and figure it out." Read `<!-- FORGE:INVESTIGATOR -->` and get a structured JSON-like summary: affected files, root cause, confidence level, recommendation. Read `<!-- FORGE:CONTEXT -->` and get the pitfalls found in prior review findings for those same files.

---

## The Implementation

I built a system called ForgeDock. At its core, it's a pipeline of Claude Code slash commands that coordinate through GitHub using structured HTML comment annotations.

Here's what it looks like in practice:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     GITHUB (Knowledge Graph)                        │
│                                                                     │
│  Issues:  FORGE:INVESTIGATOR → FORGE:CONTRACT → FORGE:ARCHITECT     │
│  PRs:     FORGE:BUILDER → FORGE:REVIEW → FORGE:TRAJECTORY           │
│  Links:   git blame → commit → PR → issue → related issues          │
│                                                                     │
│  Every agent reads this. Every agent writes to it.                  │
│  Nothing is lost between conversations.                             │
└─────────────────────────────────────────────────────────────────────┘
```

When you run `/work-on #42`, the pipeline stages execute in sequence. Each stage writes a structured annotation to the GitHub issue before the next stage starts.

**FORGE:INVESTIGATOR** — The investigation agent reads the codebase, verifies the claim in the issue, traces the root cause to specific files and commits, and writes a structured report:

```
<!-- FORGE:INVESTIGATOR -->
**Verdict**: CONFIRMED
**Confidence**: HIGH
**Root Cause**: payment_validator.py:143 assumes all users have a billing profile.
                Free-tier users don't. Introduced in commit e8f21a3 (PR #38).
**Affected Files**: payment_validator.py, api/routes/payments.py
**Recommendation**: Add nil-check before billing profile access.
```

**FORGE:CONTEXT** — Before the builder writes a single line of code, a context agent queries GitHub for institutional memory: past review findings on those specific files, prior bugs in the same module, related PRs that touched the same functions. It surfaces this as a structured advisory:

```
<!-- FORGE:CONTEXT -->
**Known Pitfall**: Don't skip the audit log write on early returns in this module.
                   Prior bug #34 did exactly this and caused a compliance gap.
**Historical Finding**: Free-tier guard was also missing in invoices.py (#43) —
                        check for the same pattern there.
```

The builder agent reads this context before writing code. It doesn't re-discover known pitfalls. It doesn't repeat mistakes that were fixed six months ago.

**FORGE:ARCHITECT** — An architecture agent traces all affected code paths, builds an ordered implementation plan, and identifies consistency invariants. The builder follows this plan exactly, in order.

**FORGE:BUILDER** — The implementation agent works in a git worktree, reads the full context chain, implements the fix, runs quality gates, and commits.

**FORGE:TRAJECTORY** — After the PR merges, a trajectory entry is written to the issue recording the full pipeline result: investigation verdict, quality gate result, review findings, merge details. Future context agents read this when working on related issues.

The key principle: **every agent writes what it learned, so the next agent doesn't have to rediscover it.**

---

## Results

Here's a concrete before/after.

**Before ForgeDock:** An agent gets issue #47 — "Billing fails for users who signed up before the subscription migration." The agent reads the codebase, explores billing-related files, eventually finds the inconsistency in the subscription lookup logic. Takes 15-20 minutes of investigation. Misses the fact that the same pattern exists in the invoices endpoint too. Fix is incomplete. Review catches it. Another iteration.

**After ForgeDock:** The context agent queries GitHub for past bugs in the billing module. It finds FORGE:TRAJECTORY from issue #38 (payment nil-check fix) and #43 (invoices nil-check fix). The investigation comment from #43 explicitly noted: "same nil-check pattern also exists in subscriptions.py — not fixed in this PR, tracked as follow-up." That follow-up is issue #47.

The agent already knows: the root cause is a nil-check pattern that was incompletely applied across three files. It knows which files. It knows which commit introduced the pattern. It knows what the fix looks like — it was already implemented correctly in two other files. Investigation takes 3 minutes. Implementation is straightforward. Review passes first time.

Another example: I was working on a feature to add rate limiting to the API. The context agent surfaced a review finding from PR #91 — "Rate limiting middleware must be applied before the auth middleware, not after — see the ordering note in middleware.md." That finding was written by a review agent eight months ago on a completely different PR. It saved me from introducing an ordering bug that would have bypassed auth for rate-limited requests.

The system gets smarter over time because the knowledge compounds. Every fix, every review finding, every architectural decision becomes queryable structured data for future agents.

There's a subtler benefit too: **the pipeline makes agents deterministic.** Without structured context, agents make different decisions on the same problem depending on which files they happen to read first and what associations their current session happens to surface. With ForgeDock, every agent working on related issues reads the same FORGE annotations. They make consistent decisions because they're working from the same structured data, not from vibes.

The review layer adds another dimension. ForgeDock's `/review-pr` command runs nine specialized review agents against every PR — each focused on a specific domain: concurrency, auth, SQL safety, frontend proxy wiring, deployment completeness, and so on. Each agent's findings become new GitHub issues, which flow through the same pipeline. Over time, the review agents get better at catching the specific bug classes that have appeared in your codebase before, because those patterns are recorded as structured findings in GitHub. The same nil-check pattern that caused a bug in the billing module will be caught by the context agent when someone touches the invoices module two months later.

It's not magic. It's just structured data, written consistently, read reliably.

---

## Try It

ForgeDock is open source and installs in two commands:

```bash
# Step 1: Install pipeline commands
npx forgedock

# Step 2: Generate config for your repo
npx forgedock init
```

`npx forgedock init` auto-detects your repo, owner, and branches, and creates a `forge.yaml` config file. Then inside Claude Code:

```
/work-on #42
```

That's it. The pipeline runs: investigate → build → quality gate → PR creation → review → merge.

The full source is at [github.com/RapierCraftStudios/ForgeDock](https://github.com/RapierCraftStudios/ForgeDock). AGPL-3.0 — free to use, modify, and self-host. If you build on it or extend it, open your modifications.

---

*Tags: #ai #github #productivity #opensource*

---

**Cross-post notes:**
- Hashnode: Same content, update canonical_url to point to dev.to post after publishing
- Medium: Publish after dev.to if reach warrants (dev.to SEO compounds faster)
- Optimal publish time: Tuesday-Thursday 9-10am ET for dev.to algorithm
