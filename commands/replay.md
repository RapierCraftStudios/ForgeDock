---
description: Read-only playback of a completed pipeline run — shows FORGE annotations phase by phase with timestamps
argument-hint: <issue-number>
---

# /replay — Pipeline Run Playback

**Input**: $ARGUMENTS (issue number)

Replay a completed pipeline run. Fetches all FORGE annotations posted during the pipeline and displays them chronologically — phase headings, timestamps, and key structured fields. Read-only: nothing is written, no labels changed.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.

---

## Config Preamble

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ -f "$CONFIG_FILE" ]; then
  GH_OWNER=$(yq '.project.owner' "$CONFIG_FILE")
  GH_REPO_NAME=$(yq '.project.repo' "$CONFIG_FILE")
  GH_REPO="${GH_OWNER}/${GH_REPO_NAME}"
  GH_FLAG="-R $GH_REPO"
else
  echo "ERROR: forge.yaml not found."
  echo "Run: npx forgedock init"
  exit 1
fi
```

---

## Step 1: Parse Input

```bash
NUMBER=$(echo "$ARGUMENTS" | grep -oP '^\s*#?\K\d+' | head -1)
if [ -z "$NUMBER" ]; then
  echo "Usage: /replay <issue-number>"
  echo "Example: /replay 42"
  exit 1
fi
echo "Replaying pipeline run for issue #${NUMBER}..."
```

---

## Step 2: Fetch Issue Metadata

```bash
ISSUE_JSON=$(gh issue view "$NUMBER" "$GH_FLAG" \
  --json number,title,state,labels,createdAt,closedAt 2>/dev/null)

if [ -z "$ISSUE_JSON" ] || echo "$ISSUE_JSON" | grep -q '"message"'; then
  echo "ERROR: Issue #${NUMBER} not found in ${GH_REPO}."
  exit 1
fi

ISSUE_TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
ISSUE_STATE=$(echo "$ISSUE_JSON" | jq -r '.state')
ISSUE_CREATED=$(echo "$ISSUE_JSON" | jq -r '.createdAt')
ISSUE_CLOSED=$(echo "$ISSUE_JSON" | jq -r '.closedAt // "open"')
WORKFLOW_LABELS=$(echo "$ISSUE_JSON" | jq -r '[.labels[].name | select(startswith("workflow:"))] | join(", ")')

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Pipeline Replay — #${NUMBER}: ${ISSUE_TITLE}"
echo "══════════════════════════════════════════════════════════════"
echo "  State   : ${ISSUE_STATE}"
echo "  Opened  : ${ISSUE_CREATED}"
[ "$ISSUE_CLOSED" != "open" ] && echo "  Closed  : ${ISSUE_CLOSED}"
[ -n "$WORKFLOW_LABELS" ] && echo "  Labels  : ${WORKFLOW_LABELS}"
echo "══════════════════════════════════════════════════════════════"
```

---

## Step 3: Fetch All Comments

```bash
# One API call — returns all comments in chronological order
ALL_COMMENTS=$(gh api "repos/${GH_REPO}/issues/${NUMBER}/comments" 2>/dev/null)

if [ -z "$ALL_COMMENTS" ] || [ "$ALL_COMMENTS" = "[]" ]; then
  echo ""
  echo "  No comments on this issue. No pipeline run to replay."
  exit 0
fi
```

---

## Step 4: Identify FORGE Annotations

```bash
# Filter to comments that contain a FORGE pipeline annotation
FORGE_COMMENTS=$(echo "$ALL_COMMENTS" | jq -c '[.[] | select(.body | test("<!-- FORGE:(INVESTIGATOR|CONTRACT|CONTEXT|ARCHITECT|BUILDER|DECOMPOSED|TRAJECTORY)"))]')
FORGE_COUNT=$(echo "$FORGE_COMMENTS" | jq 'length')

if [ "$FORGE_COUNT" -eq 0 ]; then
  echo ""
  echo "  No FORGE pipeline annotations found on issue #${NUMBER}."
  echo "  This issue was not processed by the /work-on pipeline,"
  echo "  or comments were posted before pipeline annotation was introduced."
  exit 0
