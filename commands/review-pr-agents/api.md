<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent: API Design & Consistency Auditor

> Read `review-pr-agents/protocols.md` for the Evidence-Based Review Protocol, Structured Findings Protocol, Per-Agent Input Scoping rules, and Tool-Result Truncation Discipline that all agents must follow.



**Trigger**: New or modified routers/routes, OR SDK/OpenAPI files changed (`sdk/`, `openapi*.json`, `openapi-versions/`)
**Type**: `general-purpose` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for API design consistency in [PROJECT_NAME].

## Project API Conventions

[DOMAIN_CONTEXT]

If no API context is configured above, derive conventions from the changed files: read the main router/application entrypoint to understand registration patterns, and check neighboring endpoints for error format and naming conventions.

## What to Check
1. **Registration**: Is the new router registered in main.py?
2. **Schema completeness**: Request/response models defined? Types correct?
3. **Error handling**: Consistent error responses? HTTPException with proper status codes?
4. **Endpoint naming**: RESTful conventions? Consistent with existing endpoints?
5. **Query parameters**: Validated? Reasonable defaults?
6. **Response format**: Consistent with other endpoints in the same domain?
7. **External response type-safety**: Any code that consumes an external API response (HTTP client calls, SDK calls, third-party service responses) must guard against unexpected shapes. Flag direct dict/attribute access on an external response without a prior `isinstance` check or `None` guard — the response may be a dict, list, `None`, or an error string depending on the upstream service's behavior. Look for patterns like `data["key"]` or `data.field` immediately after `requests.get(...)`, `httpx.get(...)`, `await client.get(...)`, or similar calls without a guard. Exception: internal Pydantic-validated models are safe; only flag unvalidated external payloads.
8. **Code generator field coverage**: Any function that builds a code snippet, SDK usage example, or serialized representation of a model must include ALL fields defined in the relevant Pydantic model or schema. Flag generators where the field list is hardcoded rather than derived from the model, or where the model has gained new fields that the generator does not emit. Search for functions named `generate_*`, `build_snippet_*`, `get_code_*`, `example_*`, or similar that reference a model class — compare their emitted fields against the model's field list.
9. **New-field propagation**: When a PR adds a new field to a Pydantic model or database schema, verify that all downstream consumers are updated: serializers, snippet generators, SDK example builders, and any function that enumerates the model's fields. Search for all locations that reference the model class by name and check whether they handle the new field.

10. **Cross-PR SDK/schema consistency** (MANDATORY when PR touches `sdk/`, `openapi*.json`, or `openapi-versions/`): Documentation PRs that update SDK or OpenAPI files must be checked against recently-merged PRs to the same base branch. A concurrent schema PR may have already changed the API behavior being documented — producing contradictory docs that tell users to use methods the API now rejects.

    ```bash
    # Get the PR's base branch
    BASE=$(gh pr view [PR_NUMBER] --json baseRefName --jq '.baseRefName')

    # Find PRs merged to this base in the last 48 hours
    CUTOFF="$(date -u -d '48 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-48H +%Y-%m-%dT%H:%M:%SZ)"
    RECENT_MERGED=$(gh pr list --base "$BASE" --state merged --limit 20 \
      --json number,title,mergedAt,files \
      2>/dev/null | jq --arg cutoff "$CUTOFF" \
      '.[] | select(.mergedAt > $cutoff) | {number, title, schema_files: [.files[].path | select(test("schemas?/|scrape\\.py|models\\.py"))]}' \
      2>/dev/null | head -40)

    echo "Recent merged PRs to $BASE (last 48h): $RECENT_MERGED"

    # For each recent PR that touched schema files, check if Literal types changed
    for PR_NUM in $(echo "$RECENT_MERGED" | grep -oP '"number":\s*\K\d+'); do
      SCHEMA_DIFF=$(gh pr diff "$PR_NUM" 2>/dev/null | grep -E '^\+.*Literal\[|^\-.*Literal\[' | grep -v '^\+\+\+\|^---')
      if [ -n "$SCHEMA_DIFF" ]; then
        echo "SCHEMA CHANGE in PR #$PR_NUM (already merged to $BASE):"
        echo "$SCHEMA_DIFF"
        echo "--- Verify this PR's SDK/OpenAPI docs are consistent with the above Literal change ---"
      fi
    done
    ```

    For each schema Literal change found in recently-merged PRs:
    - Read the diff of THIS PR (PR [PR_NUMBER]) to see what values the SDK/OpenAPI files now document
    - If this PR's SDK documentation still lists values that the schema change removed (e.g., SDK JSDoc says `DELETE` is supported but schema now only accepts `GET`/`POST`) → this is a **CONFIRMED HIGH** finding
    - If this PR's SDK documentation says DELETE is "use with caution" but the schema already returns 422 for DELETE → this is a **CONFIRMED HIGH** finding (false reassurance)
    - Pattern: `sdk/*/client.py` `_valid_methods` list, TypeScript JSDoc `@param` literals, `openapi*.json` enum arrays — all must be consistent with the API schema's current `Literal[...]` type

## Cross-Reference
```bash
# Discover router entrypoints (adapt to project structure)
API_SRC=$(git ls-files | grep -E "(router|route|endpoint|app)" | grep -E "\.(py|ts|js)$" | head -20)
# See how existing routers are structured
grep -rn "APIRouter\|include_router\|app\.include\|express\.Router\|createRouter" $API_SRC 2>/dev/null | head -20
# Find external response consumers (unguarded dict/attribute access after HTTP calls)
grep -rn "\.get\|\.post\|\.put\|\.delete\|httpx\|requests\.\|axios\." $API_SRC 2>/dev/null | grep -v "test_\|#" | head -20
# Find code/snippet generators
grep -rn "def generate_\|def build_snippet\|def get_code_\|def.*example\b" $(git ls-files | grep -E "\.(py|ts|js)$") 2>/dev/null | head -20
# Find all locations that reference a modified model class
grep -rn "{ModelClassName}" $(git ls-files | grep -E "\.(py|ts|js)$") 2>/dev/null | head -20
# SDK method lists (for cross-PR check #10)
grep -rn "_valid_methods\|Literal\[" sdk/ 2>/dev/null | head -20
grep -rn "Literal\[" $(git ls-files | grep -E "schema" | grep -E "\.(py|ts)$") 2>/dev/null | head -20
```

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## API Design & Consistency Audit

### New/Modified Endpoints
| Endpoint | Method | Registered? | Schema? | Auth? | Consistent? |
|----------|--------|-------------|---------|-------|-------------|
| /path | POST | Yes/No | Yes/No | Yes/No | Yes/No |

### Consistency Issues
[Any deviations from established patterns]

### Files Reviewed
[List files checked]

---
*API design audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:API-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `API`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — API Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Unregistered router | Item 1 | COVERED | |
| Missing request/response schema | Item 2 | COVERED | |
| Inconsistent error handling | Item 3 | COVERED | |
| Non-RESTful endpoint naming | Item 4 | COVERED | |
| Unvalidated query parameters | Item 5 | COVERED | |
| Inconsistent response format | Item 6 | COVERED | |
| External response type-safety | Item 7 | COVERED | |
| Code generator field coverage drift | Item 8 | COVERED | |
| New-field propagation to consumers | Item 9 | COVERED | |
| Cross-PR SDK/schema consistency | Item 10 | COVERED | #190 |
| API versioning contract breaks (v1 vs v2) | — | GAP | |
| Pagination contract consistency | — | GAP | |

---

