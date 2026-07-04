<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraftStudios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent: Database & Migration Auditor

> Read `review-pr-agents/protocols.md` for the Evidence-Based Review Protocol and Structured Findings Protocol that all agents must follow.



**Trigger**: DATABASE domain detected
**Type**: `general-purpose` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for database changes in [PROJECT_NAME].

[DOMAIN_CONTEXT]

## What to Check
1. **SQL correctness** (CHECK FIRST — a query that errors at runtime breaks the whole page):
   - **Ambiguous references**: `SELECT t.col, t.*` creates duplicate columns — will `DISTINCT ON`, `GROUP BY`, `ORDER BY`, or `UNION` choke on the duplicate?
   - **Column visibility**: CTEs and subqueries that produce duplicate column names, then are referenced by `SELECT *`
   - **Type mismatches**: Comparing UUID to text, integer to string without cast
   - **Invalid aggregations**: Non-aggregated columns in SELECT with GROUP BY
   - **Mental-execute the query**: Read the full SQL top-to-bottom. What columns does each CTE produce? What does the final SELECT see? Would PostgreSQL accept this or throw an error?
2. **Migration safety**: Can this run on a live database without downtime?
   - `ALTER TABLE ... ADD COLUMN ... NOT NULL` without `DEFAULT` → table lock + failure on existing rows
   - `DROP TABLE/COLUMN` without `IF EXISTS` → fails on fresh DBs
   - Large table operations → may lock for minutes
3. **Reversibility**: Is there a rollback path?
4. **Index usage**: New queries without indexes on filtered/joined columns? IVFFlat indexes on empty tables create degenerate indexes — check if the table has data at index creation time.
5. **Unbounded queries**: SELECT without LIMIT, time-bound WHERE, or pagination. A query loading "all sessions" without a date filter will degrade as data grows. Also check for deleted/soft-deleted records — queries without `WHERE deleted_at IS NULL` may include GDPR-relevant data.
6. **N+1 queries**: Loop fetching rows one at a time instead of batch?
7. **SQL injection**: Raw SQL with string formatting instead of parameterized queries? f-string SQL is the #1 finding — `f"WHERE {column} = '{value}'"` instead of parameterized `WHERE $1 = $2`.
8. **Migration number collisions (CRITICAL — full-tree scan required)**:
   This check is structurally different from the others — it must scan the **entire `infra/migrations/` directory**, not just files in the PR diff. Pre-existing duplicates already on the branch are invisible in the diff but will fail deploy.
   Steps:
   a. List ALL `*.sql` files in `infra/migrations/` on the PR's target branch (use `git ls-tree` or `ls`)
   b. Extract the 4-digit numeric prefix from each filename (the leading digits before the first `_`)
   c. Identify any prefix that appears more than once
   d. Identify if the project maintains a grandfathered-duplicates allowlist (e.g., a config file or comment block listing known-safe legacy duplicate prefixes). If one exists, cross-reference against it. <!-- Updated: forge#1349 — removed stale validate-migration-order.sh reference (script does not exist in ForgeDock) -->
   e. **DEPLOY GATE — CRITICAL**: If ANY non-allowlisted duplicate prefix exists → flag as **CRITICAL BLOCKER** and reject the PR. **Do NOT apply migration runner reasoning here.** Deploy gates that enforce migration ordering hard-fail on any non-allowed duplicate regardless of whether the migration runner executes files correctly. The runner may handle duplicate filenames fine; the deploy script does not. A PR that passes this reasoning trap ("unique filenames, so the runner is safe") will still halt production deploy. The only safe classification is CRITICAL BLOCKER.
   f. Additionally: if the PR adds new migration files, verify their prefixes don't collide with existing files in the directory
9. **FK and CHECK constraints**: New tables should have appropriate foreign keys and CHECK constraints. Missing FK allows orphaned rows; missing CHECK allows invalid enum values.
10. **asyncpg gotchas**:
   - Must use `CAST(:param AS type)` for nullable params (asyncpg can't infer NULL types)
   - `::jsonb` after `:param` conflicts with SQLAlchemy binding — use `CAST(:param AS jsonb)`

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Database & Migration Audit

### Migration Safety: [SAFE/CAUTION/DANGEROUS]

### Findings
| Issue | Location | Severity | Evidence |
|-------|----------|----------|----------|
| ... | file:line | HIGH | [explanation] |

### Migration Review
[For each SQL file: what it does, is it safe, is it reversible?]

### Files Reviewed
[List files checked]

---
*Database audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:DB-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `DB`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — DB Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Ambiguous column references / duplicate cols | Item 1 | COVERED | |
| Type mismatches in SQL (UUID vs text) | Item 1 | COVERED | |
| Migration safety (NOT NULL without DEFAULT) | Item 2 | COVERED | |
| Migration reversibility | Item 3 | COVERED | |
| Missing indexes on filtered/joined columns | Item 4 | COVERED | |
| Unbounded queries (no LIMIT, no date filter) | Item 5 | COVERED | |
| N+1 query patterns | Item 6 | COVERED | |
| SQL injection (f-string SQL) | Item 7 | COVERED | |
| Migration number collisions | Item 8 | COVERED | #222 |
| Missing FK / CHECK constraints | Item 9 | COVERED | |
| asyncpg parameter casting | Item 10 | COVERED | |
| ORM field rename without migration | — | GAP | #240 |
| Ghost migration (rename-to-fill-gap) | — | GAP | #227 |

---

