---
install: internal
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 3: Dependency Analysis & Execution Plan

## Phase 3: Dependency Analysis & Execution Plan

### Step 3A: Analyze explicit dependencies

For each issue (including newly spawned ones from Phase 2), check:
1. **Explicit dependencies**: Issue body contains "Depends on #X" or "Blocked by #X"
2. **Milestone ordering**: Issues within a milestone may have a natural order (foundation → features → UI)
3. **File conflicts**: If two issues modify the same files, they should be sequential (not parallel)
4. **Parent-child links**: If issue body contains "Parent investigation: #{X}", it was spawned by an investigation — no special ordering needed unless explicitly stated

Read each issue's body briefly to check for dependency markers:
```bash
for NUM in {issue_numbers}; do
  gh issue view $NUM --json body --jq '.body' | grep -iE 'depends on|blocked by|after #|parent investigation' || echo "no deps"
done
```

### Step 3B: Domain estimation

For each issue, estimate which domains it touches based on title, body, and labels. This improves DAG construction — issues in the same domain likely touch the same files and should be serialized (one becomes a predecessor of the other).

```bash
for NUM in {issue_numbers}; do
  ISSUE=$(gh issue view $NUM --json title,body,labels --jq '{title: .title, labels: [.labels[].name], body: (.body[:300])}')
  echo "=== #$NUM ==="
  echo "$ISSUE" | grep -qiE "credit|billing|pricing|stripe|charge|refund" && echo "  BILLING" || true
  echo "$ISSUE" | grep -qiE "auth|session|jwt|login|permission|oauth" && echo "  AUTH" || true
  echo "$ISSUE" | grep -qiE "worker|queue|job|task|background|consumer" && echo "  WORKER" || true
  echo "$ISSUE" | grep -qiE "migration|\.sql|database|postgres|alembic" && echo "  DATABASE" || true
  echo "$ISSUE" | grep -qiE "component|page|layout|dashboard|ui|ux|frontend|web/src" && echo "  FRONTEND" || true
  echo "$ISSUE" | grep -qiE "docker|deploy|traefik|nginx|ci|cd|infra|github.action" && echo "  INFRA" || true
  echo "$ISSUE" | grep -qiE "llm|extract|schema|format|embedding|model" && echo "  AI" || true
  # For project-specific domains, configure keywords in forge.yaml → review.domains and extend above
done
```

**Use domain info for DAG edge construction:**
- Issues in the SAME domain (especially WORKER, BILLING, DATABASE) are more likely to touch the same files → add predecessor edges to serialize them
- Issues in DIFFERENT domains are more likely independent → safe to parallelize
- BILLING + AUTH issues should be prioritized early (security-critical)
- **DATABASE issues are ALWAYS serialized — hard rule, no exceptions.** Multiple agents writing migrations simultaneously will produce duplicate migration numbers (e.g., two `0067_*.sql` files), which breaks the migration runner. DATABASE issues form a linear predecessor chain in the DAG. If 3 DATABASE issues are in a batch: A has no predecessors, B has {A} as predecessor, C has {B} as predecessor.

**Store domain tags per issue** for use in the plan presentation (Step 3E).

### Step 3C: Multi-layer conflict detection

Domain estimation (above) catches broad category overlap but misses cases where two issues modify the exact same file without mentioning the same keywords, or where two issues touch different files that share indirect dependencies (imports, config, barrel exports). This step uses three layers of structural analysis to catch conflicts the keyword heuristic misses.

#### Layer 1: Explicit file-overlap extraction

**For issues that already have an INVESTIGATOR comment** (from Wave 0 or a prior session), extract their Affected Files list. **For issues WITHOUT an investigation comment**, fall back to parsing the issue body for file paths. Both code paths accumulate into a single `LAYER1_FILES` array (declared once, before the loop) — this is the batch-wide file set that Layer 5's co-change query (below) reuses, per the "file list already extracted in Layer 1" reference in Layer 2 and Layer 5:

