---
description: Audit agent outputs from an orchestration run — timeline analysis, stall detection, active vs idle time breakdown
argument-hint: "[session-id | latest | <agent-id>]"
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /audit-agents — Agent Output Auditor

> **Skill names**: `{FORGE_SKILL_PREFIX}` is `forgedock:` (plugin install) or empty (`install.sh`), resolved once per run by `commands/work-on.md` § Skill Name Resolution. If the skill is not found under either name, STOP and report "skill not found" — never run the phase inline.

**Input**: $ARGUMENTS

## Purpose

Parse agent JSONL output files from orchestration runs to produce actionable diagnostics:
- Per-agent phase timeline with durations
- Stall detection (gaps between phases caused by agent `end_turn` stops)
- Active vs idle time breakdown
- Resume cycle counting
- Wave-level efficiency metrics

---

## Config Preamble

Before executing any phase, read `forge.yaml` to resolve project references:

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ -f "$CONFIG_FILE" ]; then
  GH_OWNER=$(yq '.project.owner' "$CONFIG_FILE")
  GH_REPO_NAME=$(yq '.project.repo' "$CONFIG_FILE")
  GH_REPO="${GH_OWNER}/${GH_REPO_NAME}"
  # FORGE_REPO: the self-pipeline repo where orchestration metrics are tracked.
  # Set project.forge_repo in forge.yaml if your pipeline repo differs from GH_REPO.
  FORGE_REPO=$(yq '.project.forge_repo // ""' "$CONFIG_FILE")
  [ -z "$FORGE_REPO" ] && FORGE_REPO="$GH_REPO"
else
  echo "WARNING: forge.yaml not found — commands will use placeholder values"
  echo "Run: cp forge.yaml.example forge.yaml  and fill in your project details"
  GH_REPO="your-org/your-repo"
  FORGE_REPO="$GH_REPO"
fi
```

---

## Phase 1: Locate Agent Outputs

### Step 1A: Find the session

Agent outputs live in `~/.claude/projects/{munged-project-path}/subagents/agent-{agentId}.jsonl`.
The project path munging rule: both `/` and `.` are replaced with `-`
(e.g. `/home/user/projects/myproject` → `-home-user-projects-myproject`).

```python
import os, sys
from pathlib import Path

def _session_project_dir(project_path):
    """Convert a Claude Code project path to its ~/.claude/projects/ directory name.
    Rule: both '/' and '.' are replaced with '-'.
    Matches pipeline-health.md _session_project_dir() exactly.
    """
    import re
    return re.sub(r'[/.]', '-', project_path)

CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

# Discover all subagent JSONL files under ~/.claude/projects/
# Each subagent file: ~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl
subagent_files = []
if CLAUDE_PROJECTS_DIR.exists():
    for jsonl_path in sorted(CLAUDE_PROJECTS_DIR.rglob("subagents/agent-*.jsonl"),
                             key=lambda p: p.stat().st_mtime, reverse=True):
        # Only process files with actual content (> 10 lines / non-empty)
        try:
            size = jsonl_path.stat().st_size
            if size < 200:  # 200 bytes ≈ fewer than 10 minimal JSONL lines
                continue
            # Count lines portably without wc -l
            with open(jsonl_path, 'rb') as fh:
                line_count = sum(1 for _ in fh)
            if line_count > 10:
                subagent_files.append(jsonl_path)
        except OSError:
            continue

if not subagent_files:
    print("SKIPPED — transcripts unreadable on this platform")
    print("  ~/.claude/projects/ not found or contains no subagent JSONL files.")
    sys.exit(0)

print(f"Found {len(subagent_files)} subagent JSONL file(s) under {CLAUDE_PROJECTS_DIR}")
```

**Input resolution:**
- `latest` or no argument → most recent session with agent outputs
- A session UUID → that specific session
- An agent ID (starts with `a`, 17+ hex chars) → find the session containing that agent
- A project path fragment (e.g., `my-project`) → filter to sessions for that project

### Step 1B: Collect agent JSONL files

```python
import os
from pathlib import Path

