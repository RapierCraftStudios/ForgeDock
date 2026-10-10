---
user-invocable: false
description: Investigate a GitHub issue — validate it's real, determine root cause, post findings
argument-hint: "{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\""
context: fork
background: false
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /work-on:investigate — Issue Investigation Subcommand

**Input**: $ARGUMENTS

> **Transient GitHub failures** (field test: a 12-minute GitHub HTTP 500 window parked an issue at needs-human): retry any `gh` call that fails with HTTP 5xx, a timeout or "Something went wrong" up to 3 times with 10s/30s/60s backoff. If it still fails, do NOT add `needs-human` — print this phase's RESULT block with `status: BLOCKED` and a blocker that starts with `github-unavailable:`. The router retries the phase; every phase resumes from GitHub state, so a retry is safe.


Standalone investigation phase for the work-on pipeline. Validates whether an issue is real, determines root cause, posts a structured FORGE:INVESTIGATOR comment to GitHub, and updates workflow labels.

This skill runs in an **isolated forked context**: it sees only this file and its args. It has no variables from the caller — every other piece of state is re-read from GitHub/git here. It ends by printing exactly one `INVESTIGATE_RESULT:` block (see `## Output`) as its final reply, on **every** exit path (success, ALREADY_DONE, INVALID, BLOCKED).

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154. This file's mechanical bits (1A label set, 1D label transitions) stay at this tier because they're interleaved with the reasoning-heavy investigation steps in the same forked `Skill()` invocation. <!-- Added: forge#1827 -->
**NEVER use plan mode (EnterPlanMode).**

<!-- FORGE:SPEC_LOADED — work-on/investigate.md loaded and active. Agent is bound by this spec. -->

---

## Inputs

Parse from $ARGUMENTS (`{NUMBER} --repo {GH_REPO} --gh-flag "{GH_FLAG}"`):
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo (e.g. `{owner}/{repo}`)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag (e.g. `-R {owner}/{repo}`)

The router passes all three. If `--repo` / `--gh-flag` are absent (standalone use), resolve them from `forge.yaml → project`.

**Fail closed**: if `{NUMBER}` is missing/non-numeric, or `{GH_REPO}` cannot be determined, print the result block below and stop — do not guess:

```
INVESTIGATE_RESULT:
  status: BLOCKED
  verdict: null
  confidence: null
  decompose: null
  comment_url: null
  gist_url: null
  milestone_index_url: null
  blocker: missing required arg: <which one>
```

**Execution order**: run the Phase 1A resume check FIRST. If it reports ALREADY_DONE, print that result and stop — skip Phases 0.5, 0.6 and everything else. Otherwise run 0.5 → 0.6 → 1A (label) → 1A.5 → 1B → 1C → 1C.5 → 1C.6 → 1D.

---

## Script resolution

**Shell state does not persist between Bash tool calls** (each call is a fresh shell): paste the block below at the top of every bash command in this skill that calls `resolve_script` or uses `FORGE_ROOT`/`UNIVERSAL_DIR`.

```bash
# Canonical script resolution (keep byte-identical across specs; guarded by scripts/forge-root.test.sh).
# Shell state does NOT persist between Bash tool calls: include this whole block at the top of
# every command that uses resolve_script or FORGE_ROOT.
REPO_PATH="${REPO_PATH:-$(yq '.paths.root // ""' forge.yaml 2>/dev/null)}"
[ -n "$REPO_PATH" ] && [ "$REPO_PATH" != "null" ] || REPO_PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ADAPTIVE_DIR_RAW="${REPO_PATH}/$(yq '.adaptive_scripts.directory // ".forgedock/scripts"' forge.yaml 2>/dev/null || echo '.forgedock/scripts')"
ADAPTIVE_DIR=$(realpath -m "$ADAPTIVE_DIR_RAW" 2>/dev/null || echo "$ADAPTIVE_DIR_RAW")
ADAPTIVE_ENABLED=$(yq '.adaptive_scripts.enabled // "true"' forge.yaml 2>/dev/null || echo 'true')
# Bounds check: reject adaptive_scripts.directory values that escape the repo root.
# Normalize REPO_PATH the same way ADAPTIVE_DIR is normalized (realpath -m) so a trailing
# slash in paths.root does not inject a '//' into the glob and trigger a false positive.
REPO_PATH_NORM=$(realpath -m "$REPO_PATH" 2>/dev/null || echo "$REPO_PATH")
if [[ "$ADAPTIVE_DIR" != "${REPO_PATH_NORM}/"* ]]; then
  echo "WARNING: adaptive_scripts.directory resolves outside repo root ('$ADAPTIVE_DIR') — adaptive tier disabled" >&2
  ADAPTIVE_ENABLED=false
fi
# ForgeDock's own install root (holds scripts/ and commands/), resolved ONCE by the canonical bootstrap
# below — never the consumer repo: plugin installs set neither FORGE_HOME nor FORGEDOCK_HOME, and a
# repo-relative fallback would execute (or miss) a same-named script controlled by the consumer repo.
# Resolution: $FORGEDOCK_HOME (authoritative when set) > $FORGE_HOME > $CLAUDE_PLUGIN_ROOT > the
# ~/.claude/commands symlink target > the Claude Code plugin cache/marketplace dirs. <!-- forge#3098 -->
# FORGE_ROOT bootstrap (canonical; keep byte-identical across specs, guarded by scripts/forge-root.test.sh)
FORGE_ROOT=""
# Windows drive-letter FORGEDOCK_HOME (C:/x or C:\x) is normalized to /c/x (cygpath when present); relative values stay rejected.
_h="${FORGEDOCK_HOME:-}"; case "$_h" in [A-Za-z]:[/\\]*) _w="$_h"; _h="$(cygpath -u "$_w" 2>/dev/null || true)"; [ -n "$_h" ] || _h="/$(printf %s "$_w" | cut -c1 | tr 'A-Z' 'a-z')$(printf %s "${_w#??}" | tr '\\' '/')" ;; esac
# Only the official marketplace is trusted (name pinned; override only via the trusted FORGEDOCK_MARKETPLACE env, never repo files).
_mk="${FORGEDOCK_MARKETPLACE:-forgedock}"; case "$_mk" in ""|.|..|*[!A-Za-z0-9._-]*) _mk="forgedock" ;; esac
if [ -n "${FORGEDOCK_HOME:-}" ]; then case "$_h" in /*) FORGE_ROOT="$_h" ;; esac; else
  # Portable to bash 3.2 (macOS), BSD/GNU coreutils and zsh: no mapfile, no sort -V, no bare globs (zsh aborts on no match). Every assignment ends in || true so the block survives set -e / pipefail.
  _l="$HOME/.claude/commands/work-on.md"; _l="$(readlink -f "$_l" 2>/dev/null || readlink "$_l" 2>/dev/null || true)"; [ -n "$_l" ] && _l="$(dirname "$(dirname "$_l")")"
  # Codex: install-codex.sh records the clone path in $CODEX_HOME/forge-home (one absolute path); skills are generated files, not symlinks.
  _cx="${CODEX_HOME:-$HOME/.codex}"; case "$_cx" in /*) _x="$(head -n 1 "$_cx/forge-home" 2>/dev/null || true)" ;; *) _x="" ;; esac
  # newest cached version first: numeric major.minor.patch of the version dir name only (non-semver names such as commit SHAs are skipped); a release outranks its pre-release (1.10.0 > 1.9.0 > 1.9.0-rc1)
  _v="$(find -L "$HOME/.claude/plugins/cache" -mindepth 3 -maxdepth 3 -type d 2>/dev/null | awk -F/ -v mk="$_mk" '$(NF-2)==mk && $(NF-1)=="forgedock" && $NF ~ /^[0-9]+\.[0-9]+\.[0-9]+(-.*)?$/{v=$NF;p=index(v,"-");r=1;if(p){v=substr(v,1,p-1);r=0};split(v,a,".");printf "%d %d %d %d %s\n",a[1],a[2],a[3],r,$(0)}' | sort -k1,1nr -k2,2nr -k3,3nr -k4,4nr | cut -d' ' -f5- || true)"
  _m="$HOME/.claude/plugins/marketplaces/$_mk"
  # '${CLAUDE_PLUGIN_ROOT}' is substituted by Claude Code when it loads a plugin spec (the exact spelling only, never as an env var), so a running plugin resolves to its own root first; unsubstituted (other runtimes) it stays a literal that the /* check rejects.
  _k="$(printf '%s\n' '${CLAUDE_PLUGIN_ROOT}' "${FORGE_HOME:-}" "$_l" "$_x" "$_v" "$_m")"
  while IFS= read -r _c; do
    case "$_c" in /*) [ -z "$FORGE_ROOT" ] && [ -f "$_c/scripts/verify-phase-trail.sh" ] && [ -f "$_c/scripts/lint-dispatch-prompt.sh" ] && [ -f "$_c/scripts/is-docs-only.sh" ] && [ -f "$_c/bin/engine/resolve.mjs" ] && [ -f "$_c/bin/engine/orchestrate-canary.mjs" ] && [ -f "$_c/bin/engine/admission.mjs" ] && FORGE_ROOT="$_c" ;; esac
  done <<< "$_k"
fi
UNIVERSAL_DIR="${FORGE_ROOT:+$FORGE_ROOT/scripts}"   # empty => tier 3 skipped, prose tier
# NOTE: never resolve this via `which` or `find` — universal scripts are
# install-relative, not installed on $PATH, so a PATH lookup always misses.
# FORGE_ROOT (above) is the deterministic resolution; there is NO repo-path fallback.
# Pipeline agents MUST NOT use `find` (unbounded or filesystem-wide) to
# locate pipeline scripts under any circumstances: if UNIVERSAL_DIR/${operation}.sh
# does not exist, resolve_script() falls through to Tier 4 (prose) below,
# which is always safe and available. A missing script is never a reason
# to search the filesystem. <!-- Added: forge#1984 -->

resolve_script() {
  local operation="${1}"
  # Tier 2: per-repo adaptive (skip if disabled)
  if [ "$ADAPTIVE_ENABLED" != "false" ] && [ -f "${ADAPTIVE_DIR}/${operation}.sh" ]; then
    echo "adaptive:${ADAPTIVE_DIR}/${operation}.sh"
    return
  fi
  # Tier 3: universal script
  if [ -n "$UNIVERSAL_DIR" ] && [ -f "${UNIVERSAL_DIR}/${operation}.sh" ]; then
    echo "universal:${UNIVERSAL_DIR}/${operation}.sh"
    return
  fi
  # Tier 4: prose fallback
  echo "prose:"
}
```


