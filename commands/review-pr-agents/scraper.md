<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent: Scraper Logic Auditor

> Read `review-pr-agents/protocols.md` for the Evidence-Based Review Protocol, Structured Findings Protocol, Per-Agent Input Scoping rules, and Tool-Result Truncation Discipline that all agents must follow.



**Trigger**: SCRAPING domain detected
**Type**: `codebase-explorer` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for domain-specific logic correctness in [PROJECT_NAME].

## Project Domain Architecture

[DOMAIN_CONTEXT]

If no domain context is configured above, derive the architecture from the changed files: read the primary consumer/worker/handler files to understand the execution model.

## What to Verify
1. **Tier selection**: Is the starting tier correct? Does escalation logic work?
2. **Tier-billing alignment**: Does `tier_used` match what's charged?
3. **Timeout handling**: Are timeouts configured correctly per tier?
4. **Error propagation**: Do scrape failures propagate correctly?
5. **Playbook authority**: Does `playbook_min_tier_is_authoritative` work as expected?
6. **Content validation**: Does escalation trigger on empty/blocked content?
7. **Detection keyword consistency**: If the PR modifies `CHALLENGE_KEYWORDS`, `COMMON_COOKIES`, or ANY frozenset/tuple/list of string identifiers used for bot detection, WAF markers, or anti-detection cookies in `anti_detection/`, `consumers/`, or `browser/`:
   - **Cross-reference sibling sets**: List all other detection-related constants in the worker service (`grep -rn "^[A-Z_]* = frozenset\|^[A-Z_]* = tuple\|^[A-Z_]* = \[" services/worker/worker/`). For each entry in the modified set, verify it appears in all relevant sibling sets. Flag any entry present in one set but absent from a functionally related sibling (e.g., `ak_bmsc` in `CHALLENGE_KEYWORDS` but not in `COMMON_COOKIES`).
   - **Intra-file comment/code drift**: Read the full file. For any identifier mentioned in comments, docstrings, or commit messages (e.g., `_abck`, `ak_bmsc`) that is NOT present in the actual set literal, flag it as a likely typo or omission. This is CONFIRMED HIGH — comments describe the intended state; the code contradicts it.
   - **Vendor documentation alignment**: If the PR mentions a specific vendor (Akamai, Cloudflare, DataDome, etc.), grep for the vendor's known markers across the entire worker service and verify the modified set is complete.
8. **Capacity constants**: Any hardcoded numeric constant defining memory limits, pool sizes, timeouts, or thresholds (e.g., `_BROWSER_ESTIMATED_MB = 200`, `MAX_BROWSERS = 5`, `POOL_SIZE = 10`):
   - Does the PR or commit message cite a measurement source (e.g., "observed peak 744-890MB", "benchmarked at N req/s", linked issue/PR)?
   - Search git history for prior art that may contradict the constant:
     ```bash
     # Search git log for related measurements — adapt keywords to the constant's domain
     git log --all -20 --oneline --grep="memory" --grep="browser" 2>/dev/null | head -10
     git log --all -20 --oneline --grep="$(echo {CONSTANT_NAME} | tr '_' ' ' | tr '[:upper:]' '[:lower:]')" 2>/dev/null | head -5
     # Check recent PRs that touched the same file for prior measurement context
     git log --oneline --all -20 -- {CHANGED_FILE} 2>/dev/null | head -10
     ```
   - If no measurement source is cited and git history contains contradicting data (e.g., a prior PR documenting real observed values): flag as **CONFIRMED** with note "Hardcoded constant contradicts measured data in git history — verify against production metrics before deploy"
   - If no measurement source is cited and no contradicting git history found: flag as **POSSIBLE** with note "Hardcoded constant without measurement annotation — verify against production metrics"
   - If a measurement source IS cited (comment, commit message, or linked issue): no flag needed
9. **API gate semantic correctness** (conditional — trigger: PR modifies any router file that gates existing request parameters behind a new condition):
   When a PR adds or changes a condition that gates a set of request fields behind a resource requirement (API key, feature flag, tier check), **verify independently for EACH parameter in the condition** whether it actually requires the gated resource:
   - For each field in the gate condition (`if request.X or request.Y:`, `if X and Y`): ask "Was this field previously handled without this gate? What is the behavioral change for existing users who send this field without satisfying the gate?"
   - Distinguish resource-dependent fields (e.g., those that invoke an external LLM or BYOK key at execution time) from resource-independent fields (those processed deterministically without the gated resource). A gate that covers both classes is incorrect — the resource-independent field must be routed separately.
   - Inspect the pre-existing code path for each field: search the router file and worker for the field's pre-change handling (`grep -rn "request\\.{field_name}" services/api/ services/worker/`). If the pre-existing path did NOT require the gated resource, the inclusion of that field in the gate is a **CONFIRMED HIGH** behavioral regression for existing callers.
   - If different fields in the condition reach different execution paths (one LLM-dependent, one not), the condition must be split — gate only the fields that require the resource.

   ```bash
   # Identify gate conditions in changed router files
   gh pr diff [PR_NUMBER] -- "services/api/app/routers/*.py" | grep "^\+" | grep -E "if request\.|if.*or.*request\." | head -20

   # For each gated field, check its pre-existing handling path
   # (adapt FIELD_NAME to each field appearing in the changed condition)
   git log --all --oneline -10 -- services/api/app/routers/ | head -10
   grep -rn "FIELD_NAME" services/api/app/ services/worker/worker/ | grep -v "^\s*#" | head -20
   ```
   <!-- Added: forge#382 -->