# Filter subagent_files by $ARGUMENTS (session UUID, agent ID, project fragment, or "latest")
ARGUMENT = "$ARGUMENTS".strip()

if not ARGUMENT or ARGUMENT.lower() == "latest":
    # Use the most recent session — take the most recently modified subagent directory
    # Group by parent session dir (grandparent of the subagent file)
    by_session = {}
    for p in subagent_files:
        session_dir = p.parent.parent  # .../projects/{project}/{sessionId}/
        mtime = session_dir.stat().st_mtime if session_dir.exists() else 0
        if session_dir not in by_session or mtime > by_session[session_dir][0]:
            by_session[session_dir] = (mtime, [])
        by_session[session_dir][1].append(p)
    if by_session:
        latest_session_dir = max(by_session, key=lambda d: by_session[d][0])
        agent_files = by_session[latest_session_dir][1]
    else:
        agent_files = []
else:
    # Filter by session UUID, agent ID, or project path fragment
    agent_files = [
        p for p in subagent_files
        if ARGUMENT in str(p)
    ]

if not agent_files:
    print(f"SKIPPED — no matching agent JSONL files found for argument: {ARGUMENT!r}")
    import sys; sys.exit(0)

print(f"Processing {len(agent_files)} agent file(s)")
for p in agent_files:
    agent_id = p.stem.replace("agent-", "", 1)
    print(f"  {agent_id}  {p}")
```

Only process files with `> 10` lines (smaller files are helper/polling agents, not work-on agents).
Line count is computed in Python from the actual JSONL bytes — not from a symlink stub.

---

## Phase 2: Parse Each Agent

For each agent JSONL file, use a Python script to extract the timeline.

**IMPORTANT**: Run this as a SINGLE Python script, not per-agent bash loops. The JSONL files can be large (500+ lines, 100KB+).

```python
import json, sys, os
from datetime import datetime
from collections import defaultdict

