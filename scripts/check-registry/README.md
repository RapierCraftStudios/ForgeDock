# ForgeDock Check Registry

The check registry is the feedback edge from review findings back into deterministic quality-gate enforcement. When the same defect class (identified by its `FORGE:PATTERN` tag) recurs 3+ times in a pipeline health window, `/pipeline-health` Phase 4 emits a check-promotion issue. Once the check is written and merged, it is registered here and runs automatically in Step 2 of `/quality-gate`.

## How it works

```
Review finding filed
  → FORGE:PATTERN tag added to issue body (review-pr.md Phase 6C)
  → pipeline-health Phase 4 counts pattern recurrences across issues
  → at threshold (3+): emits check-promotion issue referencing all source findings
  → check is written (LLM, once) and placed in scripts/check-registry/
  → check is registered in manifest.json
  → quality-gate.md Step 2 runs all registered checks — blocks commit on match
```

## manifest.json schema

Each entry in the `checks` array:

```json
{
  "slug": "migration-number-collision",
  "description": "Detects duplicate migration number prefixes (e.g. two 0220_*.sql files)",
  "pattern_tag": "migration-number-collision",
  "script": "scripts/check-registry/migration-number-collision.sh",
  "source_findings": ["#1234", "#1298", "#1315"],
  "promoted_at": "2026-07-04",
  "severity": "HIGH",
  "domains": ["DATABASE"]
}
```

Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `slug` | yes | Unique identifier, matches the `FORGE:PATTERN` slug and the script filename |
| `description` | yes | One sentence: what the check detects |
| `pattern_tag` | yes | The slug used in `<!-- FORGE:PATTERN: {slug} -->` annotations on finding issues |
| `script` | yes | Relative path from repo root to the executable check script |
| `source_findings` | yes | Issue numbers of the review findings that triggered promotion (minimum 3) |
| `promoted_at` | yes | ISO date when the check was added to the registry |
| `severity` | yes | `HIGH` (blocks commit) or `MEDIUM` (warning) |
| `domains` | yes | Quality-gate domain(s) that trigger this check (used for domain-scoped runs) |

## Check script contract

Each check script:

- **Receives**: A space-separated list of changed files on `$1` (same format as `{CHANGED_FILES}` in quality-gate.md), and the worktree path on `$2`.
- **Exits 0**: No match — check passed.
- **Exits 1**: Match found — check failed. Print one line per finding to stdout in the format: `{SLUG} | {SEVERITY} | {file:line} | {description}`
- **Exits 2**: Check not applicable (no relevant files in changeset) — treated as pass.
- **Runtime**: Must complete in ≤5s for a typical change set. Registry checks add ≤5s total to gate runtime.
- **No side effects**: Must not write files, network calls, or modify git state.

Example output on exit 1:

```
migration-number-collision | HIGH | migrations/0220_add_user_table.sql | Duplicate migration prefix 0220 — migrations/0220_existing.sql already uses this prefix
```

## Adding a new check

1. Write `scripts/check-registry/{slug}.sh` following the contract above.
2. Test it: `bash scripts/check-registry/{slug}.sh "path/to/changed/file" /path/to/repo`
3. Add an entry to `manifest.json`.
4. PR and merge — the check runs on all subsequent quality-gate invocations.

<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
