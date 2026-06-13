# Hacker News 'Show HN' Launch Post

## Post Title

```
Show HN: ForgeDock – GitHub as a knowledge graph for AI coding agents (issue in, PR out)
```

---

## Post Body

> **Target length**: ~1200–1500 characters (well within HN's ~4000 limit)
> **Tone**: Technical, first-person, specific. No marketing fluff.
> **URL**: https://github.com/RapierCraftStudios/ForgeDock

---

```
Show HN: ForgeDock – GitHub as a knowledge graph for AI coding agents (issue in, PR out)

AI coding agents have no lookback. They don't know why the code they're touching was written, that a similar approach was tried and reverted in PR #891, or that three other files share the same bug and need the same fix. Each task starts blind.

The fix isn't a bigger context window. It's structured memory that survives conversation resets.

ForgeDock treats GitHub as that memory layer. Every pipeline stage writes machine-readable HTML annotations to issues and PRs — FORGE:INVESTIGATOR traces root cause to a specific commit, FORGE:ARCHITECT produces a typed implementation plan, FORGE:CONTEXT surfaces known pitfalls from closed issues in the same module. The next agent reads these before doing anything. The gh CLI is the query interface; no external store, no embeddings.

The pipeline: /work-on #42 → investigate (reads git blame, closed issues, review findings) → architect (traces all call sites, orders changes by dependency) → build → quality gate (14+ check domains) → 9-agent review → PR. Each stage writes what it found so the next stage doesn't repeat the work. After 20,000+ issues processed across real production codebases, patterns accumulate: the context phase now flags known pitfalls in a module before the builder touches it.

It's 25 markdown command specs installed via npx forgedock, no runtime server. Would love to hear what the HN community thinks about using GitHub's existing graph structure — commits, blame, cross-references — as agent memory.
```

**Character count**: ~1,380 characters (well within 4,000 limit)

---

## Launch Timing

- **Best windows**: Tuesday–Thursday, 9–10am ET
- **Hard dependencies**: #542 (demo GIF), #543 (social preview), #544 (README restructure) must be complete first
- **Day-of commitment**: Stay online 12+ hours, respond to every comment within 30 minutes in the first 2 hours (HN front-page velocity is comment-response-weighted)
- **Avoid**: Mondays (post-weekend backlog), Fridays (low engagement), holiday weeks

---

## Pre-Drafted FAQ Responses

### "How is this different from GitHub Actions?"

> ForgeDock isn't CI/CD. GitHub Actions runs code on events. ForgeDock is a protocol for AI agents to pass structured context to each other through GitHub — investigations, implementation plans, known pitfalls. The `gh` CLI is the read/write interface, not a runner. Nothing executes in your repo; it's a set of prompt specs your Claude Code agent follows.

### "Why not just use CLAUDE.md?"

> CLAUDE.md is static — it describes your repo once, globally. FORGE annotations are dynamic and issue-specific: the FORGE:INVESTIGATOR comment on issue #42 contains the exact commit that introduced the bug, the affected file list, and the root cause. A future agent working on a related issue reads that comment and doesn't re-investigate from scratch. CLAUDE.md can't accumulate per-issue knowledge across sessions.

### "Does this work with other AI tools beyond Claude Code?"

> The pipeline logic and annotation protocol are model-agnostic. Claude Code is the supported runtime today because slash commands (`/work-on`, `/review-pr`) are a Claude Code primitive. The architecture is designed to be portable — any agent that can run `gh` CLI commands and write structured comments can participate. Provider-agnostic runtime is on the roadmap.

### "Why AGPL?"

> The network clause ensures that if someone forks ForgeDock and offers it as a service — even internally at a company — they must open-source their modifications. Developer tooling built on open protocols should stay open. AGPL lets individuals and companies use it freely as long as modifications flow back.

### "How is this different from LangChain / AutoGen / CrewAI agent frameworks?"

> Those frameworks orchestrate agents at runtime — chains, memory stores, tool calls. ForgeDock doesn't run at runtime at all. It's a protocol: structured annotations written to GitHub that survive conversation resets and work across completely separate agent sessions. The 'memory' is GitHub itself. Any agent that knows the annotation schema can pick up where the last one left off — no shared process, no running server, no embedding database.

### "What happens when the agent gets it wrong?"

> Review findings don't block merges — they become new issues that enter the same pipeline. The 9-agent review step flags problems, each finding is created as a tracked issue, and the pipeline processes them in a future run. Over time, review findings accumulate as closed issues; the context phase mines them before the next related build so the same mistake doesn't recur. The loop is: mistake → review finding → issue → fix → closed issue → future context.

### "Why HTML comments for annotations?"

> GitHub renders HTML comments invisibly to humans — the issue stays readable without noise. Agents grep for `<!-- FORGE:INVESTIGATOR -->` to find structured context fast. It's a zero-dependency protocol: no API, no schema registry, no additional auth. Any tool with `gh` CLI access can read and write annotations. The downside is parsing cost (tokens to extract fields from markdown); the [Vision section of the README](https://github.com/RapierCraftStudios/ForgeDock#vision) describes replacing this with a purpose-built graph store once the protocol is proven.

---

## Response Strategy

- **Lead technical**: HN rewards specificity. Every response should name a mechanism, not a benefit.
- **Engage skeptics directly**: "That's a fair concern — here's the exact failure mode and why the design handles it." Do not defend, explain.
- **Convert questions into examples**: If someone asks how it works, walk through the payment nil-check example from the README (issue #42 → FORGE:CONTEXT surfaces audit log pitfall from issue #34 → builder avoids the mistake).
- **Acknowledge limitations honestly**: The pipeline is only as good as the command specs. False positives in review agents were ~44% early on; the README cites improvement to <10% through accumulated findings. Be honest about this tradeoff.
- **On "why not X"**: Never dismiss alternatives. Acknowledge what X is good at, explain the specific gap ForgeDock fills.
