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

## Interfaces

One row per boundary between slices (required when the milestone plan has two or more items; a feature epic carries the
same section). Anchors are the paths that implement or call the boundary, in backticks; bootstrap-create registers each
row as an anchored decision so every lane touching those paths gets it as a preserve row, and changing one needs a
`supersedes` decision. Prefix an anchor `provider:` or `consumer:` to say which side it is. When the signature is
machine-readable (`POST /v1/x`, `refund(job_id, amount_micro)` or `queue q {field, field}`) and both sides are anchored,
`npx forgedock interfaces contract` generates a contract test (`node --test contracts/*.contract.test.mjs`) both sides run against the real source. Consumers
(`#issue` numbers or names) are reopened or get one filed issue when the interface is superseded. To record an
architecture choice the same way, add an `**Anchors**: \`path/\`` line to its section above.

| Boundary | Signature or schema | Auth mode | Owner issue | Anchors | Consumers |
|----------|---------------------|-----------|-------------|---------|-----------|
| {web -> api} | {POST /v1/x {body} -> {response}} | {API key only, no session cookie} | {issue key} | `{provider:src/api/}`, `{consumer:web/}` | {#issue or name} |

**Rationale**: {why these contracts; rejected alternative}

## Credentials

| Credential or account | Env var(s) | needs-human issue | Mock in dev/CI |
|-----------------------|------------|-------------------|----------------|
| {e.g. Google OAuth client} | `{GOOGLE_CLIENT_ID}` | {title} | {mock provider} |

**Rationale**: {why each external input is mocked until a human provides it}

## Milestone plan

1. {Foundation — what it delivers}
2. {next milestone}

**Rationale**: {build order: foundation first, then dependents}
