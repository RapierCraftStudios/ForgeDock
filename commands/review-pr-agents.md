<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent Catalog Router for `/review-pr`

This file is the routing index referenced by the `/review-pr` orchestrator during Phase 3C (agent dispatch).
Per-persona prompt templates have been split into individual files under `commands/review-pr-agents/`
to avoid loading the full catalog on every invocation. Protocols live in `docs/spec/review-protocol.md`
(canonical source) and are reproduced in `commands/review-pr-agents/protocols.md`.

Do not modify this file without also updating `review-pr.md`. To update either protocol, edit
`docs/spec/review-protocol.md` and sync the copy to `commands/review-pr-agents/protocols.md`.

**Dispatch tool: `Task` preferred, `Agent` is the documented fallback.** The orchestrator (`/review-pr` or
`/review-pr-staging`) resolves the dispatch tool once per invocation per its **Sub-Agent Dispatch Tool
Resolution** rule: `Task` when available, `Agent` when `Task` is absent from the environment — never inline
self-review as a substitute for either. Every agent template in this catalog is intended to be passed as
the `prompt` argument to whichever tool the orchestrator resolved (`Task(...)` or `Agent(...)`), with the
same per-agent isolation and the same requirement that each agent posts structured findings to the PR
directly (`gh pr comment`) rather than relaying them through the orchestrator's own context.

<!-- FORGE:PROTOCOL_SOURCE — canonical definition lives in docs/spec/review-protocol.md -->

---

## How to Load Agents (Phase 3C)

For each agent selected in Phase 3B, read **only** the files relevant to that agent:

1. **Always read first** (shared protocols, all agents require this):
   ```
   Read: $FORGE_HOME/commands/review-pr-agents/protocols.md
   ```

2. **Then read the persona file for each selected agent**:

| Agent | Trigger | File |
|-------|---------|------|
| General Security & Quality Scan | ALWAYS RUNS | `review-pr-agents/security.md` |
| Auth Conventions Auditor | AUTH domain | `review-pr-agents/auth.md` |
| Billing Integrity Auditor | BILLING domain | `review-pr-agents/billing.md` |
| Concurrency & Race Condition Auditor | CONCURRENCY or BILLING domain | `review-pr-agents/concurrency.md` |
| Domain Logic Auditor | SCRAPING domain (requires `review.domains.scraping` in forge.yaml) | `review-pr-agents/scraper.md` |
| Frontend Quality Auditor | WEB service touched | `review-pr-agents/frontend.md` |
| API Design & Consistency Auditor | New/modified routers or SDK/OpenAPI files | `review-pr-agents/api.md` |
| Database & Migration Auditor | DATABASE domain | `review-pr-agents/database.md` |
| Infrastructure & Deploy Safety Auditor | INFRA service touched | `review-pr-agents/infra.md` |

## Domain Prefixes (for Structured Findings)

| Agent | Prefix |
|-------|--------|
| General Security | `SEC` |
| Auth Conventions | `AUTH` |
| Billing Integrity | `BILL` |
| Concurrency | `CONC` |
| Domain Logic | `SCRP` |
| Frontend Quality | `FE` |
| API Design | `API` |
| Database & Migration | `DB` |
| Infrastructure | `INFRA` |

## Loading Instructions for Phase 3C

Replace the single `Read: $FORGE_HOME/commands/review-pr-agents.md` call with:

```
Read: $FORGE_HOME/commands/review-pr-agents/protocols.md
Read: $FORGE_HOME/commands/review-pr-agents/<persona>.md   (one per selected agent)
```

Each persona file contains:
- The agent's trigger condition and type
- Its full prompt template with all check items
- Its coverage matrix

The `protocols.md` file contains:
- Per-Agent Input Scoping rules
- Tool-Result Truncation Discipline
- Evidence-Based Review Protocol (all agents follow)
- Structured Findings Protocol (machine-readable findings block format)
