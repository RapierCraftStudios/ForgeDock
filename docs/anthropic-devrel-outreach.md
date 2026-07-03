# Anthropic DevRel Outreach — ForgeDock

Campaign playbook for getting ForgeDock featured in the Claude Code ecosystem. Execute each channel in order; update the tracking table after each action.

---

## Assets Ready

These assets are live and can be referenced in any outreach:

| Asset | Link | Status |
|-------|------|--------|
| GitHub repository | https://github.com/RapierCraftStudios/ForgeDock | ✅ Live |
| npm package | https://www.npmjs.com/package/forgedock | ✅ Live |
| Plugin marketplace listing | https://github.com/dev-gom/claude-code-marketplace | ✅ Submitted (#541) |
| Demo GIF | `docs/demo.tape` (generated asset) | ✅ Ready (#542) |
| FORGE Annotation Protocol spec | `docs/FORGE-PROTOCOL.md` | ✅ Published (#553) |
| dev.to article | `docs/articles/devto-how-i-built-an-ai-agent-that-never-forgets.md` | ✅ Draft ready (#549) |
| Awesome list submissions | `docs/distribution-submissions.md` | ✅ Documented (#552) |

---

## Canonical Pitch (3 sentences)

> ForgeDock is an autonomous development pipeline for Claude Code that uses GitHub as a persistent knowledge graph. Every pipeline stage (investigate → architect → build → review → merge) writes structured FORGE annotations to GitHub issues and PRs — so agents always know what happened before them, why the code looks the way it does, and what to do next. Install in seconds: `npx forgedock`, then run `/work-on #42`.

---

## Channel 1: Direct Email to Anthropic DevRel

**Target**: Alex Albert (leads Claude Code), Anthropic DevRel team
**Contact path**: Twitter/X DM (`@alexalbert__`), or via Anthropic's developer contact form at https://www.anthropic.com/contact
**Goal**: Get featured in Claude Code official docs community section, or secure a case study / guest blog post opportunity

### Email / DM Template

**Subject**: ForgeDock — Claude Code pipeline that demos what the command system can fully do

---

Hi Alex,

I built ForgeDock — an autonomous development pipeline for Claude Code that uses GitHub as a persistent knowledge graph for AI agents.

**What it does**: Install with `npx forgedock`, then type `/work-on #42`. Claude Code investigates the issue, writes an architecture plan, implements the fix, runs a quality gate, opens a PR, reviews it with specialized agents, and merges — all autonomously. Every stage writes structured FORGE annotations back to GitHub so the next agent picks up exactly where the previous one left off. No context loss between sessions.

**Why it might interest you**:
- It's a showcase of what Claude Code's command system can do at full depth — 25+ commands, multi-agent coordination, GitHub-as-knowledge-graph
- It's already being used on production codebases (dogfood: ForgeDock's own issues are built by ForgeDock)
- I published a formal FORGE Annotation Protocol spec (open standard for AI agent communication via GitHub)

**What I'm asking for**:
- If there's a community tools / ecosystem section in the Claude Code docs, I'd love ForgeDock listed there
- Happy to write a guest blog post, be a case study, or demo it for the team — whatever's useful

GitHub: https://github.com/RapierCraftStudios/ForgeDock
npm: https://www.npmjs.com/package/forgedock

Thanks for building Claude Code — it's genuinely the best AI dev tool I've used.

[Your name]

---

**Send via**: Twitter/X DM to `@alexalbert__` is the most direct path. Anthropic's contact form is the backup.

---

## Channel 2: Anthropic Discord

**Target**: Anthropic's official Discord server — Claude Code channels
**Goal**: Build genuine community presence; get noticed by Anthropic staff who monitor their own Discord
**Discord**: https://discord.gg/anthropic (official) — look for `#claude-code`, `#show-your-work`, or `#developer-tools` channels

### Discord Message Script

**For `#show-your-work` or `#claude-code` channel**:

---

Hey everyone — I built something I think you'll find useful if you're using Claude Code heavily.

**ForgeDock** — autonomous dev pipeline for Claude Code that uses GitHub as a persistent knowledge graph.

The core idea: AI agents forget everything between sessions. ForgeDock fixes that by having every pipeline stage write structured FORGE annotations to GitHub issues and PRs. The next agent (even in a new session) reads those annotations and picks up exactly where the last one left off.

**In practice**: type `/work-on #42`, Claude Code:
1. Investigates the issue (reads git blame, past bugs, related PRs)
2. Writes an architecture plan
3. Implements the fix
4. Runs a quality gate
5. Opens a PR and reviews it with specialized agents
6. Merges

Install: `npx forgedock`
GitHub: https://github.com/RapierCraftStudios/ForgeDock

Happy to answer questions or demo it. Built 100% with Claude Code — ForgeDock builds itself. 🔁

---

**Engagement tips**:
- Reply genuinely to questions in the thread
- If others share Claude Code workflows, engage with value before sharing ForgeDock
- Do NOT post the same message in multiple channels the same day — pick one channel, post once, engage for 48h before other channels

---

## Channel 3: Claude Code Docs Listing

**Target**: https://docs.anthropic.com/en/docs/claude-code — community resources / ecosystem section
**Goal**: Get ForgeDock listed as a community tool in the official Claude Code documentation

### Submission Approach

Anthropic's docs are maintained at https://github.com/anthropics/anthropic-sdk-python (API docs) but Claude Code docs may be at a separate repo. Check:
1. https://github.com/anthropics/claude-code (if public)
2. https://github.com/anthropics/anthropic-quickstarts
3. Contact via DevRel (Channel 1) and ask where to submit community tool PRs

### Formatted Listing Entry

Use this in a PR or suggestion:

```markdown
### ForgeDock
[ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) — Autonomous development pipeline for Claude Code. Uses GitHub as a persistent knowledge graph: agents investigate, architect, build, quality-gate, review, and merge with full context persistence across sessions. Install: `npx forgedock`.
```

**Category to target**: Community Tools / Extensions / Third-party integrations

---

## Channel 4: Twitter/X Mention

**Target**: `@AnthropicAI` and `@alexalbert__`
**Goal**: Public mention that prompts engagement or retweet from official accounts

### Tweet Template

```
I built an autonomous dev pipeline for @ClaudeAI Code that uses GitHub as a persistent knowledge graph for AI agents.

Every agent in the pipeline reads what came before it — investigation findings, architecture decisions, past bugs — so nothing gets lost between sessions.

25+ commands. Full investigate → build → review → merge cycle.

npx forgedock

github.com/RapierCraftStudios/ForgeDock

@alexalbert__ would love your thoughts on using it as a Claude Code case study 🙏
```

**Post timing**: Post after Anthropic Discord engagement (Channel 2) — social proof from Discord replies strengthens the tweet.

---

## Tracking Table

| Channel | Action | Status | Date | Follow-up Due | Notes |
|---------|--------|--------|------|---------------|-------|
| Direct email / DM | Send to @alexalbert__ | ⬜ Not sent | — | — | |
| Anthropic Discord | Post in Claude Code channel | ⬜ Not posted | — | — | |
| Claude Code docs | Submit PR or suggestion | ⬜ Not submitted | — | — | Find correct repo first |
| Twitter/X | Tweet mentioning @alexalbert__ | ⬜ Not posted | — | — | Post after Discord |

---

## Follow-up Cadence

After each initial outreach action:

| Timing | Action |
|--------|--------|
| Day 0 | Send initial outreach (email DM / Discord post) |
| Day 7 | If no response to DM: send one follow-up. If Discord post got engagement: reply to any threads. |
| Day 14 | If still no response: move to async — submit Claude Code docs PR directly without waiting for DevRel response |
| Day 30 | Reassess. If featured: document in this file. If not: try Anthropic contact form with a different angle (FORGE Protocol as open standard). |

---

## Success Criteria

- [ ] Outreach email/DM sent to Anthropic DevRel — update tracking table
- [ ] ForgeDock shared in Anthropic Discord — update tracking table
- [ ] PR/suggestion submitted for Claude Code docs listing — update tracking table
- [ ] Follow-up within 1 week if no response — update tracking table

---

## Related Assets

- `docs/distribution-submissions.md` — canonical description + awesome list submissions
- `docs/FORGE-PROTOCOL.md` — FORGE Annotation Protocol spec (shareable with Anthropic as ecosystem contribution)
- `docs/articles/devto-how-i-built-an-ai-agent-that-never-forgets.md` — long-form story for blog pitch
- `docs/youtube-demo-script.md` — demo video script (reference for pitch)
