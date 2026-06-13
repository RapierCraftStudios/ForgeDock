# Reddit Post — r/ClaudeAI

## Subreddit Profile

- **Community**: ~200k members, Claude power users, prompt engineers, tool builders
- **Culture**: Hands-on and practical. People share what they've built, configurations that work, tricks they've found. Receptive to Claude Code content — many are active Claude Code users.
- **Best post styles**: Show & Tell, tool releases, workflows that improved their setup
- **Avoid**: Pure self-promotion without substance, vague capability claims, anything that sounds like an ad

---

## Post Title

```
I built a slash command system that gives Claude Code permanent memory across sessions — open source
```

---

## Post Body

> **Target length**: ~800–1200 characters (Reddit has a higher threshold but shorter is better)
> **Tone**: Personal, practical, showing specific mechanisms. Show & Tell format.
> **URL**: https://github.com/RapierCraftStudios/ForgeDock

---

```
Claude Code is great. But it forgets everything between sessions. Every new conversation starts blind — even if you've investigated the same codebase a hundred times.

I got tired of re-explaining context, so I built ForgeDock: 25 slash commands that use GitHub as Claude's persistent memory layer.

The way it works: every pipeline stage writes machine-readable HTML annotations to your GitHub issues and PRs. FORGE:INVESTIGATOR traces the root cause and affected files. FORGE:CONTEXT surfaces known pitfalls from closed issues in the same module. FORGE:ARCHITECT produces a typed implementation plan. When Claude Code picks up the task — even days later, even after compaction — it reads these annotations via `gh` CLI and knows everything the previous session learned.

Typical session:
/work-on #42 → Claude investigates (reads git blame + closed issues) → writes context to GitHub → plans implementation → builds → quality gate → 9-agent PR review → opens PR

No conversation history required. GitHub is the knowledge graph.

install: npx forgedock

I've processed 20,000+ issues across production codebases this way. Happy to answer questions about how the memory protocol works.

[demo GIF — see repo]
```

---

## Launch Timing

- **Post 1–2 days after the HN Show HN post** to ride HN momentum (HN discussion often spills into Reddit)
- **Best windows**: Tuesday–Thursday, 10am–2pm PT (r/ClaudeAI peaks mid-morning Pacific)
- **Pair with**: r/SideProject on the same day or next day (different audience, no overlap)

---

## Engagement Strategy

- Respond to every comment in the first 2 hours
- Expect: "How is this different from CLAUDE.md?" and "Does it work with [other AI tool]?"
- Share specific examples when asked — walk through the payment nil-check flow from the README
- If asked for demo: link to demo GIF from #542 and offer to do a live walkthrough in comments
- Be specific about limitations: works with Claude Code today, provider-agnostic runtime on roadmap

---

## Pre-Drafted Comment Responses

### "How is this different from CLAUDE.md?"

> CLAUDE.md is static — describes your repo once, globally. FORGE annotations are dynamic and issue-specific. The FORGE:INVESTIGATOR comment on issue #42 contains the exact commit that introduced a specific bug, the affected file list, root cause, and related issues. A future session working on #47 reads that and skips the entire investigation. CLAUDE.md can't accumulate per-issue knowledge that compounds across hundreds of tasks.

### "Does this work with Cursor / Windsurf / other tools?"

> The annotation protocol is model-agnostic — it's just structured content in GitHub comments that any tool reading `gh` output can consume. Claude Code is the supported runtime today (the `/work-on` slash commands are Claude Code primitives). Porting to other runtimes is architecturally straightforward; Claude Code just has the richest slash command support right now.

### "Is this just a bunch of prompts?"

> Yes — 25 markdown files with carefully engineered prompt specs, installed via `npx forgedock`. There's no runtime server, no embeddings, no vector DB. The 'intelligence' is the structured protocol for passing context between stages, not a model. The model is Claude. ForgeDock is the memory and workflow layer.

### "What happens if Claude makes a mistake?"

> Review findings don't block merges — they become new GitHub issues that enter the same pipeline. The 9-agent review step catches most mistakes before they reach the PR stage. Over time, those review findings accumulate as closed issues; the FORGE:CONTEXT phase mines them before the next related build so the same mistake is flagged proactively. The loop is: mistake → finding → issue → fix → future prevention.
