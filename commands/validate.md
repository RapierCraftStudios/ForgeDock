---
description: Independently verify if a reported issue is actually a problem before making code changes.
argument-hint: [issue description or #number]
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /validate — Independent Issue Verification

**Input**: $ARGUMENTS

Verify whether a reported issue is real before anyone writes code. This command exists for reports that come from outside the pipeline — user complaints, DevOps alerts, monitoring triggers, gut feelings. It is the checkpoint before creating a GitHub issue.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.

**Output**: A verdict (CONFIRMED / NOT A PROBLEM / NEEDS MORE DATA) with evidence.

---

## Step 1: Parse the claim

Restate in one sentence: what exactly is being claimed?
What would prove it? What would disprove it?

---

## Step 2: Gather evidence (parallel)

Launch 2-3 agents based on what's relevant. Not every issue needs all of these.

**Agent A — Code Analysis** (always):
```
Search the codebase for all code related to [CLAIM].
- Find the exact file:line where the alleged issue would exist
- Read the full function/module, not just the line
- Trace the code path end-to-end
- Check: does the code actually do what the report claims?
- Check git log: was this area recently changed?
```

**Agent B — Production Evidence** (if production issue):
```
Use MCP tools to check production:
- get_production_logs(service="[service]", lines=200)
- get_production_status()
- run_production_health_check()
Look for: actual error messages, frequency, affected users, timestamps.
Quantify: how often, how many users, since when.
```

**Agent C — Reproduction** (if reproducible locally):
```
Try to reproduce the issue locally:
- Set up the scenario described in the report
- Execute the failing path
- Document: did it fail? How? What error?
If it doesn't reproduce: that's important data.
```

---

## Step 3: Synthesize

Cross-reference all findings:
1. Does the code actually have the reported problem?
2. Does production data confirm it's happening?
3. Could it be reproduced?
4. Are there contradictions?

---

## Step 4: Verdict

```
VALIDATION VERDICT: [CONFIRMED | NOT A PROBLEM | NEEDS MORE DATA]
Confidence: [High 90%+ | Medium 70-89% | Low <70%]

What was claimed: [one sentence]
What we found: [one sentence — may differ from claim]

Evidence:
- [source]: [finding]
- [source]: [finding]

Impact: [quantified — N users, X% of requests, $Y revenue]
Priority: [P0-P3 or NO ACTION]

If CONFIRMED — recommended next step:
  File: [path:line]
  Root cause: [one sentence]
  Fix approach: [one sentence]
  Create issue:
```bash
gh issue create --title "fix: [concise description of the confirmed bug]" \
  --label "[priority],[bug|enhancement]" \
  --body "$(cat <<'BODY_EOF'
## Problem

[1-3 sentences: what the validation confirmed is wrong. Specific and concrete.]

## Root Cause (if known)

[path:line] — [one sentence: why the bug occurs mechanically]

## Affected Files

Files that need changes:
1. `[filepath]` — [what needs to change]
2. `[filepath]` — [what needs to change]

## Acceptance Criteria

- [ ] [Specific, testable criterion]
- [ ] No regression in [related feature]

## Context

Validated by \`/validate\` on [DATE]. Confidence: [High|Medium|Low].

## Evidence

- [source]: [finding]
- [source]: [finding]
BODY_EOF
)"
```

If NOT A PROBLEM — why the report was wrong:
  [explanation]

If NEEDS MORE DATA — what's missing:
  [specific questions to answer]
```
