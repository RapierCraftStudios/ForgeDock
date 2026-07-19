---
description: Pre-implementation context gathering — surfaces historical findings, bug patterns, and related code paths before the builder writes any code
argument-hint: "[issue number] [affected_files...] [--functions function_names...]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/build/context — Pre-Implementation Context Gathering

**Invoked by**: `work-on.md` Step 3C.5, between Builder Contract and Implement.
**Time budget**: Max 2 minutes of queries. Skip any query that times out.
**Output**: Post `<!-- FORGE:CONTEXT -->` comment on the issue, then return structured briefing to caller.

<!-- FORGE:SPEC_LOADED — work-on/build/context.md loaded and active. Agent is bound by this spec. -->

---

## COMPLEXITY_BAND Guard (check BEFORE all phases)

Read COMPLEXITY_BAND from the `<!-- FORGE:FAST_PATH -->` comment on the issue:

```bash
COMPLEXITY_BAND=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:FAST_PATH")) | .body' 2>/dev/null \
  | sed -n 's/.*\*\*COMPLEXITY_BAND\*\*: \([A-Z_]*\).*/\1/p' | head -1)
COMPLEXITY_BAND="${COMPLEXITY_BAND:-STANDARD}"
```

**If COMPLEXITY_BAND: TRIVIAL** → skip all phases (C-1 through C4), post NO comment, return empty briefing to caller immediately. Do not query GitHub, do not read files. This is not an error — trivial single-file changes have no institutional memory to surface.

**If COMPLEXITY_BAND: STANDARD or COMPLEX** → proceed to Phase C-1 below.

---

## Mission

Surface what went wrong in this area before the builder writes a single line of code. The builder starts with the investigator report and contract — this step adds institutional memory: what did review agents catch last time someone touched these files, what bugs recurred, what other paths must stay consistent. When prior investigation Gists are linked in the issue body, fetch and summarize them so the builder has cross-issue context without manual lookups. When a milestone-level index Gist exists, use it to discover all investigation Gists for the milestone — providing full cross-issue context from a single URL.

**Principle**: A builder with context produces fewer review findings. Fewer findings = fewer fix cycles = lower token cost.

---

## Inputs

Parse from `$ARGUMENTS`:
- `{NUMBER}` — issue number (positional, required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}` — resolved from `forge.yaml → project`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)
- `--repo-path {REPO_PATH}` — local filesystem path to the worktree (e.g. `/path/to/.claude/worktrees/fix/issue-121`); used by Phase C3 grep commands
- `{AFFECTED_FILES}` — space-separated file paths (positional, after `{NUMBER}`, before any `--functions` flag)
- `--functions {FUNCTION_NAMES}` — space-separated function/class names extracted from the Builder Contract deliverables table (optional)

**Graceful skip for empty FUNCTION_NAMES**: If `--functions` is absent or `{FUNCTION_NAMES}` is empty, Phase C3 produces zero for-loop iterations and is effectively skipped — no error, no output for that phase. This is expected behavior when the contract does not name specific functions.

---

## Phase C-1: Authoritative Devdocs

Read project-resident authoritative docs **before** any institutional-memory queries. Devdocs contain binding project knowledge (conventions, architecture, custom instructions) that must inform the builder's mental model from the start.

**Time budget**: 30 seconds. If exceeded, log a skip note and continue to Phase C0.

**Skip if**: `{REPO_PATH}` is not set, devdocs path does not exist, or path contains no markdown files.

### Step 0: Resolve devdocs path

Read `forge.yaml → devdocs.path` from the project root. Default to `devdocs` if the key is absent or unreadable.

```bash
DEVDOCS_PATH=""

# Read forge.yaml directly from repo root (REPO_PATH points to the project root — no directory walk)
FORGE_YAML_PATH="{REPO_PATH}/forge.yaml"

