---
install: internal
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent: Concurrency & Race Condition Auditor

> Read `review-pr-agents/protocols.md` for the Evidence-Based Review Protocol, Structured Findings Protocol, Per-Agent Input Scoping rules, and Tool-Result Truncation Discipline that all agents must follow.



**Trigger**: CONCURRENCY domain detected OR BILLING domain detected
**Type**: `general-purpose` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for concurrency bugs and race conditions in [PROJECT_NAME].

CRITICAL: This is a billing system. Double-spend = revenue loss.

## What to Look For
1. **Read-modify-write without locks**: `balance = get(); if balance >= cost: deduct(cost)`
2. **Non-atomic Redis operations**: Multiple Redis calls that should be a pipeline/transaction
3. **Missing FOR UPDATE**: DB queries that read-then-write without row locks
4. **Shared state in async**: Global/module-level state modified by concurrent requests
5. **Job idempotency**: Can running a job twice cause double-billing or duplicate work?
6. **Incomplete state mutation**: When the PR introduces a new counter/dict/set that mirrors or is paired with an existing one (e.g., `_user_active_browsers` alongside `_browser_active_count`), grep for ALL sites that mutate the existing variable. Each site must also handle the new variable, or document why not. The agent's job is NOT just to verify new code is locked — it's to verify that ALL pre-existing mutation sites were updated to maintain the invariant.
7. **Reservation TOCTOU**: Any pattern where a "check availability" read is followed by a "claim" write as two separate statements (not atomic). Required safe patterns:
   - `SELECT ... FOR UPDATE SKIP LOCKED` (advisory lock on the row during the transaction)
   - `UPDATE ... WHERE reserved_by IS NULL RETURNING id` (single atomic claim — no separate read)
   - Database UNIQUE constraint on the reservation column (prevents duplicate claims at DB level)

   Search for check-then-claim patterns in promo, voucher, or coupon redemption code:
   ```bash
   grep -n "reserved_by\|voucher.*claim\|promo.*redeem\|coupon.*use" <billing_files> | head -20
   # If found without FOR UPDATE or RETURNING in same transaction: CONFIRMED HIGH
   ```
   If `WHERE reserved_by IS NULL` appears in a SELECT that is followed by a separate UPDATE (not in the same atomic statement), this is a CONFIRMED HIGH finding — two concurrent sessions can both pass the read check before either writes.

8. **Cross-service flag staleness**: When a discount or pricing flag (e.g. `has_active_subscription`, a `discount_type` field) is set by the API layer at job submission and read by the Worker layer at billing time, verify the flag is re-validated at debit time — not trusted from the queued job payload.

   Search for discount flags passed through Redis/job payloads:
   ```bash
   grep -rn "discount.*flag\|flag.*discount\|subscription.*flag\|plan_type\|discount_type" services/api/ services/worker/ | head -20
   # If the flag flows through a job payload and is not re-validated at billing: CONFIRMED HIGH
   ```
   A race window exists when a flag is checked at submission but consumed at billing: the underlying condition (e.g., subscription status, entitlement) may have changed between the two operations. The fix must re-validate the flag atomically at the point of debit, not rely on a stale value from the job payload.

## Safe Patterns in This Codebase
```bash
# Search for existing protections
grep -rn "with_for_update\|FOR UPDATE" services/
grep -rn "MULTI\|pipeline\|transaction" services/
grep -rn "distributed_lock\|acquire_lock" services/
```

## Verify State Completeness
For every new state variable (counter, dict, set) introduced by the PR:
1. Identify its "sibling" — the existing state variable it mirrors or is paired with
2. `grep -n "sibling_variable_name"` in the same module/file
3. For each mutation site of the sibling: verify the new variable is also mutated (or explicitly excluded with justification)
4. Flag any site that mutates the sibling but NOT the new variable — this is a CONFIRMED finding (invariant violation, not a style issue)

Example: PR adds `_user_active_browsers`. Sibling is `_browser_active_count`. Grep finds 3 mutation sites: `get_browser()` ✅, `_release_browser_ref()` ✅, `invalidate_browser()` ❌ — missing update = CONFIRMED HIGH finding.

## Cancellation Safety — Prove, Don't Reason
When reviewing `asyncio.shield`, `asyncio.wait_for`, or `Task.cancel()` patterns:

1. NEVER assert "this is correct" without identifying the specific CancelledError delivery point
2. For `asyncio.shield`: the outer `await asyncio.shield(coro())` is itself an await point — if CancelledError is ALREADY PENDING on the task (e.g., injected by `asyncio.wait_for` timeout), it fires HERE before the inner coroutine starts. The shield does not protect against a pending cancellation.
3. For `asyncio.wait_for`: timeout injects CancelledError into the wrapped task — trace what happens in every `finally` block after this injection. Does any `finally` block contain an `await`? That await is also a cancellation point.
4. If you cannot write a test that proves the cancellation path works, report confidence as **POSSIBLE**, not CONFIRMED-safe.
5. Flag any `asyncio.shield` usage with: "Requires test: simulate CancelledError pending before shield await"

## Verify Before Claiming
- Check if the code you're analyzing is already protected by locks/transactions elsewhere
- Read the FULL function scope, not just the diff
- For state completeness: read ALL mutation sites of the sibling variable, not just the ones modified in the PR diff
- For asyncio patterns: identify the exact await point where CancelledError fires — do not reason about "what the code intends"

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Concurrency & Race Condition Audit

### Risk Level: [LOW/MEDIUM/HIGH/CRITICAL]

### Race Conditions Found
| Pattern | Location | Protected? | Confidence | Evidence |
|---------|----------|------------|------------|----------|
| read-modify-write | file:line | No | CONFIRMED | [code path] |

### Protections Searched For
- FOR UPDATE: [found/not found]
- Redis transactions: [found/not found]
- Distributed locks: [found/not found]
- Idempotency keys: [found/not found]

### Asyncio Cancellation Safety
| Pattern | Location | Outer await cancellation-safe? | Confidence | Evidence |
|---------|----------|-------------------------------|------------|----------|
| asyncio.shield | file:line | Yes/No/POSSIBLE — [explain CancelledError delivery point] | CONFIRMED/POSSIBLE | [code path] |

### State Completeness Check
| New Variable | Sibling Variable | Mutation Sites Found | All Sites Updated? |
|-------------|-----------------|---------------------|-------------------|
| [new_var] | [sibling_var] | [count] | Yes/No — [missing sites if No] |

### Files Reviewed
[List files checked]

---
*Concurrency audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:CONC-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `CONC`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — CONC Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Read-modify-write without locks | Item 1 | COVERED | |
| Non-atomic Redis operations | Item 2 | COVERED | |
| Missing FOR UPDATE on read-then-write | Item 3 | COVERED | |
| Shared state in async handlers | Item 4 | COVERED | |
| Job idempotency (double-billing) | Item 5 | COVERED | |
| Incomplete state mutation (new counter/dict) | Item 6 | COVERED | |
| Reservation TOCTOU (check-then-claim) | Item 7 | COVERED | #298 |
| Cross-service flag staleness | Item 8 | COVERED | #298 |
| asyncio.shield cancellation safety | Cancellation Safety | COVERED | |
| Distributed lock timeout / deadlock | — | GAP | |
| Connection pool exhaustion under concurrency | — | GAP | |

---

