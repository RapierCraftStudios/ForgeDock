# YouTube Demo: "ForgeDock in 3 Minutes"

Production guide for the ForgeDock launch video. This document is the complete brief for a content creator: script, shot list, SEO metadata, social clip cut points, and README/docs embedding snippets.

---

## Video 1: "ForgeDock in 3 Minutes" (Launch Video)

**Format**: Screen recording (terminal) + voiceover
**Target length**: 2:45–3:10
**Tone**: Direct, technical, no fluff. Show — don't tell.
**Core message**: AI agents forget everything between sessions. ForgeDock fixes that by using GitHub as persistent memory.

---

## Script + Shot List

> Timing markers are guides. Each beat maps to a terminal action or screen moment.

---

### [0:00–0:20] Hook — The Problem

**Voiceover:**
> "Every time you start a new Claude Code session, the agent starts from scratch. It doesn't know why the code looks the way it does. It doesn't know what was tried and reverted. It doesn't know that a bug was fixed last week in the same function — and now it's about to repeat the same mistake."

**Screen:** Static. Text overlay or a clean terminal prompt. No action yet — let the problem land.

---

### [0:20–0:35] The Insight

**Voiceover:**
> "GitHub already has all of that memory. Every commit, every PR, every issue, every code review comment. ForgeDock turns GitHub into a structured knowledge graph that AI agents can actually query."

**Screen:** Show the ForgeDock GitHub repo briefly. Optionally: zoom into a FORGE: comment on a real issue to make the concept visual.

---

### [0:35–0:55] Setup — File the Issue

**Voiceover:**
> "Here's how it works. I'm going to file a real bug. A function that crashes on nil input — something in the wild would take 20 minutes to track down manually."

**Terminal actions:**
```
gh issue create -R your-org/your-repo \
  --title "fix: payment validator crashes on nil user profile" \
  --body "POST /api/payments returns 500 for free-tier users who have no billing profile."
```

**Voiceover:**
> "Issue filed. Now I hand it to ForgeDock."

---

### [0:55–1:20] The Pipeline Starts — `/work-on`

**Voiceover:**
> "One command: slash work-on, issue number."

**Terminal actions (Claude Code):**
```
/work-on #42
```

**Screen:** Show the pipeline starting. The terminal should show investigation starting.

**Voiceover:**
> "ForgeDock investigates first. It reads the code. Traces the commit that introduced the bug. Then — and this is the part that matters — it queries GitHub for every past bug in this module."

**Screen:** Show the FORGE:INVESTIGATOR comment appearing on the GitHub issue (either live or via `gh issue view`). Highlight the "Related Issues" section showing a past bug from 3 months ago.

**Voiceover:**
> "Notice this. It found issue 29 — a nil-check bug in the same file, fixed three months ago. A human would never have looked that up. The agent did it automatically."

---

### [1:20–1:50] The Build Phase

**Voiceover:**
> "Investigation confirmed the bug. ForgeDock moves to build. It writes a contract — what will change, and why. Then an architect plan — exact implementation order. Then it writes the code."

**Screen:** Show the FORGE:CONTRACT and FORGE:ARCHITECT comments on the issue (quick scroll), then show the terminal as the builder writes the fix.

**Voiceover:**
> "Two files. Nil-check in the validator, free-tier guard in the router. And it already knew not to skip the audit log write — because issue 34 caught that exact mistake last quarter."

---

### [1:50–2:20] Quality Gate + PR Opens

**Voiceover:**
> "Before any PR, the quality gate runs automatically — security, type safety, test coverage, breaking change detection. Fourteen checks."

**Screen:** Show quality gate output (brief scroll of checks passing).

**Voiceover:**
> "Gate passed. PR opens automatically."

**Terminal / Browser:** Show the PR being created. Show the PR on GitHub with its description, the linked issue, and the FORGE:BUILDER comment.

---

### [2:20–2:50] Review Agents + Merge