def parse_agent(filepath, agent_id):
    """Parse a single agent JSONL file and return structured timeline data."""
    with open(filepath) as f:
        lines = f.readlines()

    # Extract all events with timestamps
    events = []
    skill_invocations = []  # unique (ts, skill) pairs
    skill_set = set()
    tool_counts = defaultdict(int)
    first_ts = last_ts = None
    end_turn_points = []
    event_timestamps = []
    operator_resume_cycles = 0
    pending_end_turn = False

    def is_terminal_skill(skill):
        return skill.lower() in {'close', 'work-on/close', 'work-on:close'}

    def is_terminal_text(text):
        text = text.lower()
        return any(marker in text for marker in (
            'verdict: invalid', 'status: invalid', 'state: invalid',
            'status: merged', 'state: merged', 'status: closed', 'state: closed',
        ))

    for line in lines:
        data = json.loads(line)
        ts_str = data.get('timestamp', '')
        if not ts_str:
            continue

        ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
        if first_ts is None:
            first_ts = ts
        last_ts = ts
        event_timestamps.append(ts)

        msg = data.get('message', {})
        stop_reason = msg.get('stop_reason', '')
        content = msg.get('content', [])

        # A user turn after an assistant end_turn is an operator-style resume,
        # even when the transcript is appended rather than replayed.
        if data.get('type') == 'user' and pending_end_turn:
            operator_resume_cycles += 1
            pending_end_turn = False

        if stop_reason == 'end_turn':
            # Find the text content of this end_turn message
            text = ''
            if isinstance(content, list):
                for c in content:
                    if c.get('type') == 'text':
                        text = c.get('text', '')[:100]
                        break
            terminal = is_terminal_text(text) or any(
                is_terminal_skill(si['skill']) for si in skill_invocations
            )
            end_turn_points.append({
                'ts': ts,
                'text': text,
                'terminal': terminal,
            })
            pending_end_turn = not terminal

        if isinstance(content, list):
            for c in content:
                if c.get('type') == 'tool_use':
                    tool_name = c.get('name', '?')
                    tool_counts[tool_name] += 1

                    if tool_name == 'Skill':
                        inp = c.get('input', {})
                        skill_name = inp.get('skill', '?')
                        key = (ts_str, skill_name)
                        if key not in skill_set:
                            skill_set.add(key)
                            skill_invocations.append({
                                'ts': ts,
                                'skill': skill_name,
                                'args': inp.get('args', '')[:60]
                            })
                        else:
                            # Duplicate = resume replay
                            pass

    # Count duplicate skill timestamps to detect resume replays
    all_skill_timestamps = []
    for line in lines:
        data = json.loads(line)
        msg = data.get('message', {})
        content = msg.get('content', [])
        if isinstance(content, list):
            for c in content:
                if c.get('type') == 'tool_use' and c.get('name') == 'Skill':
                    all_skill_timestamps.append(data.get('timestamp', ''))

    # Duplicated timestamps indicate resume replays
    ts_counts = defaultdict(int)
    for t in all_skill_timestamps:
        ts_counts[t] += 1
    max_replays = max(ts_counts.values()) if ts_counts else 1
    replay_resume_cycles = max_replays - 1  # first occurrence is original, rest are replays
    resume_cycles = replay_resume_cycles + operator_resume_cycles

    # Build phase timeline from unique skill invocations.
    # Stall detection: a gap is a TRUE STALL only when it is >120s AND contains zero
    # tool_use events (i.e. ends in end_turn with no tool calls in the window).
    # Gaps that contain any tool_use block (Bash, Edit, Read, Grep, …) are ACTIVE work —
    # the agent was building; only Skill() calls were sparse.
    #
    # To detect tool activity between consecutive Skill() calls we collect all
    # tool_use timestamps from the raw lines and check whether any fall in the gap.
    all_tool_use_ts = []
    for raw_line in lines:
        raw = json.loads(raw_line)
        raw_msg = raw.get('message', {})
        raw_content = raw_msg.get('content', [])
        raw_ts_str = raw.get('timestamp', '')
        if raw_ts_str and isinstance(raw_content, list):
            for c in raw_content:
                if c.get('type') == 'tool_use':
                    try:
                        all_tool_use_ts.append(
                            datetime.fromisoformat(raw_ts_str.replace('Z', '+00:00'))
                        )
                    except ValueError:
                        pass

    phases = []
    prev_ts = first_ts
    for si in skill_invocations:
        gap_sec = (si['ts'] - prev_ts).total_seconds()
        # Any tool_use event inside the gap window means the agent was active
        has_tool_use_in_gap = any(prev_ts < t <= si['ts'] for t in all_tool_use_ts)
        # An incomplete end_turn in this gap is accounted for separately below,
        # so the same wall-clock wait is never counted twice.
        has_incomplete_end_turn_in_gap = any(
            not p['terminal'] and prev_ts < p['ts'] <= si['ts']
            for p in end_turn_points
        )
        is_stall = (
            gap_sec > 120
            and not has_tool_use_in_gap
            and not has_incomplete_end_turn_in_gap
        )
        phases.append({
            'ts': si['ts'],
            'skill': si['skill'],
            'args': si['args'],
            'gap_from_prev_sec': gap_sec,
            'is_stall': is_stall,  # True only when >2 min AND zero tool calls in gap
        })
        prev_ts = si['ts']

    # An end_turn before a terminal phase is a stall even with no idle gap. Its
    # wait is measured until the next transcript event; a terminal transcript
    # has no following event, so give it the detector's 120-second floor.
    incomplete_end_turns = [p for p in end_turn_points if not p['terminal']]
    for point in incomplete_end_turns:
        next_ts = next((t for t in event_timestamps if t > point['ts']), None)
        point['stall_sec'] = (next_ts - point['ts']).total_seconds() if next_ts else 120
        point['is_stall'] = True

    observed_total_sec = (last_ts - first_ts).total_seconds() if first_ts and last_ts else 0
    unobserved_stall_sec = sum(
        p['stall_sec'] for p in incomplete_end_turns if p['ts'] == last_ts
    )
    total_sec = observed_total_sec + unobserved_stall_sec
    phase_stall_sec = sum(p['gap_from_prev_sec'] for p in phases if p['is_stall'])
    end_turn_stall_sec = sum(p['stall_sec'] for p in incomplete_end_turns)
    stall_sec = phase_stall_sec + end_turn_stall_sec
    active_sec = total_sec - stall_sec
    reached_terminal_state_unaided = (
        any(p['terminal'] for p in end_turn_points) and resume_cycles == 0
    )

    return {
        'agent_id': agent_id,
        'filepath': filepath,
        'jsonl_lines': len(lines),
        'first_ts': first_ts,
        'last_ts': last_ts,
        'total_sec': total_sec,
        'active_sec': active_sec,
        'stall_sec': stall_sec,
        'idle_pct': (stall_sec / total_sec * 100) if total_sec > 0 else 0,
        'tool_counts': dict(tool_counts),
        'phases': phases,
        'end_turn_points': end_turn_points,
        'resume_cycles': resume_cycles,
        'operator_resume_cycles': operator_resume_cycles,
        'reached_terminal_state_unaided': reached_terminal_state_unaided,
        'skill_count': len(skill_invocations),
    }
