---
title: "What Are Those FORGE Comments on My GitHub Issues?"
description: "A 2-minute, plain-English explainer of FORGE annotations — the structured comments ForgeDock agents post on your GitHub issues and PRs. What they are, why they matter, and whether you should touch them."
keywords: ["forge annotations explained", "forgedock comments", "ai agent github comments", "claude code annotations", "what are forge comments"]
---

# What Are Those Comments on My GitHub Issues?

After your first ForgeDock run, your GitHub issue fills up with comments that start like this:

```html
<!-- FORGE:INVESTIGATOR -->
<!-- FORGE:CONTRACT -->
<!-- FORGE:ARCHITECT -->
<!-- FORGE:BUILDER -->
```

These are **FORGE annotations** — structured notes each pipeline stage leaves behind so the next stage (and your future self) can pick up exactly where the last one stopped. They're how your agents remember things.

## Before and After

**A bare GitHub issue:** a title, a description, and... nothing else. Every time an agent touches it, it starts from zero — re-reading the code, re-guessing the root cause, re-deciding the approach.

**An issue with FORGE annotations:** a full paper trail. The investigator's findings, the architect's plan, the builder's contract, and the review results all live on the issue. Any agent — or any teammate — can scroll the thread and see the whole story.

## How It Works in 30 Seconds

When you run `/work-on #42`:

1. The **investigator** traces the root cause and posts its findings as a `FORGE:INVESTIGATOR` comment.
2. The **architect** reads that comment, then posts its implementation plan.
3. The **builder** reads the plan, writes the code, and posts what it built.
4. **Review** reads everything above and records the outcome.

Each stage builds on the last. Your agents never start blind — even after Claude's context window resets, the next session just reads the thread and resumes.

Here's a real one:

```
<!-- FORGE:INVESTIGATOR -->
Verdict: CONFIRMED. All 27 command spec files load into context
on every session, blowing the token budget.
Root cause: symlink-based install pulls in every file eagerly.
Affected: bin/forgedock.mjs
```

## Do I Need to Edit Them?

**No.** FORGE annotations are machine-generated and machine-consumed. You don't have to write, edit, or delete them — the pipeline manages them for you. The `<!-- ... -->` wrapper means they render as invisible HTML comments, so they won't clutter your issue's rendered view.

Read them whenever you want visibility into what your agents are doing. That's the whole point: the work is transparent and auditable, right there in GitHub.

## Want the Technical Details?

If you're building your own agent pipeline or contributing to ForgeDock, the full machine-readable format — every annotation type, completion markers, and parsing rules — is documented in the [FORGE Annotation Protocol](./forge-annotation-protocol.md).