## Phase 0.5: Memory Retrieval — Prior Run Priors <!-- Added: forge#1316 -->

**Goal**: Before investigating, retrieve the top-k relevant prior pipeline runs from the per-repo memory index. Inject confirmed priors into the investigation context so the pipeline compounds intelligence across runs.

**This phase is non-blocking** — if the memory index is absent or retrieval fails, log the reason and proceed to Phase 1A. Never stall the pipeline for memory.

**Note on Gist visibility (forge#1587)**: The memory-index Gist is created **secret** (see `close.md` Phase C5.2 — no `--public` flag). `gh gist list` and `gh gist view` operate against the authenticated user's own Gists by description/id regardless of public/secret status, so the retrieval steps below work unchanged against a secret Gist. No code change is needed here — this note exists only so a future edit doesn't reintroduce a "must be public to be readable" assumption.

### Step 1: Locate memory index Gist

The memory index is a GitHub Gist tagged `<!-- FORGE:MEMORY_INDEX: {GH_REPO} -->`. Find it:

```bash
MEMORY_INDEX_URL=$(gh gist list --limit 100 \
  --jq '.[] | select(.description | contains("FORGE:MEMORY_INDEX: {GH_REPO}")) | .url' 2>/dev/null | head -1)

MEMORY_INDEX_ID=$(gh gist list --limit 100 \
  --jq '.[] | select(.description | contains("FORGE:MEMORY_INDEX: {GH_REPO}")) | .id' 2>/dev/null | head -1)
```

If no memory index found: log `[MEMORY] No memory index for {GH_REPO} — starting fresh` and skip to Phase 1A.

### Step 2: Retrieve relevant priors (top-k similarity)

Read the memory index content:

```bash
MEMORY_CONTENT=$(gh gist view "$MEMORY_INDEX_ID" 2>/dev/null)
```

The memory index is a newline-delimited list of prior run entries, each formatted as:

```
MEMORY_ENTRY: issue={N} title="{TITLE}" domain="{DOMAIN_TAGS}" root_cause="{ROOT_CAUSE_SUMMARY}" outcome="{merged|invalid|blocked}" files="{AFFECTED_FILES}" lesson="{KEY_LESSON_ONE_LINE}" timestamp={ISO}
```

**Retrieve top-3 relevant priors** by matching against the current issue title and body:

1. Extract keywords from the current issue title: lowercase, remove stop words, keep noun/verb tokens
2. Score each memory entry: +2 for a file path overlap, +1 per keyword match in title/root_cause/lesson
3. Return the top-3 highest-scoring entries (minimum score ≥ 1 to filter noise)

If no entries score ≥ 1: log `[MEMORY] No relevant priors found` and skip to Phase 1A.

### Step 3: Inject priors into investigation context

For each retrieved prior, emit a structured block that Phase 1B can reference:

```
[MEMORY PRIOR #{RANK}]
Issue: #{issue} — {title}
Root cause: {root_cause}
Outcome: {outcome}
Key lesson: {lesson}
Affected files: {files}
```

Print these blocks to stdout before Phase 1A begins. During Phase 1B (step 3 — blame analysis and step 5 — pickaxe pass), **explicitly check whether the current issue's suspected symbol or file appears in any prior root cause or affected files**. If a match is found, cite it in the FORGE:INVESTIGATOR comment's History Findings field as a `[MEMORY PRIOR]` hit.

---

## Phase 0.6: Forge Ledger Pre-Recall <!-- Added: forge#1740 -->

**Goal**: Query the Forge Ledger knowledge index for prior cards matching this issue's title terms, affected files, and symbols — **before reading any code**. Inject above-threshold results with explicit delta-verification framing so the investigator builds on prior knowledge rather than re-deriving it.

**This phase is non-blocking** — if the index is absent, empty, or returns no match above threshold, log a single line and proceed to Phase 1A. Never stall the pipeline for recall.

**Relationship to Phase 0.5**: Phase 0.5 retrieves structured priors from the Gist-based FORGE:MEMORY_INDEX (coarse keyword scoring over MEMORY_ENTRY lines). Phase 0.6 queries the Forge Ledger index (BM25 over structured knowledge cards, indexed by `build-knowledge-index.mjs`). Both are complementary and both run — neither replaces the other.

### Step 1: Probe for index

```bash
RECALL_PATH="${REPO_PATH:-$(git rev-parse --show-toplevel 2>/dev/null)}/bin/recall.mjs"
LEDGER_AVAILABLE=0

if [ -f "$RECALL_PATH" ]; then
  # Quick probe: does the index exist and have at least one card?
  PROBE=$(node "$RECALL_PATH" --doctor 2>/dev/null | grep "^Total cards:" | grep -v "^Total cards:    0" || true)
  [ -n "$PROBE" ] && LEDGER_AVAILABLE=1
fi

if [ "$LEDGER_AVAILABLE" -eq 0 ]; then
  echo "[recall] Forge Ledger index absent or empty — skipping Phase 0.6, proceeding to Phase 1A"
  # → Continue to Phase 1A
fi
```

### Step 2: Build combined query (title terms + symbols + affected files)

Extract query components from the issue body and title. The recall CLI accepts free text (BM25 ranked) plus repeated `--file` flags (exact-match boost):

```bash
# Extract title keywords: lowercase, remove stop words, keep noun/verb tokens (≥4 chars)
ISSUE_TITLE=$(gh issue view {NUMBER} {GH_FLAG} --json title --jq '.title' 2>/dev/null || echo '')
TITLE_TERMS=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' \
  | sed 's/[^a-z0-9 ]/ /g' \
  | tr ' ' '\n' \
  | grep -E '^[a-z]{4,}$' \
  | grep -vE '^(with|that|this|from|into|have|will|when|then|than|them|they|been|were|also|only|does|some|each|more|over|such|both|most|other|many|after|about|should|would|could|their|these|those|which|where|there|being|while|using|since|until|before|under|above)$' \
  | sort -u | head -10 | tr '\n' ' ' | xargs)

# Extract affected files from the issue body's ## Affected Files section
ISSUE_BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body' 2>/dev/null || echo '')
AFFECTED_FILES_RAW=$(echo "$ISSUE_BODY" \
  | sed -n '/^## Affected Files/,/^## /p' \
  | grep -oE '`[^`]+\.(md|mjs|js|ts|py|sh|yaml|yml|json)`' \
  | tr -d '`' | sort -u | head -5)

# Extract symbols: backtick-quoted identifiers from the issue body (≥4 chars, camelCase or snake_case)
SYMBOLS_RAW=$(echo "$ISSUE_BODY" \
  | grep -oE '`[A-Za-z_][A-Za-z0-9_]{3,}`' \
  | tr -d '`' | sort -u | head -5)

# Build --file flags (one per affected file)
FILE_FLAGS=""
while IFS= read -r f; do
  [ -n "$f" ] && FILE_FLAGS="$FILE_FLAGS --file $f"
done <<< "$AFFECTED_FILES_RAW"

# Build --symbol flag (first symbol only — recall supports one --symbol)
SYMBOL_FLAG=""
FIRST_SYMBOL=$(echo "$SYMBOLS_RAW" | head -1)
[ -n "$FIRST_SYMBOL" ] && SYMBOL_FLAG="--symbol $FIRST_SYMBOL"
```

### Step 3: Run recall query and capture results

```bash
RECALL_RESULTS=""
RECALL_ISSUE_CITATIONS=""

if [ "$LEDGER_AVAILABLE" -eq 1 ] && [ -n "$TITLE_TERMS$FILE_FLAGS$SYMBOL_FLAG" ]; then
  echo "[recall] Querying Forge Ledger: terms='${TITLE_TERMS}' files='${AFFECTED_FILES_RAW}' symbol='${FIRST_SYMBOL}'"

  # Run combined query: title terms (free text) + file flags + symbol + min-score threshold
  # --json for machine-readable output; --min-score 0.3 filters weak matches (noise gate)
  RECALL_JSON=$(node "$RECALL_PATH" \
    $TITLE_TERMS \
    $FILE_FLAGS \
    $SYMBOL_FLAG \
    --k 5 \
    --min-score 0.3 \
    --json \
    2>/dev/null || echo '[]')

  # Count results
  RECALL_COUNT=$(echo "$RECALL_JSON" | node -e "
    let d = ''; process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try { console.log(JSON.parse(d).length); } catch { console.log(0); }
    });
  " 2>/dev/null || echo "0")

  if [ "${RECALL_COUNT:-0}" -gt 0 ]; then
    echo "[recall] Found ${RECALL_COUNT} prior card(s) above threshold — injecting with delta-verification framing"

    # Extract issue citations for the Prior Investigations field in the FORGE:INVESTIGATOR comment
    RECALL_ISSUE_CITATIONS=$(echo "$RECALL_JSON" | node -e "
      let d = ''; process.stdin.on('data', c => d += c);
      process.stdin.on('end', () => {
        try {
          const cards = JSON.parse(d);
          const seen = new Set();
          const cites = cards
            .filter(c => { if (seen.has(c.issue)) return false; seen.add(c.issue); return true; })
            .map(c => '#' + c.issue)
            .join(', ');
          console.log(cites);
        } catch { console.log(''); }
      });
    " 2>/dev/null || echo '')

    # Format cards as human-readable text for injection (not raw JSON)
    RECALL_FORMATTED=$(echo "$RECALL_JSON" | node -e "
      let d = ''; process.stdin.on('data', c => d += c);
      process.stdin.on('end', () => {
        try {
          const cards = JSON.parse(d);
          const lines = [];
          for (const c of cards) {
            lines.push('── ' + c.kind.toUpperCase() + ' from #' + c.issue + ' (score: ' + c.score.toFixed(2) + ') ──');
            if (c.rootCause)  lines.push('Root Cause: ' + c.rootCause);
            if (c.prevention) lines.push('Fix/Prevention: ' + c.prevention);
            if (c.pattern)    lines.push('Pattern: ' + c.pattern);
            if (c.verdict)    lines.push('Verdict: ' + c.verdict + ' (' + (c.confidence || '?') + ')');
            if (c.paths && c.paths.length) lines.push('Files: ' + c.paths.slice(0,3).join(', '));
          }
          console.log(lines.join('\n'));
        } catch (e) { console.log(''); }
      });
    " 2>/dev/null || echo '')

    # Cap at ≤ 2K chars (same budget as context C0 Gist summaries)
    RECALL_RESULTS=$(echo "$RECALL_FORMATTED" | head -c 2048)
  else
    echo "[recall] No prior cards above threshold (min-score 0.3) — investigating from scratch"
  fi
fi
```

### Step 4: Inject recall results into investigation context

If `RECALL_RESULTS` is non-empty, print the following block to stdout **before Phase 1A begins**. The investigation steps in Phase 1B MUST treat this as starting context — verify deltas against current code rather than re-deriving the prior model.

**If `RECALL_RESULTS` is empty**: skip this step entirely and proceed to Phase 1A.

```
[FORGE:RECALL_PRIOR — Forge Ledger pre-recall results]
Prior cards matched this issue above threshold (min-score 0.3).

CRITICAL FRAMING: These cards describe prior findings on the same files/symbols.
  → Verify the deltas against current code — do NOT re-derive the prior model.
  → Stale cards (status: stale) are excluded by default — the query runs without
     --include-stale. Do not treat any card as authoritative without confirming
     the finding still exists in the current code.
  → Cite confirmed priors in the FORGE:INVESTIGATOR "Prior Investigations" field.

${RECALL_RESULTS}

[END FORGE:RECALL_PRIOR]
```

Store `RECALL_ISSUE_CITATIONS` in a variable — it is used in Phase 1C to populate the `**Prior Investigations (via recall)**` field in the FORGE:INVESTIGATOR comment.

---

## Phase 1A: Load Issue & Check Resume State

Re-read all state from GitHub (this fork has no inherited context):

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state
```

**Resume check** — run this FIRST (before Phase 0.5):

```bash
COMMENTS_JSON=$(gh api "repos/{GH_REPO}/issues/{NUMBER}/comments" --paginate --jq '.[] | {id: .id, url: .html_url, body: .body}' 2>/dev/null | jq -s '.' 2>/dev/null)
[ -z "$COMMENTS_JSON" ] && COMMENTS_JSON='[]'

# Complete = INVESTIGATOR header AND (COMPLETE or INVALID sentinel) in the SAME comment. Use the last such comment.
DONE_JSON=$(echo "$COMMENTS_JSON" | jq -c '[.[] | select(.body | contains("<!-- FORGE:INVESTIGATOR -->"))
  | select((.body | contains("<!-- INVESTIGATION:COMPLETE -->")) or (.body | contains("<!-- INVESTIGATION:INVALID -->")))] | last // empty')

# Partial = INVESTIGATOR header but NEITHER sentinel (interrupted run)
PARTIAL_IDS=$(echo "$COMMENTS_JSON" | jq -r '.[] | select(.body | contains("<!-- FORGE:INVESTIGATOR -->"))
  | select((.body | contains("<!-- INVESTIGATION:COMPLETE -->") | not) and (.body | contains("<!-- INVESTIGATION:INVALID -->") | not)) | .id')

if [ -n "$DONE_JSON" ]; then
  DONE_BODY=$(echo "$DONE_JSON" | jq -r '.body')
  DONE_URL=$(echo "$DONE_JSON" | jq -r '.url')
  R_VERDICT=$(printf '%s\n' "$DONE_BODY" | grep -oE '\*\*Verdict\*\*: *[A-Za-z_-]+' | head -1 | sed -E 's/.*: *//')
  R_CONF=$(printf '%s\n' "$DONE_BODY" | grep -oE '\*\*Confidence\*\*: *[A-Za-z]+' | head -1 | sed -E 's/.*: *//')
  if printf '%s\n' "$DONE_BODY" | sed -n '/^### Decomposition Assessment/,/^###[^#]/p' | grep -qE '^\*\*YES\*\*'; then R_DECOMP=YES; else R_DECOMP=NO; fi
  [ "$R_VERDICT" = "INVALID" ] && R_STATUS=INVALID || R_STATUS=ALREADY_DONE
  R_GIST=$(echo "$COMMENTS_JSON" | jq -r '[.[] | .body | select(contains("FORGE:KNOWLEDGE_GIST:"))] | first // ""' | grep -oE 'https://gist[^ ]+' | head -1)
  R_MS_NUM=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.number // empty' 2>/dev/null)
  R_MS_IDX=""
  [ -n "$R_MS_NUM" ] && R_MS_IDX=$(gh api "repos/{GH_REPO}/milestones/${R_MS_NUM}" --jq '.description // ""' 2>/dev/null | grep -oE '<!-- FORGE:MILESTONE_INDEX: https://[^ ]+ -->' | head -1 | sed -E 's/^<!-- FORGE:MILESTONE_INDEX: //; s/ -->$//')
  echo "INVESTIGATE_RESULT:"
  echo "  status: $R_STATUS"
  echo "  verdict: ${R_VERDICT:-null}"
  echo "  confidence: ${R_CONF:-null}"
  echo "  decompose: $R_DECOMP"
  echo "  comment_url: $DONE_URL"
  echo "  gist_url: ${R_GIST:-null}"
  echo "  milestone_index_url: ${R_MS_IDX:-null}"
  echo "  blocker: null"
  echo "RESUME: investigation already complete — copy the block above verbatim as your final reply and STOP."
else
  for CID in $PARTIAL_IDS; do
    gh api "repos/{GH_REPO}/issues/comments/${CID}" -X DELETE 2>/dev/null || true   # interrupted investigation: delete partial comment and restart
  done
  echo "RESUME: no completed investigation — proceeding with a fresh run."
fi
```

**Resume logic** (what the block implements):
- `<!-- FORGE:INVESTIGATOR -->` comment AND (`<!-- INVESTIGATION:COMPLETE -->` OR `<!-- INVESTIGATION:INVALID -->`) in the SAME comment → investigation already complete. Print the parsed existing verdict as the `INVESTIGATE_RESULT:` block (`status: ALREADY_DONE`, or `status: INVALID` when the existing verdict is INVALID) and **STOP** — do not run any later phase. `INVESTIGATION:INVALID` is the terminal sentinel Phase 1C emits for an INVALID verdict (see Phase 1C) — it is just as much a completion marker as `INVESTIGATION:COMPLETE`.
- `<!-- FORGE:INVESTIGATOR -->` comment but NEITHER sentinel → investigation was interrupted; the partial comment(s) are deleted and the run restarts.
- No investigator comment → fresh investigation.

**Set label** (only reached when not ALREADY_DONE). Use the tiered transition script; the prose fallback adds `workflow:investigating` and removes every other `workflow:*` state label:

```bash
RESOLUTION=$(resolve_script 'transition-label'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} investigating ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:investigating" --remove-label "workflow:ready-to-build,workflow:building,workflow:in-review,workflow:awaiting-merge,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true   # allowlist:check-command-side-effects
    ;;
esac
```

---

### 1A.5: Normalize Issue Body (MANDATORY)

Before investigation begins, verify the issue body contains the four mandatory pipeline sections. If any are missing, add placeholder content so the investigator has the correct scaffolding.

**Skip if**: All four sections (`## Problem`, `## Affected Files`, `## Expected Behavior`, `## Acceptance Criteria`) are already present.

```bash
ISSUE_BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body')

MISSING_SECTIONS=""
echo "$ISSUE_BODY" | grep -q "^## Problem" || MISSING_SECTIONS="$MISSING_SECTIONS PROBLEM"
echo "$ISSUE_BODY" | grep -q "^## Affected Files" || MISSING_SECTIONS="$MISSING_SECTIONS AFFECTED_FILES"
echo "$ISSUE_BODY" | grep -q "^## Expected Behavior" || MISSING_SECTIONS="$MISSING_SECTIONS EXPECTED_BEHAVIOR"
echo "$ISSUE_BODY" | grep -q "^## Acceptance Criteria" || MISSING_SECTIONS="$MISSING_SECTIONS ACCEPTANCE_CRITERIA"

if [ -n "$MISSING_SECTIONS" ]; then
  echo "Missing sections:$MISSING_SECTIONS — normalizing issue body before investigation"

  APPEND_TEXT=""
  echo "$MISSING_SECTIONS" | grep -q "PROBLEM" && APPEND_TEXT="$APPEND_TEXT
## Problem

Root cause unknown — investigation needed."

  echo "$MISSING_SECTIONS" | grep -q "AFFECTED_FILES" && APPEND_TEXT="$APPEND_TEXT
## Affected Files

Files to be identified during investigation."

  echo "$MISSING_SECTIONS" | grep -q "EXPECTED_BEHAVIOR" && APPEND_TEXT="$APPEND_TEXT
## Expected Behavior

Expected behavior to be determined during investigation."

  echo "$MISSING_SECTIONS" | grep -q "ACCEPTANCE_CRITERIA" && APPEND_TEXT="$APPEND_TEXT
## Acceptance Criteria

- [ ] Fix confirmed during investigation."

  # Append missing sections to the existing body (never replace — only extend)
  NORMALIZED_BODY="${ISSUE_BODY}${APPEND_TEXT}"
  gh issue edit {NUMBER} {GH_FLAG} --body "$NORMALIZED_BODY"   # allowlist:check-command-side-effects
  echo "Issue body normalized — added:$MISSING_SECTIONS"
else
  echo "Issue body already contains all mandatory sections — skipping normalization"
fi
```

**Continue to Phase 1B unconditionally.** Normalization is a compensation step — it never blocks investigation.

---

## Phase 1B: Investigate

**Mission**: Validate whether the issue is real. Assume description is wrong until proven otherwise.

### Resolve target repo and branch

The target repo is `{GH_REPO}` (resolved from `forge.yaml → project`). The working directory is `{REPO_PATH}` (resolved from `forge.yaml → paths.root`).

**Domain-to-files mapping**: The repo's domain structure depends on the project. Before investigating, read the issue body and labels to identify the affected domain. Then look at the repo's directory structure under `{REPO_PATH}` to locate relevant files. Common entry points:
- Command/prompt files: `commands/`, `.claude/commands/`
- Backend services: any `services/`, `routers/`, `core/` directories
- Frontend: any `web/`, `frontend/`, `src/` directories
- Infrastructure: `.github/workflows/`, `docker-compose*.yml`, `infra/`
- Config: `forge.yaml`, `.env.example`, any `config/` directory

Read `forge.yaml → review.tech_stack` and `forge.yaml → review.key_paths` (if present) to identify which files are most relevant for the affected domain. If `review.key_paths` lists domain-to-file mappings, use that table directly. If the `review` section is absent, use the issue labels, title keywords, and the affected files listed in the issue body to determine the domain. Start with the files the issue explicitly names, then expand to callers and related modules.

**Workflow pipeline issues** (repo is a ForgeDock installation):
- Key files: `commands/work-on.md`, `commands/review-pr.md`, `commands/quality-gate.md`, `commands/orchestrate.md`, `forge.yaml`, `bin/forgedock.mjs`

**INFRA domain known footguns** (read before writing any `.github/workflows/*.yml` changes):
- **appleboy/ssh-action Go template preprocessing**: Any `{{` in a `script:` block is interpreted as a Go template directive **before the script reaches SSH**. This means `docker ps --format '{{.Names}}'` and `docker inspect --format '{{index .RepoTags 0}}'` will crash the action with exit 1. Both function calls (`{{index .X Y}}`) AND field accessors (`{{.Names}}`, `{{.Status}}`) fail on the action's empty data context. Shell error handlers (`|| fallback`, `set -e`, `2>/dev/null`) are bypassed because the failure is client-side. Always use `docker inspect IMAGE | jq -r '.[0].RepoTags[0]'` and `docker ps --format json | jq -r '.Names'` patterns in `appleboy/ssh-action` scripts. (Ref: forge#226 — 6-day silent deploy failure masked by `continue-on-error: true`)

If the issue specifies a **Code branch** (`**Code branch**: \`{branch}\``), check out that branch — the affected files may not be on the default branch.

### Code Index Query (run BEFORE any grep exploration)

If `scripts/code-index.sh` exists under `{REPO_PATH}`, query the pre-built symbol/import index first. This yields deterministic answers in one tool call and avoids redundant grep exploration across agents.

```bash
# Step 0A: Ensure index is current (cache-hit on unchanged HEAD — zero cost if already built)
bash {REPO_PATH}/scripts/code-index.sh --repo-path {REPO_PATH} 2>/dev/null || true

# Step 0B: Look up the symbol or file named in the issue (replace {SYMBOL} with the relevant name)
bash {REPO_PATH}/scripts/code-index.sh query --symbol {SYMBOL} --repo-path {REPO_PATH} 2>/dev/null || true

# Step 0C: Find all callers of that symbol
bash {REPO_PATH}/scripts/code-index.sh query --callers {SYMBOL} --repo-path {REPO_PATH} 2>/dev/null || true

# Step 0D: Find all importers of an affected file
bash {REPO_PATH}/scripts/code-index.sh query --importers {AFFECTED_FILE} --repo-path {REPO_PATH} 2>/dev/null || true

# Step 0E: Get all files in the affected domain (from issue labels/body)
bash {REPO_PATH}/scripts/code-index.sh query --domain {DOMAIN_LABEL} --repo-path {REPO_PATH} 2>/dev/null || true
```

**Fallback**: If `scripts/code-index.sh` is absent or returns no results, proceed with standard grep exploration below. The index is an acceleration layer — its absence never blocks investigation.

### Investigation steps

1. **Check the right branch** — read from the branch specified in the issue body (`**Code branch**: \`{branch}\``) if present
2. **Read domain files** — start with the key files for the affected domain (use index query results from Step 0E as the file list; fall back to directory inspection if index is absent)
2.5. **Existing system search (conditional, MUST)**: If the issue describes a gap in a functional capability — content not being distributed, notifications not sending, jobs not running, data not being synced — MUST search for an existing automated system before proposing a new one. The issue body may name a specific tool or path (e.g., `reddit-bot/`, `marketing/`) — do NOT anchor on that path alone. Expand the search to all service layers:
   ```bash
   # Check all service layers for the capability (adapt paths to your project structure)
   grep -rn "{capability_keyword}" {REPO_PATH}/services/ --include="*.py" -l | head -20
   # Look for scheduled jobs, automated runners, existing integrations
   grep -rn "scheduler\|celery\|cron\|nightly\|periodic" {REPO_PATH}/services/ --include="*.py" -l | head -10
   ```
   If an existing system is found that already handles the capability: the fix MUST route through the existing system (fix its config, env var, or gate) — NOT create a new parallel tool. Document the existing system in the investigation report and make it the centerpiece of the recommendation. This check is especially critical when the issue references a standalone tool directory (`reddit-bot/`, `scripts/`, `tools/`) — those directories often duplicate functionality that a service already owns. (Ref: forge#279 — investigator anchored on `reddit-bot/` from issue body, never checked `services/herald/app/scheduler/`, built parallel PRAW integration alongside Herald's existing automated crosspost scheduler)
3. **Verify claims** — does the code actually have the problem described?
3.5. **Type Invariant Verification (MANDATORY)**: Before declaring that a field, key, or parameter has a specific type (e.g. "content is always a dict", "status is always an int"), search for ALL code paths that write to that field across ALL services:
   ```bash
   grep -rn '"field_name"\s*:' services/   # Python dict key assignments
   grep -rn 'result\["field_name"\]\s*=' services/  # Direct assignments
   grep -rn '\.field_name\s*=' services/   # Attribute assignments
   ```
   If the field is written with different types in different code paths (e.g. dict in the standard path, string in the auth-gated path), document ALL variants. The fix must handle every variant — not just the one on the primary investigated code path. A type guard like `or {}` only protects against falsy values; a non-empty string is truthy and bypasses it.
4. **Git blame** — trace when/why the relevant code was written. Run bounded, local commands (no network round-trip):
   ```bash
   # Introducing commit for each affected file (first commit that added it)
   git log --reverse --format='%h %an %ad %s' --date=short -- {affected_file} | head -1
   # Last-touch commit (most recent change)
   git log -1 --format='%h %an %ad %s' --date=short -- {affected_file}
   # Line-level blame for a specific suspect hunk, if the issue names one
   git blame -L {start},{end} -- {affected_file}
   ```
   Record the introducing commit and last-touch commit for each primary affected file — this feeds the mandatory **History findings** field in Phase 1C.
4.5. **Rogue commit pre-state comparison (conditional)**: If the issue body references a specific commit as rogue, bad, or unintended (e.g., "rogue commit `abc1234`", "bad commit", "this was never intended"), MUST run `git show {commit}^:{file}` to see the file before that commit. Compare the pre-commit state against the current file. Any block present in the current file but absent in the pre-commit state was introduced by that commit chain and is a candidate for full reversion — not just partial editing. Report the delta (pre vs. current) in the investigation report. Do NOT assume surrounding code near a named import/bug is correct simply because the issue only named a specific sub-problem. (Ref: forge#278 — investigator confirmed the broken import but never ran `git show 18a3a2cf3^:batch.py`; the surrounding 50-line feature gate was also rogue and was preserved by the fix PR, causing a P1 access regression for all non-Scale users)
5. **Domain context discovery** (narrow scope only, 1–5 files):
   ```bash
   git log --oneline --all -30 -- {affected_files} | grep -oE '#[0-9]+' | sort -u
   gh issue list -R {GH_REPO} --state closed --limit 8 --search "{function_name}"
   ```
   Keep only file/function-level overlap. Max 5 related issues. Everything is a hint to verify, not a fact.

   **Pickaxe pass (prior fix / regression detection)** — bounded to one pass, capped at 5 hits: search for prior additions/removals of the suspected symbol or literal string named in the issue (a function name, error string, or config key), independent of whether that fix was ever linked to a filed issue:
   ```bash
   git log -S"{suspected_symbol_or_string}" --oneline -- {affected_files} | head -5
   # Use -G instead of -S when the target is a regex pattern rather than a literal string
   git log -G"{pattern}" --oneline -- {affected_files} | head -5
   ```
   Any hit here is a candidate prior fix or reintroduced defect — read the commit body (`git show {hash}`) to confirm before citing it. Feed confirmed hits into the History findings field and let them inform the verdict (e.g. a defect being reintroduced raises severity).
6. **Determine root cause** — what's actually broken or missing?
7. **Identify affected files** — full list of files that need changes
7.5. **Sibling Pattern Sweep** *(conditional — when the bug is a condition, gated function call, or field presence check)*: After identifying the affected files, grep for the same pattern in sibling files within the same directory. The issue spec may name only the file where the error was first observed — but the same commit or PR that introduced the bug often applied it uniformly across related handlers.
   ```bash
   # Identify the broken condition or gated function call from the issue
   # Then search sibling files in the same router/service directory
   AFFECTED_DIR=$(dirname {PRIMARY_AFFECTED_FILE})
   grep -rn "{broken_pattern}" "$AFFECTED_DIR" --include="*.py" | grep -v "{PRIMARY_AFFECTED_FILE}"
   ```
   **If identical patterns are found in files NOT listed in the issue spec**, output a scope-gap warning:
   > **Scope-Gap Warning**: The issue spec lists `{PRIMARY_FILE}` but the same pattern exists in `{SIBLING_FILE}:{LINE}`. These were likely introduced together. Recommend widening scope to fix all callers in this PR, or creating follow-up issues for the other files before proceeding.

   Do NOT silently exclude sibling matches. The appropriate output when sibling files have the same bug is to flag them explicitly — even if the issue spec's silence appears intentional. The fix-approach validation step (step 8) will confirm whether to widen scope or create follow-ups. <!-- Added: forge#383 -->
7.6. **Finding Pattern Sweep** *(conditional — eligible when the issue has label `review-finding`, or its body carries a `FORGE:PATTERN` or `FORGE:PATTERN-CLASS` tag)*: Review findings are instances of a defect class. Fixing only the cited instance lets sibling instances resurface in the next review, so sweep the whole repo for the class before settling the affected-file list. For eligible issues this step replaces step 7.5; step 7.5 runs for non-eligible issues, and as the fallback when 7.6 is skipped or degrades. <!-- Added: forge#3449 -->
   ```bash
   REPO="{GH_REPO}"; NUMBER="{NUMBER}"
   BODY=$(gh issue view "$NUMBER" -R "$REPO" --json body --jq '.body') || BODY=""
   # Slug comes from model-written text: validate before ANY shell or jq use.
   # Class-level issues carry `<!-- FORGE:PATTERN: slug -->` too (review-pr Phase 6C), so one extractor covers both.
   SLUG=$(printf '%s\n' "$BODY" | grep -o 'FORGE:PATTERN: [A-Za-z0-9_-]*' | head -1 | sed 's/^FORGE:PATTERN: //')
   if ! [[ "$SLUG" =~ ^[a-z0-9-]+$ ]]; then
     echo "PATTERN SWEEP SKIPPED: no valid FORGE:PATTERN slug (expected ^[a-z0-9-]+$) — fall back to step 7.5"
     SLUG=""
   fi
   ```
   When `SLUG` is non-empty:
   - **Derive queries** from: the slug itself, the finding's **Prevention** sentence (extract its key identifiers), every path under **Files**, and the symbol, call, or condition cited at the defect site. Use 2-5 queries; each query is a fixed string, not a regex. A query must match `^[A-Za-z0-9_.:/-]{3,80}$` (identifier-like, no spaces, quotes, backticks, `$`, `|`); drop any query that does not, and never run an empty query (`-F ""` matches every line).
   - **Search the whole repo** (not just the affected directory), capturing the exit status so a failure is visible instead of masked by a pipe: `OUT=$(timeout 30 git grep -n -F -- "$QUERY"); RC=$?` (use `timeout` only if `command -v timeout` succeeds; stock macOS lacks it). `RC=0` means hits, `RC=1` means no match (0 hits is a valid result), any other `RC` (including 124, timeout) means the query failed. Quote the variable, always pass `-F` and `--`. Then cap: `printf '%s\n' "$OUT" | head -31`.
   - **Hit cap**: record at most 30 hits per query. If a query returns more, record the first 30 and mark the query `truncated at 30` — never silently drop hits.
   - **Disposition per hit** (MANDATORY, no unlabeled hits): `fix` (same defect class, must be changed in this PR) or `not-affected` with a one-line reason (e.g. already guarded, different semantics). The cited instance is always a `fix` row. Record each hit as `file:line` only (never the matched line text), one table row per hit.
   - **Scope cap**: if more than 25 `fix` rows result, do not grow one PR to fit them. Record the cited instance plus the rows in the same subsystem as `fix`, mark the rest `fix-deferred`, and recommend decomposition in the report (set `decompose: YES` if the remaining scope is too large for one PR).
   - **Degrade, never block**: if any query fails (`RC` other than 0 or 1), write `Pattern sweep skipped: {reason}` in the `### Pattern Sweep` section, fall back to step 7.5, and continue. A failed query must never be recorded as 0 hits. The sweep is advisory evidence, not a gate.
   - Every `fix` row MUST appear in `### Affected Files`, and the acceptance spec MUST include a class-wide coverage check plus a check that the added test exercises more than the reviewer's single repro (see Phase 1C).
8. **Fix-approach validation** — if the issue proposes a fix, don't adopt it as spec. Trace through the target system's middleware, auth, routing, config. Cross-domain: if fix in domain A interacts with domain B, read domain B's files too.

---

## Phase 1C: Post Investigation Comment

The comment MUST include a terminal sentinel at the very end, AFTER all required sections are present. **The sentinel is conditional on the resolved Verdict — it is NOT always `<!-- INVESTIGATION:COMPLETE -->`:**

- **Verdict is INVALID** → close with `<!-- INVESTIGATION:INVALID -->`. This is a distinct, already-wired-up terminal marker: `bin/engine/phases.mjs`'s `detectOutcome` for the `investigate` phase checks for it explicitly (ahead of `INVESTIGATION:COMPLETE`) and routes to `terminalReason: "invalid"`; `bin/hooks/interactive-engine.mjs`'s `PHASE_MARKERS` table also already treats it as terminal. Emitting `INVESTIGATION:COMPLETE` for an INVALID verdict is what previously caused every completed investigation to read as `{verdict: "CONFIRMED"}` regardless of actual outcome — do NOT regress this (forge#2350).
- **Verdict is CONFIRMED or PARTIAL** → close with `<!-- INVESTIGATION:COMPLETE -->` as before (PARTIAL still routes to `ready-to-build` in Phase 1D — only INVALID gets the distinct terminal sentinel).

Compute the sentinel once, before building the comment body:

```bash
if [ "{VERDICT}" = "INVALID" ]; then
  INVESTIGATION_SENTINEL="<!-- INVESTIGATION:INVALID -->"
else
  INVESTIGATION_SENTINEL="<!-- INVESTIGATION:COMPLETE -->"
fi
```

**CODEC PATH (forge#1727)**: Construct the annotation body via the protocol codec — do NOT hand-roll the `<!-- FORGE:INVESTIGATOR -->` header. Use `forge-annotation.sh write INVESTIGATOR --field ...` or `node packages/protocol/src/cli.js emit INVESTIGATOR --field ...` to produce the opening tag and completion sentinel. Fill in the Markdown body sections below. The full pattern:

**Caveat (forge#2368)**: `packages/protocol/src/types.js`'s `INVESTIGATOR.completionSentinel` is a single fixed value (`'INVESTIGATION:COMPLETE'`) and `packages/protocol/src/emit.js` appends it unconditionally — the codec does NOT currently support the verdict-conditional sentinel selection described above, and cannot emit `INVESTIGATION:INVALID`. Using the CODEC PATH for an INVALID-verdict investigation would silently regress the forge#2350 fix (every investigation would again read as `{verdict: "CONFIRMED"}`). Until the codec is extended to support a verdict-conditional sentinel, the hand-rolled block above/below (using the `${INVESTIGATION_SENTINEL}` variable computed above) is the authoritative path for Phase 1C — do not use the CODEC PATH for this annotation.

```bash
# Build the annotation body via codec (escaping and sentinel handled by codec)
ANNOTATION_BODY=$(node packages/protocol/src/cli.js emit INVESTIGATOR \
  --field "Verdict={VERDICT}" \
  --field "Confidence={CONFIDENCE}" \
  --field "Severity={SEVERITY}" \
  --field "Task Type={TASK_TYPE}" \
  --field "Decomposition Assessment={YES|NO} — {reason}")
# ANNOTATION_BODY now has opening tag + required fields + INVESTIGATION:COMPLETE sentinel.
# After appending the body sections, the Decomposition Assessment MUST be followed by exactly one
# machine-readable marker line (`<!-- DECOMPOSE:YES -->` or `<!-- DECOMPOSE:NO -->`) — see the
# "Decomposition marker" rule below the template. The codec does not add it for you.
# NOTE: the codec's sentinel is fixed — do not use this path when Verdict=INVALID (see caveat above).
# Append the Markdown body sections to it before posting.
```

Before posting, resolve the attribution annotation link from `forge.yaml`:

```bash
ATTRIBUTION_ANNOTATION_LINK=$(grep -A5 "^attribution:" forge.yaml 2>/dev/null | grep "annotation_link:" | awk '{print $(2)}' | tr -d '"' || echo "false")
ANNOTATION_LINK_FOOTER=""
if [ "$ATTRIBUTION_ANNOTATION_LINK" = "true" ]; then
  ANNOTATION_LINK_FOOTER="

---
*⚒️ Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)*"
fi
```

<!-- allowlist:check-spec-bash -->
```bash
gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:INVESTIGATOR -->
## Investigation Report

**Verdict**: {CONFIRMED|PARTIAL|INVALID}
**Confidence**: {HIGH|MEDIUM|LOW}
**Severity**: {CRITICAL|HIGH|MEDIUM|LOW}
**Task Type**: {Bug Fix|Feature|Refactor|Maintenance|Investigation}

### What Was Claimed
{summary of what the issue describes}

### What We Found
{what the code actually shows}

### Root Cause
{specific root cause, with file:line references where applicable}

### Affected Files
{numbered list of files that need changes. For \`review-finding\` issues, include every file with a \`fix\` row from the Pattern Sweep below.}

### Pattern Sweep
{Emit for \`review-finding\` issues (step 7.6). Omit this section for other issues. One row per hit, hit as \`file:line\` only. A query with no hits gets one row with Hit \`none\`. On skip, write \`Pattern sweep skipped: {reason}\`. Queries are pre-validated identifier-like text (step 7.6), so they are safe to place in this template.}

| Query | Hit | Disposition |
|-------|-----|-------------|
| {validated fixed-string query} | {file:line, \`none\`, or \`truncated at 30\`} | {fix \| not-affected — reason} |

### Evidence
{specific findings — function names, line numbers, behavior observed}

### History Findings
**Introducing commit**: {hash — author — date — subject, per primary affected file}
**Last touched**: {hash — author — date — subject}
**Pickaxe hits (prior fixes / regressions)**: {commit(s) found via \`git log -S\`/\`-G\`, or 'None found' — max 5}
{This field is MANDATORY — populate from the git blame + pickaxe commands in step 4/5. If a file is newly created (no history), write 'New file — no history.'}
**Prior Investigations (via recall)**: {Comma-separated issue citations from \`RECALL_ISSUE_CITATIONS\` (e.g. '#1172, #1243 — building on, not repeating'), or 'None — no Forge Ledger match above threshold' if \`RECALL_RESULTS\` was empty. Use the \`RECALL_ISSUE_CITATIONS\` variable populated in Phase 0.6.}

### Recommendation
{what to build/fix, concrete and actionable}

### Related Issues
{if any found via domain context discovery, max 5}

### Decomposition Assessment
**{YES|NO}** — {reason}
{if YES: proposed sub-issues with titles and dependencies}
<!-- DECOMPOSE:{YES|NO} -->

**Decomposition marker (MANDATORY, both output paths — template and codec)**: emit exactly one `<!-- DECOMPOSE:YES -->` or `<!-- DECOMPOSE:NO -->` line per investigator comment, matching the `**YES**`/`**NO**` verdict, placed after the verdict line and any sub-issue list (the `**YES**`/`**NO**` line must stay directly under the heading — the resume parser reads it). The headless engine routes to `work-on/decompose` on this marker (or on the `**YES**` heading in older comments). Never emit it when Verdict=INVALID. <!-- Added: forge#3543 -->

**Decomposition scopes the Acceptance Spec**: when the assessment is YES, the Acceptance Spec MUST cover only the first, in-scope item — or tag each check with the sub-item it belongs to (append `# item-N` to the description). Never emit checks for work the assessment assigns to a separate sub-issue: build's acceptance gate would otherwise fail on them and its repair loop would pull that work into this branch. <!-- Added: forge#3543 -->

### Acceptance Spec <!-- Added: forge#1829 -->
{For each item in the issue's ## Acceptance Criteria section, emit one machine-checkable check line using the format below. If the issue has no Acceptance Criteria section, derive checks from the Recommendation above. Each check MUST be specific, observable, and testable — not vague prose. Checks are consumed by build/validate Phase B6.5 as the merge gate.}

**Quoting (MANDATORY)**: `target=` and `matcher=` MUST always be wrapped in double quotes — `target="..."` / `matcher="..."` — even when the value is a single token (e.g. a plain file path). The downstream Phase B6.5 parser only extracts quoted values; an unquoted `target=`/`matcher=` will silently truncate at the first space and cause a false-negative gate failure for any multi-word value (shell commands with flags/arguments/pipes are almost always multi-word). Neither `target` nor `matcher` may contain a literal `"` character — use single quotes for any embedded string/regex literal inside the value, as shown below. `id=` and `type=` are always single tokens and are never quoted. `description=` is always the last field on the line and is captured to end-of-line — it does not need quoting.

```
ACCEPTANCE_CHECK: id={ac-1} type={exists|contains|command|behavior} target="{file_path|command|url}" matcher="{string|exit_0|regex}" description={one-line human description}
ACCEPTANCE_CHECK: id={ac-2} type={exists|contains|command|behavior} target="{file_path|command|url}" matcher="{string|exit_0|regex}" description={one-line human description}
```

Example with a multi-word shell command target (the case that previously broke — note the embedded single quotes around the regex, and the double quotes wrapping the whole target):
```
ACCEPTANCE_CHECK: id=ac-4 type=command target="grep -qE '(>= ?2|2\+)' commands/orchestrate/phase-1-resolve.md" matcher="exit_0" description=Fan-out cap is documented as >=2 or 2+
```

**Check types**:
- `exists` — assert a file or directory exists (`target` = path, `matcher` = ignored)
- `contains` — assert a file contains a string or regex (`target` = file path, `matcher` = string/regex). **Prefer a literal string** for code: the matcher is applied as an extended regex first, so `$`, `(`, `[`, `.`, `*`, `+`, `?`, `|` must be escaped if you mean them literally (e.g. `return \"\$HELD\"`). The acceptance gate falls back to a literal match, but a correct matcher avoids a needless repair round. For a `command` check that looks for code, use `grep -qF '<literal>' <file>`, not `grep -qE`.
- `command` — run a shell command and assert exit 0 (`target` = shell command, `matcher` = `exit_0`)
- `behavior` — assert a runtime/observable behavior via shell command (`target` = shell command, `matcher` = expected output string or regex)

**Self-defeating pipe guideline**: do NOT chain a `-q`/`--quiet` command into a downstream pipe consumer (e.g. `grep -q ... | grep ...`). A `-q` flag suppresses all stdout, so the next command in the pipe always receives empty input and the check can never pass regardless of the actual file content. If a check needs to verify two conditions against the same output, sequence them instead — e.g. `grep -qE 'first' file && grep -qE 'second' file` — or capture the output once and grep the captured variable.

**Class-wide checks (review-finding issues)**: when a Pattern Sweep was recorded, emit at least one `ACCEPTANCE_CHECK` that verifies the fix covers every `fix` row (for example a `command` check that the defective pattern no longer matches anywhere in the swept paths) and one that verifies the added test covers a representative set of instances rather than the reviewer's single repro. <!-- Added: forge#3449 -->

**Skipping**: if the issue has no verifiable acceptance criteria and none can be derived from the recommendation, emit a single sentinel: `ACCEPTANCE_CHECK: id=ac-skip type=skipped target="none" matcher="none" description=No machine-checkable criteria available — human review required`
${ANNOTATION_LINK_FOOTER}
${INVESTIGATION_SENTINEL}"
```

**Do not hardcode `<!-- INVESTIGATION:COMPLETE -->` as the closing line.** The closing line MUST be the `${INVESTIGATION_SENTINEL}` variable computed above — it resolves to `<!-- INVESTIGATION:INVALID -->` for an INVALID verdict and `<!-- INVESTIGATION:COMPLETE -->` otherwise. `INVESTIGATION:COMPLETE` and `INVESTIGATION:INVALID` are mutually exclusive within a single posted comment — never emit both.

---

## Phase 1C.5: Create Knowledge Gist

**Skip if**: A comment containing `<!-- FORGE:KNOWLEDGE_GIST:` already exists on this issue.

After the FORGE:INVESTIGATOR comment is posted, create a structured GitHub Gist containing the investigation findings. The Gist provides a stable, linkable URL that downstream issues (siblings, children) can reference.

**This phase is non-blocking** — if Gist creation fails (auth error, rate limit, network), log the failure and continue to Phase 1D. Do NOT stall the pipeline for a knowledge artifact.

### Step 0: Check cached Gist capability

`FORGE_GIST_CAPABLE` is set once by `/orchestrate` before it dispatches workers. A standalone
`/work-on` run has no parent cache, so it performs the same read-only identity probe once for its
own process. GitHub App installation identities are `Bot` users and cannot use the Gists API.

```bash
if [ -z "${FORGE_GIST_CAPABLE+x}" ]; then
  # Fail closed: only a positively identified user account can use the Gists API. A GitHub App
  # installation token cannot read /user at all (HTTP 403, empty type), so "not Bot" is NOT
  # evidence of capability; an unavailable probe disables Gists rather than letting every
  # worker fail on its first Gist write.
  GIST_AUTH_TYPE=$(gh api user --jq '.type' 2>/dev/null || true)
  if [ "$GIST_AUTH_TYPE" = "User" ]; then
    FORGE_GIST_CAPABLE=true
  else
    FORGE_GIST_CAPABLE=false
  fi
  export FORGE_GIST_CAPABLE
fi

if [ "$FORGE_GIST_CAPABLE" != "true" ]; then
  echo "INFO: Knowledge Gist subsystem unavailable for this authentication — skipping Gist phases"
  GIST_URL=""
  INDEX_URL=""
  # Skip every remaining step in Phases 1C.5 and 1C.6; continue directly to Phase 1D.
fi
```

When `FORGE_GIST_CAPABLE` is not `true`, do not call `gh gist create`, `gh gist view`,
`gh gist edit`, or any other Gist command in either Phase 1C.5 or Phase 1C.6. This is an
informational skip, not a warning, retry, or escalation.

### Step 1: Check for existing Gist annotation

```bash
EXISTING_GIST=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:KNOWLEDGE_GIST:")) | .body' | head -1)

if [ -n "$EXISTING_GIST" ]; then
  echo "Knowledge Gist already exists — skipping creation"
  # → Continue to Phase 1D
fi
```

### Step 2: Extract investigation content

```bash
INVESTIGATION_BODY=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body' | head -1)
```

### Step 3: Generate filename and metadata

```bash
ISSUE_TITLE=$(gh issue view {NUMBER} {GH_FLAG} --json title --jq '.title')
MILESTONE=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.title // "none"')

# Generate slug from title: lowercase, replace non-alphanumeric with hyphens, collapse, truncate
SLUG=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | cut -c1-40)

# Derive repo short name from GH_REPO (e.g., "acme-org/acme-platform" → "acme-platform")
REPO_SHORT=$(echo "{GH_REPO}" | sed 's|.*/||')

GIST_FILENAME="${REPO_SHORT}_${NUMBER}_${SLUG}.md"
```

### Step 4: Build Gist content with frontmatter

Extract verdict, task type, and confidence from the investigation body, then compose the Gist:

```bash
VERDICT=$(echo "$INVESTIGATION_BODY" | grep -oE '\*\*Verdict\*\*: [A-Za-z_-]+' | head -1 | sed -E 's/^\*\*Verdict\*\*: //')
TASK_TYPE=$(echo "$INVESTIGATION_BODY" | grep -oE '\*\*Task Type\*\*: .+' | head -1 | sed -E 's/^\*\*Task Type\*\*: //')
CONFIDENCE=$(echo "$INVESTIGATION_BODY" | grep -oE '\*\*Confidence\*\*: [A-Za-z_-]+' | head -1 | sed -E 's/^\*\*Confidence\*\*: //')
SEVERITY=$(echo "$INVESTIGATION_BODY" | grep -oE '\*\*Severity\*\*: [A-Za-z_-]+' | head -1 | sed -E 's/^\*\*Severity\*\*: //')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

GIST_CONTENT=$(cat <<GIST_EOF
---
issue: ${NUMBER}
repo: {GH_REPO}
milestone: ${MILESTONE}
verdict: ${VERDICT}
task_type: ${TASK_TYPE}
confidence: ${CONFIDENCE}
severity: ${SEVERITY}
created: ${TIMESTAMP}
source: FORGE:INVESTIGATOR
---

# Investigation: ${ISSUE_TITLE} (#${NUMBER})

${INVESTIGATION_BODY}
GIST_EOF
)
```

### Step 5: Create secret Gist

```bash
GIST_URL=$(echo "$GIST_CONTENT" | gh gist create \
  -f "$GIST_FILENAME" \
  -d "Investigation findings for ${REPO_SHORT}#${NUMBER}: ${ISSUE_TITLE}" \
  - 2>/dev/null)

if [ -z "$GIST_URL" ]; then
  echo "WARNING: Gist creation failed — continuing without knowledge artifact"
  # → Continue to Phase 1D (non-blocking)
fi
```

### Step 6: Post Gist URL annotation

```bash
if [ -n "$GIST_URL" ]; then
  gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:KNOWLEDGE_GIST: ${GIST_URL} -->
## Knowledge Gist Created

Investigation findings persisted as a linkable artifact.

**Gist**: ${GIST_URL}
**Filename**: \`${GIST_FILENAME}\`

_This Gist can be referenced by downstream issues for context transfer._"
fi
```

→ Continue to Phase 1C.6.

---

## Phase 1C.6: Update Milestone Index Gist

**Skip if**: The issue has no milestone (`MILESTONE` is `"none"` or empty).

**Also skip if**: `FORGE_GIST_CAPABLE` from Phase 1C.5 is not `true`. Do not independently
re-probe capability here; the cached result covers both Gist phases.

After the per-issue Knowledge Gist is created (Phase 1C.5), update the milestone-level index Gist. The index aggregates all investigation Gist URLs for a milestone into a single reference document. Any agent working on a milestone issue can fetch one index URL to get full context across all investigations.

**This phase is non-blocking** — if index creation or update fails, log the warning and continue to Phase 1D. Do NOT stall the pipeline for the index.

### Step 1: Check milestone and skip conditions

```bash
MILESTONE=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.title // "none"')
MILESTONE_NUM=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.number // empty')

if [ "$MILESTONE" = "none" ] || [ -z "$MILESTONE_NUM" ]; then
  echo "No milestone on issue #${NUMBER} — skipping milestone index update"
  # → Continue to Phase 1D
fi
```

### Step 2: Read milestone description for existing index

```bash
MILESTONE_DESC=$(gh api repos/{GH_REPO}/milestones/${MILESTONE_NUM} --jq '.description // ""')
EXISTING_INDEX_URL=$(echo "$MILESTONE_DESC" | grep -oE '<!-- FORGE:MILESTONE_INDEX: https://[^ ]+ -->' | head -1 | sed -E 's/^<!-- FORGE:MILESTONE_INDEX: //; s/ -->$//')
```

### Step 3: Build index entry for this issue

```bash
ISSUE_TITLE=$(gh issue view {NUMBER} {GH_FLAG} --json title --jq '.title')
VERDICT=$(echo "$INVESTIGATION_BODY" | grep -oE '\*\*Verdict\*\*: [A-Za-z_-]+' | head -1 | sed -E 's/^\*\*Verdict\*\*: //')
SEVERITY=$(echo "$INVESTIGATION_BODY" | grep -oE '\*\*Severity\*\*: [A-Za-z_-]+' | head -1 | sed -E 's/^\*\*Severity\*\*: //')
TASK_TYPE=$(echo "$INVESTIGATION_BODY" | grep -oE '\*\*Task Type\*\*: .+' | head -1 | sed -E 's/^\*\*Task Type\*\*: //')
RECOMMENDATION=$(echo "$INVESTIGATION_BODY" | sed -n '/^### Recommendation/,/^### /p' | head -5 | tail -n +2 | tr '\n' ' ' | cut -c1-120)

# GIST_URL comes from Phase 1C.5 (may be empty if Gist creation failed)
INDEX_ENTRY="| #${NUMBER} | ${ISSUE_TITLE} | ${VERDICT} / ${SEVERITY} | ${TASK_TYPE} | ${GIST_URL:-_no gist_} | ${RECOMMENDATION:-_see investigation_} |"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
```

### Step 4a: Create new index Gist (no existing index)

```bash
if [ -z "$EXISTING_INDEX_URL" ]; then
  MILESTONE_SLUG=$(echo "$MILESTONE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | cut -c1-40)
  REPO_SHORT=$(echo "{GH_REPO}" | sed 's|.*/||')
  INDEX_FILENAME="${REPO_SHORT}_milestone_${MILESTONE_SLUG}_index.md"

  INDEX_CONTENT=$(cat <<INDEX_EOF
---
type: milestone-index
repo: {GH_REPO}
milestone: ${MILESTONE}
milestone_number: ${MILESTONE_NUM}
last_updated: ${TIMESTAMP}
---

# Milestone Index: ${MILESTONE}

Investigation findings index for all issues in this milestone.

| Issue | Title | Verdict / Severity | Task Type | Gist URL | Key Finding |
|-------|-------|--------------------|-----------|----------|-------------|
${INDEX_ENTRY}
INDEX_EOF
)

  INDEX_URL=$(echo "$INDEX_CONTENT" | gh gist create \
    -f "$INDEX_FILENAME" \
    -d "Milestone index: ${MILESTONE} (${REPO_SHORT})" \
    - 2>/dev/null)

  if [ -z "$INDEX_URL" ]; then
    echo "WARNING: Milestone index Gist creation failed — continuing without index"
    # → Continue to Phase 1D (non-blocking)
  fi
fi
```

### Step 4b: Update existing index Gist (index already exists)

```bash
if [ -n "$EXISTING_INDEX_URL" ]; then
  INDEX_GIST_ID=$(echo "$EXISTING_INDEX_URL" | grep -oE '[a-f0-9]{20,}' | tail -1)

  if [ -z "$INDEX_GIST_ID" ]; then
    echo "WARNING: Could not extract Gist ID from index URL — skipping update"
    # → Continue to Phase 1D
  fi

  # Fetch current index content
  CURRENT_INDEX=$(gh gist view "$INDEX_GIST_ID" --raw 2>/dev/null)

  if [ -z "$CURRENT_INDEX" ]; then
    echo "WARNING: Could not fetch existing index Gist — skipping update"
    # → Continue to Phase 1D
  fi

  # Check if this issue is already in the index
  if echo "$CURRENT_INDEX" | grep -q "| #${NUMBER} |"; then
    echo "Issue #${NUMBER} already in milestone index — skipping"
    INDEX_URL="$EXISTING_INDEX_URL"
    # → Continue to Phase 1D
  else
    # Update the last_updated timestamp in frontmatter
    UPDATED_INDEX=$(echo "$CURRENT_INDEX" | sed "s|^last_updated:.*|last_updated: ${TIMESTAMP}|")

    # Append new entry to the table
    UPDATED_INDEX="${UPDATED_INDEX}
${INDEX_ENTRY}"

    # Determine the filename from the existing Gist
    INDEX_FILENAME=$(gh api gists/${INDEX_GIST_ID} --jq '.files | keys[0]' 2>/dev/null)
    if [ -z "$INDEX_FILENAME" ]; then
      INDEX_FILENAME="milestone_index.md"
    fi

    # Update the Gist
    # gh gist edit does not support stdin via '-'; use a temp file instead
    TMPFILE=$(mktemp "${TMPDIR:-/tmp}/forge-index.XXXXXX")
    echo "$UPDATED_INDEX" > "$TMPFILE"
    gh gist edit "$INDEX_GIST_ID" -f "$INDEX_FILENAME" "$TMPFILE" 2>/dev/null
    EDIT_EXIT=$?
    rm -f "$TMPFILE"
    if [ $EDIT_EXIT -eq 0 ]; then
      INDEX_URL="$EXISTING_INDEX_URL"
      echo "Milestone index Gist updated: ${INDEX_URL}"
    else
      echo "WARNING: Failed to update milestone index Gist — continuing"
      INDEX_URL="$EXISTING_INDEX_URL"
    fi
  fi
fi
```

### Step 5: Store index URL in milestone description

```bash
if [ -n "$INDEX_URL" ]; then
  if [ -n "$EXISTING_INDEX_URL" ]; then
    # Replace existing annotation with updated URL (in case Gist was recreated)
    UPDATED_DESC=$(echo "$MILESTONE_DESC" | sed "s|<!-- FORGE:MILESTONE_INDEX: [^ ]* -->|<!-- FORGE:MILESTONE_INDEX: ${INDEX_URL} -->|")
  else
    # Append annotation to milestone description
    UPDATED_DESC="${MILESTONE_DESC}

<!-- FORGE:MILESTONE_INDEX: ${INDEX_URL} -->"
  fi

  gh api repos/{GH_REPO}/milestones/${MILESTONE_NUM} \
    -X PATCH \
    -f description="$UPDATED_DESC" 2>/dev/null

  if [ $? -eq 0 ]; then
    echo "Milestone description updated with index URL: ${INDEX_URL}"
  else
    echo "WARNING: Failed to update milestone description — index URL not stored"
  fi
fi
```

→ Continue to Phase 1D.

---

## Phase 1D: Update Labels & Return Verdict

### 1D.0: Finding Lifecycle Label Transition (MANDATORY — run before workflow label update)

**Purpose**: Wire the investigation verdict into the finding-validation lifecycle. If the issue under investigation is a review-finding (carries `needs-validation`), translate the verdict into `validated` or `false-positive` using `transition-label.sh --validate`. This is the primary mechanism that resolves the `needs-validation → validated/false-positive` lifecycle gap. <!-- Added: forge#1730 -->

**Run this block regardless of verdict (CONFIRMED, PARTIAL, INVALID) — the verdict-to-label mapping handles all cases:**

```bash
# Check if this issue is a finding awaiting validation
ISSUE_LABELS=$(gh issue view {NUMBER} {GH_FLAG} --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null || echo "")

if echo "$ISSUE_LABELS" | grep -q "needs-validation"; then
  echo "Issue #{NUMBER} has needs-validation — applying verdict label transition..."
  RESOLUTION=$(resolve_script 'transition-label')
  TIER="${RESOLUTION%%:*}"
  SCRIPT_PATH="${RESOLUTION#*:}"
  case "$TIER" in
    adaptive|universal)
      bash "$SCRIPT_PATH" --validate {VERDICT} {NUMBER} {GH_FLAG} || true
      ;;
    prose)
      # Prose fallback: apply label transition directly via gh
      if [ "{VERDICT}" = "CONFIRMED" ]; then
        gh issue edit {NUMBER} {GH_FLAG} --add-label "validated" --remove-label "needs-validation" 2>/dev/null || true
        echo "Applied: needs-validation → validated (verdict: CONFIRMED)"
      else
        gh issue edit {NUMBER} {GH_FLAG} --add-label "false-positive" --remove-label "needs-validation" 2>/dev/null || true
        echo "Applied: needs-validation → false-positive (verdict: {VERDICT})"
      fi
      ;;
  esac
else
  echo "Issue #{NUMBER} does not have needs-validation — no finding lifecycle transition needed"
fi
```

**Verdict → label mapping**: `CONFIRMED` → `validated`; `PARTIAL`, `NOT-CONFIRMED`, `INVALID` → `false-positive`.

**Idempotency**: `transition-label.sh --validate` is a no-op if the issue already has `validated` or `false-positive`, or if it lacks `needs-validation`. Safe to call on any issue.

---

### 1D.1: Correction Capture (MANDATORY — run after 1D.0, BEFORE the workflow label update) <!-- Added: forge#667 -->

Before routing, scan all non-agent comments for correction signals from the repository owner. Correction signals are owner comments that contain phrases like "no, use", "actually use", "use X instead", "not X, use Y", or "wrong branch". If found, write the correction to `forge.yaml → learned:` and emit a `FORGE:LEARNED` annotation.

**Scan for correction signals**:
```bash
# Get repo owner login for filtering.
# Tiered resolution — necessary because project.owner is the GitHub org/user NAME,
# but comment .user.login is always a personal account login. For org-owned repos
# these are structurally different (e.g. org="RapierCraftStudios", commenter="mrdubey"),
# so using project.owner directly silently disables correction capture for all org repos.
#
# Resolution order:
#   1. project.owner_login (explicit override — required for org repos where owner ≠ personal login)
#   2. gh api repos/{GH_REPO} --jq '.owner.login' (auto-resolves correctly for personal repos)
#   3. project.owner (backward-compat fallback — still broken for org repos, but avoids hard failure)
REPO_OWNER=$(yq '.project.owner_login // ""' forge.yaml 2>/dev/null || echo '')
if [ -z "$REPO_OWNER" ]; then
  REPO_OWNER=$(gh api repos/{GH_REPO} --jq '.owner.login' 2>/dev/null || echo '')
fi
if [ -z "$REPO_OWNER" ]; then
  REPO_OWNER=$(yq '.project.owner' forge.yaml 2>/dev/null || echo '')
fi

# Fetch all comments, filter to owner-only, look for correction signals
CORRECTIONS=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  | jq -r --arg owner "$REPO_OWNER" \
  '.[] | select(.user.login == $owner) | select(
    (.body | test("no,? use|actually use|use .+ instead|not .+, use|wrong branch"; "i"))
  ) | .body' 2>/dev/null || echo '')
```

**If correction signals found** — extract and write each correction:

```bash
# Example: extract branch target correction "use develop not staging"
# Adjust regex to the correction pattern detected

if [ -n "$CORRECTIONS" ]; then
  echo "Correction signals detected — writing to forge.yaml → learned:"
  echo "$CORRECTIONS"

  # Write to forge.yaml using yq in-place merge (idempotent — yq merge overwrites existing keys)
  # Always use env variable injection to avoid YAML injection from comment content
  # Example for branch target correction:
  #   BRANCH_VALUE="develop"
  #   yq eval '.learned.branch_targets.staging = env(BRANCH_VALUE)' -i forge.yaml

  # After writing, emit FORGE:LEARNED annotation
  LEARNED_KEYS="branch_targets.staging"  # replace with actual extracted keys
  CAPTURED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Update captured_at and captured_by metadata
  CAPTURED_AT_VAL="$CAPTURED_AT" yq eval '.learned.captured_at = env(CAPTURED_AT_VAL)' -i forge.yaml
  CAPTURED_BY_VAL="work-on/{NUMBER}" yq eval '.learned.captured_by = env(CAPTURED_BY_VAL)' -i forge.yaml

  LEARNED_BODY="<!-- FORGE:LEARNED -->
## Learned Pattern Captured

**Source**: Owner correction in comment on issue #{NUMBER}
**Captured at**: $CAPTURED_AT
**Keys written**: \`$LEARNED_KEYS\`

The following project-specific pattern was detected from owner feedback and written to \`forge.yaml → learned:\`. Future sessions will use this override automatically.

\`\`\`yaml
# Written to forge.yaml
learned:
  # {key}: {value}
\`\`\`

**Idempotency**: yq merge-write — re-running will not duplicate entries."
  gh issue comment {NUMBER} {GH_FLAG} --body "$LEARNED_BODY"   # allowlist:check-command-side-effects

  echo "FORGE:LEARNED annotation posted."
fi
```

**Idempotency guarantee**: Use `yq eval '.learned.key = env(VAR)' -i forge.yaml` — yq overwrites existing keys rather than appending. Re-running the capture step on the same comment produces the same forge.yaml state.

---

### 1D.2: Update Labels & Return Verdict

Resolve the posted investigation comment URL once (used in the result block):

```bash
COMMENT_URL=$(gh api "repos/{GH_REPO}/issues/{NUMBER}/comments" --paginate --jq '[.[] | select(.body | contains("<!-- FORGE:INVESTIGATOR -->")) | .html_url] | last' 2>/dev/null | tail -1)
```

**CONFIRMED or PARTIAL with decompose: NO** — transition to `ready-to-build` (this phase owns that label):
```bash
RESOLUTION=$(resolve_script 'transition-label'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} ready-to-build ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:ready-to-build" --remove-label "workflow:investigating,workflow:building,workflow:in-review,workflow:awaiting-merge,workflow:merged,workflow:invalid,workflow:decomposed" 2>/dev/null || true   # allowlist:check-command-side-effects
    ;;
esac
```

No `FORGE:CHECKPOINT` is written — the label already disambiguates the resume point (forge#1826). Print `INVESTIGATE_RESULT:` with `status: COMPLETE`, `decompose: NO` and STOP.

**CONFIRMED or PARTIAL with decompose: YES** — this phase does NOT set `workflow:decomposed` (the decompose phase owns it) and does NOT add `workflow:ready-to-build`. Only remove the investigating label:
```bash
gh issue edit {NUMBER} {GH_FLAG} --remove-label "workflow:investigating" 2>/dev/null || true   # allowlist:check-command-side-effects
```

No `FORGE:CHECKPOINT` is written. Print `INVESTIGATE_RESULT:` with `status: COMPLETE`, `decompose: YES` and STOP.

**INVALID** — transition to `invalid` and close the issue (terminal):
```bash
RESOLUTION=$(resolve_script 'transition-label'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} invalid ;;
  prose)
    gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:invalid" --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:awaiting-merge,workflow:merged,workflow:decomposed" 2>/dev/null || true   # allowlist:check-command-side-effects
    ;;
esac
gh issue close {NUMBER} {GH_FLAG} --comment "Closing as invalid: {reason from investigation}"   # allowlist:check-command-side-effects
```

No checkpoint written — INVALID is terminal. Print `INVESTIGATE_RESULT:` with `status: INVALID` and STOP.

---

## Output

The subcommand writes its results to GitHub (FORGE:INVESTIGATOR comment, labels). Its **final reply** must be exactly this one block — it is all the caller sees. Print it on **every** exit path (COMPLETE, ALREADY_DONE, INVALID, BLOCKED). This subcommand is complete after printing; do not continue to any later phase.

```
INVESTIGATE_RESULT:
  status: {COMPLETE|ALREADY_DONE|INVALID|BLOCKED}
  verdict: {CONFIRMED|PARTIAL|INVALID|null}
  confidence: {HIGH|MEDIUM|LOW|null}
  decompose: {YES|NO|null}
  comment_url: {url of posted (or pre-existing) comment, or null}
  gist_url: {url of knowledge gist, or null if creation failed/skipped}
  milestone_index_url: {url of milestone index gist, or null if no milestone/creation failed}
  blocker: {one-line reason when status is BLOCKED, else null}
```

**Status mapping**:
- `COMPLETE` — fresh investigation finished with verdict CONFIRMED or PARTIAL (`decompose` YES or NO).
- `ALREADY_DONE` — resume check found a completed investigation with a non-INVALID verdict; the block carries the parsed existing verdict (Phase 1A).
- `INVALID` — verdict INVALID (fresh run, or an existing `INVESTIGATION:INVALID` comment found on resume); issue closed with `workflow:invalid`.
- `BLOCKED` — a required arg is missing, the issue cannot be read, or investigation cannot proceed; set `blocker` and leave the other fields `null` where unknown.