10. **Cross-component gate tracing** (conditional — trigger: PR touches both a router file that injects a field into a job payload AND a worker file that reads that field at execution time):
    When a worker-layer review identifies that a resource field (API key, LLM key, BYOK credential) is resolved at use-time from a job payload, the review MUST also trace to the API-layer gate condition that controls injection of that field. A gate can fail at the API layer for logic that executes at the worker layer — both components must be reviewed together.
    - Find the API router that creates the job payload and injects the field. Read the condition that controls whether the field is populated.
    - Verify the gate condition is semantically correct for ALL request fields that flow through it — not just the primary feature field.
    - If the API gate fires before job enqueue and the worker gate fires after dequeue, a misconfigured API gate will silently reject valid requests before the worker ever sees them.

    ```bash
    # Find all sites where the key/credential field is injected into the job payload
    grep -rn "byok_api_key\|llm_key\|extraction_key\|api_key" services/api/app/routers/ | grep -v "^\s*#" | head -20

    # For each injection site, read the surrounding conditional context (±15 lines)
    # Then cross-reference: what request fields trigger the injection condition?
    # Are ALL those fields genuinely dependent on the injected resource?

    # Check the worker consumption site for the same field
    grep -rn "byok_api_key\|llm_key\|extraction_key\|api_key" services/worker/worker/ | grep -v "^\s*#" | head -20
    ```
    <!-- Added: forge#382 -->

```bash
# Find all detection-related string constants in the worker service
grep -rn "^[A-Z_]* = frozenset\(\|^[A-Z_]* = tuple(\|^[A-Z_]* = \[" services/worker/worker/ 2>/dev/null

# For each modified set, check if its entries appear in sibling detection files
for f in [CHANGED_ANTI_DETECTION_FILES]; do
    grep -oE "'[a-z_][a-z0-9_-]{3,}'" "$f" | tr -d "'" | sort -u | while read entry; do
        grep -rl "'$entry'\|\"$entry\"" services/worker/worker/ | grep -v "^$f$" | grep '\.py$' || \
            echo "SCRP: '$entry' in $f not found in any sibling worker file — verify if cross-module sync needed"
    done
    # Check comment vs set drift
    grep -oE "#.*\`_?[a-z][a-z0-9_-]+\`" "$f" | grep -oE "\`[^']+\`" | tr -d '`' | while read ref; do
        grep -q "'$ref'\|\"$ref\"" "$f" || \
            echo "SCRP: '$ref' mentioned in comment in $f but absent from string sets — possible typo or omission (HIGH)"
    done
done
```

## Cross-Service Consistency
- API-side: Job creation, initial tier selection
- Worker-side: Actual execution, tier escalation, result handling
- Verify consistency between services

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Scraper Logic Audit

### Components Affected: [list the specific service/worker/api components touched — e.g. job-queue/rate-limiter/validation/gate-semantics/cross-component-gate]

### Tier Flow Analysis
[Trace the tier selection and escalation with file:line references]

### Detection Keyword Consistency
[If any detection set was modified: table of sibling sets checked, entries present/absent in each, comment/code drift found]
| Set Name | File | Entries | Missing from Sibling? | Comment Drift? |
|----------|------|---------|----------------------|----------------|
| CHALLENGE_KEYWORDS | file:line | N entries | [list missing] | [yes/no] |

### Capacity Constants
[If any capacity constants were added or modified: list each constant, its value, whether a measurement source was cited, and any contradicting git history]
| Constant | Value | Measurement Source Cited? | Git History Finding |
|----------|-------|--------------------------|---------------------|
| _BROWSER_ESTIMATED_MB | 200 | No | PR #4958 documented 744-890MB observed peak |

### API Gate Semantic Correctness
[If any router file gates request fields behind a new condition: for each field in the condition, state whether it requires the gated resource and whether the pre-existing behavior is preserved. "N/A — no gate condition changes in diff" is acceptable if no gate conditions changed.]

### Cross-Component Gate Tracing
[If worker layer injects or reads a resource field from the job payload: state the API-layer gate condition that controls injection, the fields it gates, and whether each field genuinely requires the gated resource. "N/A — no cross-component key/gate flow in diff" is acceptable if not triggered.]

### Findings
| Category | Issue | Location | Confidence |
|----------|-------|----------|------------|
| Tier logic | [issue] | file:line | CONFIRMED |
| Detection keywords | [issue] | file:line | CONFIRMED |
| Capacity constant | [issue] | file:line | POSSIBLE |
| API gate semantics | [issue] | file:line | CONFIRMED |
| Cross-component gate | [issue] | file:line | CONFIRMED |

### Cross-Service Consistency
[If changes span services, verify they're consistent]

### Files Reviewed
[List files checked]

---
*Scraper logic audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:SCRP-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `SCRP`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — SCRP Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Tier selection correctness | Item 1 | COVERED | |
| Tier-billing alignment | Item 2 | COVERED | |
| Timeout configuration per tier | Item 3 | COVERED | |
| Error propagation on scrape failure | Item 4 | COVERED | |
| Playbook authority logic | Item 5 | COVERED | |
| Content validation / escalation trigger | Item 6 | COVERED | |
| Detection keyword cross-set consistency | Item 7 | COVERED | |
| Capacity constant measurement verification | Item 8 | COVERED | |
| Cross-service consistency — tier logic (API vs Worker) | Cross-Service section | COVERED | |
| API gate semantic correctness per parameter | Item 9 | COVERED | forge#382 |
| Cross-component gate tracing (API gate ↔ worker injection) | Item 10 | COVERED | forge#382 |
| Playwright resource cleanup on failure | — | GAP | |
| Domain playbook override conflicts | — | GAP | |

---