if [ -f "$FORGE_YAML_PATH" ]; then
  # Extract devdocs.path key (simple grep — value is on the same or next line under "devdocs:")
  DEVDOCS_REL=$(grep -A5 '^devdocs:' "$FORGE_YAML_PATH" \
    | grep '^\s*path:' \
    | head -1 \
    | sed 's/.*path:\s*//' \
    | tr -d '"'"'"' \
    | tr -d '[:space:]')
fi

# Default to "devdocs" if not found
DEVDOCS_REL="${DEVDOCS_REL:-devdocs}"
DEVDOCS_PATH="{REPO_PATH}/${DEVDOCS_REL}"

if [ ! -d "$DEVDOCS_PATH" ]; then
  echo "Devdocs path '${DEVDOCS_PATH}' does not exist — skipping Phase C-1 (no blocking)"
  DEVDOCS_PATH=""
fi
```

> **Note**: `devdocs/` must be tracked in git for the worktree to contain it. If the project gitignores `devdocs/`, the path will not exist in the worktree and this phase silently skips — this is by design. Run `git check-ignore -v devdocs/` to confirm tracking status.

### Step 1: Enumerate and filter applicable files

**Index-first path** (preferred when `index.yaml` exists): Read the lightweight index, extract issue labels to filter by domain, load only matching docs. Falls back to O(N) enumerate when index is absent.

```bash
DEVDOCS_APPLICABLE=""  # list of paths that apply
INDEX_PATH="${DEVDOCS_PATH}/index.yaml"

# --- Read devdocs.index_path override from forge.yaml (optional) ---
if [ -f "$FORGE_YAML_PATH" ]; then
  INDEX_PATH_OVERRIDE=$(grep -A5 '^devdocs:' "$FORGE_YAML_PATH" \
    | grep '^\s*index_path:' \
    | head -1 \
    | sed 's/.*index_path:\s*//' \
    | tr -d '"'"'"' \
    | tr -d '[:space:]')
  if [ -n "$INDEX_PATH_OVERRIDE" ]; then
    # Resolve relative to REPO_PATH if not absolute
    case "$INDEX_PATH_OVERRIDE" in
      /*) INDEX_PATH="$INDEX_PATH_OVERRIDE" ;;
      *)  INDEX_PATH="{REPO_PATH}/${INDEX_PATH_OVERRIDE}" ;;
    esac
  fi
fi

if [ -n "$DEVDOCS_PATH" ] && [ -f "$INDEX_PATH" ]; then
  # --- Index-first loading path ---
  echo "Devdocs index found at ${INDEX_PATH} — using selective domain loading"

  # Read issue labels to determine domain(s)
  ISSUE_LABELS=$(gh issue view {NUMBER} -R {GH_REPO} --json labels \
    --jq '[.labels[].name] | join(" ")' 2>/dev/null || echo "")
  echo "Issue labels: ${ISSUE_LABELS:-none}"
  # Separate newline-joined list for the loop below — GitHub label names CAN
  # contain spaces (e.g. "good first issue"), so the space-joined $ISSUE_LABELS
  # above is only safe for display, never for iteration.
  ISSUE_LABELS_LIST=$(gh issue view {NUMBER} -R {GH_REPO} --json labels \
    --jq '.labels[].name' 2>/dev/null || echo "")

  # Read index content
  INDEX_CONTENT=$(cat "$INDEX_PATH" 2>/dev/null || echo "")

  # Extract always_load paths (lines with "path:" under "always_load:" block)
  ALWAYS_LOAD_PATHS=$(echo "$INDEX_CONTENT" \
    | awk '/^always_load:/,/^[a-z]/' \
    | grep '^\s*-\s*path:' \
    | sed 's/.*path:\s*//' \
    | tr -d '"'"'"' \
    | tr -d '[:space:]')

  # Extract domain blocks matching any issue label keyword
  DOMAIN_PATHS=""
  # $ISSUE_LABELS_LIST is one label per line — herestring (not a piped
  # `| while read`, which would run the loop body in a subshell and discard
  # DOMAIN_PATHS once the loop exits) preserves newline-safety for labels
  # containing spaces.
  while IFS= read -r label; do
    [ -z "$label" ] && continue
    # Strip workflow:, priority:, review-finding prefixes — use bare keyword
    KEYWORD=$(echo "$label" | sed 's/^workflow://; s/^priority://; s/^review-finding$//')
    [ -z "$KEYWORD" ] && continue
    # Sanitize KEYWORD before AWK injection — strip chars that would break awk regex delimiters
    SAFE_KEYWORD=$(printf '%s' "$KEYWORD" | tr -cd 'a-zA-Z0-9_-')
    [ -z "$SAFE_KEYWORD" ] && continue

    # Find the domain block matching this keyword, extract its doc paths
    BLOCK_PATHS=$(echo "$INDEX_CONTENT" \
      | awk "/^  ${SAFE_KEYWORD}:/{found=1; next} found && /^  [a-z]/{found=0} found && /^\s*-\s*path:/{print}" \
      | sed 's/.*path:\s*//' \
      | tr -d '"'"'"' \
      | tr -d '[:space:]')

    if [ -n "$BLOCK_PATHS" ]; then
      echo "Domain '${SAFE_KEYWORD}' matched — adding docs: $(echo "$BLOCK_PATHS" | tr '\n' ' ')"
      DOMAIN_PATHS="${DOMAIN_PATHS}${BLOCK_PATHS}"$'\n'
    fi
  done <<< "$ISSUE_LABELS_LIST"

  # Combine always_load + domain paths (deduplicate)
  ALL_PATHS=$(printf "%s\n%s" "$ALWAYS_LOAD_PATHS" "$DOMAIN_PATHS" \
    | grep -v '^$' | sort -u)

  # When no domain labels matched, load only authority:required files from always_load
  if [ -z "$DOMAIN_PATHS" ]; then
    echo "No domain labels matched index — loading always_load entries only"
    ALL_PATHS="$ALWAYS_LOAD_PATHS"
  fi

  # Build DEVDOCS_APPLICABLE list with sort keys
  while IFS= read -r rel_path; do
    [ -z "$rel_path" ] && continue
    ABS_PATH="${DEVDOCS_PATH}/${rel_path}"
    [ -f "$ABS_PATH" ] || { echo "WARN: index references missing file: ${rel_path} — skipping"; continue; }

    # Extract authority from frontmatter for sort key
    FRONTMATTER=$(awk '/^---/{c++; if(c==1){next} if(c==2){exit}} c==1{print}' "$ABS_PATH" 2>/dev/null)
    AUTHORITY=$(echo "$FRONTMATTER" | grep 'authority:' | head -1 | sed 's/.*authority:\s*//' | tr -d ' ')
    case "$AUTHORITY" in
      required)    SORT_KEY="1" ;;
      recommended) SORT_KEY="2" ;;
      reference)   SORT_KEY="3" ;;
      *)           SORT_KEY="4" ;;
    esac
    DEVDOCS_APPLICABLE="${DEVDOCS_APPLICABLE}${SORT_KEY}|${ABS_PATH}"$'\n'
  done <<< "$ALL_PATHS"

  DEVDOCS_APPLICABLE=$(printf "%s" "$DEVDOCS_APPLICABLE" | sort | cut -d'|' -f2-)

  # --- Module dossier glob pass (index-first path only) ---
  # When AFFECTED_FILES are known (passed via --repo-path or from the contract),
  # match each file against every modules[].glob in index.yaml. Inject matched
  # dossier files into DEVDOCS_APPLICABLE as authority:required entries.
  #
  # Skip if: AFFECTED_FILES is empty, modules section absent, or DEVDOCS_PATH unset.
  #
  # Glob matching uses bash `case` (fnmatch semantics): supports * ? and [class].
  # Operators must use patterns that match the BASENAME of the affected file
  # (e.g. "runner*" matches "bin/runner.mjs" via basename extraction below)
  # OR a relative-path prefix pattern (e.g. "bin/runner*").
  # Both forms are tried; first match wins for each module entry.
  if [ -n "${AFFECTED_FILES:-}" ] && [ -n "$DEVDOCS_PATH" ] && [ -f "$INDEX_PATH" ]; then
    # Extract modules[] entries from index.yaml
    # Format per entry: "name|glob|path"
    MODULE_ENTRIES=$(yq '.modules[]? | .name + "|" + .glob + "|" + .path' "$INDEX_PATH" 2>/dev/null || echo "")

    if [ -n "$MODULE_ENTRIES" ]; then
      IFS=' ' read -ra AFFECTED_FILES_GLOB_ARR <<< "${AFFECTED_FILES}"
      while IFS='|' read -r MOD_NAME MOD_GLOB MOD_PATH; do
        [ -z "$MOD_GLOB" ] || [ -z "$MOD_PATH" ] && continue
        DOSSIER_ABS="${DEVDOCS_PATH}/${MOD_PATH}"
        [ -f "$DOSSIER_ABS" ] || { echo "WARN: modules[${MOD_NAME}] references missing dossier '${MOD_PATH}' — skipping"; continue; }
        MATCHED=0
        for af in "${AFFECTED_FILES_GLOB_ARR[@]}"; do
          [ -z "$af" ] && continue
          AF_BASENAME=$(basename "$af")
          # Try basename match first, then relative-path match
          case "$AF_BASENAME" in
            $MOD_GLOB) MATCHED=1; break ;;
          esac
          case "$af" in
            $MOD_GLOB) MATCHED=1; break ;;
          esac
        done
        if [ "$MATCHED" -eq 1 ]; then
          echo "Module dossier matched: '${MOD_GLOB}' → ${MOD_PATH} (module: ${MOD_NAME})"
          # Add as sort key "0" (higher priority than required=1) so dossier appears first
          DEVDOCS_APPLICABLE="0|${DOSSIER_ABS}"$'\n'"${DEVDOCS_APPLICABLE}"
        fi
      done <<< "$MODULE_ENTRIES"
    fi
  fi