**Voiceover:**
> "Review runs nine specialized agents in parallel — concurrency, security, auth, database, test coverage, and more. Each one posts structured findings as separate issues. The PR gets merged."

**Screen:** Show the PR merge on GitHub. Show the issue auto-closing.

**Voiceover:**
> "The whole pipeline — investigate, architect, build, quality gate, review, merge — took under ten minutes. And every decision is written back to GitHub as structured annotations, ready for the next agent."

---

### [2:50–3:05] Install + Close

**Voiceover:**
> "Install takes thirty seconds."

**Terminal:**
```bash
npx forgedock
npx forgedock init
```

**Voiceover:**
> "That's it. ForgeDock — GitHub as a knowledge graph for AI agents. Link in the description."

**Screen:** ForgeDock GitHub repo page. Star count visible.

---

## Terminal Recording Guide

**What to prepare before recording:**

1. A clean terminal with a readable font (JetBrains Mono or Fira Code, 16–18pt, dark background).
2. A real GitHub repo with at least one open issue to work on.
3. ForgeDock installed (`npx forgedock && npx forgedock init`).
4. Claude Code open and ready.
5. A test issue pre-filed (you can use the exact `gh issue create` command from the script above).

**Terminal window sizing:** 1920×1080 at 2:1 zoom looks best on YouTube. Alternatively, record at 2560×1440 and let YouTube downscale.

