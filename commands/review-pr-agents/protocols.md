---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Shared Review Protocols

This file contains the shared protocols that ALL review agents must follow.
It is read alongside individual persona files during Phase 3C agent dispatch.
Canonical source: `docs/spec/review-protocol.md` — sync changes there first.

## Per-Agent Input Scoping

**Each domain agent receives only the diff slice relevant to its domain**, not the full PR changeset. The orchestrator (Phase 3C of `review-pr.md`) pre-computes these slices and substitutes `[DOMAIN_DIFF_SLICE]` in each agent's prompt before dispatch.

**Rationale**: Passing the full changeset to every agent inflates per-child input cost on large PRs. A billing agent reviewing auth code produces noise, not signal. Scoped inputs reduce cost and improve focus.

**Fallback rule**: If a domain's file pattern matches nothing in the PR (slice is empty), the orchestrator falls back to the full diff — ensuring no agent is launched with an empty context. This preserves review coverage on PRs where domain boundaries are blurry.

**Security agent exception**: The General Security agent ALWAYS receives the full diff — security vulnerabilities are cross-cutting and cannot be safely scoped to a file-path filter.

## Tool-Result Truncation Discipline

All tool results consumed by agents — including diff slices, file reads, and command outputs — are capped at **~100K characters**. This mirrors the runner's built-in 100K-char tool-result cap (`bin/runner.mjs`).

**Agents must NOT re-fetch `gh pr diff` in full** — use the pre-supplied `[DOMAIN_DIFF_SLICE]` instead. If an agent needs to read a specific file in full (e.g., to trace an import), cap the read at the relevant section using `head -N` or `sed -n 'X,Yp'`. Never pipe unbounded command output into context without a `| head -N` guard.

Rationale: agents receiving oversized context perform worse, not better — attention dilutes across irrelevant content, and token limits risk truncating the structured findings block that the triage phase depends on.

## File Resolution Discipline