```

---

## Phase 3: Identify Issues

For each agent, try to determine which GitHub issue it was working on:

```bash
# Read the first user message in the JSONL — it contains the agent prompt with issue number
python3 -c "
import json
with open('$FILEPATH') as f:
    first = json.loads(f.readline())
msg = first.get('message', {}).get('content', '')
if isinstance(msg, list):
    for c in msg:
        if c.get('type') == 'text':
            msg = c['text']
            break
# Extract issue number
import re
m = re.search(r'#(\d+)', str(msg))
print(m.group(1) if m else 'unknown')
"
```

Also extract the issue title from the prompt.

---

## Phase 4: Generate Report

### Step 4A: Per-agent timeline

For each agent, display:

```
## Agent: #{ISSUE_NUMBER} — {ISSUE_TITLE}
**Duration**: {total_min} min (active: {active_min} min, idle: {stall_min} min — {idle_pct}% idle)
**Resume cycles**: {resume_cycles} (replay: {replay_resume_cycles}, injected user turn: {operator_resume_cycles})
**Terminal state**: {"reached unaided" if reached_terminal_state_unaided else "required intervention or did not reach terminal state"}
**JSONL lines**: {lines} | **Tool calls**: Bash:{N} Read:{N} Edit:{N} Skill:{N}

### Phase Timeline
| Time | Phase | Duration | Gap | Status |
|------|-------|----------|-----|--------|
| 12:09:11 | work-on | — | — | start |
| 12:09:24 | investigate | 1m 3s | 13s | ok |
| 12:17:46 | build | — | **7m 22s** | STALL |
| 12:18:28 | build:context | 42s | 42s | ok |
| 12:42:13 | build:architect | 25s | **23m 45s** | STALL |
| 12:42:38 | build:implement | 39s | 25s | ok |
| 12:43:17 | build:validate | 4s | 39s | ok |
| 12:43:21 | quality-gate | 1m 18s | 4s | ok |
| 12:44:39 | review | 44s | 1m 18s | ok |
| 12:45:23 | review-pr | 2m 13s | 44s | ok |
| 12:47:36 | close | 1m 16s | 2m 13s | ok |

### end_turn Stops (caused stalls)
| Time | Last message before stop |
|------|--------------------------|
| 12:10:27 | `INVESTIGATE_RESULT: verdict: CONFIRMED...` |
| 12:19:07 | `Context phase complete. Returning to B4.` |
```

### Step 4B: Wave summary

```
## Wave Summary

| Agent | Issue | Total | Active | Idle | Idle% | Resumes | Terminal unaided | Stall Points |
|-------|-------|-------|--------|------|-------|---------|------------------|--------------|
| afbc… | #14513 | 40m | 8m | 31m | 80% | 2 | no | investigate→build, context→architect |
| a3b5… | #14508 | 23m | 23m | 0m | 0% | 0 | yes | — |
| adf5… | #14514 | 55m | 12m | 43m | 78% | 3 | no | investigate→build, context→architect, implement→validate |

