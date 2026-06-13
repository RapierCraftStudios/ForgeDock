# ForgeDock — Twitter/X Launch Thread + Content Strategy

Coordinate with: **#547** (HN Show HN post) — post within 24h of HN launch going live.

---

## Launch Thread (8-10 tweets)

Post as a numbered thread. Reply to tweet 1 with each subsequent tweet.

---

**Tweet 1 — Hook** (168 chars)

> Your AI coding agent has amnesia.
>
> Every session starts from scratch. No memory of what came before. No idea why the code looks the way it does.
>
> We fixed that. 🧵

---

**Tweet 2 — The Problem** (267 chars)

> The problem isn't context window size.
>
> It's that when an agent compacts, everything it learned is gone.
>
> The next agent re-investigates the same bug. Makes the same mistakes. Has no idea a similar fix was already tried and reverted in PR #891.

---

**Tweet 3 — The Insight** (218 chars)

> GitHub already stores everything an agent needs to know.
>
> Commits, PRs, issues, blame, cross-references.
>
> It's a knowledge graph. We just made it machine-readable.

---

**Tweet 4 — Demo GIF** (176 chars + GIF)

> Here's what that looks like in practice.
>
> `/work-on #42` → full autonomous pipeline → PR opened.
>
> No prompting. No hand-holding. Issue in, PR out.
>
> [Attach demo GIF from #542]

---

**Tweet 5 — How FORGE Annotations Work** (≤280 chars)

> Every stage writes structured annotations to GitHub:
>
> FORGE:INVESTIGATOR → root cause + affected files
> FORGE:ARCHITECT → ordered implementation plan
> FORGE:BUILDER → commits + acceptance criteria
> FORGE:TRAJECTORY → full audit trail
>
> Every downstream agent reads what came before.

---

**Tweet 6 — The Result** (256 chars)

> When the builder starts, it doesn't explore blind.
>
> It reads the investigation that already traced the root cause.
>
> When it finds a related bug in a sibling file, it knows — because the knowledge graph surfaced a fix from 3 months ago in the same module.

---

**Tweet 7 — The Stats** (192 chars)

> 25 slash commands.
> 9 specialized review agents.
> 14+ quality gate domains.
>
> Investigate → Architect → Build → Quality Gate → Review → Merge.
>
> Fully autonomous. Built for Claude Code.

---

**Tweet 8 — Install** (119 chars)

> Install in 30 seconds:
>
> ```
> npx forgedock
> ```
>
> Symlinks 25 commands into ~/.claude/commands/
>
> Then: `/work-on #<issue>`

---

**Tweet 9 — Star Ask + Link** (198 chars)

> Open source, AGPL-3.0.
>
> If this solves a real problem for you — a ⭐ on GitHub helps more than you'd think.
>
> github.com/RapierCraftStudios/ForgeDock
>
> cc @AnthropicAI @alexalbert__

---

**Tweet 10 — Optional Bonus: The Cascade** (243 chars)

> The pipeline also catches its own false positives.
>
> A review agent flags a finding. Investigation traces the full call chain. Finds the fix already exists in a downstream gate.
>
> Closed as invalid. Full audit trail.
>
> The system self-corrects.

---

## Strategic Metadata

**Optimal posting time**: Tuesday–Thursday, 9–11am ET or 2–4pm ET (peak AI/dev Twitter activity)

**Tags**:
- @AnthropicAI
- @alexalbert__ (Claude Code lead)

**Hashtags** (add to tweet 9 or distribute across thread):
- #ClaudeCode
- #AIAgents
- #DevTools
- #OpenSource

**Threading instructions**:
1. Post tweet 1 first
2. Reply to your own tweet 1 with tweet 2, and so on through tweet 9 (or 10)
3. The thread should be readable top-to-bottom as a continuous story
4. Tweet 4 requires the demo GIF asset from issue #542 — download and attach at posting time
5. Pin tweet 1 to your profile for the launch week

**Coordination with HN (#547)**:
- Post this thread within 24 hours of the HN Show HN submission going live
- Cross-link: add a comment on the HN thread pointing to the Twitter thread
- If the HN post is gaining traction (>50 points), post the thread immediately to amplify

---

## Ongoing Content Calendar (1–2 posts/week)

### Week 1 (Launch Week — ride the HN wave)

**Post 1 — Pipeline run highlight**

> ForgeDock just fixed bug #[X] autonomously.
>
> Here's the knowledge graph it built:
> - 3 related issues surfaced from git history
> - 2 past bugs in the same module (avoided repeating them)
> - 1 sibling file with the identical bug, caught by scope-gap analysis
>
> 7 minutes. Issue in, PR out.

**Post 2 — FORGE annotation explainer**

> FORGE annotations are machine-readable HTML comments posted to GitHub issues.
>
> They look like: `<!-- FORGE:INVESTIGATOR -->`
>
> Every agent reads them. Every agent writes to them.
>
> After compaction, a new agent reconstructs full context from GitHub alone — not conversation history.

---

### Week 2 (Social proof + specificity)

**Post 1 — Real example from your pipeline**

> [Share a real screenshot of a FORGE:TRAJECTORY comment from a recent run]
>
> This is what an autonomous pipeline audit trail looks like.
>
> Every decision. Every finding. Every file changed. Timestamped.
>
> No black box.

**Post 2 — Quality gate highlight**

> The ForgeDock quality gate runs 14+ domain-specific checks before any PR opens:
>
> - Auth model consistency
> - SQL injection vectors
> - Hardcoded credentials
> - API response contract consumers
> - Frontend proxy wiring
> - DB config lambda callback arity
>
> Agents don't guess. They gate.

---

### Week 3 (Milestone celebration / star count)

**Post 1 — Star count milestone** (fill in actual count)

> [X] stars in [N] days.
>
> The community is building something real here.
>
> Biggest thing you've shipped with ForgeDock this week? Drop it below. 👇

**Post 2 — Multi-agent review explainer**

> ForgeDock PRs are reviewed by 9 specialized agents simultaneously:
>
> - Concurrency agent
> - Security agent
> - Billing Integrity agent
> - API contract agent
> - Auth model agent
> - (+ 4 more)
>
> Each writes findings as separate issues — tracked, investigated, fixed.
>
> Review is a pipeline, not a checkbox.

---

### Week 4 (Community + deeper dive)

**Post 1 — The self-correcting pipeline**

> A review agent flagged "no input size cap on the system key path."
>
> Investigation traced the full call chain.
>
> The cap already existed — in a downstream gate the review agent didn't see.
>
> Closed as `workflow:invalid`. Audit trail preserved.
>
> The pipeline catches its own false positives.

**Post 2 — Invite to contribute**

> ForgeDock is open source (AGPL-3.0) and the pipeline is self-improving.
>
> Every review finding becomes an issue. Every issue flows through the pipeline.
>
> The tool ships itself.
>
> PRs welcome: github.com/RapierCraftStudios/ForgeDock

---

## Recurring Content Templates

**Template: Pipeline run showcase**
> ForgeDock just [action] autonomously.
>
> Here's what the knowledge graph surfaced:
> - [Finding 1]
> - [Finding 2]
> - [Finding 3]
>
> [Time]. Issue in, PR out.
>
> [Optional: link to PR or trajectory comment screenshot]

**Template: Milestone celebration**
> [X] [metric] milestone reached.
>
> [One-sentence reflection on what it means]
>
> [CTA: star, try, contribute]

**Template: Feature spotlight**
> One ForgeDock feature I don't talk about enough:
>
> [Feature name]
>
> [2-3 sentences on what it does and why it matters]
>
> [Optional: screenshot or GIF]

---

## Asset Checklist (before posting)

- [ ] Demo GIF from #542 — download and verify it plays correctly on mobile (under 15MB)
- [ ] HN post live (#547) — confirm timing before scheduling thread
- [ ] Tweet 1 character count verified (≤280)
- [ ] All 9 tweets character count verified (≤280, URLs count as 23 chars)
- [ ] @AnthropicAI and @alexalbert__ tags in tweet 9
- [ ] GitHub repo URL in tweet 9
- [ ] Thread pinned to profile after posting