Pipeline agents MUST NOT use `find` (unbounded or filesystem-wide) to locate protocol files, persona templates, or verification scripts under any circumstances. If a `Read` or `bash` invocation of an expected pipeline file fails (e.g. because `$FORGE_HOME` is unset and the path degraded to a root-anchored form), that is never a reason to search the filesystem — it means the deterministic fallback chain the orchestrator already computed (`$FORGE_HOME` → `$REPO_PATH` → documented last-resort) was exhausted. Stop and report the failure (or fall through to the orchestrator's documented FATAL/hard-stop behavior — see `commands/review-pr.md` Phase 3C `TEMPLATE_BASE` guard) instead of improvising a `find /`-style search. A filesystem-wide `find` on an unset variable is the exact failure mode that produced runaway orphaned processes in production (see forge#1984, forge#2035).

---

## Evidence-Based Review Protocol (ALL Agents Follow) <!-- allowlist:check-protocol-restatements -->

Every agent MUST follow this protocol:

### 1. Start From the PR Diff

**Input scoping**: You have been given a pre-computed diff slice containing only the files relevant to your domain (`[DOMAIN_DIFF_SLICE]`). Do NOT re-fetch `gh pr diff [PR_NUMBER]` in full — use the slice provided. This is capped at ~100K chars, mirroring the runner's tool-result limit.

```bash
# Verify review is still current before reading diff
CURRENT_SHA=$(gh pr view [PR_NUMBER] --json headRefOid --jq '.headRefOid')
if [ "$CURRENT_SHA" != "[REVIEW_SHA]" ]; then
    echo "WARNING: PR HEAD changed during review. Review may be stale."
    echo "Review pinned to: [REVIEW_SHA_SHORT]"
    echo "Current HEAD: $(echo $CURRENT_SHA | cut -c1-7)"
fi

# List files in your domain slice
gh pr diff [PR_NUMBER] --name-only

# Use the pre-computed domain diff slice supplied by the orchestrator:
# [DOMAIN_DIFF_SLICE]
```

**Tool-result truncation**: When reading individual files or running commands for deeper investigation, always cap output: `cat file.py | head -200`, `grep ... | head -50`. Never pipe unbounded output into context.

**Hot-spot prior**:
[CHURN_CONTEXT]

If a file you are reviewing is listed above as a hot-spot, apply deeper scrutiny to it — high historical churn correlates with defect density. Prefer tracing that file's full code paths (Evidence-Based Review Protocol §2) over a quick pattern scan, and weight ambiguous findings in hot-spot files toward LIKELY rather than POSSIBLE.

### 2. Dynamic Exploration
- From each changed file, follow imports and function calls
- Trace data flows across service boundaries (API → Redis → Worker)
- Search for related code: `grep -rn "function_name" services/`

### 3. Validation Before Reporting

| Confidence | Criteria | Action |
|------------|----------|--------|
| **CONFIRMED** | Traced the full code path, found specific lines proving the bug | Report as blocking — P1 issue |
| **LIKELY** | Code pattern suggests issue but mitigations might exist elsewhere | Report with caveat — P2 issue |
| **POSSIBLE** | Suspicious pattern but couldn't trace the full flow | Report as informational — P3 advisory (non-blocking) |
| **UNFOUNDED** | Looked for the issue but found mitigations/correct handling | Do NOT report |

### 3.5 REPRODUCTION GATE — Required Before CONFIRMED Classification

**MANDATORY**: Before classifying any finding as CONFIRMED, you MUST document one of the following forms of reproduction evidence in your report. A pattern match alone is not sufficient.

**Acceptable reproduction evidence (one of)**:
- **(a) Full code path trace**: List the execution chain from PR-changed code to the failure point. Minimum: 3 steps with specific file + line for each. Example: `src/api/routers/billing.py:142 → credits.py:check_balance():87 → returns None → caller at billing.py:148 raises AttributeError`. The chain must terminate at the actual failure — not at "and then it could fail."
- **(b) Specific input demonstration**: Provide concrete input values that trigger the failure. Example: `POST /api/v1/scrape with {"url": "http://internal:6432/"}` → `requests.get()` hits internal DB port → SSRF confirmed. The values must be specific (not "if an attacker provides a malicious URL") and must map to actual code in the PR diff.

**Downgrade rule**: If you cannot produce either (a) or (b) after a reasonable trace attempt, you MUST classify the finding as **POSSIBLE** — not CONFIRMED or LIKELY. Do NOT use CONFIRMED when the finding is based on:
- A suspicious pattern without tracing whether the condition is reachable via changed code
- A theoretical exploit path not grounded in specific lines from the diff
- A heuristic ("this type of code often has X bug") without verification

**POSSIBLE findings are informational advisories** — they are logged and tracked but do NOT block merge and do NOT trigger mandatory fix PRs. When in doubt, POSSIBLE is the correct classification.

### 4. SEVERITY CLASSIFICATION — TRACE THE IMPACT

**CRITICAL RULE: Never dismiss a finding as "minor", "cosmetic", or "harmless" without tracing its downstream impact.** If you spot something unusual (redundant code, odd patterns, duplicated values), ask: "Does this cause a runtime error, data corruption, or wrong behavior in any code path that touches it?" Trace forward through every consumer of the construct.

**Severity decision tree:**
1. Will this error at runtime? → **HIGH or CRITICAL** (not "minor redundancy")
2. Will this produce wrong data silently? → **HIGH**
3. Will this cause degraded performance? → **MEDIUM**
4. Is it genuinely cosmetic with no runtime impact after tracing all consumers? → **LOW**

If you're unsure whether something is cosmetic or a runtime error, **assume it's a runtime error** and flag it for investigation. A false positive costs a minute of review time. A missed runtime error costs production downtime.

### 5. INTERACTION ANALYSIS — "Pre-existing" Is Not "Safe"

**CRITICAL RULE: Never dismiss a finding as "pre-existing, not introduced by this PR" without checking whether NEW code in the PR interacts with the pre-existing construct to create a bug.**

A redundant import, an unused variable, or a duplicated constant may be harmless in isolation. But new code added in the same scope can turn it into a crash. Example: a local `import os` inside a function is harmless until new code above it calls `os.getenv()` — Python treats `os` as local for the entire function scope, causing `UnboundLocalError` before the import line is reached.

**Before dismissing anything as "pre-existing":**
1. List every NEW line in the PR that references the pre-existing construct
2. For each reference, ask: "Does the pre-existing construct cause this new line to fail at runtime?"
3. If yes → CONFIRMED finding, not a dismissal

### 6. FALSE POSITIVE PREVENTION

**Before claiming variable scope issues:** Read the FULL function, count indentation levels, check if/else structure.

**Before claiming type/unit mismatches:** Trace the variable to its source. Check if naming is misleading (e.g., `balanceCents` might hold microcents).

**Before claiming missing functions/imports:** `grep -rn "functionName" .` — check re-exports, aliases.

**Before claiming unreachable code:** Check all callers, dynamic dispatch, test code.

**Before dismissing redundant imports as harmless:** In Python, a local `import X` inside a function makes `X` a local variable for the ENTIRE function scope. Any use of `X` before that import line will raise `UnboundLocalError`. Check whether any code (existing or new) references `X` before the local import. This is a CONFIRMED CRITICAL if found — it crashes at runtime.

### 7. Report Format

Every finding must include:
- **File:Line** — Exact location
- **Code snippet** — The problematic code
- **Evidence** — Why this is a bug (show the code path)
- **Confidence** — CONFIRMED/LIKELY/POSSIBLE
- **What you checked** — List files you read to verify

---

## Structured Findings Protocol

**All review agents MUST include a machine-readable findings block at the end of their PR comment.** This is NON-OPTIONAL. Without structured findings, the review system cannot create GitHub issues, and findings die as unread PR comments. Every finding that doesn't become a GitHub issue is a finding that will never be addressed.

### Format

Append this block at the very end of your comment (after the `---` footer line, still inside the EOF heredoc). It uses HTML comments so it's invisible in rendered markdown:

`<!-- REVIEW-FINDINGS-START -->`
`<!-- FINDING:PREFIX-N|CONFIDENCE|SEVERITY|file.py:line|One-line summary|DISPOSITION -->`
`<!-- REVIEW-FINDINGS-END -->`

`DISPOSITION` is optional and defaults to `FILE` when omitted (fully backward-compatible with the pre-forge#2683 5-field format). See "Admission Gate — NOTED Disposition" below for when to set it to `NOTED`.

### Rules

1. **Include ALL findings at CONFIRMED, LIKELY, and POSSIBLE confidence** — every finding is recorded in the structured block. Nothing stays as an unread, unstructured PR comment. Most findings become a GitHub issue; findings that fail the Admission Gate below are recorded as `NOTED` instead — visible and searchable in the structured block, but not filed. **POSSIBLE findings are informational advisories (P3/non-blocking)** — they are tracked but do not require a fix PR and do not block merge. CONFIRMED and LIKELY findings are blocking at P1/P2 respectively.
2. **One line per finding** — sequential numbering (PREFIX-1, PREFIX-2, ...)
3. **Confidence**: `CONFIRMED`, `LIKELY`, or `POSSIBLE`
4. **Severity**: `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`
5. **Location**: Exact `file:line` reference
6. **Summary**: Concise one-line description (no pipe `|` characters in summary)
7. **Disposition**: `FILE` (default, may be omitted) or `NOTED` — see Admission Gate below
8. **Empty block**: If no findings at all, include just the START/END markers
9. **HTML comments**: The block is invisible in rendered markdown but parseable by the review system

### Admission Gate — NOTED Disposition

Not every LOW-severity or POSSIBLE-confidence finding should become a GitHub issue. A finding is **self-refuting** when the agent's own Evidence text concedes the flagged condition cannot actually be reached — e.g. "not exploitable", "cannot occur", "no changes required unless a fault-injection seam is added". Filing these forces the pipeline to pay full investigate-and-close cost on a ticket the agent already proved is a no-op — this was independently identified as the pipeline's largest systemic waste source (2026-07-19 audit of #2657, #2660).

**Evaluate this gate per finding, BEFORE emitting its structured marker line:**

1. If the finding's Evidence contains a reachability-concession phrase (regex below) AND does NOT also include a concrete "**How to reach it**:" line naming a specific input/state/call site that reaches the flagged code → disposition is `NOTED`.
2. If Confidence is `POSSIBLE` OR Severity is `LOW`, filing requires an explicit "**How to reach it**:" line in the Evidence describing the concrete trigger. Without it → disposition is `NOTED`.
3. CONFIRMED and LIKELY findings at MEDIUM+ severity are unaffected — they always `FILE`. The gate targets exactly the identified waste (self-refuting LOW/POSSIBLE tickets), not the pipeline's core signal.
4. `NOTED` is not deletion. NOTED findings remain fully visible in the structured findings block and in the agent's PR comment — they are simply not turned into a GitHub issue. A later review pass that finds a real trigger can promote a NOTED finding to `FILE` (re-emit it with a concrete "How to reach it:" line).

**Reachability-concession phrase regex** (case-insensitive, applied to the finding's Evidence text): `not exploitable|not reachable|cannot occur|can.t occur|no changes required unless|not exploitable through|never happens|not currently reachable|no known trigger`

**Single source of truth**: This admission rule is defined ONLY in this file. `commands/review-pr.md` Phase 6 and `commands/review-pr-staging.md` Phase 7 read the `DISPOSITION` field emitted here and skip issue creation for `NOTED` findings — they do NOT restate the admission criteria. Persona files in the Agent Catalog below inherit this rule by reading this shared protocols file (see "Per-Agent Input Scoping" at the top of this document); they must not copy-paste the rule text.

### Domain Prefixes

| Agent | Prefix |
|-------|--------|
| General Security | `SEC` |
| Auth Conventions | `AUTH` |
| Billing Integrity | `BILL` |
| Concurrency | `CONC` |
| Scraper Logic | `SCRP` |
| Frontend Quality | `FE` |
| API Design | `API` |
| Database & Migration | `DB` |
| Infrastructure | `INFRA` |
### Example

`<!-- REVIEW-FINDINGS-START -->`
`<!-- FINDING:SEC-1|CONFIRMED|HIGH|src/api/routers/upload.py:45|SQL injection via unsanitized user input in query parameter -->`
`<!-- FINDING:SEC-2|LIKELY|MEDIUM|src/worker/jobs/process.py:312|Potential SSRF through user-controlled proxy URL -->`
`<!-- FINDING:SEC-3|POSSIBLE|LOW|shared/symlink.py:88|Symlink target could theoretically escape sandbox — NOTED, not exploitable through ForgeDock's own install path (its symlinks always use absolute targets)|NOTED -->`
`<!-- REVIEW-FINDINGS-END -->`

---

## Agent Catalog
