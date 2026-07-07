# Awesome List Submission Drafts

Important: Have a contributor or community member submit these, not the repo owner's account. Many lists reject self-submissions.

---

## 1. hesreallyhim/awesome-claude-code (36.8K stars) — TOP PRIORITY

### PR Title
```
Add ForgeDock — autonomous pipeline commands for Claude Code
```

### Entry (add under "Workflow & Automation" or "Agent Frameworks" section)

```markdown
- [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) - Structured autonomous development pipeline that adds investigate-build-review-merge workflow to Claude Code. Features 9-agent specialist PR review, 14-domain quality gate, and GitHub-native persistent memory via FORGE annotations. `npx forgedock`
```

### PR Description

```markdown
Adding ForgeDock, an open-source (AGPL) tool that adds structured pipeline commands to Claude Code.

**What it does**: Turns Claude Code from a stateless chatbot into a multi-stage development pipeline. Each stage (investigate, build, review, merge) posts machine-readable annotations to GitHub issues/PRs, so agents reconstruct full context after compaction.

**Key features**:
- 20+ slash commands including `/work-on` (full pipeline), `/orchestrate` (parallel multi-issue), `/autopilot` (self-improvement cycle)
- 9-agent specialist PR review (security, database, auth, concurrency, etc.)
- 14-domain quality gate
- GitHub labels as workflow state machine
- `forge.yaml` per-repo configuration

**Install**: `npx forgedock`

**Why it belongs here**: It's the most comprehensive pipeline orchestration system in the Claude Code ecosystem — 35 command files totaling 800KB+ of structured prompt engineering.
```

---

## 2. rohitg00/awesome-claude-code-toolkit

### Entry

```markdown
### Pipeline Orchestration
- [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) - Full SDLC pipeline for Claude Code: investigate → build → review → merge. 9-agent review, quality gate, GitHub-native memory via FORGE annotations. `npx forgedock`
```

---

## 3. travisvn/awesome-claude-skills

### Entry

```markdown
- [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) - 20+ pipeline commands: `/work-on` (full pipeline), `/orchestrate` (parallel issues), `/review-pr` (9-agent review), `/autopilot` (self-improvement), `/quality-gate` (14-domain checks). Uses GitHub as persistent knowledge graph.
```

---

## 4. ComposioHQ/awesome-claude-skills

### Entry

```markdown
- [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) - Autonomous development pipeline commands for Claude Code. Structured investigate-build-review-merge workflow with GitHub-native memory, multi-agent review, and quality gates.
```

---

## 5. VoltAgent/awesome-agent-skills

### Entry

```markdown
- [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) - Structured autonomous dev pipeline for Claude Code agents. Uses GitHub Issues/PRs as a knowledge graph with machine-readable FORGE annotations for inter-agent context passing. 35 command specs covering the full SDLC.
```

---

## 6. Broader awesome lists

### awesome-ai-agents

```markdown
- [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) - Open-source pipeline orchestrator for AI coding agents. Structures investigate → build → review → merge workflow using GitHub as a persistent knowledge graph. Currently supports Claude Code; multi-model planned.
```

### awesome-developer-tools

```markdown
- [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock) - Autonomous development pipeline that adds structured workflow commands to Claude Code. 9-agent PR review, 14-domain quality gate, GitHub-native memory. `npx forgedock`
```

---

## Submission Checklist

- [ ] Check each list's CONTRIBUTING.md for formatting requirements
- [ ] Ensure the entry follows the list's existing style (alphabetical? categorized?)
- [ ] One PR per list
- [ ] Submitter should have some GitHub activity (not a brand new account)
- [ ] Don't submit all on the same day — space them out over 1-2 weeks
- [ ] Priority order: awesome-claude-code first, then toolkit, then skills lists, then broader lists