fi

echo ""
echo "  Found ${FORGE_COUNT} pipeline annotation(s). Playing back..."
echo ""
```

---

## Step 5: Display Each Annotation

Phase mapping (inline): `INVESTIGATOR`→Phase 1, `CONTRACT`→Phase 3C, `CONTEXT`→Phase 3C.5, `ARCHITECT`→Phase 3C.6, `BUILDER`→Phase 3M, `DECOMPOSED`→Phase 2, `TRAJECTORY`→Phase 7.

For each FORGE comment in chronological order, print a formatted block. Use Python for robust multiline extraction from the comment body.

```bash
echo "$FORGE_COMMENTS" | jq -c '.[]' | while IFS= read -r COMMENT; do
  BODY=$(echo "$COMMENT" | jq -r '.body')
  CREATED=$(echo "$COMMENT" | jq -r '.created_at')
  AUTHOR=$(echo "$COMMENT" | jq -r '.user.login')

  # Identify annotation type
  ANNOTATION=$(echo "$BODY" | grep -oP '(?<=<!-- )FORGE:[A-Z:]+(?= -->| -->)' | head -1)

  # Map to phase label
  case "$ANNOTATION" in
    "FORGE:INVESTIGATOR") PHASE_LABEL="Phase 1 — Investigation" ;;
    "FORGE:CONTRACT")     PHASE_LABEL="Phase 3C — Builder Contract" ;;
    "FORGE:CONTEXT")      PHASE_LABEL="Phase 3C.5 — Context Gathering" ;;
    "FORGE:ARCHITECT")    PHASE_LABEL="Phase 3C.6 — Architecture Plan" ;;
    "FORGE:BUILDER")      PHASE_LABEL="Phase 3M — Implementation" ;;
    "FORGE:DECOMPOSED")   PHASE_LABEL="Phase 2 — Decomposition" ;;
    "FORGE:TRAJECTORY")   PHASE_LABEL="Phase 7 — Pipeline Trajectory" ;;
    *)                    PHASE_LABEL="$ANNOTATION" ;;
  esac

  # Format timestamp: 2025-01-15T14:32:00Z → 2025-01-15 14:32 UTC
  TIMESTAMP=$(echo "$CREATED" | sed 's/T/ /; s/:[0-9][0-9]Z/ UTC/')

  echo "┌─────────────────────────────────────────────────────────────"
  echo "│  ${PHASE_LABEL}"
  echo "│  ${TIMESTAMP}  ·  @${AUTHOR}"
  echo "├─────────────────────────────────────────────────────────────"

  # Extract key fields per annotation type
  python3 - <<PYEOF
import re, sys

body = """$BODY"""

def extract(pattern, default="—"):
    m = re.search(pattern, body, re.MULTILINE | re.DOTALL)
    return m.group(1).strip() if m else default

def count_lines(header):
    m = re.search(r'### ' + header + r'\n(.*?)(?=\n###|\Z)', body, re.DOTALL)
    if not m: return 0
    return len([l for l in m.group(1).strip().splitlines() if l.strip()])

annotation = "$ANNOTATION"

if annotation == "FORGE:INVESTIGATOR":
    verdict    = extract(r'\*\*Verdict\*\*:\s*(\S+)')
    confidence = extract(r'\*\*Confidence\*\*:\s*(\S+)')
    severity   = extract(r'\*\*Severity\*\*:\s*(\S+)')
    task_type  = extract(r'\*\*Task Type\*\*:\s*([^\n]+)')
    root_cause = extract(r'### Root Cause\n([^\n]+)')
    decompose  = extract(r'\*\*(YES|NO)\*\* —', '—')
    print(f"│  Verdict    : {verdict} ({confidence} confidence)")
    print(f"│  Severity   : {severity}  |  Task type: {task_type}")
    print(f"│  Root cause : {root_cause[:80]}")
    print(f"│  Decompose  : {decompose}")

