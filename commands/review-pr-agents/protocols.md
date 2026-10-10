---
user-invocable: false
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

## File-Backed GitHub Write Integrity

When staging a body for `gh issue create|edit` or `gh pr create|comment` with `--body-file`, use the session scratchpad (or a repo-relative scratch directory) rather than a generic path under shared `/tmp`; native Windows `gh` may not resolve Git Bash `/tmp` reliably. The filename must contain the issue or PR number and an agent-unique token, and `mktemp` must add a random suffix. Add exactly one caller-chosen marker to the body: `<!-- FORGE:BODY-INTEGRITY:<entity>_<role>_<agent-token> -->`.

Immediately after the write, re-read the issue, PR, or posted comment and assert that it contains that exact marker. Treat a missing marker as a hard error and stop. A unique filename reduces collision risk, but only the read-back detects another agent's plausible-looking content being posted in its place; do not rely on a visual review. The `/issue` programmatic contract performs this assertion for its `--body-file` callers.

## File Resolution Discipline

Pipeline agents MUST NOT use `find` (unbounded or filesystem-wide) to locate protocol files, persona templates, or verification scripts under any circumstances. If a `Read` or `bash` invocation of an expected pipeline file fails (e.g. because `$FORGE_HOME` is unset and the path degraded to a root-anchored form), that is never a reason to search the filesystem — it means the deterministic fallback chain the orchestrator already computed (`$FORGE_HOME` → `$REPO_PATH` → documented last-resort) was exhausted. Stop and report the failure (or fall through to the orchestrator's documented FATAL/hard-stop behavior — see `commands/review-pr.md` Phase 3C `TEMPLATE_BASE` guard) instead of improvising a `find /`-style search. A filesystem-wide `find` on an unset variable is the exact failure mode that produced runaway orphaned processes in production (see forge#1984, forge#2035). <!-- Added: forge#2035 -->

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

# Materialize the pre-computed domain diff slice supplied by the orchestrator.
# Persona greps below read "$SLICE_FILE" -- they never re-fetch the full diff.
SLICE_FILE=$(mktemp)
cat > "$SLICE_FILE" <<'FORGE_SLICE_EOF'
[DOMAIN_DIFF_SLICE]
FORGE_SLICE_EOF
```

**Empty or truncated slice**: if the slice is empty or ends mid-hunk, read the specific changed files with bounded reads (`sed -n 'X,Yp'`, `head -N`) — never fall back to fetching the full PR diff.

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

**POSSIBLE findings are informational advisories** — they are logged and tracked but do NOT block merge and do NOT trigger mandatory fix PRs. When in doubt, POSSIBLE is the correct classification. <!-- Added: forge#371 -->

### 4. SEVERITY CLASSIFICATION — TRACE THE IMPACT

**CRITICAL RULE: Never dismiss a finding as "minor", "cosmetic", or "harmless" without tracing its downstream impact.** If you spot something unusual (redundant code, odd patterns, duplicated values), ask: "Does this cause a runtime error, data corruption, or wrong behavior in any code path that touches it?" Trace forward through every consumer of the construct.

**Severity decision tree:**
1. Will this error at runtime? → **HIGH or CRITICAL** (not "minor redundancy")
2. Will this produce wrong data silently? → **HIGH**
3. Will this cause degraded performance? → **MEDIUM**
4. Is it genuinely cosmetic with no runtime impact after tracing all consumers? → **LOW**

**Precision first.** Report defects that are likely to be real in the code this PR changes and the code it reaches. If you cannot verify a runtime impact after tracing the path, report the finding at **POSSIBLE** confidence — do not inflate its severity or confidence to be safe. A false positive costs reviewer trust and triggers a cascade of follow-up issues and re-reviews; an unverified suspicion belongs at POSSIBLE, where it stays a non-blocking note, not at an inflated severity.

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

**All review agents MUST include a machine-readable findings block at the end of their PR comment.** This is NON-OPTIONAL. Without structured findings, the review system cannot classify, file, or track what you found. The orchestrator (`/review-pr` §6B.4/§6B.5) decides disposition: CONFIRMED/LIKELY findings that pass its gates become issues, while LOW severity and POSSIBLE confidence findings are non-blocking NOTEs that are not filed as standalone issues.

### Persist Before Post

GitHub is a delivery channel, not the sole record of a review. Before the first `gh pr comment` attempt, write the finalized complete review body, including its `<!-- FORGE:REVIEW-AGENT:{domain} -->` marker and structured findings block, to a uniquely named durable file such as `${TMPDIR:-/tmp}/forge-review-${PR_NUMBER}-${DOMAIN}-$$.md`. Use `gh pr comment --body-file "$REVIEW_BODY_PATH"`; do not construct a retry loop around a failed write.

Every agent MUST return its verdict, finding count, and one line per finding to the orchestrator even when posting succeeds. If the post fails, return the durable body path and the same finding summary, then stop. A 403 or other write failure is a failed delivery, not a clean review and not a reason to retry in the background.

### Format

Append this block at the very end of your comment (after the `---` footer line, still inside the EOF heredoc). It uses HTML comments so it's invisible in rendered markdown:

`<!-- REVIEW-FINDINGS-START -->`
`<!-- FINDING:PREFIX-N|CONFIDENCE|SEVERITY|file.py:line|One-line summary -->`
`<!-- REVIEW-FINDINGS-END -->`

### Rules

1. **Include every finding you can support at CONFIRMED, LIKELY, or POSSIBLE confidence in the block** — the orchestrator needs them all to classify. Inclusion does not mean a GitHub issue is filed: `/review-pr` §6B.4/§6B.5 decide filing. **POSSIBLE confidence and LOW severity findings are non-blocking NOTEs** — reported in the review, never filed as standalone issues, never block merge. CONFIRMED and LIKELY findings are blocking at P1/P2 respectively. Do not pad the block with unverified or speculative items; precision over recall.
2. **One line per finding** — sequential numbering (PREFIX-1, PREFIX-2, ...)
3. **Confidence**: `CONFIRMED`, `LIKELY`, or `POSSIBLE`
4. **Severity**: `CRITICAL`, `HIGH`, `MEDIUM`, or `LOW`
5. **Location**: Exact `file:line` reference
6. **Summary**: Concise one-line description (no pipe `|` characters in summary)
7. **Empty block**: If no findings at all, include just the START/END markers
8. **HTML comments**: The block is invisible in rendered markdown but parseable by the review system
9. **Agent marker**: Include exactly one `<!-- FORGE:REVIEW-AGENT:{domain} -->` marker in the persisted body, where `{domain}` is the marker domain the orchestrator passes you (the canonical value from the roster-to-marker table in `review-pr.md`, e.g. `infra` and `scraper`; never a lowercased display name such as `infrastructure` or `scraping`).
10. **Reviewed SHA**: Include exactly one line `Reviewed-SHA: [REVIEW_SHA]` (the full 40-hex head you were pinned to) in the persisted body, outside the marker. `/review-pr` scopes its completion wait and idempotent re-entry to this line, so a comment without the current head does not count as a completed review. Do NOT put the SHA inside the `<!-- FORGE:REVIEW-AGENT:{domain} -->` marker.
11. **Failure scenario and scope (provenance inputs)**: every finding's body section (the prose above the findings block) MUST carry a `**Failure scenario**` line — concrete inputs leading to a wrong output or behaviour — and a `**Scope**: changed` or `**Scope**: pre-existing` line (`changed` = the cited line is added or modified by this PR; `pre-existing` = it was already there). `/review-pr` §6B.4 reads these: a finding without a failure scenario is demoted to a note (unless CRITICAL/HIGH CONFIRMED), and a finding whose cited line is not in the PR diff is routed as pre-existing. Speculative hardening with no failure scenario is a note, not a finding. The one-line `<!-- FINDING:... -->` grammar above is unchanged. <!-- Added: forge#3452 -->

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
`<!-- REVIEW-FINDINGS-END -->`

---

## Agent Catalog
