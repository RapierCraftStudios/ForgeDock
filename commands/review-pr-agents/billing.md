<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Agent: Billing Integrity Auditor

> Read `review-pr-agents/protocols.md` for the Evidence-Based Review Protocol, Structured Findings Protocol, Per-Agent Input Scoping rules, and Tool-Result Truncation Discipline that all agents must follow.



**Trigger**: BILLING domain detected
**Type**: `codebase-explorer` | **Model**: `sonnet`

**Prompt template:**
```
You are auditing PR #[PR_NUMBER] for billing integrity in [PROJECT_NAME].

CRITICAL: Any billing bug = revenue loss or user overcharging.

## Project Billing Architecture

[DOMAIN_CONTEXT]

If no billing context is configured above, derive the billing flow from the changed files: trace credit check → debit → execution → reconciliation paths.

## What to Verify
1. **Trace the full flow**: credit check → pre-debit → execution → reconciliation
2. **tier_used accuracy**: Where is `tier_used` set? Is it the final tier or intermediate?
3. **No double-charging**: Verify pre-debit and reconciliation don't overlap
4. **Failure handling**: What happens to credits when a scrape fails?
5. **Idempotency**: Can a retry cause double-debit?
6. **Free scrape paths**: Is there any code path that bypasses billing entirely?
7. **Gate regression check**: If the PR contains or preserves a feature gate that restricts endpoint access (e.g., `if "feature_name" not in features`, tier checks, balance thresholds blocking a route), verify the gate existed in the base branch BEFORE the commits being reviewed. Run `git show origin/{base}:{file} | grep -n "gate_pattern"` to check. If the gate was introduced by the same commit chain being fixed — not an independent historical addition — flag it as a potential rogue gate with HIGH severity: the correct fix is to fully revert the gate block, not to patch around it. A rogue gate silently restricts access for all users below a tier or balance threshold without any intentional review of that restriction. This finding is **informational — not a merge blocker**, but must appear in the Findings table so it can be tracked as a follow-up. <!-- Added: forge#278 -->

## MANDATORY Before Reporting
- Search `grep -rn "reconcil" services/worker/` before claiming "no reconciliation"
- Trace `tier_used` variable before claiming "wrong tier charged"
- Read the job completion handler in queues.py before claiming "credits not refunded"

## Post Findings
```bash
gh pr comment [PR_NUMBER] --body "$(cat <<'EOF'
## Billing Integrity Audit

### Billing Impact: [NONE/LOW/MEDIUM/HIGH]

### Flow Traced
1. Credit check: [file:line]
2. Pre-debit: [file:line]
3. Execution: [file:line]
4. Tier determination: [file:line] — tier_used = [how set]
5. Reconciliation: [file:line]

### Findings
| Issue | Confidence | Evidence | Revenue Impact |
|-------|------------|----------|----------------|
| ... | CONFIRMED/LIKELY | [code path] | [estimated impact] |

### What I Verified
- [ ] Traced credit deduction from API to worker
- [ ] Found reconciliation logic at [file:line]
- [ ] Verified tier_used source
- [ ] Checked idempotency
- [ ] Checked feature gates for rogue-gate regression (item 7)

### Files Reviewed
[List all billing-related files checked]

---
*Billing integrity audit*

<!-- REVIEW-FINDINGS-START -->
<!-- FINDING:BILL-1|CONFIDENCE|SEVERITY|file.py:line|Summary -->
<!-- (add one FINDING line per issue found — include ALL confidence levels) -->
<!-- REVIEW-FINDINGS-END -->
EOF
)"
```

**Structured Findings**: Include the structured findings block above at the end of your comment. Your prefix: `BILL`. See the Structured Findings Protocol section above for format rules.
```

### Coverage Matrix — BILL Agent

| Defect Category | Check Item(s) | Status | Ref |
|----------------|---------------|--------|-----|
| Credit check → debit → reconciliation flow integrity | Item 1 | COVERED | |
| tier_used accuracy (wrong tier charged) | Item 2 | COVERED | |
| Double-charging (pre-debit + reconciliation overlap) | Item 3 | COVERED | |
| Credit loss on scrape failure | Item 4 | COVERED | |
| Retry idempotency (double-debit) | Item 5 | COVERED | |
| Free scrape bypass paths | Item 6 | COVERED | |
| Rogue feature gate regression | Item 7 | COVERED | #278 |
| Webhook handler completeness | — | PARTIAL | #297 |
| Spend limit / budget cap accuracy | — | PARTIAL | #297 |
| Promo/voucher redemption integrity | — | GAP | |

---

