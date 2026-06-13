# ForgeDock Demo — Zero to PR Speedrun
# Generates: docs/demo.gif
#
# Requirements: https://github.com/charmbracelet/vhs
# Usage:        vhs docs/demo.tape
#
# Shows the full /work-on pipeline:
#   1. File a GitHub issue
#   2. Run /work-on — agent investigates, architects, builds, and opens a PR
#
# Target: under 30 seconds, under 5MB

Output docs/demo.gif

Set FontSize 14
Set Width 1200
Set Height 650
Set Theme "Dracula"
Set TypingSpeed 60ms
Set PlaybackSpeed 1.0

# ── Step 1: Set the scene ─────────────────────────────────────────────────────

Type "# Zero to PR — ForgeDock speedrun"
Sleep 800ms
Enter

Sleep 400ms

# Show the issue we're working on
Type "gh issue view 42 -R your-org/your-repo --json title,body | jq -r '.title'"
Sleep 400ms
Enter
Sleep 1s

# ── Step 2: Launch Claude Code and invoke /work-on ───────────────────────────

Type "claude"
Sleep 400ms
Enter
Sleep 2s

Type "/work-on 42"
Sleep 400ms
Enter
Sleep 1.5s

# ── Step 3: Investigation phase ──────────────────────────────────────────────
# Agent reads the issue, searches the codebase, traces root cause

Sleep 500ms
Type "# Agent: Reading issue #42 → tracing root cause..."
Enter
Sleep 1s

# Simulate the agent reading files (fast-forward)
Sleep 800ms
Type "# [Investigation] Confirmed: nil-check missing in payment_validator.py:87"
Enter
Sleep 1s

# ── Step 4: Context + Architect phase ────────────────────────────────────────
# Agent reads historical findings, builds implementation plan

Type "# [Context] Found 2 historical bugs in this module (issues #29, #34)"
Enter
Sleep 800ms

Type "# [Architect] Implementation order: validator → router → tests"
Enter
Sleep 1s

# ── Step 5: Build phase ───────────────────────────────────────────────────────
# Agent writes the code

Type "# [Build] Writing fix to payment_validator.py..."
Enter
Sleep 1s

Type "git diff --stat"
Sleep 400ms
Enter
Sleep 1.2s

Type "git log --oneline -3"
Sleep 400ms
Enter
Sleep 800ms

# ── Step 6: PR opened ────────────────────────────────────────────────────────

Type "# [Review] Opening PR → /review-pr #107 --auto-merge"
Enter
Sleep 1s

Type "gh pr view 107 --json title,state | jq -r '\"PR: \" + .title + \" (\" + .state + \")\"'"
Sleep 400ms
Enter
Sleep 1.2s

# ── Step 7: Done ─────────────────────────────────────────────────────────────

Type "# Done. Issue → Investigation → Build → PR in one command."
Enter
Sleep 1.5s

Type "gh issue view 42 --json labels --jq '[.labels[].name]'"
Sleep 400ms
Enter
Sleep 1.5s

# Final pause before loop
Sleep 1s
