---
description: Independently verify if a reported issue is actually a problem before making code changes.
argument-hint: "[issue description or #number]"
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /validate — Independent Issue Verification

**Input**: $ARGUMENTS

Verify whether a reported issue is real before anyone writes code. This command exists for reports that come from outside the pipeline — user complaints, DevOps alerts, monitoring triggers, gut feelings. It is the checkpoint before creating a GitHub issue.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.

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
Route through the `/issue` create-hook's programmatic invocation contract (see `commands/issue.md` § "Programmatic Invocation Contract") instead of calling the raw issue-creation command directly — this gets dedup (Phase 2D) and body validation (Phase 3F) for free:

```bash
VALIDATE_ISSUE_TITLE="fix: [concise description of the confirmed bug]"
VALIDATE_ISSUE_BODY_FILE=$(mktemp)
cat <<'BODY_EOF' > "$VALIDATE_ISSUE_BODY_FILE"
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

# [priority] and [bug|enhancement] are two separate labels — passed as repeated --label flags,
# never comma-joined (the /issue programmatic contract's --label is repeatable, not CSV).
Skill(skill="issue", args="--title \"$VALIDATE_ISSUE_TITLE\" --body-file \"$VALIDATE_ISSUE_BODY_FILE\" --label \"[priority]\" --label \"[bug|enhancement]\"")
rm -f "$VALIDATE_ISSUE_BODY_FILE"
```

If NOT A PROBLEM — why the report was wrong:
  [explanation]

If NEEDS MORE DATA — what's missing:
  [specific questions to answer]
```

---

## Step 5: Finding Lifecycle Label Transition (MANDATORY when input is an issue number)

**Skip if**: Input was not an issue number (e.g., `/validate` was invoked with a plain description, not `#NNN`).

**Purpose**: If the validated issue is a review-finding with `needs-validation`, wire the verdict back into the finding lifecycle. This prevents `needs-validation` from becoming a permanent no-op label. <!-- Added: forge#1730 -->

```bash
# Parse issue number from input — skip if not an issue reference
INPUT_ISSUE=$(echo "$ARGUMENTS" | grep -oE '#?([0-9]+)' | grep -oE '[0-9]+' | head -1)
GH_FLAG=$(yq -r '"-R " + .project.owner + "/" + .project.repo' forge.yaml 2>/dev/null || echo "")

if [ -n "$INPUT_ISSUE" ] && [ -n "$GH_FLAG" ]; then
  # forge#1997: a bare `2>/dev/null || echo ""` here collapsed "fetch
  # failed" and "fetch succeeded, issue has no labels" into the same empty
  # string, so a failed fetch fell through to the "no needs-validation —
  # no label transition needed" branch below, silently misreporting a
  # transient API failure as a legitimate no-op. Use the same
  # `if VAR=$(cmd); then ... else ... fi` idiom already applied to
  # scripts/transition-label.sh (forge#1991) to keep the two outcomes
  # distinguishable.
  if ! ISSUE_LABELS=$(gh issue view "$INPUT_ISSUE" "$GH_FLAG" --json labels \
    --jq '[.labels[].name] | join(",")' 2>/dev/null); then
    echo "WARNING: needs-validation label fetch failed (transient network error / rate limit?) for issue #$INPUT_ISSUE — cannot determine finding-lifecycle state. Skipping label transition." >&2
  elif echo "$ISSUE_LABELS" | grep -q "needs-validation"; then
    echo "Issue #$INPUT_ISSUE has needs-validation — applying verdict label transition..."

    # Map /validate verdict to transition-label.sh verdict format
    # CONFIRMED → validated; NOT A PROBLEM / NEEDS MORE DATA → false-positive
    case "$VALIDATION_VERDICT" in
      CONFIRMED)         FORGE_VERDICT="CONFIRMED" ;;
      "NOT A PROBLEM")   FORGE_VERDICT="NOT-CONFIRMED" ;;
      "NEEDS MORE DATA") FORGE_VERDICT="NOT-CONFIRMED" ;;
      *)                 FORGE_VERDICT="NOT-CONFIRMED" ;;
    esac

    # Resolve and call transition-label.sh --validate
    REPO_PATH=$(yq -r '.paths.root' forge.yaml 2>/dev/null || echo ".")
    SCRIPT="$REPO_PATH/scripts/transition-label.sh"
    if [ -f "$SCRIPT" ]; then
      bash "$SCRIPT" --validate "$FORGE_VERDICT" "$INPUT_ISSUE" "$GH_FLAG" || true
    else
      # Prose fallback: apply directly via gh
      if [ "$FORGE_VERDICT" = "CONFIRMED" ]; then
        gh issue edit "$INPUT_ISSUE" "$GH_FLAG" --add-label "validated" --remove-label "needs-validation" 2>/dev/null || true
        echo "Applied: needs-validation → validated"
      else
        gh issue edit "$INPUT_ISSUE" "$GH_FLAG" --add-label "false-positive" --remove-label "needs-validation" 2>/dev/null || true
        echo "Applied: needs-validation → false-positive"
      fi
    fi
  else
    echo "Issue #$INPUT_ISSUE does not have needs-validation — no label transition needed"
  fi
fi
```

**Note**: `$VALIDATION_VERDICT` is the verdict string from Step 4's output block. Extract it before this step runs. If extraction fails, default to `NOT-CONFIRMED` (conservative — do not auto-label as confirmed).