**Recording tool recommendations:**
- macOS: [Kap](https://getkap.co/) for GIF, QuickTime for video
- Linux: OBS Studio or [asciinema](https://asciinema.org/) (can be converted to video)
- Windows: OBS Studio

**Key moments to cut to browser:**
- When FORGE:INVESTIGATOR comment appears on the issue (GitHub issue view)
- When the PR is created (GitHub PR page)
- After merge (GitHub showing the closed issue)

---

## YouTube SEO Metadata

### Title (primary)
```
ForgeDock in 3 Minutes — AI Agents That Never Forget
```

### Title (alternative A/B test)
```
I gave Claude Code a memory — here's what happened
```

### Description
```
ForgeDock turns GitHub into a structured knowledge graph for AI coding agents. Every pipeline stage writes machine-readable annotations to GitHub issues and PRs — so every downstream agent knows what was investigated, what was tried, what bugs were fixed before, and why the code looks the way it does.

In this video:
→ File a bug issue
→ Run /work-on — ForgeDock investigates, architects, builds, and opens a PR
→ Watch it surface context from a bug fixed 3 months ago — automatically
→ Quality gate + 9-agent review runs before merge

Install in 30 seconds:
  npx forgedock
  npx forgedock init

→ GitHub: https://github.com/RapierCraftStudios/ForgeDock
→ Docs: https://github.com/RapierCraftStudios/ForgeDock/tree/main/docs

Chapters:
0:00 The problem — AI agents that forget
0:20 GitHub as a knowledge graph
0:35 File the issue
0:55 /work-on — pipeline starts
1:20 Build phase
1:50 Quality gate + PR
2:20 Review agents + merge
2:50 Install

#ClaudeCode #AICoding #AIAgents #GitHub #DeveloperTools
```

### Tags
```
claude code, claude code tools, ai coding agent, ai developer tools, github automation, ai pair programmer, autonomous coding, forgedock, ai code review, github knowledge graph, claude anthropic, ai software development, coding automation, ai agents, developer productivity
```

### Thumbnail Specification
- **Size**: 1280×720px
- **Background**: Dark (#0D1117 — GitHub dark mode background)
- **Main text**: "ForgeDock" in white, large, bold (Inter or similar sans-serif)
- **Subtext**: "AI agents that never forget" in a muted accent color
- **Visual element**: Terminal window showing `/work-on #42` command with the agent response starting
- **Accent**: Orange (#FF6F00) or GitHub purple (#6E40C9) for highlights
- **No faces or stock photos** — engineering aesthetic, terminal-first

---

## Social Clip Cut Points

### Clip 1: Twitter/X + LinkedIn (60 seconds)
**Cut**: [0:35] to [1:35]
**Content**: File issue → `/work-on` starts → FORGE:INVESTIGATOR appears → context from past bug surfaces
**Caption for Twitter/X**: "This AI agent looked up a bug from 3 months ago automatically. That's ForgeDock — GitHub as memory for AI agents. /work-on takes it from issue to PR."
**Caption for LinkedIn**: "We built GitHub into a knowledge graph for AI coding agents. Every investigation writes structured annotations that every downstream agent can read. Here's what that looks like in practice."

### Clip 2: Twitter/X (30 seconds, teaser)
**Cut**: [0:00] to [0:35]
**Content**: Problem statement only — hook clip
**Caption**: "AI coding agents have no lookback. They can't see what was tried and reverted. They can't see that the same bug was fixed last quarter. ForgeDock fixes that."

### Clip 3: LinkedIn (90 seconds, technical)
**Cut**: [1:20] to [2:50]
**Content**: Build phase → quality gate → PR → review agents → merge
**Caption**: "From a confirmed bug to a merged PR — with investigation, architecture planning, quality gate (14 checks), and 9-agent review — in under 10 minutes. This is what ForgeDock's full pipeline looks like."

---

## Embedding Plan

### README.md (add after the "See It Working" section or at the top of Quick Start)

```markdown
## Demo

[![ForgeDock in 3 Minutes](https://img.youtube.com/vi/YOUR_VIDEO_ID/maxresdefault.jpg)](https://www.youtube.com/watch?v=YOUR_VIDEO_ID)

> *Watch ForgeDock autonomously investigate, build, and merge a real bug fix — surfacing historical context from 3 months ago along the way.*
```

Replace `YOUR_VIDEO_ID` with the YouTube video ID after upload (the part after `v=` in the URL).

### docs/ page (optional — add to WORKFLOW.md or a new docs/DEMO.md)

```markdown
## Live Demo

The fastest way to understand ForgeDock is to watch it run:

**[ForgeDock in 3 Minutes (YouTube)](https://www.youtube.com/watch?v=YOUR_VIDEO_ID)**

The video shows:
- Filing a bug issue via `gh issue create`
- Running `/work-on` to start the full pipeline
- Investigation surfacing context from past bugs automatically
- Build, quality gate, 9-agent review, and merge — end to end
```

---

## Video 2 Outline: "ForgeDock Deep Dive" (10 minutes)

*Optional follow-up for after the launch video performs.*

| Segment | Duration | Content |
|---------|----------|---------|
| Architecture overview | 2:00 | GitHub as knowledge graph, FORGE: annotation system, phase dispatcher |
| FORGE: annotations explained | 2:00 | Show FORGE:INVESTIGATOR, FORGE:CONTRACT, FORGE:ARCHITECT, FORGE:BUILDER on a real issue |
| `/review-pr` demo | 2:00 | 9-agent review running in parallel, findings as issues |
| `/orchestrate` demo | 1:30 | Multiple issues running in parallel |
| `/quality-gate` demo | 1:00 | 14-domain gate, what each check covers |
| Install + forge.yaml walkthrough | 1:30 | `npx forgedock init`, config options |

---

## Production Checklist

- [ ] Terminal recording tool chosen and tested
- [ ] Test issue filed in demo repo
- [ ] ForgeDock installed and configured on demo repo
- [ ] Recording done — raw footage captured
- [ ] Voiceover recorded (or subtitles written if silent demo)
- [ ] Video edited to 2:45–3:10
- [ ] Thumbnail designed to spec
- [ ] YouTube metadata filled in (title, description, tags, chapters)
- [ ] Video uploaded as unlisted for review
- [ ] Social clips cut (60-sec, 30-sec, 90-sec)
- [ ] README.md updated with embed snippet (replace `YOUR_VIDEO_ID`)
- [ ] Published and links shared on Twitter/X, LinkedIn, dev.to, HN
