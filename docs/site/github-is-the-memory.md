---
title: "GitHub Is Already Your Agents' Memory"
description: "AI agents re-derive everything from scratch every session. The data they need to avoid that is already in GitHub — commits, PRs, issues, blame. ForgeDock makes it machine-readable."
keywords: ["ai agent memory", "github knowledge graph", "forge annotation protocol", "deterministic phase engine", "trajectory receipt"]
---

# GitHub Is Already Your Agents' Memory

Every agent session begins the same way. The model reads the codebase, forms a hypothesis, and starts writing. It does not know that the function it is about to change was shaped by a bug fix filed in issue #347. It does not know that the approach it is about to try was already attempted and reverted in PR #891. It does not know that three other files will need the same change, because a review agent noted that dependency two weeks ago and the note lives in a comment thread the current session never read.

This is the memory problem — not context length. Context windows are large enough. The bottleneck is that nothing ever gets written down in a place where the next agent session can find it.

The common solution is a sidecar memory store: a vector database, an MCP memory server, a proprietary knowledge base. The agent writes embeddings after a run; the next agent retrieves them at session start. The idea is reasonable. The execution has a consistent flaw: it duplicates structure that already exists in GitHub while being invisible to humans and every tool that is not specifically wired to query it. A human reading the issue thread sees none of it. A `git blame` reveals none of it. A new developer onboarding to the codebase sees none of it.

GitHub is already a citation graph. Commits reference issues. Pull requests reference commits. Issues cross-reference related issues. `git blame` traces every line to a commit, which traces to a PR, which traces to an issue thread containing the full reasoning behind the change. That graph is public, auditable, searchable with standard tools, and survives any vendor relationship. Agents just do not use it as one.

The question is not whether to give agents memory. The question is whether that memory should live inside proprietary stores that duplicate GitHub, or whether it should live in GitHub itself — where every human and tool on the project can already read it.

---

## What "machine-readable" means here

The GitHub citation graph is human-readable by design. An issue thread mixes prose rationale, code snippets, review comments, and reactions. A commit message is free text. A PR description has whatever structure the author chose to give it.

Human-readable is not the same as machine-parseable. A downstream agent cannot reliably extract "the root cause identified in the investigation phase" from a prose paragraph that may or may not contain one. It cannot reliably distinguish a speculative suggestion from a confirmed finding. It cannot know which comment in a 40-comment thread represents the agreed-upon plan.

ForgeDock's answer is **FORGE annotations** — structured HTML comments written by each pipeline stage and read by every downstream stage. An annotation looks like this:

```html
<!-- FORGE:INVESTIGATOR
verdict: CONFIRMED/HIGH
root_cause: The co-change query reads a variable populated only by the Layer 5 subsystem, which shipped in PR #1204 three hours before this issue was filed. The variable is never written on the headless path.
affected_files: commands/orchestrate.md, scripts/layer5-query.sh
-->
```

This is still a GitHub comment — a human reading the thread sees it as a collapsed HTML comment or reads its contents directly. But a downstream agent querying the issue with `gh issue view` gets it as structured text it can parse without guessing at prose intent. The annotation is the contract between stages.