elif [ -n "$DEVDOCS_PATH" ]; then
  # --- Fallback: O(N) enumerate (backward compatible — no index.yaml present) ---
  echo "No index.yaml found at ${INDEX_PATH} — falling back to full enumerate (backward compatible)"

  while IFS= read -r -d '' mdfile; do
    # Extract frontmatter block (between first two --- markers)
    FRONTMATTER=$(awk '/^---/{c++; if(c==1){next} if(c==2){exit}} c==1{print}' "$mdfile" 2>/dev/null)

    # Check if applies_to contains work-on
    if echo "$FRONTMATTER" | grep -q 'applies_to:.*work-on'; then
      AUTHORITY=$(echo "$FRONTMATTER" | grep 'authority:' | head -1 | sed 's/.*authority:\s*//' | tr -d ' ')
      # Prepend sort key: 1=required, 2=recommended, 3=reference, 4=other
      case "$AUTHORITY" in
        required)    SORT_KEY="1" ;;
        recommended) SORT_KEY="2" ;;
        reference)   SORT_KEY="3" ;;
        *)           SORT_KEY="4" ;;
      esac
      DEVDOCS_APPLICABLE="${DEVDOCS_APPLICABLE}${SORT_KEY}|${mdfile}"$'\n'
    fi
  done < <(find "$DEVDOCS_PATH" -name "*.md" -print0 2>/dev/null)

  # Sort by authority key and extract paths
  DEVDOCS_APPLICABLE=$(printf "%s" "$DEVDOCS_APPLICABLE" | sort | cut -d'|' -f2-)
fi

if [ -z "$DEVDOCS_APPLICABLE" ]; then
  echo "No applicable devdocs files found — skipping Phase C-1 content read"
fi
```

### Step 2: Read content of applicable files

For each applicable file: read its content (max 200 lines; truncate with note if longer). Accumulate for output.

```bash
DEVDOCS_CONTENT=""

while IFS= read -r mdfile; do
  [ -z "$mdfile" ] && continue
  TOTAL_LINES=$(wc -l < "$mdfile" 2>/dev/null || echo 0)
  if [ "$TOTAL_LINES" -gt 200 ]; then
    FILE_CONTENT=$(head -200 "$mdfile")
    TRUNCATION_NOTE="_[Truncated at 200 lines — ${TOTAL_LINES} total. Read full file for complete context.]_"
  else
    FILE_CONTENT=$(cat "$mdfile")
    TRUNCATION_NOTE=""
  fi

  # Relative path for display
  REL_PATH="${mdfile#${DEVDOCS_PATH}/}"

  DEVDOCS_CONTENT="${DEVDOCS_CONTENT}

#### \`${REL_PATH}\`
${FILE_CONTENT}
${TRUNCATION_NOTE}"
done <<< "$DEVDOCS_APPLICABLE"
```

### Step 3: Store for output

`DEVDOCS_CONTENT` is used in the `### Authoritative Devdocs` section of the FORGE:CONTEXT comment output. If empty (path absent or no applicable files), the section is replaced with a skip note.

**Module dossier injection**: When the glob pass (Step 1, index-first path) matched one or more dossiers, they appear first in `DEVDOCS_APPLICABLE` (sort key `0`) and are rendered as `#### Module Dossier: {name}` sub-sections within `### Authoritative Devdocs`. The 200-line/file cap applies to each dossier individually — the same cap used for all other devdocs files. This ensures dossier injection is bounded by the existing token budget even as dossiers grow.

---

## Phase C-0.5: Active Peer Claims Reader (conditional — when running under orchestration batch)

**Skip if**: `FORGE_COORD_ISSUE` is not set. This phase is a no-op when the agent is not running under an `/orchestrate` batch — no error, no output.

**Purpose**: Before writing any code, check whether peer agents in the same orchestration batch have posted `FORGE:CLAIM` annotations on the coordination issue that overlap with this agent's planned files. If overlapping claims exist, inject them into the builder's mental model as explicit constraints so the builder avoids modifying interfaces the peer has reserved.

**Time budget**: 20 seconds. If exceeded, log a warning and continue without peer-claim constraints.