**Wave efficiency**: {avg_idle_pct}% idle time across all agents
**Longest stall**: {max_stall_min} min ({agent_id} between {phase_a} → {phase_b})
**Clean agents**: {N} of {total} ran without stalls or intervention
```

### Step 4C: Stall pattern analysis

Identify recurring stall patterns across agents:

```
## Stall Pattern Analysis

### Common stall boundaries
| Boundary | Agents affected | Avg gap |
|----------|----------------|---------|
| investigate → build | 4/5 | 7.5 min |
| context → architect | 4/5 | 23.8 min |
| implement → validate | 3/5 | 20.3 min |

### Root cause indicators
- **Synchronized stall times**: 4 agents stalled at 12:17, 12:42, 13:03
  → Orchestrator polling intervals, not agent-side issues
- **end_turn at phase boundaries**: Agent outputs result text then stops
  → LLM routing loop exits instead of continuing to next phase
- **Resume replays**: Each resume re-sends full conversation history
  → Context grows with each cycle, compounding the problem
```

### Step 4D: Recommendations

Based on the data, output specific recommendations:

- If idle% > 50% across wave → "Orchestrator polling too slow — agents spend more time waiting than working"
- If resume_cycles > 0 for most agents → "Routing loop in work-on.md not continuing past phase boundaries"
- If any agent did not reach a terminal state unaided → "Routing loop required operator intervention; inspect end_turn stops before declaring the wave clean"
- If specific boundary stalls repeatedly → "Phase {X} returns text with end_turn instead of continuing loop — check work-on.md routing instructions"
- If one agent ran clean but others didn't → "Compare clean agent (#XXXX) vs stalled agents — what differs?"

### Step 4E: Persist summary (triggered by `--persist` flag)

**Trigger**: Run this step ONLY when `$ARGUMENTS` contains `--persist`. Default mode (no flag) skips this step and only prints to the conversation.

This step posts a structured `<!-- FORGE:AUDIT-AGENTS -->` summary comment to the Forge orchestration-metrics tracking issue so that `/pipeline-health` can query historical efficiency data.

**Step 4E.1 — Locate or create the tracking issue**:

Creation (first-use only — the `gh issue list` existence check below still gates whether creation runs at all) is routed through the `/issue` create-hook's programmatic invocation contract (see `commands/issue.md` → Programmatic Invocation Contract):

```bash
# Ensure the label exists before using it (gh issue create fails with GraphQL error if label is absent).
# Color and description match the canonical ForgeDock label manifest (bin/labels.json).
# Run `npx forgedock labels setup` to bootstrap all managed labels at once.
gh label create "orchestration-metrics" -R {FORGE_REPO} \
  --color "5319E7" --description "Running log of persisted audit-agents efficiency summaries. Managed by ForgeDock." \
  --force 2>/dev/null || true

TRACKING_ISSUE=$(gh issue list -R {FORGE_REPO} \
  --state open --label "orchestration-metrics" --limit 1 \
  --json number --jq '.[0].number' 2>/dev/null)

if [ -z "$TRACKING_ISSUE" ]; then
  # Create the tracking issue on first use
  TRACKING_BODY_FILE=$(mktemp)
  cat > "$TRACKING_BODY_FILE" <<'EOF'
## Problem

No `orchestration-metrics` tracking issue exists yet — this is the first `/audit-agents --persist` run for this repo.

## Affected Files

N/A — this is a running log issue, not a code change.

## Acceptance Criteria

- [ ] This issue stays open indefinitely as a running log of persisted `/audit-agents` summaries

## Context

This issue is a running log of persisted `/audit-agents` summaries. Each comment contains one session's efficiency metrics. Do not close this issue — `/pipeline-health` Phase 2K queries it to aggregate orchestration efficiency trends.
EOF

  Skill(skill="{FORGE_SKILL_PREFIX}issue", args="--title \"Orchestration Metrics — Running Log\" --body-file \"$TRACKING_BODY_FILE\" --label \"orchestration-metrics\"")

  # /issue's programmatic mode does not print a structured return value — re-query
  # by label to recover the newly created issue number.
  TRACKING_ISSUE=$(gh issue list -R {FORGE_REPO} \
    --state open --label "orchestration-metrics" --limit 1 \
    --json number --jq '.[0].number' 2>/dev/null)
  echo "Created orchestration-metrics tracking issue #$TRACKING_ISSUE"