The annotation format is an open standard — the [FORGE Annotation Protocol](https://github.com/RapierCraftStudios/ForgeDock/blob/main/docs/spec/forge-protocol-v1.md). Any agent pipeline can implement it without ForgeDock. The format is documented in full, the vocabulary is fixed, and the license is CC-BY-4.0.

---

## Three terms, defined once

**Knowledge graph** — in this context, the set of GitHub issues, pull requests, commits, and their cross-references, treated as a queryable graph rather than a linear history. The `gh` CLI is the query interface. `gh issue view`, `gh pr view`, `gh issue list --search`, and `git log` are the operations. No additional infrastructure is required.

**Trajectory receipt** — the `FORGE:TRAJECTORY` annotation written to a GitHub issue at the end of a pipeline run. It records what each phase actually did: the investigation verdict, the architectural decision, the build summary, the quality gate results, the review findings, and the merge commit. It is not a log file on a server; it is a public comment on the issue, readable by any agent that opens that issue in any future session. On this repository, trajectory receipts are the primary mechanism by which the pipeline avoids repeating work.

**Deterministic phase engine** — the component that decides what happens next in a pipeline run, based on GitHub state rather than model inference. When a run is interrupted and resumed, the engine reads the annotations present on the issue, determines which phases have completed, and advances to the correct next phase. The model does not decide whether to re-run investigation; the engine reads the `FORGE:INVESTIGATOR` annotation, finds it present and valid, and skips directly to context. Phase selection is a pure rule-based state machine. The engine shipped in [PR #1326](https://github.com/RapierCraftStudios/ForgeDock/pull/1326).

---

## What the receipts actually show

These are public runs on this repository — the annotation trails are readable on the linked issues.

**Citing past bugs by number, before a line is written.** From [issue #1196](https://github.com/RapierCraftStudios/ForgeDock/issues/1196), the context phase produced this output before build began:

> "`commands/orchestrate.md` has a dense review-finding history from PR #1081/#1107/#1126… associative-array declaration mistakes (#1113), array-element removal via pattern substitution corrupting partial matches (#1108)… the new Layer 5 subsection should not introduce a competing edge-direction convention that could reintroduce a cycle class."

That output came from querying the knowledge graph — the agent read the PR history for `commands/orchestrate.md`, extracted the annotated findings from prior reviews, and synthesized the relevant constraints. It did not come from a vector database. It came from GitHub.

**Review catching a bug in the fix itself.** [Issue #1230](https://github.com/RapierCraftStudios/ForgeDock/issues/1230): the pipeline's own staging review identified dead code in a feature the pipeline had shipped three hours earlier (the co-change query read a never-populated variable). A fix was built. The review phase then caught a defect in the fix: stray backticks in the grep pattern meant every `git-log` pathspec silently matched zero commits. The reviewer's finding read: "the fix would not have actually worked." The fix was corrected. Intent to merged: 30 minutes.

**Self-invalidation with receipts.** [Issue #952](https://github.com/RapierCraftStudios/ForgeDock/issues/952): the investigation phase closed the pipeline's own proposal as INVALID. The deliverable had already shipped weeks earlier. The trajectory receipt documents the reasoning and links the prior PR. Zero code written. The pipeline did not guess; it queried GitHub, found the prior work, and stopped.

These are not selected for drama. They are selected because each one is a case where the pipeline's behavior was downstream of structured data in GitHub — not model intuition, not a sidecar store, not a human prompt.

---

## Why memory that lives where the work lives is different

A sidecar memory store requires explicit maintenance. Someone has to decide what gets stored, in what format, with what retention policy. If the store is lost or migrated, the memory is gone. If a new engineer joins the project, they cannot read the memory with their existing tools — they need access to and familiarity with the store.

Memory in GitHub requires none of this. Every FORGE annotation is a GitHub comment. It appears in the issue timeline. It is indexed by GitHub search. It is exportable via the standard API. It is archived in every repository clone. A new engineer reading an issue thread encounters the full investigation, architectural rationale, build summary, and review findings as part of the normal issue history — no additional access required.

This is what "auditable, portable, and survives any vendor" means in practice. The annotations are machine-readable because they have structure. They are human-readable because they are GitHub comments. They are durable because GitHub is the primary store, not a secondary one.

The `gh` CLI as query interface means the memory is queryable from any shell, any CI environment, and any agent session — with no SDK, no API key rotation for a separate service, and no schema migration to manage.

---

## The compounding property

Trajectory receipts compound. When the pipeline works on a module it has touched before, the context phase finds prior trajectory receipts for that module, extracts the review findings they record, and forwards them to the architect and builder as known constraints. Known bugs do not get reintroduced. Known approaches that failed are not re-attempted. Known patterns that the reviewer flagged get applied proactively.

In this repository's first 30 days (June 4 through July 4, 2026): 693 issues filed, 605 closed, 603 PRs merged. 49% of all issues filed originated from the pipeline's own review agents — bugs the pipeline found in its own output, filed as issues, and then fixed. That loop runs because each review's findings are annotated on the PR, the trajectory receipt records them on the issue, and the context phase for any subsequent work on the same files reads them. Numbers are point-in-time; a reproducible benchmark is in progress at [#1264](https://github.com/RapierCraftStudios/ForgeDock/issues/1264).

---

## Two paths forward

**Try it end-to-end with ForgeDock:**

```bash
npx forgedock demo
```

This spins up a risk-free demo repository and walks the full pipeline — investigate, build, review, merge — so you can read the annotations it produces before pointing it at a production codebase. The full setup:

```bash
npx forgedock
```

Checks your environment, installs the slash commands into Claude Code, and generates a `forge.yaml` for your repository.

**Adopt the protocol without ForgeDock:**

The annotation format is the independently useful part. The [FORGE Annotation Protocol](https://github.com/RapierCraftStudios/ForgeDock/blob/main/docs/FORGE-PROTOCOL.md) document describes the philosophy and vocabulary. The [protocol spec](https://github.com/RapierCraftStudios/ForgeDock/blob/main/docs/spec/forge-protocol-v1.md) gives the full technical definition — annotation types, required fields, completion markers, and query patterns. The license is CC-BY-4.0. Any agent pipeline can implement structured GitHub annotations using these specs without adopting ForgeDock's command layer. The only requirement is consistency: if annotations are written and read with the same vocabulary, the knowledge graph is coherent across sessions.

---

The sidecar stores are building a parallel infrastructure for something GitHub already does. The annotations are the part that was missing — the structured layer that makes the existing graph machine-readable. Once that layer exists, the query interface is `gh`, the storage is GitHub, and the memory is wherever the work is.
