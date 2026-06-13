# Reddit Post — r/programming

## Subreddit Profile

- **Community**: ~6M members, general software developers
- **Culture**: High bar for substance. Values problem/solution framing, architectural insights, honest tradeoffs. Dislikes obvious marketing and "here's my product" posts. Loves posts that teach something or present a genuinely novel approach.
- **Best post styles**: Architecture discussions, "here's a problem I solved and how", technical essays with a clear thesis
- **Avoid**: Pure announcements, product marketing, vague claims without mechanisms

---

## Post Title

```
How we solved the AI agent amnesia problem: using GitHub as a structured knowledge graph
```

---

## Post Body

> **Target length**: ~1000–1400 characters (r/programming readers skim — lead with the insight)
> **Tone**: Third-person / conceptual. Frame as architectural insight, not product launch.
> **URL**: https://github.com/RapierCraftStudios/ForgeDock

---

```
AI coding agents forget everything between sessions. Doesn't matter how capable the model is — when the conversation ends, every investigation, every root cause trace, every historical pattern the agent discovered is gone. The next agent starts blind.

Context window size doesn't fix this. The problem is that learned context doesn't persist to where future agents can find it.

The approach we settled on: treat GitHub as a knowledge graph, not a ticket tracker. GitHub already stores everything an agent needs — issues reference PRs, PRs reference commits, commits track file history, git blame traces the "why" behind every line. It's a causal graph. We just needed to make it machine-readable.

ForgeDock is a protocol for writing structured annotations directly to GitHub issues and PRs — machine-readable HTML comments that survive conversation resets. Every stage of the development pipeline reads the annotations from prior stages and writes its own findings back.

The result: a new session reading GitHub for issue #42 knows the root cause traced to commit e8f21a3, knows the three files that need to change, knows that a similar nil-check bug was already fixed in issue #34, and knows the historical pitfall to avoid in the audit log path. Not because it explored the codebase — because a prior agent left structured breadcrumbs.

After 20,000+ issues processed across production codebases: false positive rate in automated review dropped from 44% to <10% as the knowledge graph accumulated. The memory compounds.

https://github.com/RapierCraftStudios/ForgeDock — 25 markdown command specs, install via npx forgedock

[demo GIF — see repo]
```

---

## Launch Timing

- **Post 2–3 days after HN** — r/programming audience regularly cross-posts from HN; being second is fine
- **Best windows**: Tuesday–Thursday, 8am–11am ET (highest engagement window for r/programming)
- **Avoid**: Weekends (lower engagement), Monday mornings (buried in new posts)

---

## Engagement Strategy

- Frame responses around the architectural problem, not the tool
- r/programming readers often engage with "what's the alternative?" — acknowledge vector stores, CLAUDE.md, and agent frameworks, explain the specific tradeoff each makes
- If the post gains traction, expand in comments with concrete examples (the payment nil-check example from the README is good)
- Welcome critical responses — r/programming culture rewards "that's a fair criticism, here's the tradeoff"

---

## Pre-Drafted Comment Responses

### "Why not just keep a local notes file or wiki?"

> The agent needs to find the relevant context automatically, not search a wiki. When Claude starts on issue #42 (payment validation bug), it needs to know — without human guidance — that the same nil-check pattern broke issue #34 six months ago. That relationship lives in git history, linked issues, and PR cross-references. A static notes file doesn't have queryable causal structure. GitHub does.

### "This is just structured logging / a write-ahead log"

> That's a fair description of the mechanism. The annotations are append-only structured records on GitHub that any agent can read in a fresh session. The key property is that they're stored in the same system where the code lives — issue #42's annotation is linked to commit e8f21a3, which is linked to the PR that introduced the bug, which is linked to the issue that PR closed. The causal chain is traversable. A write-ahead log detached from the codebase doesn't have those edges.

### "How do you handle hallucinations in the annotations?"

> Downstream agents read annotations as input, not ground truth. FORGE:INVESTIGATOR says "root cause: nil-check missing at payments/validator.py:84" — the architect agent actually reads that file before writing code. The annotation guides where to look, not what to build. Hallucinated annotations produce wrong investigations that get flagged in review. Over time those failures are tracked as closed issues and FORGE:CONTEXT surfaces them as pitfalls before the same path is touched again.

### "Wouldn't this fail on large codebases where history is noisy?"

> We scope the history mining intentionally — the context phase reads last 30 commits on the affected files, not the full repo history. The signal-to-noise improves as the FORGE annotations accumulate: after N issues processed in a module, the annotation history for that module is richer than git history alone. For brand-new codebases, the first few issues run without historical context; it builds from there.
