# Show HN Draft

<!-- Updated by #1092: messaging angles research (2026-06-25) -->
<!-- Updated by #1099: context-rot pain framing (2026-06-27) -->
<!-- Research: "LLM Wiki" vocabulary = 17M views / 5K stars (Karpathy gist, April 2026).
     "Context rot" is now mainstream community vocabulary (MindStudio, Augment Code, Stack Overflow, 2025-2026).
     Lead with context rot pain; use LLM Wiki vocabulary as the HN title hook. Full research: docs/design/messaging-angles-research.md -->

## Title (choose one)

**Option D** (research-backed — RECOMMENDED for HN):
```
Show HN: ForgeDock — Codebase LLM Wiki for AI agents, built on GitHub Issues
```
*Rationale: "LLM Wiki" has 17M views of cultural priming from Karpathy's April 2026 gist. Developers
searching for the pattern recognize it immediately. Direct vocabulary alignment with the activated term.*

**Option E** (pain-first — RECOMMENDED for product pages and README hero):
```
Show HN: ForgeDock — AI agents forget everything. This gives them memory that lives in GitHub.
```
*Rationale: "Memory" is the #1 vocabulary by adoption (Mem0 48K stars). Names the felt pain ("forget")
directly. No explanation required.*

**Option A** (technical):
```
Show HN: ForgeDock – Open-source pipeline that turns Claude Code into a deterministic dev team
```

**Option B** (problem-first):
```
Show HN: ForgeDock – Structured autonomous dev pipeline using GitHub as a knowledge graph
```

**Option C** (concise):
```
Show HN: ForgeDock – Autonomous investigate-build-review-merge pipeline for Claude Code
```

---

## URL

https://github.com/RapierCraftStudios/ForgeDock

---

## Maker Comment (post immediately after submission)

Hi HN. AI coding agents suffer from context rot: the gradual degradation of output quality as context fills with noise, stale file contents, and conventions re-explained from scratch every session. Every context reset, the agent forgets what it investigated, what decisions it made, what it already tried. You end up re-explaining your codebase every time.

Most teams try to fight context rot with config files — CLAUDE.md, AGENTS.md, .cursorrules, Copilot instructions, Kiro steering. Five files, five formats, five things to keep in sync, and the agent still can't reconstruct what happened in the last PR.

ForgeDock takes a different approach: it turns GitHub itself into the agent's persistent memory. When the pipeline runs on an issue, each stage (investigate, build, review, merge) posts a machine-readable FORGE: annotation to the issue/PR. Downstream stages read what upstream stages wrote. When context compacts, the agent runs `gh issue view` and reconstructs full state from GitHub alone — no external memory layer, no proprietary database, no vendor lock-in.

Unlike DeepWiki (which generates a documentation snapshot of your codebase once), ForgeDock writes structured annotations during each pipeline execution — so context reflects the current state of every open issue and in-flight decision, not a snapshot that goes stale.

It's the LLM Wiki pattern (Karpathy's April 2026 gist), but applied to your entire development pipeline: issues are the wiki entries, FORGE: annotations are the structured knowledge, and GitHub's API is the query interface.

The pipeline has 9 phases, a 9-agent specialist review system (security, database, auth, concurrency, etc.), and a 14-domain quality gate — all running as Claude Code slash commands. It's not a wrapper or thin CLI; the command specs are 50KB+ prompt engineering documents that constrain agent behavior at every step.

Some technical details:
- Zero runtime code — just markdown command specs symlinked into Claude Code
- Install: `npx forgedock`
- Uses `gh` CLI and `yq` as only dependencies
- AGPL licensed, free forever for the core pipeline
- Currently Claude Code only, investigating multi-model support

Known limitations:
- Claude Code only (no Cursor/Codex/Aider support yet)
- Token-heavy on first run before adaptive scripts cache project patterns
- The pipeline is opinionated — it enforces a specific workflow that may not fit every team

I'm a solo developer building this to solve my own problems. Happy to answer questions about the architecture, the FORGE annotation protocol, or the prompt engineering behind the command specs.

---

## Posting Guidelines

- **When**: Tuesday–Thursday, 9AM–12PM ET
- **First 60 minutes**: Respond to every comment
- **Tone**: Technical, honest, no marketing language
- **If asked about monetization**: "Open-core model — the pipeline is AGPL and always free. Planning a commercial dashboard for pipeline observability."
- **If compared to Devin**: "Devin is a cloud service; ForgeDock runs locally with your own API key. Different trade-offs — Devin is turnkey, ForgeDock gives you full control and traceability."
- **If compared to DeepWiki**: "DeepWiki generates a documentation snapshot of your repo. ForgeDock writes structured annotations during each pipeline run — context stays current with your actual work, not a snapshot."
- **If asked about scale**: Be honest about current adoption. Don't inflate numbers.
