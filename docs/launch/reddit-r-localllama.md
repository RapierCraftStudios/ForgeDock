# Reddit Post — r/LocalLLaMA

## Subreddit Profile

- **Community**: ~400k members, AI/LLM researchers, engineers, enthusiasts
- **Culture**: Highly technical, skeptical of hype, rewards architectural depth. People here read papers, benchmark models, and build infrastructure. They want the mechanism, not the pitch.
- **Best post styles**: Technical deep-dives, architecture posts, novel approaches with clear trade-offs
- **Avoid**: Marketing language, vague claims ("intelligent agents"), self-promotion without substance, anything that sounds like a product announcement

---

## Post Title

```
Using GitHub's existing graph structure as persistent memory for AI coding agents — architecture deep-dive
```

---

## Post Body

> **Target length**: ~1500–2000 characters (r/LocalLLaMA tolerates longer technical posts)
> **Tone**: Technical, architectural, honest about trade-offs. Describe the mechanism, not the outcome.
> **URL**: https://github.com/RapierCraftStudios/ForgeDock

---

```
AI coding agents have a memory problem that bigger context windows don't fully solve. Even within a 200k token window, agents exploring a codebase from scratch on every task re-discover the same root causes, miss the same historical mistakes, and make the same implementation errors that prior sessions already identified. The bottleneck isn't token capacity — it's structured lookback.

The key insight: GitHub already stores everything an agent needs as structured relationships. Issues reference PRs. PRs reference commits. Commits point to files. git blame traces when and why code was written. The relationships are there; agents just don't use them systematically.

ForgeDock is a protocol that makes these relationships machine-readable. Every pipeline stage writes HTML annotations directly to GitHub issues and PRs using a consistent schema:

- FORGE:INVESTIGATOR — verdict, root cause with file:line references, affected files, severity
- FORGE:CONTEXT — historical findings from related issues, known pitfalls in the same module
- FORGE:ARCHITECT — ordered implementation plan with full dependency graph of affected code paths
- FORGE:BUILDER — branch, commits, acceptance criteria status

When a new agent session starts — even after compaction, even days later — it queries GitHub via `gh` CLI and reconstructs full context from these annotations. No conversation history dependency. No vector store. No embedding lookup. The storage layer is GitHub itself.

The pipeline: investigate (git blame + closed issue mining) → context (surface historical module failures) → architect (trace all call sites before writing code) → build → quality gate (14+ check domains) → 9-agent review → PR. Each stage reads what came before and writes what it found. Agents don't explore; they follow structured data.

Trade-offs worth knowing: (1) annotation parsing costs tokens — you're spending ~800 tokens to read a FORGE:INVESTIGATOR comment that could be 50 tokens in a purpose-built store; (2) GitHub is append-only, so corrections require new comments, not edits; (3) quality depends heavily on the quality of the command specs.

After 20,000+ issues on production codebases, the main observation: false positive rate in review agents dropped from 44% to <10% through the accumulated findings loop. The knowledge graph compounds.

install: npx forgedock (25 markdown command specs, no runtime)
```

---

## Launch Timing

- **Post 2–3 days after HN** — r/LocalLLaMA audience overlaps with HN; wait for HN discussion to settle
- **Best windows**: Weekday mornings, 9am–12pm ET (community peaks weekday mornings)
- **Pair with**: r/programming on the same or next day (different tone, some audience overlap)

---

## Engagement Strategy

- This community will probe the architecture hard — welcome it
- If asked about token costs: acknowledge the parsing overhead and link to the Vision section of the README (purpose-built graph store as the roadmap end state)
- If compared to RAG/vector approaches: explain that structured relationships in GitHub are qualitatively different from semantic similarity search — git blame tells you *why* code exists, not just that it's similar
- Be precise about what "memory" means: it's not fine-tuning, not RAG, not in-context learning — it's structured state written to an external store that persists across conversation boundaries

---

## Pre-Drafted Comment Responses

### "Why not just use a vector database?"

> Vector stores give you semantic similarity — "this code looks like that code." GitHub's graph gives you causal relationships — "this code was written to fix issue #347, which was caused by the same nil-check pattern that broke issue #291." Those are different. For a coding agent, the causal chain (what changed, why, what broke after) is more useful than semantic proximity. GitHub already has the causal chain as structured relationships. We're just reading it systematically.

### "This seems like it would be expensive in tokens"

> It is — parsing a full FORGE:INVESTIGATOR comment costs ~800 tokens for what could be 50 tokens in a purpose-built store. That's a known trade-off we're accepting in v1 to validate the protocol before building a custom storage layer. The Vision section of the README describes the end state: a purpose-built graph store where those 5 fields come back as structured data, not markdown. The current GitHub-as-database approach is the proof-of-concept.

### "How does this handle model context limits in long-running pipelines?"

> Each pipeline stage reads only the annotations relevant to it — FORGE:INVESTIGATOR is ~800 tokens, FORGE:CONTEXT is ~600, FORGE:ARCHITECT is ~1000. Total context load per stage is well under 3k tokens for a typical task. Each stage also writes its findings, so downstream stages don't need to re-read upstream raw data. The annotation protocol is explicitly designed to be token-efficient per stage, not session-efficient overall.

### "Isn't this just prompt chaining?"

> The annotations are structured state that outlives any conversation. Prompt chaining typically means passing output from one LLM call directly to the next within a session. ForgeDock annotations persist on GitHub indefinitely — a session six months from now can read the FORGE:INVESTIGATOR from today and not re-investigate. That's closer to a write-ahead log than a prompt chain.
