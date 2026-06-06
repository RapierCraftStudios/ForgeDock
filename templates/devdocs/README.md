---
authority: required
scope: project
applies_to: [work-on, review-pr, issue, orchestrate, quality-gate]
---

# DevDocs — Authoritative Knowledge Base

This directory contains the authoritative knowledge base for your project. Pipeline agents (ForgeDock commands) read these files as **binding source-of-truth** before acting — not as suggestions.

---

## Purpose

DevDocs bridge the gap between what agents know by default and what your project requires. They answer:

- How do we use ForgeDock in this project? (`agent/using-forgedock.md`)
- How do we use GitHub in this project? (`agent/using-github.md`)
- What templates do we use? (`templates/`)
- What is this project's tech stack, architecture, and conventions? (`project/`)

---

## Directory Structure

```
devdocs/
  README.md                     ← you are here
  agent/
    using-forgedock.md          ← ForgeDock pipeline how-to (all phases, lanes, commands)
    using-github.md             ← GitHub CLI, branch naming, labels, commit discipline
  templates/
    issue.md                    ← reusable issue body template
    pull-request.md             ← reusable PR body template
    commit-convention.md        ← conventional commit reference
    review-finding.md           ← review-finding issue template
  project/
    custom-instructions.md      ← user binding directives (HIGHEST precedence)
    stack.md                    ← tech stack description
    architecture.md             ← system and domain overview
    conventions.md              ← coding standards and patterns
    glossary.md                 ← domain terms and definitions
```

---

## Precedence Rules

When a conflict arises between different knowledge sources, agents follow this priority order:

| Priority | Source | Description |
|----------|--------|-------------|
| 1 (highest) | `project/custom-instructions.md` | Explicit user-authored directives. Always wins. |
| 2 | Other `project/*.md` files | Authoritative project context (stack, architecture, conventions) |
| 3 | `agent/*.md` files | Authoritative ForgeDock/GitHub usage instructions |
| 4 | `templates/*.md` files | Standard templates (lower authority than instructions) |
| 5 | Agent memory | Recalled knowledge from past sessions |
| 6 (lowest) | Agent defaults | Built-in behaviors when no other source applies |

**Rule**: When `custom-instructions.md` says X, agents do X — even if their training or memory says otherwise.

---

## Authority Levels

Each file declares an `authority` field in its frontmatter:

| Authority | Meaning |
|-----------|---------|
| `required` | Agent MUST read this file before acting in its domain |
| `recommended` | Agent SHOULD read this file; improves output quality |
| `reference` | Agent MAY consult this file; informational only |

---

## How Agents Use DevDocs

1. **Before investigating**: Read `agent/using-forgedock.md` and `project/custom-instructions.md`
2. **Before building**: Read `agent/using-github.md`, relevant `project/*.md`, applicable `templates/*.md`
3. **Before reviewing**: Read `project/conventions.md`, `project/stack.md`
4. **Always**: Treat `project/custom-instructions.md` as the final authority

---

## Regeneration

If this directory was scaffolded by `npx forgedock docs init`, re-running that command will add any new template files introduced in newer ForgeDock versions. It will **not** overwrite files you have edited (idempotent).

---

## Maintenance Notes

- Edit `project/*.md` files to reflect your project's actual stack, architecture, and conventions
- Edit `project/custom-instructions.md` to add binding directives for your project
- Do NOT edit `agent/*.md` unless you want to override ForgeDock's default behavior for this project
- `templates/*.md` files can be customized; changes affect what pipeline agents use as templates
