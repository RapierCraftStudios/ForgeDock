---
description: Audit agent outputs from an orchestration run — timeline analysis, stall detection, active vs idle time breakdown
argument-hint: [session-id | latest | <agent-id>]
---

# /audit-agents — Agent Output Auditor

**Input**: $ARGUMENTS

## Purpose

Parse agent JSONL output files from orchestration runs to produce actionable diagnostics:
- Per-agent phase timeline with durations
- Stall detection (gaps between phases caused by agent `end_turn` stops)
- Active vs idle time breakdown
- Resume cycle counting
- Wave-level efficiency metrics

---

## Phase 1: Locate Agent Outputs

### Step 1A: Find the session

Agent outputs live in `/tmp/claude-1000/` as symlinks to JSONL files in `~/.claude/projects/*/subagents/`.

```bash
# List recent sessions
ls -lt /tmp/claude-1000/ 2>/dev/null | head -10

# For each session dir, list agent output files
for DIR in /tmp/claude-1000/*/; do
  TASKS_DIR="${DIR}*/tasks/"
  AGENT_COUNT=$(find $TASKS_DIR -name "a*.output" -type l 2>/dev/null | wc -l)
  if [ "$AGENT_COUNT" -gt 0 ]; then
    echo "$(stat -c %Y "$DIR" 2>/dev/null) $DIR ($AGENT_COUNT agents)"
  fi
done | sort -rn | head -5
```

**Input resolution:**
- `latest` or no argument → most recent session with agent outputs
- A session UUID → that specific session
- An agent ID (starts with `a`, 17+ hex chars) → find the session containing that agent
- A project path fragment (e.g., `ScraperAPI`) → filter to sessions for that project

### Step 1B: Collect agent JSONL files

```bash
SESSION_DIR="/tmp/claude-1000/{PROJECT_PATH}/{SESSION_ID}"
TASKS_DIR="${SESSION_DIR}/tasks"

# Agent files are symlinks starting with 'a' pointing to .jsonl files
for LINK in ${TASKS_DIR}/a*.output; do
  AGENT_ID=$(basename "$LINK" .output)
  TARGET=$(readlink -f "$LINK")
  LINES=$(wc -l < "$TARGET" 2>/dev/null || echo 0)
  echo "$AGENT_ID $LINES $TARGET"
done
```

Only process files with `> 10` lines (smaller files are helper/polling agents, not work-on agents).

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
    resume_count = 0
    first_ts = last_ts = None
    end_turn_points = []

    for line in lines:
        data = json.loads(line)
        ts_str = data.get('timestamp', '')
        if not ts_str:
            continue

        ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
        if first_ts is None:
            first_ts = ts
        last_ts = ts

        msg = data.get('message', {})
        stop_reason = msg.get('stop_reason', '')
        content = msg.get('content', [])

        if stop_reason == 'end_turn':
            # Find the text content of this end_turn message
            text = ''
            if isinstance(content, list):
                for c in content:
                    if c.get('type') == 'text':
                        text = c.get('text', '')[:100]
                        break
            end_turn_points.append({'ts': ts, 'text': text})

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

        # Detect resume points: user messages that contain resume instructions
        if data.get('type') == 'user':
            if isinstance(content, str) and any(kw in content.lower() for kw in ['continue', 'resume', 'you need to']):
                resume_count += 1
            elif isinstance(content, list):
                for c in content:
                    if c.get('type') == 'text':
                        t = c.get('text', '').lower()
                        if any(kw in t for kw in ['continue the', 'resume', 'you need to continue']):
                            resume_count += 1

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
    resume_cycles = max_replays - 1  # first occurrence is original, rest are replays

    # Build phase timeline from unique skill invocations
    phases = []
    prev_ts = first_ts
    for si in skill_invocations:
        gap_sec = (si['ts'] - prev_ts).total_seconds()
        phases.append({
            'ts': si['ts'],
            'skill': si['skill'],
            'args': si['args'],
            'gap_from_prev_sec': gap_sec,
            'is_stall': gap_sec > 120  # > 2 min = stall
        })
        prev_ts = si['ts']

    total_sec = (last_ts - first_ts).total_seconds() if first_ts and last_ts else 0
    stall_sec = sum(p['gap_from_prev_sec'] for p in phases if p['is_stall'])
    active_sec = total_sec - stall_sec

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
**Resume cycles**: {resume_cycles} (agent stopped and was resumed {resume_cycles} times)
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

