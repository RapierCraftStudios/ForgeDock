<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- /bootstrap needs-human issue: one per credential, account or external input (OAuth client, cloud or DNS account,
payment keys, API keys, legal review). Label it needs-human and set "needsHuman": true in the plan. Code issues
reference it (#{{KEY}}) but never list it under Dependencies; their mocks keep dev and CI green. Copy from "## Problem" down. -->
## Problem

{which credential, account or external input is needed, and which issues use it}

### Setup steps

1. {exact console URL and the clicks to create it}
2. {settings to choose: redirect URIs, scopes, region}
3. {store the values as deploy secrets (repository or environment secrets)}

### Environment variables

- `{SERVICE_CLIENT_ID}` — {what it is}
- `{SERVICE_CLIENT_SECRET}` — {what it is}

### Secret handling

Never commit these values or paste them into issues. Store them only as deploy/CI secrets and a local untracked
`.env`. Rotate them if exposed. Until they exist, dev and CI use the mock provider.

## Root Cause (if known)

Greenfield: an external input agents cannot create.

## Affected Files

1. `docs/setup/{service}.md` — new

## Acceptance Criteria

- [ ] Credentials created and stored as deploy secrets [type:manual]
- [ ] The real provider replaces the mock in staging [type:manual]

## Context

**Parent**: #{{SPIKE}}

## Dependencies

None.
