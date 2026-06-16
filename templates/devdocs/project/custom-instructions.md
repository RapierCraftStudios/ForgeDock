---
authority: required
scope: project
applies_to: [work-on, review-pr, issue, orchestrate, quality-gate]
domain: pipeline
last_validated: "YYYY-MM-DD"
version: "0.0.0"
---

# Custom Instructions — Binding Project Directives

**This file has the highest precedence of all devdocs.** Instructions here override agent defaults, training knowledge, and all other devdocs files. Agents MUST follow these directives exactly.

---

## How to Use This File

Add directives below in the format:

```markdown
### {Topic}
{Clear, specific instruction. Use imperative language: "Always", "Never", "Must".}
```

Be explicit. Agents follow instructions literally — vague directives produce inconsistent behavior.

---

## Project-Specific Directives

<!-- Add your binding directives below this line. -->
<!-- Each directive should be a level-3 heading followed by the instruction. -->

### Example: Code Style Override

> **Example — replace or remove this section.**
> Always use double quotes for strings in Python (not single quotes), even when linters suggest otherwise. This project enforces double quotes in its style guide.

### Example: Testing Requirement

> **Example — replace or remove this section.**
> Every new function in `services/api/` must include a corresponding unit test. Do not close a build phase without adding tests for changed code. The quality gate will enforce this, but plan for it in the Builder Contract.

### Example: Deployment Constraint

> **Example — replace or remove this section.**
> Never modify `docker-compose.prod.yml` without also updating `.env.example` with any new environment variables. These two files must stay in sync.

### Example: Forbidden Pattern

> **Example — replace or remove this section.**
> Never use `os.system()` — always use `subprocess.run()` with `check=True`. The security audit will flag `os.system()` calls as HIGH severity.

---

## Instructions for Reviewers

When `/review-pr` runs, agents read this file and apply its directives when classifying findings. A violation of a `custom-instructions.md` directive is automatically elevated to HIGH severity, regardless of the standard severity classification.

---

## Precedence Reminder

```
custom-instructions.md (this file)
    ↑ HIGHEST PRIORITY
    
project/*.md (stack, architecture, conventions, glossary)
agent/*.md (using-forgedock, using-github)
templates/*.md (issue, pr, commit, review-finding)
agent memory
agent defaults
    ↓ LOWEST PRIORITY
```

When this file says one thing and another source says another, follow this file.