```bash
if [ -n "${FORGE_COORD_ISSUE:-}" ]; then
  COORD_NUM=$(echo "$FORGE_COORD_ISSUE" | grep -oE '[0-9]+$')
  if [ -n "$COORD_NUM" ]; then
    echo "Phase C-0.5: reading active peer claims from coordination issue #${COORD_NUM}"

    # Fetch all comments from coordination issue
    COORD_COMMENTS=$(gh api repos/{GH_REPO}/issues/${COORD_NUM}/comments \
      --jq 'map(select(.body | contains("<!-- FORGE:CLAIM -->")))' 2>/dev/null || echo '[]')

    # Extract active claims: FORGE:CLAIM comments that are NOT followed by FORGE:CLAIM_RELEASED
    # from the same Holder. We identify active claims by the presence of CLAIM:COMPLETE
    # and the absence of a subsequent CLAIM_RELEASED referencing the same Holder.
    # Self-exclusion is done via jq select() against the **Holder**: #{NUMBER} field —
    # the actual encoding of the owning issue number — not by grep-matching flattened text
    # (claim comment lines never start with a bare #N, so a line-prefix grep can never match).
    ACTIVE_PEER_CLAIMS=$(echo "$COORD_COMMENTS" | jq -r --arg num "$NUMBER" '.[] |
      select(.body | contains("<!-- CLAIM:COMPLETE -->")) |
      select(.body | contains("<!-- FORGE:CLAIM_RELEASED -->") | not) |
      select((.body | capture("\\*\\*Holder\\*\\*: #(?<n>[0-9]+)").n // "") != $num) |
      "Holder: " + (.body | capture("\\*\\*Holder\\*\\*: (?P<h>[^\n]+)").h // "unknown") +
      "\nFiles: " + (.body | capture("\\*\\*Files\\*\\*: (?P<f>[^\n]+)").f // "none")
    ' 2>/dev/null || echo "")

    if [ -n "$ACTIVE_PEER_CLAIMS" ]; then
      echo "Active peer claims found:"
      echo "$ACTIVE_PEER_CLAIMS"

      # Extract claimed file paths from peer claims (self already excluded above via jq select)
      PEER_CLAIMED_FILES=$(echo "$COORD_COMMENTS" | jq -r --arg num "$NUMBER" '.[] |
        select(.body | contains("<!-- CLAIM:COMPLETE -->")) |
        select(.body | contains("<!-- FORGE:CLAIM_RELEASED -->") | not) |
        select((.body | capture("\\*\\*Holder\\*\\*: #(?<n>[0-9]+)").n // "") != $num) |
        .body' 2>/dev/null \
        | awk '/\*\*Files\*\*:/{found=1; next} /\*\*Interfaces\*\*:/{found=0} found{print}' \
        | grep -oP '[a-zA-Z0-9._/-]+\.(py|tsx?|jsx?|sql|json|ya?ml|md|mjs|sh)' \
        | sort -u || echo "")

      # Check overlap with this agent's planned files (from FORGE:CONTRACT)
      OWN_FILES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
        --jq '[.[] | select(.body | contains("FORGE:CONTRACT"))] | last | .body' 2>/dev/null \
        | grep -oP '`[^`]+\.(py|tsx?|jsx?|sql|json|ya?ml|md|mjs|sh)`' \
        | tr -d '`' | sort -u || echo "")

      OVERLAP=$(comm -12 <(echo "$PEER_CLAIMED_FILES") <(echo "$OWN_FILES") 2>/dev/null || echo "")

      if [ -n "$OVERLAP" ]; then
        PEER_CLAIMS_CONSTRAINT="
⚠ CLAIMS BOARD CONSTRAINT: The following files are claimed by peer agents in this orchestration batch.
You MUST NOT modify the public interfaces of these files without first checking the peer's FORGE:CLAIM
on coordination issue #${COORD_NUM} to understand what interfaces they have reserved.

Overlapping claimed files:
$(echo "$OVERLAP" | sed 's/^/  - /')

Peer claims:
$(echo "$ACTIVE_PEER_CLAIMS" | sed 's/^/  /')

If you need to change an interface claimed by a peer, post a comment on coordination issue #${COORD_NUM}
describing the conflict — this routes to Phase 2.5 arbitration."
      else
        PEER_CLAIMS_CONSTRAINT="
ℹ CLAIMS BOARD: Peer claims exist but no file overlap with this agent's planned files.
Peer agents are working on independent file sets — no interface constraint applies.
Peer claims (for reference): $(echo "$ACTIVE_PEER_CLAIMS" | head -5)"
      fi

      # Store for injection into the FORGE:CONTEXT comment (Phase C4)
      export PEER_CLAIMS_CONSTRAINT
    else
      echo "Phase C-0.5: no active peer claims found on coordination issue #${COORD_NUM}"
      PEER_CLAIMS_CONSTRAINT=""
      export PEER_CLAIMS_CONSTRAINT
    fi
  fi
fi
```

**Constraint injection into FORGE:CONTEXT**: When `PEER_CLAIMS_CONSTRAINT` is set, append it to the `### Known Pitfalls for This Area` section of the FORGE:CONTEXT comment (Phase C4). This ensures the builder sees peer claims in the same context block as historical review findings — a single consolidated constraint surface. If `PEER_CLAIMS_CONSTRAINT` is empty, the section is omitted.

---

## Phase C0.5: Danger-Zone Rule Cards (fixed 400-token slot)

Surface the highest-value risk knowledge for exactly the files this build will touch. Reads the persisted danger-zones index produced by `scripts/danger-zones.mjs`, filters to files that overlap the Builder Contract's deliverables table, ranks by risk score, and emits one-line rule cards cut at a hard 400-token ceiling. The slot is constant by construction — never more, never less — so risk injection adds zero variance to the builder's token budget.

**Time budget**: 10 seconds. If exceeded, log a warning and continue without danger-zone cards.

**Skip if**: `~/.forge/index/danger-zones.json` is absent (cold start — no index built yet). Zero cards → section omitted from FORGE:CONTEXT (no empty scaffolding). <!-- Cold-start safety: required — the index only exists after danger-zones.mjs has run at least once -->

### Step 0: Locate danger-zones.json

```bash
# Resolve index directory — forge.yaml may override ~/.forge/index
FORGE_INDEX_DIR="${HOME}/.forge/index"
if [ -f "{REPO_PATH}/forge.yaml" ]; then
  FORGE_INDEX_OVERRIDE=$(yq '.forge_index.directory // ""' "{REPO_PATH}/forge.yaml" 2>/dev/null || echo '')
  [ -n "$FORGE_INDEX_OVERRIDE" ] && FORGE_INDEX_DIR="$FORGE_INDEX_OVERRIDE"
fi

DANGER_ZONES_PATH="${FORGE_INDEX_DIR}/danger-zones.json"

if [ ! -f "$DANGER_ZONES_PATH" ]; then
  echo "Phase C0.5: danger-zones.json absent at ${DANGER_ZONES_PATH} — skipping (cold start)"
  DANGER_ZONE_CARDS=""
  # → Continue to Phase C0 without emitting any cards
fi
```

### Step 1: Extract contract-overlapping files

Read the Builder Contract from the FORGE:CONTRACT comment on the issue. Extract the file paths listed in the Deliverables table:

```bash
CONTRACT_FILES=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:CONTRACT")) | .body] | last // ""' 2>/dev/null \
  | grep -oE '`[^`]+\.(py|ts|tsx|js|mjs|md|sh|yaml|yml|json)[^`]*`' \
  | tr -d '`' \
  | sort -u)

if [ -z "$CONTRACT_FILES" ]; then
  # Fallback: use AFFECTED_FILES from arguments
  CONTRACT_FILES=$(echo "{AFFECTED_FILES}" | tr ' ' '\n' | grep -v '^$' | sort -u)
fi
echo "Phase C0.5: contract files: $(echo "$CONTRACT_FILES" | tr '\n' ' ')"
```

### Step 2: Filter danger-zones.json to overlapping files

Read the danger-zones index and select only entries whose `file` key matches (by basename or full path) any file in the contract:

```bash
DANGER_ZONE_CARDS=""
TOKEN_BUDGET=400          # hard cap (tokens)
CHAR_BUDGET=$((TOKEN_BUDGET * 4))   # proxy: 1 token ≈ 4 chars → 1600 chars
CHARS_USED=0

# Read and filter danger-zones.json entries (files key is a dict keyed by file path)
# For each contract file: look up its entry in danger-zones.json by basename or full path
while IFS= read -r contract_file; do
  [ -z "$contract_file" ] && continue
  BASENAME=$(basename "$contract_file")

  # Look up by exact path first, then by basename match
  DZ_ENTRY=$(python3 -c "
import sys, json, os

dz = json.load(open('${DANGER_ZONES_PATH}'))
files = dz.get('files', {})

# Try exact match first
target = '${contract_file}'
if target in files:
    entry = files[target]
    entry['file'] = target
    print(json.dumps(entry))
    sys.exit(0)

# Basename fallback: match any file whose basename equals the target basename
basename = os.path.basename(target)
for path, entry in files.items():
    if os.path.basename(path) == basename:
        entry['file'] = path
        print(json.dumps(entry))
        sys.exit(0)
" 2>/dev/null || echo '')

  [ -z "$DZ_ENTRY" ] && continue

  # Extract fields for the card
  FILE_PATH=$(echo "$DZ_ENTRY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('file',''))" 2>/dev/null || echo '')
  FINDINGS=$(echo "$DZ_ENTRY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('findingCount90d',0))" 2>/dev/null || echo '0')
  TOP_PATTERN=$(echo "$DZ_ENTRY" | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('topPatterns',[]); print(p[0] if p else '')" 2>/dev/null || echo '')
  TOP_ISSUE=$(echo "$DZ_ENTRY" | python3 -c "import sys,json; d=json.load(sys.stdin); ci=d.get('citedIssues',[]); print('#'+str(ci[0]) if ci else '')" 2>/dev/null || echo '')
  RISK_SCORE=$(echo "$DZ_ENTRY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('riskScore',0))" 2>/dev/null || echo '0')

  # Skip files with zero findings (only in danger-zones due to co-change, not findings)
  [ "$FINDINGS" -eq 0 ] && continue

  # Build one-line card in issue-spec format:
  # {file} — {N} findings/90d — recurring: {pattern} (#{issue}); rule: {prevention}
  if [ -n "$TOP_PATTERN" ] && [ -n "$TOP_ISSUE" ]; then
    CARD="${FILE_PATH} — ${FINDINGS} findings/90d — recurring: ${TOP_PATTERN} (${TOP_ISSUE}); rule: do not repeat this pattern"
  elif [ -n "$TOP_PATTERN" ]; then
    CARD="${FILE_PATH} — ${FINDINGS} findings/90d — recurring: ${TOP_PATTERN}; rule: do not repeat this pattern"
  else
    CARD="${FILE_PATH} — ${FINDINGS} findings/90d; rule: review before modifying"
  fi

  # Enforce 400-token cap (1600 char proxy)
  CARD_LEN=${#CARD}
  if [ $((CHARS_USED + CARD_LEN + 2)) -gt $CHAR_BUDGET ]; then
    echo "Phase C0.5: token cap reached at ${CHARS_USED} chars (≈$((CHARS_USED / 4)) tokens) — truncating card list"
    break
  fi

  DANGER_ZONE_CARDS="${DANGER_ZONE_CARDS}
- ${CARD}"
  CHARS_USED=$((CHARS_USED + CARD_LEN + 2))

done < <(echo "$CONTRACT_FILES")

CARDS_TOKEN_COUNT=$((CHARS_USED / 4))
if [ -n "$DANGER_ZONE_CARDS" ]; then
  echo "Phase C0.5: emitting ${CARDS_TOKEN_COUNT} tokens of danger-zone cards (cap: ${TOKEN_BUDGET})"
else
  echo "Phase C0.5: no danger-zone entries for contract files — skipping section"
fi
```

### Step 3: Store for output

`DANGER_ZONE_CARDS` and `CARDS_TOKEN_COUNT` are used in the `### Danger-Zone Rule Cards` section of the FORGE:CONTEXT comment output. If `DANGER_ZONE_CARDS` is empty (no overlapping files with findings, or index absent), the section is **omitted entirely** — no empty scaffolding.

---

## Phase C0: Prior Investigation Findings (from Gists)

Scan the issue body for `<!-- FORGE:PRIOR_GIST: {url} -->` annotations embedded by the decompose or orchestrate phases (GIST-02). Also check for `<!-- FORGE:MILESTONE_INDEX: {url} -->` annotations — these reference a milestone-level index Gist (GIST-04) that aggregates all investigation Gist URLs for a milestone into a single reference. Both annotation types reference Knowledge Gists created during upstream investigation (GIST-01) and contain structured findings — verdict, root cause, recommendation, affected files — that the builder needs before writing code.

**Time budget**: 30 seconds total for all Gist fetches. Each individual fetch times out after 15 seconds.

**Skip if**: Issue body contains no `FORGE:PRIOR_GIST` or `FORGE:MILESTONE_INDEX` annotations, AND the issue's milestone description contains no `FORGE:MILESTONE_INDEX` annotation. Zero iterations, no output — this is expected for issues without prior investigation context.

### Step 0: Check for milestone index Gist

Before scanning individual Gist annotations, check if the issue's milestone has an index Gist. If so, fetch the index and extract individual Gist URLs from the table rows.

```bash
ISSUE_BODY=$(gh issue view {NUMBER} -R {GH_REPO} --json body --jq '.body')
MILESTONE_NUM=$(gh issue view {NUMBER} -R {GH_REPO} --json milestone --jq '.milestone.number // empty')

MILESTONE_INDEX_URL=""
INDEX_GIST_URLS=""

# Check issue body for milestone index annotation
MILESTONE_INDEX_URL=$(echo "$ISSUE_BODY" \
  | sed -n 's/.*<!-- FORGE:MILESTONE_INDEX: \(https:\/\/[^ ]*\) -->.*/\1/p' \
  | head -1)

# If not in issue body, check milestone description
if [ -z "$MILESTONE_INDEX_URL" ] && [ -n "$MILESTONE_NUM" ]; then
  MILESTONE_DESC=$(gh api repos/{GH_REPO}/milestones/${MILESTONE_NUM} --jq '.description // ""' 2>/dev/null)
  MILESTONE_INDEX_URL=$(echo "$MILESTONE_DESC" \
    | sed -n 's/.*<!-- FORGE:MILESTONE_INDEX: \(https:\/\/[^ ]*\) -->.*/\1/p' \
    | head -1)
fi

# If found, fetch the index and extract individual Gist URLs from table rows
if [ -n "$MILESTONE_INDEX_URL" ]; then
  INDEX_GIST_ID=$(echo "$MILESTONE_INDEX_URL" | grep -oE '[a-f0-9]{20,}' | tail -1)
  if [ -n "$INDEX_GIST_ID" ]; then
    INDEX_CONTENT=$(timeout 15 gh gist view "$INDEX_GIST_ID" --raw 2>/dev/null)
    if [ -n "$INDEX_CONTENT" ]; then
      # Extract Gist URLs from table rows (format: | ... | https://gist.github.com/... | ... |)
      INDEX_GIST_URLS=$(echo "$INDEX_CONTENT" \
        | grep -oE 'https://gist\.github\.com/[A-Za-z0-9_-]+/[a-f0-9]+' \
        | head -10)
      echo "Milestone index fetched: found $(echo "$INDEX_GIST_URLS" | wc -l) investigation Gist(s)"
    else
      echo "WARNING: Failed to fetch milestone index Gist — falling back to individual annotations"
    fi
  fi
fi
```

### Step 1: Detect Gist URLs in issue body

```bash
GIST_URLS=$(echo "$ISSUE_BODY" \
  | sed -n 's/.*<!-- FORGE:PRIOR_GIST: \(https:\/\/[^ ]*\) -->.*/\1/p' \
  | head -5)

# Merge with any URLs discovered from milestone index (deduplicate)
if [ -n "$INDEX_GIST_URLS" ]; then
  GIST_URLS=$(echo -e "${GIST_URLS}\n${INDEX_GIST_URLS}" | sort -u | head -5)
fi

# Self-exclusion: drop this issue's own Knowledge Gist before fetching/summarizing.
# investigate.md Phase 1C.5 posts this issue's own investigation as a Gist and links it via
# FORGE:KNOWLEDGE_GIST on this same issue; Phase 1C.6 (same run) then folds that identical URL
# into the milestone index. By the time this phase runs, the milestone index can already contain
# this issue's own Gist — with no filter, Step 2 below would re-fetch and re-summarize the
# current issue's own FORGE:INVESTIGATOR content into "Prior Investigation Findings", producing
# a third same-thread copy of content already in FORGE:INVESTIGATOR and already linked via
# FORGE:KNOWLEDGE_GIST. Match on the literal, unmodified Gist URL string (both sides derive from
# the same $GIST_URL value with no transformation) rather than a derived/prefixed form — see
# forge#1841 for the failure mode a heuristic match here would otherwise repeat.
SELF_GIST_URL=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("FORGE:KNOWLEDGE_GIST:"))] | last | .body // ""' 2>/dev/null \
  | sed -n 's/.*<!-- FORGE:KNOWLEDGE_GIST: \(https:\/\/[^ ]*\) -->.*/\1/p' | head -1)

if [ -n "$SELF_GIST_URL" ] && [ -n "$GIST_URLS" ]; then
  GIST_URLS=$(echo "$GIST_URLS" | grep -vF "$SELF_GIST_URL" || true)
fi

if [ -z "$GIST_URLS" ]; then
  echo "No FORGE:PRIOR_GIST or FORGE:MILESTONE_INDEX annotations found (or only this issue's own Gist was present) — skipping Phase C0"
  # → Continue to Phase C1
fi
```

**Max Gists**: 5 per issue. If more than 5 are present (from combined individual + index sources), process only the first 5 to stay within time budget.

### Step 2: Fetch and summarize each Gist

For each Gist URL, extract the Gist ID (last path segment) and fetch the raw content:

```bash
GIST_SUMMARIES=""

for url in $GIST_URLS; do
  # Extract Gist ID from URL (last path segment, strip any trailing slash)
  GIST_ID=$(echo "$url" | grep -oE '[a-f0-9]{20,}' | tail -1)

  if [ -z "$GIST_ID" ]; then
    echo "WARNING: Could not extract Gist ID from URL: $url — skipping"
    continue
  fi

  # Fetch Gist content with timeout
  GIST_CONTENT=$(timeout 15 gh gist view "$GIST_ID" --raw 2>/dev/null)

  if [ -z "$GIST_CONTENT" ]; then
    echo "WARNING: Failed to fetch Gist $GIST_ID — skipping (deleted, private, or network error)"
    GIST_SUMMARIES="${GIST_SUMMARIES}
- **Gist ${GIST_ID}** (${url}): _Fetch failed — Gist may be deleted or inaccessible_"
    continue
  fi

  # Extract key sections for summary (~2K chars target per Gist)
  VERDICT=$(echo "$GIST_CONTENT" | sed -n 's/.*verdict: \([A-Za-z_]*\).*/\1/p' | head -1)
  TASK_TYPE=$(echo "$GIST_CONTENT" | sed -n 's/.*task_type: \(.*\)/\1/p' | head -1)
  SEVERITY=$(echo "$GIST_CONTENT" | sed -n 's/.*severity: \([A-Za-z_]*\).*/\1/p' | head -1)
  SOURCE_ISSUE=$(echo "$GIST_CONTENT" | sed -n 's/.*issue: \([0-9]*\).*/\1/p' | head -1)

  # Extract structured sections: Root Cause, Recommendation, Affected Files
  ROOT_CAUSE=$(echo "$GIST_CONTENT" \
    | sed -n '/^### Root Cause/,/^### /p' \
    | head -10 | tail -n +2 | head -8)
  RECOMMENDATION=$(echo "$GIST_CONTENT" \
    | sed -n '/^### Recommendation/,/^### /p' \
    | head -10 | tail -n +2 | head -8)
  AFFECTED_FILES=$(echo "$GIST_CONTENT" \
    | sed -n '/^### Affected Files/,/^### /p' \
    | head -10 | tail -n +2 | head -8)

  GIST_SUMMARIES="${GIST_SUMMARIES}

#### Investigation #${SOURCE_ISSUE:-unknown} (${VERDICT:-unknown} / ${SEVERITY:-unknown})
**Source**: ${url}
**Task type**: ${TASK_TYPE:-unknown}

**Root Cause**:
${ROOT_CAUSE:-_Not extracted — read Gist directly_}

**Recommendation**:
${RECOMMENDATION:-_Not extracted — read Gist directly_}

**Affected Files**:
${AFFECTED_FILES:-_Not extracted — read Gist directly_}"
done
```

### Step 3: Store for output

If `GIST_SUMMARIES` is non-empty, it will be included in the `### Prior Investigation Findings` section of the FORGE:CONTEXT comment (see Output Format below). If empty (all fetches failed or no annotations found), the section is omitted from the output.

---

## Phase C1: Past Review Findings on These Files

**Primary path — Forge Ledger** (O(1) local index lookup, zero API calls):

Check for a local knowledge index before making any GitHub API calls. If the index exists, use
`forge recall` for exact file-path lookups. Fall back to live `gh issue list --search` only when
the index is absent or returns no results for a given file.

```bash
# Resolve recall CLI path relative to repository root
RECALL_PATH="${REPO_PATH:-$(git rev-parse --show-toplevel 2>/dev/null)}/bin/recall.mjs"
LEDGER_AVAILABLE=0

if [ -f "$RECALL_PATH" ]; then
  # Quick probe: does the index exist and have cards?
  PROBE=$(node "$RECALL_PATH" --doctor 2>/dev/null | grep "^Total cards:" | grep -v "^Total cards:    0" || true)
  [ -n "$PROBE" ] && LEDGER_AVAILABLE=1
fi

LEDGER_FINDINGS=""

if [ "$LEDGER_AVAILABLE" -eq 1 ]; then
  echo "[context:C1] Using Forge Ledger for file-path recall (zero API calls)"
  IFS=' ' read -ra AFFECTED_FILES_ARR <<< "{AFFECTED_FILES}"
  for file in "${AFFECTED_FILES_ARR[@]}"; do
    FILE_CARDS=$(node "$RECALL_PATH" --file "$file" --k 5 --json 2>/dev/null || echo "[]")
    if [ "$FILE_CARDS" != "[]" ] && [ -n "$FILE_CARDS" ]; then
      LEDGER_FINDINGS="${LEDGER_FINDINGS}
### Ledger findings for \`${file}\`
\`\`\`json
${FILE_CARDS}
\`\`\`"
    fi
  done
fi
```

**Extract from ledger results** (when `LEDGER_AVAILABLE=1` and `LEDGER_FINDINGS` is non-empty):
Parse the JSON card array. For each card: extract `kind`, `rootCause`, `pattern`, `prevention`,
`paths`, `symbols`, `issue` (citation). Include in the FORGE:CONTEXT output under
**### Known Pitfalls for This Area** (pattern/stale cards) and **### Historical Findings on These
Files** (investigation cards). Cards with `status: "stale"` are noted as such but still included
— they may describe a bug class that has since moved files.

**Fallback path — live GitHub search** (when `LEDGER_AVAILABLE=0` or `LEDGER_FINDINGS` is empty):

Query closed issues with `review-finding` label, searching by filename:

```bash
if [ "$LEDGER_AVAILABLE" -eq 0 ] || [ -z "$LEDGER_FINDINGS" ]; then
  echo "[context:C1] Forge Ledger unavailable or empty — falling back to live gh search"
  IFS=' ' read -ra AFFECTED_FILES_ARR <<< "{AFFECTED_FILES}"
  for file in "${AFFECTED_FILES_ARR[@]}"; do
    basename=$(basename "$file" .py)
    gh issue list -R {GH_REPO} \
      --state closed \
      --label "review-finding" \
      --search "$basename" \
      --limit 10 \
      --json number,title,body \
      --jq '.[] | {
        number,
        title,
        pattern:    (.body | capture("\\*\\*Pattern\\*\\*: *(?<p>[^\\n]+)").p    // null),
        prevention: (.body | capture("\\*\\*Prevention\\*\\*: *(?<v>[^\\n]+)").v // null),
        root_cause: (.body | capture("\\*\\*Root cause\\*\\*: *(?<rc>[^\\n]+)").rc // (.body | capture("Root Cause[^\\n]*\\n(?<rc>[^\\n]+)").rc // "see body"))
      }'
  done
fi
```

Keep findings where the filename or function name appears in the title or body. Discard false matches (same word, different module).

**Pattern extraction note**: Issues created by `/review-pr` after the feedback-loop feature include structured `**Pattern**`, `**Root cause**`, and `**Prevention**` fields in the `## Pattern Metadata` section. Extract all three when present — they are the primary signal. Fall back to `root_cause` regex for older issues that predate this feature.

**Max results**: 10 findings total across all files.

---

## Phase C2: Past Bugs in the Same Module

Mine git log for commit messages referencing issues, then fetch those issues. Also read commit bodies/diffs directly — local git history is near-free relative to `gh api` round-trips, and commit bodies often explain the "why" without needing to fetch the linked issue at all.

```bash
# Step 1: find issue numbers from git history on affected files
git log --oneline -30 -- {AFFECTED_FILES} \
  | grep -oE '#[0-9]+' \
  | sort -u \
  | head -8

# Step 2: for each issue number found, fetch title and any root cause annotation
gh issue view {RELATED_NUMBER} -R {GH_REPO} \
  --json number,title,body,labels \
  --jq '{number, title, labels: [.labels[].name], snippet: (.body[:300])}'
```

Filter: keep only `bug`, `fix`, or `review-finding` labeled issues. Skip feature issues — they add noise without bug signal.

**Max results**: 5 issues.

**Direct commit-body read (bounded, prefer over `gh api` when it already answers "why")**: For the top 5 commits touching `{AFFECTED_FILES}`, read the commit subject + body directly instead of round-tripping to `gh issue view` when the body already explains the change:
```bash
git log -5 --format='%h %ad %s%n%b' --date=short -- {AFFECTED_FILES}
```
If a commit body fully explains the prior bug/fix (common for squashed or fix-up commits with no `#NNN` reference), use it directly as a "Past Bug in This Module" entry — do not require a linked GitHub issue to exist.

**Pickaxe pass (has this exact area been fixed before?)** — one bounded pass, capped at 5 hits, keyed on the suspected symbol/string from the Builder Contract or investigation report:
```bash
git log -S"{suspected_symbol_or_string}" --oneline -- {AFFECTED_FILES} | head -5
# Use -G instead of -S for regex patterns
git log -G"{pattern}" --oneline -- {AFFECTED_FILES} | head -5
```
Any hit is a candidate prior fix or reintroduced defect for this exact code area — read `git show {hash}` to confirm scope before including it in the output. This catches regressions the issue-number harvest above misses (e.g. a defect fixed via a squashed commit with no `#NNN` reference).

---

## Phase C3: Related Code Paths

Identify callers, importers, and sibling implementations that must stay consistent with the changed code:

```bash
# Python: find importers of modified functions/classes
for fn in {FUNCTION_NAMES}; do
  grep -r "$fn" {REPO_PATH} \
    --include="*.py" \
    -l \
    | grep -v "__pycache__" \
    | grep -v {AFFECTED_FILES} \
    | head -5
done

# TypeScript: find usages
for fn in {FUNCTION_NAMES}; do
  grep -r "$fn" {REPO_PATH}/web/src \
    --include="*.ts" --include="*.tsx" \
    -l \
    | head -5
done
```

For each related file found: note the file path and the nature of the relationship (caller, sibling, test).

**Max results**: 8 related files.

---

## Phase C4: Successful Similar Implementations

Find merged PRs that touched the same domain with a successful outcome — use as a positive pattern reference:

```bash
gh pr list -R {GH_REPO} \
  --state merged \
  --search "{domain_keywords}" \
  --limit 5 \
  --json number,title,files \
  --jq '.[] | {number, title, file_count: (.files | length)}'
```

Use 2-3 keywords from the issue title. If no results, skip this phase — do not block on it.

---

## Output Format

**CODEC PATH**: Post the `<!-- FORGE:CONTEXT -->` comment via the protocol codec — do NOT hand-roll the opening tag or completion sentinel. Use `forge-annotation.sh write CONTEXT` or `node packages/protocol/src/cli.js emit CONTEXT` to produce the tag and sentinel (`<!-- FORGE:CONTEXT:COMPLETE -->`). The codec handles completion sentinel emission automatically.

```bash
# Codec produces the opening tag and completion sentinel
CONTEXT_BODY=$(node packages/protocol/src/cli.js emit CONTEXT)
# $CONTEXT_BODY = "<!-- FORGE:CONTEXT -->\n<!-- FORGE:CONTEXT:COMPLETE -->"
# Insert the Markdown sections between the opening tag line and the sentinel.
```

Post the following as a GitHub comment on `{NUMBER}`:

```bash
gh issue comment {NUMBER} -R {GH_REPO} --body "<!-- FORGE:CONTEXT -->
## Implementation Context for #{NUMBER}

### Authoritative Devdocs
<!-- Project-resident authoritative knowledge read from devdocs/ (Phase C-1).
     These files have the highest precedence — they override agent defaults and memory.
     custom-instructions.md directives are BINDING and MUST be followed exactly.
     If devdocs path was absent or no files matched applies_to: work-on — write:
     'No devdocs found at {DEVDOCS_PATH} — skipping. Run `npx forgedock docs init` to scaffold.' -->
{DEVDOCS_CONTENT}

### Danger-Zone Rule Cards
<!-- Ranked risk cards for contract-overlapping files from the Forge Ledger danger-zones index (Phase C0.5).
     Token budget: {CARDS_TOKEN_COUNT} / 400 tokens used.
     Each card: {file} — {N} findings/90d — recurring: {pattern} (#{issue}); rule: {prevention}
     BINDING CONSTRAINT: treat each card as a must-not-violate rule before committing.
     If danger-zones.json was absent or no contract files had findings — omit this section entirely (no empty scaffolding). -->
{DANGER_ZONE_CARDS}

### Prior Investigation Findings
<!-- Summarized Knowledge Gist content from upstream investigations (Phase C0).
     If no FORGE:PRIOR_GIST annotations were found in the issue body: omit this section entirely.
     If Gist fetches failed: include the failure note so the builder knows context was attempted. -->
{GIST_SUMMARIES}

### Claims Board Constraints
<!-- Active peer claims from the orchestration coordination issue (Phase C-0.5).
     If FORGE_COORD_ISSUE is not set (not running under /orchestrate): omit this section entirely.
     If no peer claims overlap this agent's planned files: write 'No overlapping peer claims.' -->
{PEER_CLAIMS_CONSTRAINT}

### Known Pitfalls for This Area
<!-- Structured prevention rules extracted from past review-finding issues (Pattern Metadata section).
     If a finding has a Prevention field, list it here. Builder MUST read these before writing code.
     If none: 'No structured pitfalls recorded — first time these files are touched or all findings predate the feedback loop.' -->
- **{PATTERN}** (`{FILE}`): {PREVENTION}

### Historical Findings on These Files
<!-- List of past review-finding issues from C1. If none: 'No prior findings.' -->
- #{NUM}: \"{TITLE}\" — root cause: {ROOT_CAUSE}

### Past Bugs in This Module
<!-- List of closed bug issues from git log mining, PLUS pickaxe-derived findings (commits with no linked issue, or
     commit bodies read directly per the C2 direct-commit-body step). If none: 'No prior bugs found in git history.' -->
- #{NUM}: \"{TITLE}\" — root cause: {SNIPPET}
- {COMMIT_HASH} (no linked issue): {COMMIT_SUBJECT} — {WHY_RELEVANT, from commit body or pickaxe hit}

### Related Code Paths (must stay consistent)
<!-- Files that import or call the changed functions. Builder must read and validate these. -->
- \`{FILE}\` — {RELATIONSHIP}

### Patterns That Cause Bugs Here
<!-- Synthesize from C1+C2: recurring bug types (e.g. 'String/int coercion at JSON boundaries — 3 prior incidents'). If none: 'No recurring patterns identified.' -->

### Successful Similar Implementations
<!-- Positive patterns from C4. If none: 'No similar merged PRs found.' -->
- PR #{NUM}: \"{TITLE}\" — {FILE_COUNT} files, notes: {OBSERVATION}

<!-- FORGE:CONTEXT:COMPLETE -->
"
```

---

## Timing Rules

- Phase C-1 devdocs read: 30s total budget (file enumeration + content reads combined); skip if exceeded
- Phase C0 `gh gist view` calls: timeout after 15s each, 30s total budget for all Gist fetches
- Each `gh issue list` call: timeout after 20s, skip if exceeded
- Each `gh pr list` call: timeout after 20s, skip if exceeded
- Each `grep -r` call: timeout after 10s, skip if exceeded
- Total wall time budget: **2 minutes** (C-1 through C4 combined). If budget exceeded, post partial results with `<!-- FORGE:CONTEXT:PARTIAL -->` marker instead of `COMPLETE`.

---

## Skip Conditions

Skip this entire step (post nothing, return empty briefing) if:
- **COMPLEXITY_BAND: TRIVIAL** — checked via FORGE:FAST_PATH comment at entry (see guard above)
- Issue is a 1-file config or docs edit with no code logic
- The affected files have zero git history (new files being created)
- `{AFFECTED_FILES}` is empty (investigation produced no file list)

---

## Integration Point in work-on.md

This module runs at **Step 3C.5** — after Builder Contract is posted, before Implement:

```
3C   → Builder Contract posted
3C.5 → [THIS MODULE] Context gathering (max 2 min)
         Phase C-1:  Authoritative Devdocs (project-resident knowledge — highest precedence)
         Phase C-0.5: Active Peer Claims Reader (conditional — orchestration only)
         Phase C0.5: Danger-Zone Rule Cards (fixed 400-token slot — forge#1744)
         Phase C0:  Prior Investigation Findings (from Gists)
         Phase C1:  Past Review Findings on These Files
         Phase C2:  Past Bugs in the Same Module
         Phase C3:  Related Code Paths
         Phase C4:  Successful Similar Implementations
3F   → Implement (builder now has context briefing)
```

The builder agent reads the `<!-- FORGE:CONTEXT -->` comment before writing any code. If the context step was skipped, the builder proceeds with investigation report + contract only.

**Devdocs precedence** (Phase C-1): Content from `project/custom-instructions.md` has the HIGHEST precedence of all context sources. Directives there override agent defaults, training knowledge, and all other devdocs. Other `project/*.md` and `agent/*.md` files with `applies_to: work-on` provide authoritative project conventions and ForgeDock usage guidance.

When prior investigation Gists are available (Phase C0), the `### Prior Investigation Findings` section gives the builder cross-issue context — root causes, recommendations, and affected files from upstream investigations — without requiring manual Gist lookups. When a milestone-level index Gist exists (GIST-04), Phase C0 can resolve the index to discover all investigation Gists for the milestone from a single URL — providing full milestone-wide context automatically.
