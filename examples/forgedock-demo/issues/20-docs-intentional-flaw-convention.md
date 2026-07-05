---
title: "docs(demo): document the intentional-flaw and graded-issue authoring convention"
labels: ["documentation", "priority:P3"]
difficulty: "easy"
---

## Problem

The demo corpus relies on a deliberate convention — intentional flaws in source
code, graded issue difficulty, DEMO NOTE comments — but this convention is
undocumented outside of the source code comments themselves. Someone contributing
new issues, or using this corpus as a template for their own eval harness, has no
single reference explaining how the pieces fit together.

## Proposed Solution

Create `docs/CORPUS-AUTHORING.md` that explains:

1. **The intentional-flaw pattern** — why flaws are introduced in baseline
   source code and how to mark them with `>>> DEMO NOTE:` comments.
2. **The graded-difficulty taxonomy** — the five categories (bug, feature,
   refactor, perf, docs) and the three difficulty tiers (easy, medium, hard),
   with one example per category from this corpus.
3. **Issue spec format** — the required YAML frontmatter fields (`title`,
   `labels`, `difficulty`), the required markdown sections (`## Problem`,
   `## Affected Files`, `## Acceptance Criteria`), and the closing `> ...`
   callout paragraph.
4. **Independence constraint** — how to verify that a new issue is resolvable
   against the baseline commit without depending on other unmerged issues.

## Affected Files

1. `docs/CORPUS-AUTHORING.md` (NEW).
2. `README.md` — add a link to `docs/CORPUS-AUTHORING.md` in a "Contributing
   issues" sub-section.

## Acceptance Criteria

- [ ] `docs/CORPUS-AUTHORING.md` covers all four sections listed above.
- [ ] Each section references at least one existing issue from the corpus as a
  concrete example.
- [ ] `README.md` links to the new doc.
- [ ] No code changes required.

> A meta-doc that makes the demo self-explaining. Useful for anyone wanting to
> extend the corpus or use it as a template for their own benchmark.
