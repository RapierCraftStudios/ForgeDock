---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Shared Priority Rubric

This file is the canonical, single-sourced definition of the `priority:P0`-`priority:P3`
label scale used by every issue-filing surface in ForgeDock (`/issue`, `/review-pr`,
`/review-pr-staging`, `/adopt`, `/security-audit`, decomposition, milestone planning). It is
read once per command spec instead of being independently paraphrased inline.

**Normative for**: the P0-P3 label *definitions* (wording + examples + the required
justification field). Label *metadata* (hex colors, `gh label create` description strings)
remains sourced from `bin/labels.json` — this file aligns with that wording rather than
replacing it; do not fork a third copy of the description text.

**Why this file exists**: an audit of the last 10 closed issues (2026-07-19) found
`priority:P1` assigned to a pure code-dedup refactor and a rare-substring regex edge case —
both should have been P2/P3. Root cause: the rubric had drifted into 4+ independently-worded
copies (this file's own git history — see the commit that introduced it — cites the specific
finding), none of which required the filer to state *why* a priority was chosen. This file
and the required P-justification line (below) are the fix.

## The rubric

| Priority | Meaning | Example 1 | Example 2 |
|----------|---------|-----------|-----------|
| `priority:P0` | Critical — production broken, data loss, security breach. No workaround exists and users are actively affected right now. | Payment webhook silently drops all events — customers are charged but subscriptions never activate. | A credential leaked in a public commit; rotation is not yet complete. |
| `priority:P1` | High — a major feature is broken for a meaningful set of users, with no workaround. | The scrape endpoint 500s for every request using tier-3 proxies (a whole tier is unusable). | Login is broken for all OAuth users (a whole auth path is down), though email/password still works. |
| `priority:P2` | Medium — functionality is impaired but a workaround exists, or the feature is degraded rather than broken. | A dashboard chart renders with stale data until a manual refresh; the underlying data is correct. | A CLI flag silently falls back to a default instead of erroring on invalid input. |
| `priority:P3` | Low — cosmetic issue, polish, minor edge case, or a change with no user-facing functional impact (refactors, internal doc fixes, one-off rare-input edge cases). | A code-dedup refactor with no behavior change. | A regex mishandles a rare substring that has never been observed in production traffic. |

**Two independent axes — do not conflate them**: when a *review finding* has a `**Confidence**`
value (`CONFIRMED`/`LIKELY`/`POSSIBLE` — how sure the reviewer is the bug is real) alongside a
`**Severity**` value (`CRITICAL`/`HIGH`/`MEDIUM`/`LOW` — how bad the bug is if real), priority
MUST be derived from **Severity only**, via `scripts/severity-to-priority.sh`. Deriving it from
Confidence instead is the exact bug class forge#2447 fixed once already (a LOW-severity,
CONFIRMED-confidence finding was mislabeled `priority:P1`) — any command spec's prose that maps
Confidence directly to a `priority:P*` label is restating a fixed bug and must instead call the
script. See `scripts/severity-to-priority.sh`'s own header comment for the CLI contract.

## Required: the P-justification line

Every issue body created by a pipeline agent (via `/issue`'s programmatic path, or a
review-finding/staging-review heredoc) MUST include a one-line justification for the chosen
priority, immediately after the `**Severity**` or priority-bearing field in the template:

```
**P-justification**: {one sentence — why this priority, referencing what breaks and for whom}
```

Examples:
- `**P-justification**: P1 because the tier-3 proxy pool is completely unusable for every request routed through it, with no workaround.`
- `**P-justification**: P3 because this is a pure refactor with no behavior change — nothing is broken for any user.`

A justification that just restates the priority name ("P1 because it's high priority") is not
acceptable — it must name the concrete impact from the rubric table above.

## Soft lint: title prefix vs. priority

Filing paths (primarily `/issue` Phase 3E validation) SHOULD warn — not block — when:

- Title starts with `refactor:` or `chore:` **and** the assigned priority is `priority:P0` or
  `priority:P1`.

This is a warning, not a hard gate: a refactor *can* legitimately be P1 (e.g. it's blocking
another P0 fix), but the filer must override explicitly with a P-justification line that says
so, rather than the priority passing through unexamined. The lint's purpose is to force the
justification to be written, not to forbid the combination.

## Usage

A command spec that currently paraphrases the P0-P3 definitions inline replaces that
paraphrase with:

> Priority rubric: see `commands/shared/priority-rubric.md` for canonical P0-P3 definitions, the required P-justification line, and the soft title-vs-priority lint.

Command-specific triage heuristics (e.g. `/adopt`'s keyword-signal table for inferring priority
from issue text) are NOT restatements of this rubric — they are a distinct concern (how to
*infer* a priority from unstructured text) and should stay local, but should note that the
priority levels they map onto are defined here (e.g. "signals below map to the P0-P3 levels
defined in `commands/shared/priority-rubric.md`").