```bash
LAYER1_FILES=()
for NUM in {issue_numbers}; do
  echo "=== #$NUM ==="
  FILES_FOR_NUM=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
    --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' 2>/dev/null \
    | grep -oP '`[^`]*\.(py|tsx?|jsx?|sql|json|ya?ml)`' | tr -d '`' | sort -u)

  # Fall back to parsing the issue body directly when no INVESTIGATOR comment exists yet.
  if [ -z "$FILES_FOR_NUM" ]; then
    FILES_FOR_NUM=$(gh issue view $NUM --json body --jq '.body' \
      | grep -oP '`[^`]*\.(py|tsx?|jsx?|sql|json|ya?ml)`' | tr -d '`' | sort -u)
  fi

  echo "$FILES_FOR_NUM"

  # Accumulate into the batch-wide array — read line-by-line so each extracted path
  # becomes one array element (paths here don't contain spaces, but this stays robust).
  while IFS= read -r f; do
    [ -n "$f" ] && LAYER1_FILES+=("$f")
  done <<< "$FILES_FOR_NUM"
done
```

**Cross-reference all extracted file lists:**
- If two issues share ANY affected file → one MUST be a predecessor of the other (serialized)
- The issue with lower issue number goes first (stable ordering), unless an explicit `Depends on #` says otherwise
- Add a conflict note to the DAG plan: "#{A} and #{B} both modify `{file}` — #{A} is predecessor of #{B}"

#### Layer 2: Directory-proximity detection

Two issues that modify different files in the **same leaf directory** have a high probability of conflicting through shared `__init__.py`, `index.ts`, barrel re-exports, or tightly coupled sibling modules. This layer catches indirect conflicts that Layer 1 misses.

**Extract the leaf directory for each affected file:**

```bash
# For each issue's file list, extract unique directories
for NUM in {issue_numbers}; do
  echo "=== #$NUM directories ==="
  # From the file list already extracted in Layer 1:
  echo "$FILES_FOR_NUM" | xargs -I{} dirname {} | sort -u
done
```

**Cross-reference directory lists:**
- If two issues share a leaf directory AND that directory is "small" (contains fewer than 10 tracked files), flag as **probable conflict** → serialize
- If the shared directory is a broad container (e.g., `services/api/app/routers/` with 15+ files), downgrade to **possible conflict** → serialize only if same domain tag (from Step 3B)
- **Known high-conflict directories** (always serialize if shared):
  - `services/api/app/models/` (SQLAlchemy models often share Base, imports)
  - `services/api/app/core/` (shared dependencies)
  - `services/worker/worker/` (tightly coupled consumer modules)
  - `web/src/lib/` (shared utilities)
  - `shared/` (volume-mounted, affects all services)
  - `infra/migrations/` (already covered by DATABASE hard rule, but explicit here too)

#### Layer 3: Shared-module inference

When two issues modify different files that **import from the same utility/init module**, both agents often end up modifying that shared module (adding imports, updating re-exports). This creates merge conflicts invisible to Layer 1.

**Heuristic rules (no git operations needed — pattern-based):**

| Pattern | Inference | Action |
|---------|-----------|--------|
| Issue A modifies `routers/billing.py`, Issue B modifies `routers/auth.py` | Both likely import from `routers/__init__.py` or `dependencies.py` | Flag as possible conflict if same service |
| Issue A modifies `models/user.py`, Issue B modifies `models/subscription.py` *(Python/SQLAlchemy example)* | Both likely modify `models/__init__.py` (model registry) | Flag as probable conflict → serialize |
| Issue A modifies `routes/users.js`, Issue B modifies `routes/billing.js` *(Node.js example)* | Both likely import from `routes/index.js` barrel | Flag as possible conflict if same service |
| Issue A modifies `internal/user/handler.go`, Issue B modifies `internal/billing/handler.go` *(Go example)* | Both likely register in `internal/router/router.go` | Flag as possible conflict if same service |
| Issue A modifies `web/src/components/X.tsx`, Issue B modifies `web/src/components/Y.tsx` | May share `index.ts` barrel export | Flag only if same parent directory |
| Issue A modifies the app entrypoint (e.g. `main.py`, `main.go`, `server.js`, `app.ts`) | Entrypoint is a high-fan-in file (router registration, middleware) — set the path via `forge.yaml → review.layout.api_main` | Serialize with ANY other same-service issue |
| Issue A modifies `docker-compose.yml` or `docker-compose.prod.yml` | Global config — any concurrent modification conflicts | Serialize with ALL other issues that touch infra |

**Apply inferences:**
```
# High-fan-in files — if ANY issue touches these, serialize it with all same-service issues.
# Read layout paths from forge.yaml review.layout; fall back to sensible generic defaults.
# Example (pseudo-code — adapt to your forge.yaml parsing method):
#   API_MAIN    = forge_yaml.review.layout.api_main    ?? "src/main.py"   # set in forge.yaml; no stack-specific default
#   WORKER_MAIN = forge_yaml.review.layout.worker_main ?? "src/worker.py" # set in forge.yaml; no stack-specific default
#   PAGES_ROOT  = forge_yaml.review.layout.pages       ?? "web/src/app"   # Next.js default; override in forge.yaml for other frameworks

HIGH_FAN_IN = [
  API_MAIN,                          # app entrypoint — router/middleware registration (set forge.yaml review.layout.api_main)
  WORKER_MAIN,                       # worker entrypoint (set forge.yaml review.layout.worker_main)
  PAGES_ROOT + "/layout.tsx",        # root layout for all pages (Next.js; adapt for your framework)
  "docker-compose.yml",
  "docker-compose.prod.yml",
  ".env.example"
]

# For each issue, check if affected files include a high-fan-in file
# If yes: that issue cannot be parallelized with any other issue touching the same service
```

#### Layer 4: Conservative fallback (low-confidence cases)

When file extraction yields **fewer than 2 file paths** for an issue (common for issues without investigation comments, or issues described in prose without backtick-wrapped paths), the conflict detection has low confidence. Rather than assuming independence, apply conservative serialization.

**Rules:**
- If an issue has 0-1 extracted file paths AND shares a domain tag (from Step 3B) with another issue → serialize them
- If an issue has 0 extracted file paths AND no domain tag could be determined → add it as a predecessor of the next same-domain issue, or if no domain match exists, serialize it after the most recently added issue (safest default)
- Add a note to the plan: "#{N} — low file-extraction confidence, serialized conservatively"

**Rationale**: The cost of a false-negative (two agents conflict → one fails with merge error, wasting the full agent run) far exceeds the cost of a false-positive (an issue waits for one predecessor before starting). Always err toward serialization when uncertain.

#### Layer 5: Historical co-change coupling <!-- Added: forge#1196 --> <!-- Empty-set guard: forge#1206 --> <!-- Matrix lookup: forge#1738 -->

Layers 1-4 infer conflict risk from structure — path overlap, directory nesting, hard-coded high-fan-in lists. They miss the case where two files with no directory or naming relationship have historically changed together in the same commits (e.g. `models/user.py` and `services/billing/charge.py`), and they over-serialize the inverse case where files merely sit near each other but have never actually co-changed. Git commit history answers both questions directly and empirically. This layer reads **commit metadata only** — the list of files touched per commit — never file contents, so it does not violate Hard Rule 2 ("dispatcher, not a builder... never read code").

**Primary path — persisted co-change matrix** (O(1) lookup, repo-wide coverage): <!-- Added: forge#1738 -->

Check whether `~/.forge/index/cochange.jsonl` (produced by `scripts/danger-zones.mjs`) exists before
falling back to the live `git log` query. The matrix is repo-wide and covers file pairs outside the
current batch — providing broader coupling signal than the batch-scoped live query alone.

```bash
COCHANGE_INDEX="${HOME}/.forge/index/cochange.jsonl"
COCHANGE_META="${HOME}/.forge/index/cochange-meta.json"

if [ -f "$COCHANGE_INDEX" ]; then
  echo "Layer 5: co-change matrix found — using persisted index for pair lookups"
  LAYER5_SOURCE="matrix"
  TOTAL_COMMITS=$(cat "$COCHANGE_META" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('totalCommits',0))" 2>/dev/null || echo "0")
else
  echo "Layer 5: co-change matrix absent — falling back to live git query (run 'node scripts/danger-zones.mjs' to build)"
  LAYER5_SOURCE="live"
  TOTAL_COMMITS=0
fi
```

**Matrix lookup per file pair** (when `LAYER5_SOURCE=matrix`):

For each pair of files across issues in the batch, query the matrix for coupling verdict:

```bash
# Query a single file pair from the matrix
query_cochange_pair() {
  local FILE_A="$1"
  local FILE_B="$2"

  # Find the record for FILE_A (matrix stores each pair once in lexicographic order,
  # but also includes reverse-lookup entries for O(1) lookup from either side)
  local RECORD
  RECORD=$(grep -m1 "\"file\":\"${FILE_A}\"" "$COCHANGE_INDEX" 2>/dev/null || true)
  if [ -z "$RECORD" ]; then
    echo "unknown"  # FILE_A not in matrix — insufficient history
    return
  fi

  # Extract n(A) — sum of monthly ring buffer
  local N_A
  N_A=$(echo "$RECORD" | python3 -c "
import sys, json
r = json.loads(sys.stdin.read())
n = r.get('n', [0,0,0])
print(sum(n))
" 2>/dev/null || echo "0")

  # Extract c(A,B) — co-occurrence count with FILE_B
  local C_AB
  C_AB=$(echo "$RECORD" | python3 -c "
import sys, json
r = json.loads(sys.stdin.read())
partners = r.get('partners', {})
c = partners.get('${FILE_B}', [0,0,0])
print(sum(c))
" 2>/dev/null || echo "0")

  # Apply thresholds: cold-start check (n < 5), support (c >= 3), confidence
  if [ "$N_A" -lt 5 ]; then
    echo "unknown"  # Insufficient history for FILE_A
    return
  fi

  local FILE_B_RECORD
  FILE_B_RECORD=$(grep -m1 "\"file\":\"${FILE_B}\"" "$COCHANGE_INDEX" 2>/dev/null || true)
  local N_B=0
  if [ -n "$FILE_B_RECORD" ]; then
    N_B=$(echo "$FILE_B_RECORD" | python3 -c "
import sys, json
r = json.loads(sys.stdin.read())
n = r.get('n', [0,0,0])
print(sum(n))
" 2>/dev/null || echo "0")
  fi

  if [ "$N_B" -lt 5 ]; then
    echo "unknown"  # Insufficient history for FILE_B
    return
  fi

  # Use danger-zones.mjs --query for the authoritative normalization verdict
  # (handles ubiquity, directional confidence, companions — avoids re-implementing)
  VERDICT=$(node "$(git rev-parse --show-toplevel 2>/dev/null)/scripts/danger-zones.mjs" \
    --query "$FILE_A" 2>/dev/null \
    | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
partners = d.get('cochangePartners', [])
for p in partners:
    if p['file'] == '${FILE_B}':
        print(p['verdict'])
        sys.exit(0)
print('unknown')
" 2>/dev/null || echo "unknown")
  echo "$VERDICT"
}
```

**Fallback path — live git query** (when matrix is absent or file pair not found in matrix):

```bash
# Union of affected files across all issues in the CURRENT batch only (already
# extracted per-issue in Layer 1) — never the whole repo. Built as an array
# (not a newline-joined scalar) so each path survives as a single pathspec
# argument below — a plain string here would be word-split and glob-expanded
# by the shell when handed to `git log --`, silently mangling or dropping any
# path containing a space or glob metacharacter.
mapfile -t ALL_AFFECTED_FILES < <(printf '%s\n' "${LAYER1_FILES[@]}" | sort -u | grep -v '^$')

# Guard: an empty array expands to nothing after `--`, which git interprets as
# "no pathspec restriction" (i.e. the whole repo) rather than "match nothing".
# Skip the query entirely in that case instead of letting it silently widen to
# a full-repo scan — this can happen when upstream file-extraction (Layer 1)
# yields zero paths for every issue in the batch.
# NOTE: `grep -v '^$'` above is required — without it, `printf '%s\n'` on an
# empty array emits one blank line (printf runs its format string once even
# with zero variadic args), which `mapfile` captures as a 1-element array of
# [""], making this guard evaluate to false and causing `git log -- ""` to run.
if [ "${#ALL_AFFECTED_FILES[@]}" -eq 0 ]; then
  echo "Layer 5: no affected files extracted by Layer 1 for this batch — skipping co-change query, falling back to Layers 1-4."
else
  # Bounded window: last 90 days, capped at 200 commits — whichever is smaller.
  # Each commit's file list is delimited by a marker so co-occurring files can be
  # grouped per-commit in a single pass. The array is expanded quoted
  # ("${ALL_AFFECTED_FILES[@]}") so every path is passed as one literal argument.
  git log --name-only --since="90 days ago" --max-count=200 \
    --pretty=format:'---%H---' -- "${ALL_AFFECTED_FILES[@]}" \
    > /tmp/cochange_log.txt

  # Parse into commit → file-set groups, then increment a co-occurrence counter
  # for every unordered pair of files that appear in the SAME commit's file list.
  # (Illustrative — an agent executing this reads /tmp/cochange_log.txt and tallies
  # pairs; no separate script is shipped, matching the pseudo-code style of Layers 1-4.)
fi
```

**Scoring rule**: A file pair is **co-change coupled** when it appears together in **3 or more** commits in the window. A pair with **zero** co-occurrences across the entire window (and both files have n ≥ 5 commits) is **verified independent**. Pairs where either file has fewer than 5 commits in the window are **unknown** — the matrix must NOT be used to downgrade edges for unknown pairs.

**Apply the signal:**
- **High co-change pair spans two different issues in the batch** → add a serialization edge between them (same directed-edge convention as Layers 1-4: lower issue number is predecessor), OR, if the pair also carries competing investigation recommendations, flag it for Phase 2.5 arbitration instead of a blind serialization edge (see cross-reference in Step 2.5B below).
- **Verified-independent pair** → MAY be used to downgrade an existing Layer 2 "broad directory + different domain" or Layer 4 "conservative fallback" serialization to parallel. This downgrade is **never** applied to Layer 1 (same-file hard conflict, which is ground truth from the current batch, not historical inference) or to Layer 3 high-fan-in-file edges (a file can be structurally high-risk even with a thin history window, e.g. a newly added `main.py`). Ubiquitous-file pairs (n/N > 0.2 for either file) are **ineligible** for verified-independent downgrade even with zero co-occurrences.
- If `ALL_AFFECTED_FILES` is empty, the guard above skips the query and Layer 5 contributes nothing for the entire batch. If the matrix or live query returns no data for a pair → Layer 5 contributes nothing; fall back silently to Layers 1-4's existing verdict for that pair.

**Wire-through proof (mandatory check)**: When `LAYER5_SOURCE=matrix`, confirm the matrix lookup path executes on at least one pair in the batch and log the verdict. This proves the path is live, not dead code. If no pairs are in the matrix, log that the live fallback ran instead. <!-- Ref: forge#1731, forge#1230, forge#1244 — Layer 5 has had two dead-code defects; this check prevents recurrence. -->

**Rationale**: The persisted matrix provides broader coverage (repo-wide, not batch-scoped) and O(1) lookup vs O(batch × commits) live query. The live fallback ensures no regression when the matrix is absent (cold start or first run). Bounding the live fallback to the batch file set keeps it cheap and deterministic.

#### Combining all layers

Build the final conflict graph by merging signals from all five layers:

| Signal | Strength | Action |
|--------|----------|--------|
| Layer 1: Same file | **Hard conflict** | Always serialize |
| Layer 2: Same small directory | **Probable conflict** | Serialize |
| Layer 2: Same broad directory + same domain | **Probable conflict** | Serialize |
| Layer 2: Same broad directory + different domain | **Possible conflict** | Parallelize (accept risk) — unless Layer 5 shows high co-change, then serialize |
| Layer 3: High-fan-in file touched | **Probable conflict** | Serialize with same-service issues |
| Layer 3: Shared model/init pattern | **Probable conflict** | Serialize |
| Layer 4: Low confidence + same domain | **Conservative** | Serialize |
| Layer 4: Low confidence + no domain | **Conservative** | Add predecessor edge to most recent issue — unless Layer 5 shows verified independence, then parallelize |
| Layer 5: High co-change (3+ shared commits, cross-issue file pair) | **Probable conflict** | Serialize (or route to Phase 2.5 arbitration if a competing-recommendation conflict is also present) |
| Layer 5: Verified independent (zero shared commits) | **Downgrade signal** | Permits downgrading a Layer 2 "broad directory + different domain" or Layer 4 verdict to parallel — never overrides Layer 1 or Layer 3 |

**This supplements, not replaces, the domain keyword estimation.** Domain tags still help with broad sequencing decisions. Multi-layer conflict detection catches the specific cases keywords miss (e.g., two issues that both modify files in `services/api/app/models/` where one is labeled WORKER and the other BILLING — Layer 2 catches this even though Layer 1 shows no direct file overlap; or two issues touching files in unrelated directories that Layer 5 shows have co-changed in 4 of the last 12 commits touching either file).

### Step 3D: Build the dependency DAG

Build a **directed acyclic graph (DAG)** of per-issue dependencies. Each issue gets a `predecessors` set — the specific issues that must reach a terminal state before this issue can dispatch. This replaces the previous wave-grouping model where all issues in a wave had to complete before any issue in the next wave could start.

**DAG construction rules:**
- Investigation issues already ran in Phase 2 — they are NOT included in this DAG
- Each issue starts with an empty predecessor set
- **Explicit dependencies**: If issue B says "Depends on #A" or "Blocked by #A", add A to B's predecessors
- **File-conflict edges**: If two issues share affected files (from Step 3C Layer 1), add a directed edge: lower issue number → higher issue number (unless explicit deps say otherwise). The later issue has the earlier issue in its predecessors.
- **Domain serialization edges**: DATABASE issues form a linear chain (each has the previous DATABASE issue as its predecessor). Same-small-directory issues (Layer 2) and high-fan-in file issues (Layer 3) get directed edges as per Step 3C rules.
- **Conservative fallback edges**: Low-confidence issues (Layer 4) get edges to same-domain issues as per Step 3C rules.
- **Co-change coupling edges** <!-- Added: forge#1196 -->: High co-change file pairs (Layer 5, 3+ shared commits in the bounded window) that span two different issues get a directed edge using the same lower-issue-number-is-predecessor convention as Layer 1. Verified-independent pairs (Layer 5, zero shared commits) may instead REMOVE an edge that Layer 2 or Layer 4 would otherwise have added for that pair — Layer 1 and Layer 3 edges are never removed by a Layer 5 downgrade.
- **Claims-board downgrade (Layer 2/4 edges only)** <!-- Added: forge#1736 -->: After dispatch begins (Phase 4A), when both issues in a Layer-2 or Layer-4 serialized pair post `FORGE:CLAIM` annotations on the coordination issue and their claimed file sets are **disjoint** (no path appears in both claims), the serialization edge for that pair MAY be relaxed — the blocked issue becomes ready. This downgrade is **never** applied to Layer-1 (same-file) or Layer-3 (high-fan-in) edges. See Step 4B: Claims-board relaxation sweep for the runtime check.
- **No artificial concurrency limit by default** — all issues with empty predecessor sets dispatch simultaneously. The only constraints are file overlap, explicit dependencies, and co-change coupling. When `forge.yaml → orchestration.max_concurrent` is set, the dispatch loop queues excess ready issues and releases them as running workers complete (see Engine mode § Concurrency model).

### Step 3D.1: Create coordination issue (claims board) <!-- Added: forge#1736 -->

**When to run**: Immediately after DAG construction (Step 3D), before Step 3D.5 cycle detection. Run once per orchestration batch. Skip if `FORGE_COORD_ISSUE` is already set (e.g., resumed session).

**Purpose**: Create a dedicated GitHub issue that serves as the shared claims board for the batch. Agents post `FORGE:CLAIM` annotations here when they begin implementation; they post `FORGE:CLAIM_RELEASED` when they reach a terminal state. The orchestrator reads active claims during the Layer-2/4 relaxation sweep (Step 4B) to determine whether serialized pairs can now run in parallel.

```bash
# Create coordination issue for this orchestration batch
BATCH_ISSUE_COUNT="${#ISSUES[@]}"
BATCH_ID="$(date -u +%Y%m%dT%H%M%S)-$$"

COORD_ISSUE_BODY="## Orchestration Batch Claims Board

This issue is the claims board for an orchestration batch of ${BATCH_ISSUE_COUNT} issues.
Agents post \`FORGE:CLAIM\` here on build start and \`FORGE:CLAIM_RELEASED\` on terminal state.

**Batch ID**: ${BATCH_ID}
**Issues in batch**: ${ISSUES[*]/#/#}
**Created**: $(date -u +%Y-%m-%dT%H:%M:%SZ)

<!-- FORGE:COORD_ISSUE -->
<!-- FORGE:BATCH_ID: ${BATCH_ID} -->"

COORD_ISSUE_URL=$(gh issue create -R {GH_REPO} \
  --title "orchestrate: claims board for batch ${BATCH_ID}" \
  --body "$COORD_ISSUE_BODY" \
  --label "automation" 2>/dev/null || echo "")

if [ -z "$COORD_ISSUE_URL" ]; then
  echo "WARNING: failed to create coordination issue — claims board disabled for this batch. Layer-2/4 relaxation will not run."
  FORGE_COORD_ISSUE=""
else
  COORD_ISSUE_NUMBER=$(echo "$COORD_ISSUE_URL" | grep -oE '[0-9]+$')
  FORGE_COORD_ISSUE="$COORD_ISSUE_URL"
  echo "Coordination issue created: ${COORD_ISSUE_URL} (#${COORD_ISSUE_NUMBER})"
  export FORGE_COORD_ISSUE
  export COORD_ISSUE_NUMBER
fi
```

**Idempotency**: If `FORGE_COORD_ISSUE` is already set in the environment (e.g., after a compaction / orchestrator restart), skip creation and use the existing URL. The coordination issue persists for the lifetime of the batch.

**Terminology:**
- **Ready issues**: Issues whose predecessor set is empty (all predecessors have reached terminal state or were never added)
- **Blocked issues**: Issues with one or more unresolved predecessors
- **Critical path**: The longest chain of dependent issues in the DAG — determines minimum wall-clock time

**Example DAG:**
```
Phase 2 (already done): #2644 (investigation) → spawned #2645, #2646, #2647

Dependency graph:
  #2633 (orphaned queues)     → predecessors: {}          ← READY
  #2636 (invalidation sub)    → predecessors: {}          ← READY
  #2645 (new finding)         → predecessors: {}          ← READY
  #2646 (new finding)         → predecessors: {}          ← READY
  #2634 (enable daemon)       → predecessors: {#2633}     ← blocked until #2633 completes
  #2647 (depends on #2645)    → predecessors: {#2645}     ← blocked until #2645 completes

Critical path: #2633 → #2634 (2 steps) or #2645 → #2647 (2 steps)
Initial dispatch: #2633, #2636, #2645, #2646 (all ready — launched simultaneously)
```

**Key advantage over waves**: When #2633 completes, #2634 dispatches immediately — it does not wait for #2636, #2645, or #2646 to finish. Similarly, when #2645 completes, #2647 dispatches immediately regardless of other issues' status.

### Step 3D.5: Cycle Detection (MANDATORY) <!-- Added: forge#1085 -->

**Run immediately after Step 3D's DAG edge construction, before presenting the plan (Step 3E).** This step validates that the predecessor graph is acyclic. Without it, mutual `Depends on` declarations (e.g., A depends on B AND B depends on A) cause both issues to remain permanently blocked in Step 4B's dispatch loop — no error, no timeout, indefinite deadlock.

**Algorithm**: Kahn's topological sort. Runs in O(V+E) — negligible overhead for typical batch sizes.

```bash
# --- Step 3D.5: Cycle Detection ---
# Inputs:
#   ISSUES[]         — array of all issue numbers in the DAG
#   PREDECESSORS[N]  — space-separated list of predecessor issue numbers for issue N

# Step 1: Compute in-degree for each issue
declare -A IN_DEGREE
for NUM in "${ISSUES[@]}"; do
  IN_DEGREE[$NUM]=0
done
for NUM in "${ISSUES[@]}"; do
  for PRED in ${PREDECESSORS[$NUM]:-}; do
    IN_DEGREE[$NUM]=$(( ${IN_DEGREE[$NUM]:-0} + 1 ))
  done
done

# Step 2: Seed the queue with zero-in-degree issues (no predecessors)
KAHN_QUEUE=()
for NUM in "${ISSUES[@]}"; do
  [ "${IN_DEGREE[$NUM]}" -eq 0 ] && KAHN_QUEUE+=("$NUM")
done

# Step 3: Process queue — reduce successor in-degrees, enqueue newly freed issues
PROCESSED_COUNT=0
PROCESSED_ORDER=()
while [ "${#KAHN_QUEUE[@]}" -gt 0 ]; do
  # Dequeue
  CURRENT="${KAHN_QUEUE[0]}"
  KAHN_QUEUE=("${KAHN_QUEUE[@]:1}")
  PROCESSED_ORDER+=("$CURRENT")
  PROCESSED_COUNT=$(( PROCESSED_COUNT + 1 ))

  # Reduce in-degree of all issues that depend on CURRENT (i.e., CURRENT is in their PREDECESSORS)
  for SUCCESSOR in "${ISSUES[@]}"; do
    for PRED in ${PREDECESSORS[$SUCCESSOR]:-}; do
      if [ "$PRED" = "$CURRENT" ]; then
        IN_DEGREE[$SUCCESSOR]=$(( ${IN_DEGREE[$SUCCESSOR]} - 1 ))
        [ "${IN_DEGREE[$SUCCESSOR]}" -eq 0 ] && KAHN_QUEUE+=("$SUCCESSOR")
      fi
    done
  done
done

# Step 4: Any issue not processed has in-degree > 0 — part of a cycle
CYCLE_ISSUES=()
EXCLUDED_CYCLE=()
for NUM in "${ISSUES[@]}"; do
  FOUND=false
  for P in "${PROCESSED_ORDER[@]}"; do [ "$P" = "$NUM" ] && FOUND=true && break; done
  [ "$FOUND" = "false" ] && CYCLE_ISSUES+=("$NUM")
done

# Step 5: Handle cycles
if [ "${#CYCLE_ISSUES[@]}" -gt 0 ]; then
  echo "CYCLE DETECTED in dependency graph — the following issues form a circular dependency:"
  for C in "${CYCLE_ISSUES[@]}"; do
    echo "  #${C}: predecessors=[${PREDECESSORS[$C]}]"
    # Label each cyclic issue needs-human
    gh issue edit "$C" -R {GH_REPO} --add-label "needs-human" 2>/dev/null || true
    gh issue comment "$C" -R {GH_REPO} --body "**Cycle detected by /orchestrate**: This issue is part of a circular dependency chain involving issues: ${CYCLE_ISSUES[*]/#/#}. The orchestrator cannot dispatch it automatically. Please fix the \`Depends on\` declarations so that no cycle exists, then re-run /orchestrate." 2>/dev/null || true
    # Remove from DAG — store in EXCLUDED_CYCLE for Step 3E reporting
    EXCLUDED_CYCLE+=("$C")
    # Remove from ISSUES array for all downstream processing
    # Use exact-match filter loop — pattern substitution (${array[@]/pattern}) leaves blank
    # slots and corrupts partial matches (e.g., removing 100 changes 1000 to 0).
    NEW_ISSUES=()
    for I in "${ISSUES[@]}"; do
      [ "$I" != "$C" ] && NEW_ISSUES+=("$I")
    done
    ISSUES=("${NEW_ISSUES[@]}")
  done
  echo ""
  echo "These issues have been labeled needs-human and excluded from the DAG."
  echo "Fix their dependency declarations and re-run /orchestrate."
else
  echo "DAG cycle check: PASS — no cycles detected. Proceeding with ${#PROCESSED_ORDER[@]} issues."
fi

# Guard: if all issues were cyclic, ISSUES[] is now empty — abort before presenting an empty plan
if [ "${#ISSUES[@]}" -eq 0 ]; then
  echo ""
  echo "ERROR: All issues in this batch form circular dependencies and have been excluded."
  echo "Every issue has been labeled needs-human."
  echo "Fix the Depends on / Blocked by declarations so no cycle exists, then re-run /orchestrate."
  exit 1
fi
# --- End Step 3D.5 ---
```

**After this step**:
- `ISSUES[]` contains only acyclic issues — safe to dispatch
- `EXCLUDED_CYCLE[]` contains cyclic issue numbers — reported in Step 3E, never dispatched
- If `EXCLUDED_CYCLE` is non-empty, report it clearly in the Step 3E plan before asking for user confirmation
- If `ISSUES[]` is empty after cycle exclusion (all issues were cyclic), the guard above aborts with `exit 1` — Step 3E is never reached with an empty plan <!-- Added: forge#1110 -->

### Step 3E.5: Value/Cost Scoring Pass (MANDATORY) <!-- Added: forge#1743 -->

**Run immediately after Step 3D.5, before presenting the plan (Step 3E).** This step scores every issue in `ISSUES[]` by its expected value/cost ratio and re-orders the ready-set (issues with an empty predecessors set) in descending value/cost order. Dependency constraints are **never overridden** — this is a reordering pass within the existing ready-set only, not an edge-insertion pass. No new edges are added; cycle detection (Step 3D.5) has already completed.

**Purpose**: Ensure that when a budget is finite (see `--budget` in Phase 4), the highest-value-per-token work dispatches first. When no budget is set (the default, uncapped behavior), dispatch order still reflects value/cost — useful for observability even without a hard cap.

#### Value function (transparent heuristic — deferral decisions must be explainable)

```
value(issue) = priority_weight × danger_zone_weight
```

**Priority weight** (from issue labels):

| Label | Weight |
|-------|--------|
| `priority:P0` | 4.0 |
| `priority:P1` | 3.0 |
| `priority:P2` | 2.0 |
| `priority:P3` | 1.0 |
| *(no priority label)* | 1.5 |

**Danger-zone weight** (from affected files via FORGE:INVESTIGATOR comment): Read the `### Affected Files` section and check each file path against the danger-zone list from `forge.yaml → review.danger_zones[]`. Each affected file that appears in a danger zone adds 0.5 to the weight (additive, capped at 2.0). Default (no matches): 1.0.

```
danger_zone_weight = min(2.0, 1.0 + 0.5 × count_of_danger_zone_files_affected)
```

If `forge.yaml → review.danger_zones` is absent: danger_zone_weight = 1.0 for all issues.

#### Cost function (fallback hierarchy)

```
cost_estimate(issue) → expected_spend_usd
```

Resolve in this order (use the first that produces a non-null result):

1. **Cost-prior lookup** (primary): Read `~/.forge/index/cost-priors.json`. Compute key = `task_type:module` where:
   - `task_type` = FORGE:INVESTIGATOR `**Task Type**` field (lower-cased, spaces→hyphens). If no investigator comment: infer from issue labels (`feature` → `feature`, `bug` → `bug-fix`, else `unknown`).
   - `module` = basename (no ext, lowercase) of the primary affected file from FORGE:INVESTIGATOR. If absent: `_unknown`.
   - If the key exists in cost-priors.json: use `priors[key].mean`. Mark the issue as `has_prior: true` for exploration-reserve logic below.

2. **Label heuristic fallback** (when cost-priors.json absent or key not found):
   ```
   bug/fix: $0.20 · feature: $0.40 · refactor: $0.30 · investigation: $0.50 · unknown: $0.35
   ```
   Mark the issue as `has_prior: false`.

3. **File-count proxy** (last resort — no labels and no prior):
   ```
   estimated_cost = 0.10 + 0.05 × count_of_affected_files
   ```
   Mark the issue as `has_prior: false`.

#### Scoring and sorting

```bash
# --- Step 3E.5: Value/Cost Scoring Pass ---
# Requires: ISSUES[] (post-cycle-detection), PREDECESSORS[], GH_REPO
# Outputs: ISSUE_SCORE[], ISSUE_COST_ESTIMATE[], ISSUE_HAS_PRIOR[], SORTED_READY_SET[]

declare -A ISSUE_SCORE        # issue → value/cost ratio (float)
declare -A ISSUE_COST_ESTIMATE # issue → estimated cost (USD float string)
declare -A ISSUE_HAS_PRIOR    # issue → true|false
declare -A ISSUE_VALUE        # issue → value weight (float)

COST_PRIORS_PATH="${HOME}/.forge/index/cost-priors.json"

for NUM in "${ISSUES[@]}"; do
  # 1. Fetch issue data for scoring (labels, investigator comment)
  ISSUE_DATA=$(gh issue view "$NUM" -R {GH_REPO} --json labels,body \
    --jq '{labels: [.labels[].name]}' 2>/dev/null || echo '{"labels":[]}')

  LABELS=$(echo "$ISSUE_DATA" | jq -r '.labels[]' 2>/dev/null || echo '')

  # --- Value: priority weight ---
  if echo "$LABELS" | grep -q "priority:P0"; then
    PRIO_WEIGHT=4.0
  elif echo "$LABELS" | grep -q "priority:P1"; then
    PRIO_WEIGHT=3.0
  elif echo "$LABELS" | grep -q "priority:P2"; then
    PRIO_WEIGHT=2.0
  elif echo "$LABELS" | grep -q "priority:P3"; then
    PRIO_WEIGHT=1.0
  else
    PRIO_WEIGHT=1.5
  fi

  # --- Value: danger-zone weight ---
  DANGER_WEIGHT=1.0
  DANGER_ZONES=$(yq '.review.danger_zones[]? // ""' forge.yaml 2>/dev/null || echo '')
  if [ -n "$DANGER_ZONES" ]; then
    # Fetch affected files from INVESTIGATOR comment
    AFFECTED=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
      --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' 2>/dev/null \
      | grep -oP '`[^`]+\.(py|mjs|ts|md|sh|yaml|yml)`' | tr -d '`' | head -20 || echo '')
    ZONE_HIT_COUNT=0
    while IFS= read -r dz; do
      [ -z "$dz" ] && continue
      if echo "$AFFECTED" | grep -q "$dz"; then
        ZONE_HIT_COUNT=$((ZONE_HIT_COUNT + 1))
      fi
    done <<< "$DANGER_ZONES"
    DZ_ADD=$(echo "scale=1; if ($ZONE_HIT_COUNT * 0.5 > 1.0) 1.0 else $ZONE_HIT_COUNT * 0.5" | bc 2>/dev/null || echo "0")
    DANGER_WEIGHT=$(echo "scale=1; 1.0 + $DZ_ADD" | bc 2>/dev/null || echo "1.0")
  fi

  VALUE=$(echo "scale=4; $PRIO_WEIGHT * $DANGER_WEIGHT" | bc 2>/dev/null || echo "$PRIO_WEIGHT")
  ISSUE_VALUE[$NUM]="$VALUE"

  # --- Cost: prior lookup → label heuristic → file-count proxy ---
  COST=""
  HAS_PRIOR="false"

  if [ -f "$COST_PRIORS_PATH" ]; then
    # Derive task_type:module key
    TASK_TYPE=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
      --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body] | last // ""' 2>/dev/null \
      | grep -oP '(?<=\*\*Task Type\*\*: )\S+' | head -1 | tr '[:upper:]' '[:lower:]' \
      | tr ' ' '-' || echo '')
    [ -z "$TASK_TYPE" ] && {
      if echo "$LABELS" | grep -q "^feature$"; then TASK_TYPE="feature"
      elif echo "$LABELS" | grep -q "^bug$"; then TASK_TYPE="bug-fix"
      else TASK_TYPE="unknown"; fi
    }

    PRIMARY_FILE=$(gh api repos/{GH_REPO}/issues/${NUM}/comments \
      --jq '[.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body] | last // ""' 2>/dev/null \
      | grep -oP '`[^`]+\.(py|mjs|ts|md|sh|yaml|yml)`' | tr -d '`' | head -1 || echo '')
    MODULE=$(basename "${PRIMARY_FILE:-_unknown}" | sed 's/\.[^.]*$//' | tr '[:upper:]' '[:lower:]')
    [ -z "$MODULE" ] && MODULE="_unknown"

    PRIOR_KEY="${TASK_TYPE}:${MODULE}"
    COST=$(jq -r --arg k "$PRIOR_KEY" '.priors[$k].mean // empty' "$COST_PRIORS_PATH" 2>/dev/null || echo '')
    [ -n "$COST" ] && HAS_PRIOR="true"
  fi

  if [ -z "$COST" ]; then
    # Label heuristic fallback
    if echo "$LABELS" | grep -q "^feature$"; then COST="0.40"
    elif echo "$LABELS" | grep -q "^bug$"; then COST="0.20"
    elif echo "$LABELS" | grep -q "^refactor$"; then COST="0.30"
    else COST="0.35"; fi
  fi

  # Score = value / cost (protected against divide-by-zero)
  SCORE=$(echo "scale=4; if ($COST > 0) $VALUE / $COST else $VALUE / 0.01" | bc 2>/dev/null || echo "1.0")

  ISSUE_SCORE[$NUM]="$SCORE"
  ISSUE_COST_ESTIMATE[$NUM]="$COST"
  ISSUE_HAS_PRIOR[$NUM]="$HAS_PRIOR"

  echo "Score: #${NUM} value=${VALUE} cost_est=\$${COST} (prior=${HAS_PRIOR}) score=${SCORE}"
done

# --- ε-exploration reserve ---
# ε = 10% of budget allocated to no-prior issues (high-variance unknowns).
# A no-prior issue is guaranteed a dispatch slot within the ε reserve even if
# its score would otherwise place it below the budget cutoff. This prevents
# discovery starvation on novel modules with no cost history.
#
# Implementation: when --budget is set in Phase 4, the dispatch loop reserves
# EPSILON_BUDGET = 0.10 × BUDGET_LIMIT for issues where ISSUE_HAS_PRIOR[N] == "false".
# This step only MARKS the no-prior issues; Phase 4 reads ISSUE_HAS_PRIOR[] to apply the reserve.
#
# No-prior issues still compete in the main dispatch queue by score. The reserve
# acts as a safety net: if no no-prior issue has been dispatched by the time
# PROJECTED_SPEND reaches (BUDGET_LIMIT − EPSILON_BUDGET), the highest-scoring
# no-prior issue is force-dispatched from the reserve before budget cutoff.

NO_PRIOR_ISSUES=()
for NUM in "${ISSUES[@]}"; do
  [ "${ISSUE_HAS_PRIOR[$NUM]:-false}" = "false" ] && NO_PRIOR_ISSUES+=("$NUM")
done
echo "Exploration reserve: ${#NO_PRIOR_ISSUES[@]} no-prior issues (ε=10% of budget reserved for these)"

# --- Sort the ready-set by descending score ---
# The ready-set is the subset of ISSUES with empty PREDECESSORS[].
# Dependency-constrained issues (non-empty PREDECESSORS[]) keep their original DAG ordering —
# their dispatch is triggered by predecessor completion, not by score rank.
# SORTED_READY_SET is consumed by Step 3E (plan) and Phase 4 (dispatch order).

READY_SET=()
for NUM in "${ISSUES[@]}"; do
  [ -z "${PREDECESSORS[$NUM]:-}" ] && READY_SET+=("$NUM")
done

# Sort by score descending (bc-based comparison via temporary file)
SCORE_PAIRS=""
for NUM in "${READY_SET[@]}"; do
  SCORE_PAIRS="${SCORE_PAIRS}${ISSUE_SCORE[$NUM]:-0} $NUM"$'\n'
done
SORTED_READY_SET=()
while IFS=' ' read -r _score num; do
  [ -n "$num" ] && SORTED_READY_SET+=("$num")
done < <(echo "$SCORE_PAIRS" | sort -rn -k1,1 | grep -v '^$')

echo ""
echo "Ready-set dispatch order (descending value/cost):"
for NUM in "${SORTED_READY_SET[@]}"; do
  PRIOR_TAG="${ISSUE_HAS_PRIOR[$NUM]:-false}"
  [ "$PRIOR_TAG" = "false" ] && PRIOR_NOTE=" [ε-reserve eligible]" || PRIOR_NOTE=" [prior known]"
  echo "  #${NUM} score=${ISSUE_SCORE[$NUM]:-?} cost_est=\$${ISSUE_COST_ESTIMATE[$NUM]:-?}${PRIOR_NOTE}"
done
# --- End Step 3E.5 ---
```

**Output state** (consumed by Step 3E and Phase 4):
- `ISSUE_SCORE[N]` — value/cost ratio for each issue
- `ISSUE_COST_ESTIMATE[N]` — estimated spend in USD
- `ISSUE_HAS_PRIOR[N]` — `true` if cost-priors.json had an entry; `false` = no-prior (ε-reserve eligible)
- `SORTED_READY_SET[]` — ready issues sorted by descending score (used in Step 3E plan table and Phase 4 dispatch loop)
- `NO_PRIOR_ISSUES[]` — issues with no cost history (a subset of `SORTED_READY_SET` + blocked issues)

**Important**: `ISSUE_SCORE[]` and `ISSUE_COST_ESTIMATE[]` are also set for blocked issues (for reporting). The sorted order only affects the ready-set — blocked issues dispatch when their predecessors complete, regardless of score.

### Step 3E: Present the plan to the user

```
## Orchestration Plan

**Scope**: {milestone name / "N issues" / "fast-lane"}
**Total issues**: {count} ({investigation_count} investigations + {implementation_count} implementations)
**Execution model**: Dependency-graph streaming (issues dispatch as predecessors complete)

{IF investigations exist:}
### Investigations (run first, may spawn new issues)
| # | Title | Expected Output |
|---|-------|----------------|
| #{INV1} | {title} | New issues → folded into dependency graph |

### Implementation (after investigations complete)
{END IF}

### Domain Distribution
| Domain | Issues | Notes |
|--------|--------|-------|
| FRONTEND | {N} | {Independent pages / Shared components} |
| BILLING | {N} | {Critical — dispatches immediately} |
| DATABASE | {N} | {Serialized chain — migration order matters} |
| AUTH | {N} | {Critical — dispatches immediately} |
| WORKER | {N} | {High overlap risk within worker service} |
| AI | {N} | {Independent} |
| INFRA | {N} | {Independent} |

(Omit rows with 0 issues. Add project-specific domain rows from forge.yaml → review.domains.)

### Dependency Graph

| Issue | Predecessors | Domain | Score | Est. Cost | Status |
|-------|-------------|--------|-------|-----------|--------|
| #{A} | — | FRONTEND | {score} | ${cost} | Ready (dispatches 1st by score) |
| #{B} | — | BILLING | {score} | ${cost} | Ready (dispatches 2nd by score) |
| #{C} | — | WORKER | {score} | ${cost} [ε] | Ready (dispatches 3rd — ε-reserve) |
| #{D} | #{A} | FRONTEND | {score} | ${cost} | Blocked (waits for #{A} only) |
| #{E} | — | DATABASE | {score} | ${cost} | Ready (dispatches 4th by score) |
| #{F} | #{E} | DATABASE | {score} | ${cost} | Blocked (serialized — waits for #{E}) |

**[ε]** = no cost prior; eligible for exploration reserve (10% of budget guaranteed for these)

**Score** = value / estimated_cost (value = priority_weight × danger_zone_weight; higher = dispatches first within the ready-set)
**Est. Cost** = cost-prior mean for (task_type × module), or label heuristic if no prior

**Critical path**: #{E} → #{F} (2 steps, determines minimum wall-clock time)
**Initial dispatch**: #{A}, #{B}, #{C}, #{E} (all predecessors resolved — ordered by score)
**Streaming**: #{D} dispatches as soon as #{A} completes — does NOT wait for #{B}, #{C}, or #{E}

**Note**: Investigations may create additional issues that will be automatically added to the dependency graph. The final graph will be confirmed after investigations complete.

**Excluded** (already in progress / ineligible):
- #{X} — {reason}

{IF EXCLUDED_CYCLE is non-empty:}
### ⚠ Circular Dependencies Detected — Manual Fix Required

The following issues form a circular dependency chain and **cannot be dispatched** until the cycle is resolved:

| Issue | Depends On | Problem |
|-------|------------|---------|
{rows: each EXCLUDED_CYCLE issue, its predecessor list, "mutual dependency — forms cycle with #{other}"}

**Action required**: Edit each issue's body to remove or correct the `Depends on` / `Blocked by` declarations so no cycle exists. Each issue has been labeled `needs-human`. After fixing, re-run `/orchestrate` to dispatch them.
{END IF}

Proceed? (yes / adjust / pick specific issues)
```

**Wait for user confirmation before spawning agents.** This is the checkpoint — once agents launch, they run autonomously.

**After confirmation**: If investigations exist, execute Phase 2B-E first. Then re-present the expanded plan (with newly spawned issues added to the dependency graph) for a quick confirmation before launching implementation.

---

## Engine mode (default)

Dispatch each issue via the durable execution engine. This is the **default execution mode** for both interactive (`/autopilot`, `/orchestrate`) and headless/CI paths:

```bash
forgedock run-issue <issue> --lane <staging|milestone/slug>
```

The engine drives every phase transition deterministically, mirrors state to the `FORGE:STATE` block on the issue, and holds a lease. Its **fail-closed review gate** (`phases.mjs → detectOutcome`) means the PR must be confirmed merged before the phase is committed — missing or unparseable review comments are treated as failures, not approvals. To recover stalls, scan in-flight issues' `FORGE:STATE`; any issue with an expired lease and a non-terminal state is re-dispatched with the same `forgedock run-issue <issue>` command — it resumes from the last committed phase (idempotent). This replaces the label-heuristic "already in progress" check and the resume-with-nagging loop.

**Why engine-first**: The engine's phase table enforces gate semantics in code — not via LLM interpretation of markdown specs. This eliminates the class of bug where the LLM assumes a review approved when the FORGE:REVIEW comment is absent or unreadable (issue #1714). Interactive sessions that run `/work-on` via Skill invocations additionally bridge to the engine run-log via the SubagentStop hook (`bin/hooks/interactive-engine.mjs`) — state is durable across compaction and context resets.

**Fallback (no forgedock CLI)**: If `forgedock` is not in PATH, fall back to spawning Agent sub-agents that run `Skill("work-on", ...)` per issue. The SubagentStop hook still bridges these runs to the engine run-log for state persistence.

### Concurrency model: in-process worker pool + worktree-per-issue

**Decision** (recorded 2026-07-04, issue #1324): The durable engine uses an **in-process worker pool** model — a single control plane dispatches and monitors all concurrent issues, each isolated in its own git worktree.

**Rationale over process-per-issue:**
- Worktree isolation primitive already ships: `scripts/worktree-lifecycle.sh` (`ensure`/`cleanup` subcommands, merged #1268) provides deterministic filesystem isolation without forking a separate OS process per issue.
- A single control plane can enforce **shared rate-limit backpressure** across all in-flight issues; per-process models require IPC to share API quota state.
- Co-ordination primitives (DAG ready-set, completion callbacks, lease renewal) live in one place with no cross-process synchronisation overhead.
- Aligns with the engine-first inversion (#1256): the engine owns correctness; the spec owns routing.

**Filesystem isolation**: Before dispatching each issue, the engine calls:
```bash
scripts/worktree-lifecycle.sh ensure <issue-number> <lane>
# → creates or reuses .forgedock/worktrees/issue-<number>/
```
On completion or failure:
```bash
scripts/worktree-lifecycle.sh cleanup <issue-number>
```

**Concurrency cap** (`forge.yaml → orchestration.max_concurrent`):
- Default: uncapped — all DAG-ready issues dispatch simultaneously (preserves current behaviour).
- When `max_concurrent: N` is set, the dispatch loop holds at most N in-flight workers. Newly ready issues queue and start as running workers complete.
- Prevents wave-triggered rate-limit storms on large batches (e.g., 40-issue milestone dispatches).

**Rate-limit backpressure** (pre-dispatch gate):

Before dispatching each new worker, the engine runs:
```bash
REMAINING=$(gh api rate_limit --jq '.resources.core.remaining')
RESET_AT=$(gh api rate_limit --jq '.resources.core.reset')
RATE_LIMIT_FLOOR=${FORGE_RATE_LIMIT_FLOOR:-200}

if [ "$REMAINING" -lt "$RATE_LIMIT_FLOOR" ]; then
  echo "GitHub API headroom below floor ($REMAINING < $RATE_LIMIT_FLOOR). Pausing dispatch until reset at $RESET_AT."
  # Pause dispatch loop — already-running workers continue unaffected
  sleep_until "$RESET_AT"
fi
```

- `FORGE_RATE_LIMIT_FLOOR` defaults to 200 remaining requests. Override in `forge.yaml → orchestration.rate_limit_floor`.
- Already-in-flight workers are **never interrupted** by the backpressure gate — only new dispatches pause.
- The gate is re-checked after each worker completion, not on a timer, so dispatch resumes immediately once the floor is cleared.

**Configuration reference** (`forge.yaml`):
```yaml
orchestration:
  max_concurrent: 8          # optional; default: uncapped
  rate_limit_floor: 200      # optional; default: 200
```

---

## Background Dispatch Mode <!-- Added: forge#1251 -->

This section governs how the orchestrator dispatches DAG-ready issues as background agents and how it handles wake/compaction recovery. Read it before every Phase 4 dispatch decision.

### Feature gate

Background dispatch (via `run_in_background=true` on each `Agent()` call) is the primary dispatch path. It is enabled when **both** of the following conditions hold:

1. **Version**: Claude Code >= v2.1.186 (the release that introduced background subagents with proper `agent_completed` completion notifications and the Notification hook). Below this version, background agents may not surface completion events correctly.
2. **Env var**: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is **not** set (or is empty).

Check both at the start of Phase 4, before the first dispatch:

```bash
# Feature gate check — run once before Phase 4 dispatch begins
BACKGROUND_DISPATCH_ENABLED=true

if [ -n "${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:-}" ]; then
  echo "Background dispatch disabled: CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is set."
  BACKGROUND_DISPATCH_ENABLED=false
fi

# Version check: if the Claude Code version can be read, compare it.
# If the version cannot be determined, default to ENABLED (optimistic).
CC_VERSION=$(claude --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' | head -1 || echo "")
if [ -n "$CC_VERSION" ]; then
  # Compare major.minor.patch numerically
  IFS='.' read -r CC_MAJOR CC_MINOR CC_PATCH <<< "$CC_VERSION"
  if [ "$CC_MAJOR" -lt 2 ] || \
     { [ "$CC_MAJOR" -eq 2 ] && [ "$CC_MINOR" -lt 1 ]; } || \
     { [ "$CC_MAJOR" -eq 2 ] && [ "$CC_MINOR" -eq 1 ] && [ "$CC_PATCH" -lt 186 ]; }; then
    echo "Background dispatch disabled: Claude Code ${CC_VERSION} < v2.1.186."
    BACKGROUND_DISPATCH_ENABLED=false
  fi
fi
```

**When `BACKGROUND_DISPATCH_ENABLED=false`**: fall back to the current streaming dispatch behavior — `run_in_background=true` is still set on each `Agent()` call (existing behavior, already correct), but treat completions as synchronous and do not rely on `agent_completed` notifications. Poll issue labels for terminal state instead.

**When `BACKGROUND_DISPATCH_ENABLED=true`**: use `run_in_background=true` (already in the Step 4A Agent() template) and react to `agent_completed` notifications as documented in Step 4B. Do NOT poll.

### Orchestrator state reconstruction on wake / after compaction

The orchestrator context window must stay small regardless of how many issues have been dispatched. Achieving this requires that all dispatch state is stored on GitHub — not in the orchestrator's context.

**Contract**: After any compaction event or orchestrator wake (session resumed after idle/restart), do NOT rely on in-context variables. Instead, reconstruct the DAG dispatch state from GitHub before checking for newly ready issues:

This reconstruction MUST use the same three-way **DONE / GATED / FAILED** predecessor classification defined in `phase-4-execution.md` Step 4B ("Predecessor Classification") — not a binary terminal/non-terminal grep. A binary grep is exactly the bug forge#1812 fixed: it let `needs-human` simultaneously satisfy "predecessor is done, dispatch the successor" (this block, pre-fix) and "predecessor failed, skip the successor" (Step 4B's failure handler, pre-fix) — with no way to represent "predecessor is human-gated, its PR is still open, and its dependents should wait but not be abandoned." That third case is exactly what wake/compaction reconstruction hits most often, since a merge approved by a human typically happens *after* the orchestrator session that dispatched the predecessor has already ended — this block, not the live Step 4B loop, is the realistic trigger point for "gating PR merged while nobody was watching."

```bash
# Reconstruct dispatch state from GitHub after compaction / wake
# Run this block at the top of every resumed Phase 4 loop iteration.

# 1. Re-fetch all issue labels and classify each into DONE / GATED / FAILED / IN_PROGRESS
#    (same classify_predecessor_state() function defined in phase-4-execution.md Step 4B —
#    re-declare it here if this block runs in a fresh context that hasn't sourced Step 4B yet).
declare -A ISSUE_CLASS
DONE_ISSUES=()
GATED_ISSUES=()
FAILED_ISSUES=()
ACTIVE_ISSUES=()   # IN_PROGRESS — still mid-pipeline, not yet terminal-for-this-agent

for NUM in {all_issue_numbers_in_batch}; do
  CLASS=$(classify_predecessor_state "$NUM")
  ISSUE_CLASS["$NUM"]="$CLASS"
  case "$CLASS" in
    DONE) DONE_ISSUES+=("$NUM") ;;
    GATED) GATED_ISSUES+=("$NUM") ;;
    FAILED) FAILED_ISSUES+=("$NUM") ;;
    *) ACTIVE_ISSUES+=("$NUM") ;;
  esac
done

# 2. Re-derive the ready set: any non-terminal issue whose predecessors are ALL classified DONE.
#    A GATED predecessor blocks dispatch but does NOT fail the dependent — see step 2.5 below.
READY_ISSUES=()
NEWLY_BLOCKED=()   # dependents whose gating predecessor is GATED — need blocked-on-human-merge tracking
for NUM in "${ACTIVE_ISSUES[@]}"; do
  ALL_PREDS_DONE=true
  GATING_PRED=""
  for PRED in {predecessors_of_NUM}; do
    case "${ISSUE_CLASS[$PRED]:-IN_PROGRESS}" in
      DONE) ;;
      GATED) ALL_PREDS_DONE=false; GATING_PRED="$PRED" ;;
      *) ALL_PREDS_DONE=false ;;
    esac
  done
  if [ "$ALL_PREDS_DONE" = "true" ]; then
    READY_ISSUES+=("$NUM")
  elif [ -n "$GATING_PRED" ]; then
    NEWLY_BLOCKED+=("$NUM|$GATING_PRED")
  fi
done

# 2.5. Track newly-blocked dependents (mirrors phase-4-execution.md Step 4B item 6.5)
# Self-heal the label if not yet bootstrapped (same pattern as review-pr.md 6C / phase-4-execution.md item 6.5).
gh label create "blocked-on-human-merge" --color "006B75" --description "Dependent of a gated (needs-human/awaiting-merge) predecessor. Managed by ForgeDock." --force -R {GH_REPO} 2>/dev/null
for ENTRY in "${NEWLY_BLOCKED[@]:-}"; do
  [ -z "$ENTRY" ] && continue
  DEP="${ENTRY%%|*}"
  PRED="${ENTRY##*|}"
  # Anchor on the exact "**Gating predecessor**: #N" label with a word boundary —
  # a bare contains("#N") substring would false-match #50/#500 for predecessor #5. <!-- forge#1830 -->
  ALREADY_TRACKED=$(gh api repos/{GH_REPO}/issues/${DEP}/comments \
    --jq --arg prednum "${PRED}" '[.[] | select(.body | contains("FORGE:BLOCKED_ON_HUMAN_MERGE") and test("Gating predecessor\\*\\*: #" + $prednum + "\\b"))] | length' 2>/dev/null || echo "0")
  if [ "$ALREADY_TRACKED" -eq 0 ]; then
    GATING_PR=$(gh pr list -R {GH_REPO} --state open --search "\"Closes #${PRED}\" in:body" \
      --json number --jq '.[0].number // empty' 2>/dev/null || echo "")
    gh issue comment "$DEP" -R {GH_REPO} --body "<!-- FORGE:BLOCKED_ON_HUMAN_MERGE -->
**Gating predecessor**: #${PRED} (state: \`${ISSUE_CLASS[$PRED]}\`${GATING_PR:+, open PR #${GATING_PR}})
**Status**: Detected on orchestrator wake/compaction reconstruction. Ready to dispatch as soon as #${PRED} reaches \`workflow:merged\`."
    gh issue edit "$DEP" -R {GH_REPO} --add-label "blocked-on-human-merge" 2>/dev/null || true
  fi
done

# 3. Merge-triggered wake: any issue tracked as blocked-on-human-merge whose gating predecessor
#    is now DONE gets un-blocked and added to the ready set. This is the wake-time equivalent of
#    phase-4-execution.md Step 4B item 6.6 — it is what makes "auto-dispatch on merge, no manual
#    /orchestrate re-run" hold true even when the merge happened after the session ended.
BLOCKED_NOW=$(gh issue list -R {GH_REPO} --state open --label "blocked-on-human-merge" --json number \
  --jq '.[].number' 2>/dev/null || echo "")
for DEP in $BLOCKED_NOW; do
  # Read which predecessor(s) this DEP is tracked against
  GATING_PREDS_RAW=$(gh api repos/{GH_REPO}/issues/${DEP}/comments \
    --jq '[.[] | select(.body | contains("FORGE:BLOCKED_ON_HUMAN_MERGE")) | (.body | capture("Gating predecessor\\*\\*: #(?<p>[0-9]+)").p)]' 2>/dev/null || echo '[]')
  STILL_GATED=false
  for GPRED in $(echo "$GATING_PREDS_RAW" | jq -r '.[]' 2>/dev/null); do
    GPRED_CLASS=$(classify_predecessor_state "$GPRED")
    [ "$GPRED_CLASS" != "DONE" ] && STILL_GATED=true
  done
  if [ "$STILL_GATED" = "false" ]; then
    gh issue edit "$DEP" -R {GH_REPO} --remove-label "blocked-on-human-merge" 2>/dev/null || true
    gh issue comment "$DEP" -R {GH_REPO} --body "<!-- FORGE:UNBLOCKED -->
All gating predecessor(s) reached \`workflow:merged\` (detected on orchestrator wake) — dispatching now."
    READY_ISSUES+=("$DEP")
  fi
done

# 4. Dispatch the reconstructed ready set (DONE_ISSUES-unblocked + merge-triggered-woken) via the
#    standard Step 4A.pre.0 → 4A.pre → 4A flow. FAILED_ISSUES' transitive dependents remain marked
#    "skipped — dependency failed" per phase-4-execution.md Step 4B item 6 — do not re-add them here.
```

**Why this keeps context small**: Each `Agent()` call returns an agent ID stored only in `AGENT_ISSUE_MAP`, which is rebuilt per Step 4A.pre dispatch batch. After compaction, the map is gone — but the DAG state, including `blocked-on-human-merge` tracking (a durable `FORGE:BLOCKED_ON_HUMAN_MERGE` comment plus label, not an in-context variable), is fully on GitHub. The reconstruction above re-derives the ready set, the gated set, and the blocked-on-human-merge set from labels and comments alone, so the orchestrator context never needs to hold cumulative dispatch history.

---

