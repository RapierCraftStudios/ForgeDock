---
authority: reference
scope: project
applies_to: [work-on, review-pr, issue]
domain: glossary
last_validated: "YYYY-MM-DD"
version: "0.0.0"
---

# Domain Glossary

This file defines domain-specific terms, abbreviations, and concepts used in this project. Agents read this file to interpret issue descriptions, code comments, and PR reviews accurately.

---

## Instructions

Add terms below in alphabetical order. Each entry should:
- Define what the term means **in this project's context** (not a generic definition)
- Note how the term maps to code if applicable (`module`, `table`, `field`)
- Flag synonyms or similar terms that might cause confusion

---

## ForgeDock Pipeline Terms

> These terms are pre-defined for all ForgeDock projects. Add project-specific terms below.

**Fast Lane**
: Issues without a milestone. PRs target `staging`. Used for bug fixes, small improvements, and urgent work.

**Feature Lane**
: Issues with a milestone. PRs target `milestone/{slug}`. Used for large features developed over time.

**Worktree**
: A git worktree created in `.claude/worktrees/{branch}` for each in-flight issue. Provides isolation between concurrent pipeline runs.

**Review Finding**
: A GitHub issue created by a `/review-pr` domain agent for a code quality concern. Labeled `review-finding`. Not a merge blocker — addressed in subsequent PRs.

**Terminal State**
: A label state that signals the pipeline is complete: `workflow:merged`, `workflow:invalid`, `needs-human`, or `workflow:decomposed`.

**FORGE:BUILDER**
: An HTML comment marker in a GitHub issue comment that signals the build phase is complete. The pipeline searches for this marker to determine resume point.

**Quality Gate**
: The `/quality-gate` check that runs on changed files before commit. Flags dead code, missing error handling, security anti-patterns, and performance footguns.

---

## Project-Specific Terms

> Add your project's domain terms below. Remove this instruction block when done.

### {Term}

: {Definition in the context of this project. What does it mean? How is it used in code?}
: **Code**: `{module.ClassName}` or `{table_name.field_name}` if applicable
: **Also called**: {synonyms or alternative names, if any}
: **Contrast with**: {similar term that means something different in this project}

---

## Example Entries

> These are examples to illustrate the format. Replace with your actual terms.

**Credit**
: A unit of consumption that users spend to perform actions (e.g., run a scrape job). Stored as an integer in `users.credits`. One credit = one unit of API compute.
: **Code**: `services/api/app/billing/credits.py` → `check_balance()`, `deduct()`
: **Contrast with**: "subscription" (the plan type) and "token" (authentication artifact)

**Blue Container**
: The currently-serving production container in the blue/green deploy strategy. The Traefik router sends live traffic to blue until green is promoted.
: **Code**: `docker-compose.prod.yml` → service `api-blue`
: **Contrast with**: "green container" (staged, not serving traffic yet)

**Webhook**
: An HTTP callback from an external service (e.g., Stripe) to our API. Webhooks are idempotent — the same event may be delivered more than once.
: **Code**: `services/api/app/webhooks/`
: **Important**: Always verify webhook signatures before processing. Store processed event IDs to prevent duplicate processing.

**Slug**
: A URL-safe, lowercase, hyphenated string derived from a human-readable name. Used for branch names, milestone identifiers, and URL path segments.
: **Example**: "User Auth v2" → `user-auth-v2`
: **Code**: Branch pattern `milestone/{slug}` in `forge.yaml → branches.feature_pattern`
