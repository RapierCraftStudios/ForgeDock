# Reddit Post — r/SideProject

## Subreddit Profile

- **Community**: ~300k members, indie builders, solo developers, weekend hackers
- **Culture**: Personal, story-driven. People share what they shipped, what they learned, what failed. Celebrates the journey. Wants to know: what problem did you solve, how long did it take, what's the install path?
- **Best post styles**: Launch stories, "I built X in N weeks", personal journey + demo
- **Avoid**: Corporate tone, excessive technical depth without narrative, anything that doesn't have a clear "you can try it right now" CTA

---

## Post Title

```
Shipped: an autonomous dev pipeline where you open a GitHub issue and an AI agent investigates, builds, and opens the PR — open source
```

---

## Post Body

> **Target length**: ~800–1100 characters (r/SideProject readers want the story + CTA, not architecture)
> **Tone**: First-person, story-driven, authentic. Share what it does in concrete terms, not abstract claims.
> **URL**: https://github.com/RapierCraftStudios/ForgeDock

---

```
The workflow I wanted: open a GitHub issue, walk away, come back to a PR.

The problem: AI coding agents forget everything between sessions. Every task starts from zero — re-reading the codebase, re-investigating root causes, making the same mistakes that prior sessions already caught. Without persistent memory, "autonomous" means "needs constant hand-holding."

The solution I built: ForgeDock. It uses GitHub itself as the agent's memory layer. Every pipeline stage writes structured annotations to the issue — root cause, implementation plan, known pitfalls, historical bugs in the same module. The next session reads those annotations and picks up where the last one left off. No external server, no embeddings — just structured content in GitHub comments.

The actual workflow now:
/work-on #42 → AI investigates (reads git blame, traces root cause, checks related issues) → plans implementation → builds → runs quality checks → 9-agent PR review → opens PR

Start to PR: ~15 minutes for a focused bug fix.

Built it because I was tired of babysitting Claude through the same investigations over and over. Turned out to be generally useful.

install: npx forgedock
repo: https://github.com/RapierCraftStudios/ForgeDock

[demo GIF — see repo]
```

---

## Launch Timing

- **Post Day 1 after HN** — r/SideProject is perfect for the launch day personal story wave
- **Best windows**: Any weekday, 10am–4pm ET (r/SideProject is active throughout the day)
- **Good pairing**: Post r/ClaudeAI on the same day (different audience, non-overlapping)

---

## Engagement Strategy

- r/SideProject community is warm and encouraging — engage genuinely
- Share the backstory when asked: what problem prompted this, how long it took, what you'd do differently
- Have a clear answer for "what's the hardest part?" — the answer is the quality of the command specs; the agent is only as good as the investigation prompt
- If people ask about monetization/pricing: AGPL, free, open-source. Sponsors welcome.
- Don't oversell the autonomy — be honest that it works well for scoped tasks and less well for massive architectural changes

---

## Pre-Drafted Comment Responses

### "What kinds of tasks does it handle well?"

> Best for: bug fixes with clear reproduction steps, feature additions to existing modules, refactors with a defined scope, maintenance tasks (dependency updates, config changes). Less reliable for: greenfield architecture decisions, tasks requiring external API knowledge it doesn't have, anything where the spec is genuinely ambiguous. It's strongest when GitHub has history in the affected area — the more closed issues and PRs, the richer the context it can pull.

### "How long did it take to build?"

> The core pipeline (investigate → build → review) took about 3 months of evenings. The quality gate and review agent system took another 2 months of iterating on actual production runs. The false positive rate in review was ~44% in the early builds; it's now under 10% from accumulated findings. Most of the time went into the command specs — the prompt engineering, not the orchestration.

### "Does it replace developers or just help them?"

> Helps, not replaces — at least today. It handles the mechanical parts: investigation, implementation of scoped changes, review findings. A developer still decides what to build, reviews the PR, and merges. The goal is to make the gap between "I have an idea" and "I have a reviewed PR" as short as possible, not to remove humans from the loop entirely. The autopilot mode exists but humans gate every merge.

### "What if the AI makes a bad change?"

> Every change goes through a 9-agent PR review before it's mergeable. Review findings become new GitHub issues. Nothing auto-merges to production without a human looking at the PR. The annotation trail also makes it easy to see exactly why the agent did what it did — every decision is documented in the issue comments (FORGE:INVESTIGATOR, FORGE:ARCHITECT, etc.). If something's wrong, you can trace it back to the exact annotation that led the agent astray.