| Agent | Issue | Total | Active | Idle | Idle% | Resumes | Stall Points |
|-------|-------|-------|--------|------|-------|---------|--------------|
| afbc… | #14513 | 40m | 8m | 31m | 80% | 2 | investigate→build, context→architect |
| a3b5… | #14508 | 23m | 23m | 0m | 0% | 0 | — |
| adf5… | #14514 | 55m | 12m | 43m | 78% | 3 | investigate→build, context→architect, implement→validate |

**Wave efficiency**: {avg_idle_pct}% idle time across all agents
**Longest stall**: {max_stall_min} min ({agent_id} between {phase_a} → {phase_b})
**Clean agents**: {N} of {total} ran without stalls
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
- If specific boundary stalls repeatedly → "Phase {X} returns text with end_turn instead of continuing loop — check work-on.md routing instructions"
- If one agent ran clean but others didn't → "Compare clean agent (#XXXX) vs stalled agents — what differs?"

### Step 4E: Persist summary (triggered by `--persist` flag)

**Trigger**: Run this step ONLY when `$ARGUMENTS` contains `--persist`. Default mode (no flag) skips this step and only prints to the conversation.

This step posts a structured `<!-- FORGE:AUDIT-AGENTS -->` summary comment to the Forge orchestration-metrics tracking issue so that `/pipeline-health` can query historical efficiency data.

**Step 4E.1 — Locate or create the tracking issue**:

```bash
# Ensure the label exists before using it (gh issue create fails with GraphQL error if label is absent)
gh label create "orchestration-metrics" -R RapierCraftStudios/forge \
  --color "5319E7" --description "Running log of persisted audit-agents efficiency summaries" \
  --force 2>/dev/null || true

TRACKING_ISSUE=$(gh issue list -R RapierCraftStudios/forge \
  --state open --label "orchestration-metrics" --limit 1 \
  --json number --jq '.[0].number' 2>/dev/null)

if [ -z "$TRACKING_ISSUE" ]; then
  # Create the tracking issue on first use
  TRACKING_ISSUE=$(gh issue create -R RapierCraftStudios/forge \
    --title "Orchestration Metrics — Running Log" \
    --label "orchestration-metrics" \
    --body "This issue is a running log of persisted \`/audit-agents\` summaries. Each comment contains one session's efficiency metrics. Do not close this issue — \`/pipeline-health\` Phase 2K queries it to aggregate orchestration efficiency trends." \
    --json number --jq '.number')
  echo "Created orchestration-metrics tracking issue #$TRACKING_ISSUE"
fi
```

**Step 4E.2 — Compute wave-level aggregate metrics** (from the data already parsed in Phase 2):

```bash
# From the per-agent data computed in Phase 2, derive wave-level aggregates
TOTAL_AGENTS=$(echo "${AGENT_DATA[@]}" | jq 'length')
AVG_IDLE=$(echo "${AGENT_DATA[@]}" | jq '[.[].idle_pct] | add / length | . * 10 | round / 10')
AVG_RESUMES=$(echo "${AGENT_DATA[@]}" | jq '[.[].resume_cycles] | add / length | . * 100 | round / 100')
CLEAN_N=$(echo "${AGENT_DATA[@]}" | jq '[.[] | select(.idle_pct == 0 and .resume_cycles == 0)] | length')

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

gh issue comment $TRACKING_ISSUE -R RapierCraftStudios/forge --body "<!-- FORGE:AUDIT-AGENTS -->
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
- **Symlinks**: Files in `/tmp/claude-1000/*/tasks/a*.output` are symlinks to `~/.claude/projects/*/subagents/agent-*.jsonl`.
- **Size filtering**: Only analyze files > 10 lines. Small files are helper/polling agents spawned by the orchestrator for status checks.
- **Resume detection**: When an agent is resumed, the full conversation is replayed. Duplicate `(timestamp, skill_name)` pairs indicate replay cycles. `max(duplicates) - 1 = resume_cycles`.