elif annotation == "FORGE:CONTRACT":
    task_type  = extract(r'\*\*Task type\*\*:\s*([^\n]+)')
    approach   = extract(r'### Proposed Approach\n([^\n]+)')
    n_files    = len(re.findall(r'^\|[^|]+\|[^|]+\|[^|]+\|', body, re.MULTILINE)) - 2  # subtract header+sep
    n_criteria = len(re.findall(r'^- \[', body, re.MULTILINE))
    print(f"│  Task type  : {task_type}")
    print(f"│  Approach   : {approach[:80]}")
    print(f"│  Deliverables: {max(0,n_files)} file(s)  |  Criteria: {n_criteria}")

elif annotation == "FORGE:CONTEXT":
    pitfalls = extract(r'### Known Pitfalls[^\n]*\n([^\n]+)')
    print(f"│  Pitfalls   : {pitfalls[:80]}")
    print(f"│  (Context gathered — see full comment for details)")

elif annotation == "FORGE:ARCHITECT":
    n_paths = len(re.findall(r'^\| \d+', body, re.MULTILINE))
    order_m = re.search(r'### Implementation Order\n(.*?)(?=\n###|\Z)', body, re.DOTALL)
    n_steps = len([l for l in (order_m.group(1).strip().splitlines() if order_m else []) if re.match(r'^\d+\.', l.strip())])
    print(f"│  Paths      : {n_paths} affected path(s)")
    print(f"│  Order      : {n_steps} implementation step(s)")
    print(f"│  (Full plan in comment)")

elif annotation == "FORGE:BUILDER":
    branch   = extract(r'\*\*Branch\*\*:\s*`([^`]+)`')
    commits  = extract(r'\*\*Commits\*\*:\s*([^\n]+)')
    n_files  = extract(r'\*\*Files changed\*\*:\s*(\d+)')
    approach = extract(r'### Approach\n([^\n]+)')
    print(f"│  Branch     : {branch}")
    print(f"│  Commits    : {commits}")
    print(f"│  Files      : {n_files}")
    print(f"│  Approach   : {approach[:80]}")

elif annotation == "FORGE:DECOMPOSED":
    subs_m = re.search(r'### Sub-Issues Created\n(.*?)(?=\n###|\Z)', body, re.DOTALL)
    subs = [l.strip() for l in (subs_m.group(1).strip().splitlines() if subs_m else []) if l.strip().startswith('-')]
    print(f"│  Sub-issues : {len(subs)}")
    for s in subs[:5]:
        print(f"│    {s}")

elif annotation == "FORGE:TRAJECTORY":
    # Print the phase table lines verbatim (they're already formatted)
    in_table = False
    count = 0
    for line in body.splitlines():
        if '| Phase' in line or (in_table and line.startswith('|')):
            in_table = True
            print(f"│  {line}")
            count += 1
        elif in_table and not line.startswith('|'):
            break
    if count == 0:
        print("│  (Trajectory table not found in comment)")
    decisions = extract(r'\*\*Decisions\*\*:\s*([^\n]+)')
    anomalies = extract(r'\*\*Anomalies\*\*:\s*([^\n]+)')
    print(f"│  Decisions  : {decisions[:80]}")
    print(f"│  Anomalies  : {anomalies[:80]}")

else:
    # Unknown annotation — print first non-empty, non-marker line
    for line in body.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith('<!--') and not stripped.startswith('#'):
            print(f"│  {stripped[:100]}")
            break
PYEOF

  echo "└─────────────────────────────────────────────────────────────"
  echo ""
done
```

---

## Step 7: Summary Footer

```bash
echo "══════════════════════════════════════════════════════════════"
echo "  Replay complete — ${FORGE_COUNT} pipeline phase(s) shown"
echo "  Issue: https://github.com/${GH_REPO}/issues/${NUMBER}"
echo "══════════════════════════════════════════════════════════════"
```

---

**Constraints**: Read-only — never writes to GitHub, never posts comments, never edits labels. Partial pipeline runs are shown as-is (missing phases are absent, not errors).
