<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Technical Spike: {PRODUCT_NAME}

> Written by /bootstrap. Every decision is followed by an ADR-style `**Rationale**:` line (the decision, why, and the
> rejected alternative). bootstrap-create.mjs refuses to create the backlog while a section or a rationale is missing.

## Assumptions

{the "Here's what I assumed" list, one line each: aspect — default — rationale}

## Guardrails

{guardrails and domain rules from the interview; copied into every issue's Context}

## Stack

{languages, frameworks, database, auth, UI library}

**Rationale**: {why this stack fits the product; rejected alternative}

## Repo layout

```
{tree of planned directories and key files; /issue --greenfield validates Affected Files against it}
```

**Rationale**: {why this layout}

## Runtime topology

{services, workers, storage, CDN; the bootstrap-to-scale path: day-one single node -> next step -> at scale}

**Rationale**: {why}

## Data model

{entities, relations, tenancy model, retention}

**Rationale**: {why}

## Security and privacy

{authn/authz, secrets, PII handling, data residency, compliance}

**Rationale**: {why}

## Design system and quality gates

{design tokens, component library, dark mode, a11y target; lint, type, test and performance gates in CI}

**Rationale**: {why}

## Route/API map

| Route or endpoint | Purpose | Auth |
|-------------------|---------|------|
| {path} | {what} | {who} |

**Rationale**: {why}

## Credentials

| Credential or account | Env var(s) | needs-human issue | Mock in dev/CI |
|-----------------------|------------|-------------------|----------------|
| {e.g. Google OAuth client} | `{GOOGLE_CLIENT_ID}` | {title} | {mock provider} |

**Rationale**: {why each external input is mocked until a human provides it}

## Milestone plan

1. {Foundation — what it delivers}
2. {next milestone}

**Rationale**: {build order: foundation first, then dependents}
