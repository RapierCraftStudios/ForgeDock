---
authority: required
scope: project
applies_to: [work-on, review-pr, issue, orchestrate, quality-gate]
domain: pipeline
last_validated: "YYYY-MM-DD"
version: "0.0.0"
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

## Frontmatter Schema (v2)

All devdoc files use the following frontmatter schema. The first three fields are v1 (stable); the last three are v2 additions for lifecycle management.

```yaml
---
authority: required          # required | recommended | reference
scope: project               # project | agent | template
applies_to: [work-on]        # list of commands this doc applies to
domain: pipeline             # topic domain for selective loading (see Domain Values below)
last_validated: "YYYY-MM-DD" # ISO date when content was last confirmed accurate
version: "1.0.14"            # ForgeDock version this doc was validated against
---
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `authority` | enum | How strictly agents must read this file |
| `scope` | enum | Which category of content this file contains |
| `applies_to` | list | Which ForgeDock commands use this file |
| `domain` | enum | Topic domain for selective loading (agents filter by domain before loading) |
| `last_validated` | ISO date | When a human or agent last confirmed the content is accurate |
| `version` | semver string | The ForgeDock package version at the time of last validation |

### Domain Values

| Domain | Description | Typical files |
|--------|-------------|---------------|
| `pipeline` | ForgeDock pipeline mechanics, commands, workflow | `agent/using-forgedock.md`, `templates/*.md`, `project/custom-instructions.md` |
| `github` | GitHub CLI, branches, labels, commit discipline | `agent/using-github.md` |
| `architecture` | System structure, component boundaries, data flow | `project/architecture.md` |
| `conventions` | Coding standards, patterns, anti-patterns | `project/conventions.md` |
| `stack` | Technology stack, frameworks, tooling | `project/stack.md` |
| `glossary` | Domain terms and definitions | `project/glossary.md` |
| `auth` | Authentication and authorization | project-specific files |
| `billing` | Billing and subscription logic | project-specific files |
| `infra` | Infrastructure, deployment, CI/CD | project-specific files |

Add project-specific domain values to this list as your project grows.

### Staleness Threshold

A devdoc is considered **stale** when the time since `last_validated` exceeds **90 days**, or when the `version` field is more than one minor version behind the current ForgeDock release.

**When agents encounter a stale devdoc**:
1. Read the file anyway — stale guidance is better than no guidance
2. Flag the staleness in the investigation or build report
3. Create a GitHub issue to schedule re-validation (do NOT block the current task)

### Maintenance Workflow

**Who updates `last_validated`**: The agent or developer who makes the first change to a file, or explicitly re-reads and confirms accuracy.

**When to update**:
- After editing any content in the file
- After verifying the content is still accurate against the current codebase
- After a ForgeDock version upgrade that touches the relevant domain

**How to update**:
1. Set `last_validated` to today's ISO date (`YYYY-MM-DD`)
2. Set `version` to the current ForgeDock package version (check `package.json`)
3. Commit with `docs(devdocs): re-validate {filename}`

**Automated re-validation**: The `/quality-gate` command checks `last_validated` on all `authority: required` devdocs and flags any older than 90 days.

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