fi
```

**Step 4E.2 — Compute wave-level aggregate metrics** (from the data already parsed in Phase 2):

```bash
# From the per-agent data computed in Phase 2, derive wave-level aggregates
TOTAL_AGENTS=$(echo "${AGENT_DATA[@]}" | jq 'length')
AVG_IDLE=$(echo "${AGENT_DATA[@]}" | jq '[.[].idle_pct] | add / length | . * 10 | round / 10')
AVG_RESUMES=$(echo "${AGENT_DATA[@]}" | jq '[.[].resume_cycles] | add / length | . * 100 | round / 100')
CLEAN_N=$(echo "${AGENT_DATA[@]}" | jq '[.[] | select(.idle_pct == 0 and .resume_cycles == 0 and .reached_terminal_state_unaided)] | length')

# Top stall boundaries: aggregate gap_from_prev_sec > 120 entries by skill transition label
# Format: "investigate→build(4), context→architect(3), implement→validate(2)"
STALL_BOUNDARIES=$(echo "${AGENT_DATA[@]}" | jq -r '
  [.[].phases[] | select(.is_stall) | .skill] |
  group_by(.) | map({boundary: .[0], count: length}) |
  sort_by(-.count) | .[:5] |
  map("\(.boundary)(\(.count))") | join(", ")
')
```

**Step 4E.3 — Post the structured summary comment**:

```bash
SESSION_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

gh issue comment $TRACKING_ISSUE -R {FORGE_REPO} --body "<!-- FORGE:AUDIT-AGENTS -->
## Audit-Agents Summary — $SESSION_DATE

**Session**: \`$SESSION_ID\`
**Date**: $SESSION_DATE
**Agents**: $TOTAL_AGENTS
**Avg idle%**: $AVG_IDLE
**Avg resumes**: $AVG_RESUMES
**Clean agents**: $CLEAN_N/$TOTAL_AGENTS
**Stall boundaries**: $STALL_BOUNDARIES

_Posted by \`audit-agents --persist\`. Queried by \`/pipeline-health\` Phase 2K._

<!-- FORGE:AUDIT-AGENTS:COMPLETE -->"

echo "Persisted audit summary to tracking issue #$TRACKING_ISSUE"
```

---

## Phase 5: Comparison Mode (optional)

If `$ARGUMENTS` contains `--compare` or two session IDs, run the analysis on both sessions and produce a diff:

```
## Session Comparison

| Metric | Session A | Session B | Delta |
|--------|-----------|-----------|-------|
| Avg agent duration | 38m | 24m | -37% |
| Avg idle% | 62% | 15% | -47pp |
| Avg resume cycles | 2.5 | 0.3 | -88% |
| Clean agents | 1/5 | 4/5 | +60pp |
```

This enables tracking whether orchestrator/prompt changes actually improved throughput.

---

## Notes

- **File format**: Agent outputs are JSONL (one JSON object per line). Each line has `type` (user/assistant), `timestamp`, `message` (with `content` array and optional `stop_reason`).
- **Subagent files**: Located at `~/.claude/projects/{munged-project-path}/{sessionId}/subagents/agent-{agentId}.jsonl`. The munging rule: both `/` and `.` in the project path are replaced with `-` (e.g. `/home/user/projects/myapp` → `-home-user-projects-myapp`). There are no platform-specific temp paths or symlinks involved.
- **Size filtering**: Only analyze files > 10 lines. Small files are helper/polling agents spawned by the orchestrator for status checks.
- **Resume detection**: Replay-dispatched resumes produce duplicate `(timestamp, skill_name)` pairs. SendMessage-style resumes append a user turn after an assistant `end_turn`. Both signals contribute to `resume_cycles`.
