---
user-invocable: false
description: Decompose subcommand — break a complex issue into ordered sub-issues, post FORGE:DECOMPOSED, stop
context: fork
background: false
argument-hint: "{NUMBER} --repo {GH_REPO} --gh-flag \"{GH_FLAG}\""
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# work-on/decompose — Decomposition Subcommand

> **Skill Name Resolution (forked phase)**: `{FORGE_SKILL_PREFIX}` is the namespace this skill itself was invoked under — invoked as `forgedock:work-on:…` → `forgedock:` (nesting `:`); as `work-on:…` → empty (`install.sh`); as `forge-work-on-…` → `forge-` (Codex, nesting `-`); OpenCode → empty with `-` nesting. Confirm the target name in the available-skills list before calling it. A forked phase receives no resolved value from its caller; never guess, and if the target skill is not listed return BLOCKED "skill not found: <name>".

**Input**: $ARGUMENTS

> **Transient GitHub failures** (field test: a 12-minute GitHub HTTP 500 window parked an issue at needs-human): retry any `gh` call that fails with HTTP 5xx, a timeout or "Something went wrong" up to 3 times with 10s/30s/60s backoff. If it still fails, do NOT add `needs-human` — print this phase's RESULT block with `status: BLOCKED` and a blocker that starts with `github-unavailable:`. The router retries the phase; every phase resumes from GitHub state, so a retry is safe.


**Invoked by**: the work-on router, when `INVESTIGATE_RESULT.decompose = YES`. This skill runs in an isolated forked context: it sees only its args and re-reads everything else from GitHub.
**Output**: Create sub-issues, update parent tracker, post `<!-- FORGE:DECOMPOSED -->` comment, set `workflow:decomposed`. STOP — each sub-issue runs its own /work-on. This skill is the SOLE owner of the `workflow:decomposed` label. On BLOCKED it adds `needs-human` and posts the blocker.

**Engine coverage** (forge#2379): this subcommand's `command` name (`work-on/decompose`) and completion marker (`FORGE:DECOMPOSED:COMPLETE`) are registered as a real phase in the headless engine's phase table — `decompose` in `packages/protocol/src/phases.js`'s `PHASE_IDS`/`PHASE_MARKERS`, and the matching `decompose` entry in `bin/engine/phases.mjs`'s `PHASES` array. The engine's `investigate` phase hands off to it on `DECOMPOSE:YES` instead of terminating in place, so a headless `runIssue()` walk dispatches this subcommand rather than stopping short.

**Agent model policy**: `model: "{DEFAULT_MODEL}"` — resolved from forge.yaml `agents.default_model`, else "sonnet" (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154. This file's mechanical bits (label transitions, sub-issue creation) stay at this tier because they're interleaved with the reasoning-heavy sub-issue design steps in the same `Skill()` invocation. <!-- Added: forge#1827 -->
**NEVER use plan mode (EnterPlanMode).**

---

## Inputs

Parse from $ARGUMENTS:
- `{NUMBER}` — issue number (required)
- `--repo {GH_REPO}` — GitHub repo, e.g. `{owner}/{repo}` (required)
- `--gh-flag {GH_FLAG}` — gh CLI repo flag, e.g. `-R {owner}/{repo}` (required)

If `{NUMBER}`, `--repo` or `--gh-flag` is missing, print the result block with `status: BLOCKED`, blocker: "missing required arg: <name>", and STOP (no GitHub write is possible without them).

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

---

## Result emission

Every exit path of this skill — COMPLETE, ALREADY_DONE, every guard, every failure — ends by printing exactly one block as the final reply:

```
DECOMPOSE_RESULT:
  status: COMPLETE | ALREADY_DONE | BLOCKED
  sub_issues: [N, N, ...]
  comment_url: {url of the FORGE:DECOMPOSED comment; empty if none}
  blocker: {description if status=BLOCKED, else empty}
```

`sub_issues` is a plain list of issue numbers on every path (`[]` when none), never objects.

### Blocked exit

Every `BLOCKED` exit first runs this procedure (set `BLOCKER` to the reason text), then prints the result block with `status: BLOCKED`. It guarantees the parent never keeps a terminal `workflow:decomposed` label without sub-issues:

```bash
BLOCKER="{reason}"
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
run gh issue edit {NUMBER} {GH_FLAG} --add-label "needs-human" --remove-label "workflow:decomposed" 2>/dev/null || true
run gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DECOMPOSE_BLOCKED -->
## Decomposition Blocked

${BLOCKER}

Human attention required (\`needs-human\`)."
```

---

## Phase D0: Load State from GitHub (MANDATORY)

Re-read current state before doing anything:

```bash
gh issue view {NUMBER} {GH_FLAG} --json number,title,body,labels,state,milestone

# Read investigation report (required — contains decomposition plan)
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR")) | .body'
```

**MANDATORY — Owner override detection**: After reading the investigation comment, read ALL other comments on the issue to check for owner override signals:

```bash
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '.[] | select(.body | contains("FORGE:INVESTIGATOR") | not) | {author: .user.login, body: .body}'
```

Ignore machine-posted marker comments (`FORGE:DIFF_SIZE`, `FORGE:SIZE_OVERRIDE`) in this scan: a `FORGE:DIFF_SIZE` comment is a plan source (below), never an owner override direction. Scan non-agent comments for override signals — phrases like "do not", "do NOT", "instead", "revert", "remove this", "override", "actually", or explicit disagreement with the investigation's recommendation. If an override comment is found from a repo owner or admin (not a bot):

1. **Document the override**: Note which direction the owner is steering (e.g., "remove the feature" vs. investigation's "keep with warnings")
2. **Re-derive sub-issue scopes**: Derive sub-issue titles, bodies, and file scope from the override direction — NOT from the original investigation recommendation. The investigation's Decomposition Assessment may list sub-issues that are now stale or contradictory with the override.
3. **If override makes a sub-issue obsolete**: Skip creating it. Note the skip reason in the decomposition comment (Phase D5).
4. **If override changes the sequencing dependency**: Revise the execution order so that the override's primary action (e.g., "strip the feature") completes before any downstream doc/SDK sub-issues are built against it.

**Why this matters**: Sub-issues scoped before an override are built against a stale premise. A docs sub-issue scoped as "neutralize liability language" becomes incorrect if the upstream schema sub-issue will fully remove the feature — the docs sub-issue should instead be "remove all references to the deleted feature." Building both in parallel against the pre-override scope produces contradictory staging state.

> **Shared Scoping Convention**: This investigation gate (blocks without a `FORGE:INVESTIGATOR` comment) is the **reference pattern** for investigation-gated issue creation across the pipeline. `milestone.md` Step 4 and `orchestrate.md` MUST apply the same principle: read code and identify all affected call sites BEFORE writing any issue body. Sub-issue bodies created in Phase D3 MUST use the Pipeline Issue Template defined in `issue.md` Phase 3D — that template is the single canonical standard for all automated issue creation. <!-- Added: forge#293 -->

Extract from investigation report:
- Decomposition Assessment section: list of proposed sub-issues with titles and dependencies

**Size-gate plan source** <!-- Added: forge#3450 -->: when the build's diff-size gate routed here, the investigation said no decomposition, so its assessment lists no sub-issues. Read the latest TRUSTED `FORGE:DIFF_SIZE` comment (anchored, through `scripts/trusted-comments.sh`; the Script resolution block applies) and use it when it has `result: OVER`:

```bash
# <Script resolution block, verbatim>
set -o pipefail
TRUSTED_SCRIPT="${UNIVERSAL_DIR:+$UNIVERSAL_DIR/trusted-comments.sh}"
if [ -n "$TRUSTED_SCRIPT" ] && [ -f "$TRUSTED_SCRIPT" ]; then
  SIZE_PLAN=$(gh api --paginate "repos/{GH_REPO}/issues/{NUMBER}/comments" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:DIFF_SIZE' | jq -r 'select(type == "string")' ) \
    && echo "SIZE_PLAN_READ=ok" || echo "SIZE_PLAN_READ=FAILED"
else echo "SIZE_PLAN_READ=FAILED"; fi
```

A `FAILED` read or a comment without `result: OVER` means there is no size-gate plan (the assessment rules below then apply unchanged). Its `### Split Proposal` lines (`- **{title}** — {files}`) are the proposed sub-issues, in dependency order, for Phase D2.
- Milestone (from issue metadata)
- Priority label (P0/P1/P2) from issue labels

Extract milestone title for sub-issue creation:
```bash
MILESTONE_TITLE=$(gh issue view {NUMBER} {GH_FLAG} --json milestone --jq '.milestone.title // empty')
```

---

## Phase D1: Guards and Resume Check

Evaluate in this order. Each BLOCKED exit runs the Blocked exit procedure.

**Guard 1 — issue is itself a sub-issue**: an issue whose body carries a `**Parent**: #N` reference is a child created by an earlier decomposition and is never decomposed again (prevents recursive decomposition). <!-- Added: forge#2379 -->

```bash
ISSUE_BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body')
PARENT_REF=$(printf '%s\n' "$ISSUE_BODY" | grep -E '^\*\*Parent\*\*: #[0-9]+' | head -1)
[ -n "$PARENT_REF" ] && echo "SUB_ISSUE_GUARD: ${PARENT_REF}"
```

If `PARENT_REF` is non-empty → BLOCKED, blocker: "Issue #{NUMBER} is a sub-issue (${PARENT_REF}) — sub-issues are never decomposed again; run /work-on build on it directly".

**Guard 2 — investigation report present**: If the FORGE:INVESTIGATOR comment is absent → BLOCKED, blocker: "No investigation report found — run investigate first".

**Guard 3 — decomposition plan present**: If the investigation report has no Decomposition Assessment section, OR the assessment does not list any sub-issues, AND there is no trusted `FORGE:DIFF_SIZE` comment with `result: OVER` and a `### Split Proposal` (the size-gate plan source from D0) → BLOCKED, blocker: "Investigation report has no decomposition plan — re-run investigate with explicit decomposition scope".

**Resume check**:

```bash
gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | contains("<!-- FORGE:DECOMPOSED -->"))] | last // empty | {url: .html_url, body: .body}'
```

If a `<!-- FORGE:DECOMPOSED -->` comment exists → decomposition already complete. Derive `sub_issues` as a plain number list from that comment's `- #N:` lines and the comment URL from `.url`:

```bash
# $DECOMP_BODY is the .body of the comment found above
SUB_LIST=$(printf '%s\n' "$DECOMP_BODY" | sed -nE 's/^- #([0-9]+).*/\1/p' | paste -sd, - | sed 's/,/, /g')
echo "sub_issues: [${SUB_LIST}]"
```

Run Phase D6 (idempotent label re-assert), then EXIT with `DECOMPOSE_RESULT: status: ALREADY_DONE`, `sub_issues: [${SUB_LIST}]`, `comment_url` from the comment.

---

## Phase D1.5: Collect Parent Knowledge Gist URLs

Query the parent issue's comments for `FORGE:KNOWLEDGE_GIST` annotations created by Phase 1C.5 of the investigation. These URLs will be embedded in each sub-issue body so downstream agents can fetch prior investigation context.

```bash
GIST_URLS=$(gh api repos/{GH_REPO}/issues/{NUMBER}/comments \
  --jq '[.[] | select(.body | test("<!-- FORGE:KNOWLEDGE_GIST: https://")) | .body | capture("<!-- FORGE:KNOWLEDGE_GIST: (?<url>https://[^ ]+) -->").url] | unique | .[]')

if [ -n "$GIST_URLS" ]; then
  echo "Found Knowledge Gist URL(s) on parent issue #${NUMBER}:"
  echo "$GIST_URLS"
else
  echo "No Knowledge Gist annotations found on parent issue #${NUMBER} — sub-issues will not include Prior Investigation section"
fi
```

If `GIST_URLS` is non-empty, a `## Prior Investigation` section will be appended to each sub-issue body in Phase D3.

---

## Phase D2: Design Sub-Issues

From the Decomposition Assessment in the investigation report (adjusted for any owner override detected in Phase D0), or, when the assessment lists none, from the size-gate `### Split Proposal` in the trusted `FORGE:DIFF_SIZE` comment (Phase D0), extract:
1. Sub-issue titles (in dependency order — independent issues first)
2. Dependencies between sub-issues (if issue B depends on issue A, A is created first)
3. Brief description for each sub-issue body

For each sub-issue, prepare:
- **Title**: from investigation report's proposed sub-issue title (re-derived from the owner override when one was detected), including the final `{fix|feat|refactor}: ` prefix used in Phase D3
- **Body**: brief description of scope + `**Parent**: #{NUMBER}` + dependency note if applicable
- **Labels**: inherit priority label (P0/P1/P2) from parent; do NOT copy workflow labels
- **Milestone**: same milestone title as parent (if parent has one)

Sub-issues made obsolete by an owner override are not created; record each as `SKIPPED_NOTES` (title + reason) for the Phase D5 comment.

**Ordering rule**: Create independent sub-issues first. If sub-issue B depends on A, create A first so its issue number can be referenced in B's body.

---

## Phase D2.5: Equivalent Set Check

Before creating any sub-issue, check whether the complete planned title set already exists for this parent. This covers an interrupted earlier decomposition: its child issues may exist even though it never reached the `FORGE:DECOMPOSED` comment checked in Phase D1.

```bash
# SUB_TITLES contains the final, ordered titles prepared in D2.
EXPECTED_TITLES=$(printf '%s\n' "${SUB_TITLES[@]}" | jq -Rsc 'split("\n") | map(select(length > 0)) | sort')
PARENT_SUB_ISSUES=$(gh issue list {GH_FLAG} --state all \
  --search "\"**Parent**: #{NUMBER}\" in:body" --limit 100 --json number,title,body)

# Keep the earliest child for each title as canonical. This also collapses a
# previously duplicated set without creating a third copy.
CANONICAL_SUB_ISSUES=$(jq --arg parent "**Parent**: #{NUMBER}" --argjson expected "$EXPECTED_TITLES" '
  ([.[] | select(.body | contains($parent)) | {number, title}]
    | sort_by(.number) | group_by(.title) | map(.[0])) as $canonical
  | ($canonical | map(.title) | sort) as $actual
  | if $actual == $expected then $canonical else empty end
' <<< "$PARENT_SUB_ISSUES")

# Plain number list for the result block, e.g. "101, 102"
CANONICAL_NUMBERS=$(printf '%s' "$CANONICAL_SUB_ISSUES" | jq -r 'map(.number) | sort | map(tostring) | join(", ")' 2>/dev/null)
```

If `CANONICAL_SUB_ISSUES` is non-empty, the decomposition has already created an equivalent set. Do **not** create issues, edit the parent body, or post another decomposition comment. Preserve those original sub-issues, run Phase D6 (idempotent label re-assert), and EXIT with:

```
DECOMPOSE_RESULT:
  status: ALREADY_DONE
  sub_issues: [${CANONICAL_NUMBERS}]
  comment_url:
  blocker:
```

If no exact title-set match exists, continue. A partial set is not equivalent: let `/issue` dedup protect its existing children while creating only the missing work.

---

## Phase D3: Create Sub-Issues

For each sub-issue (in dependency order), route creation through the `/issue` create-hook's programmatic invocation contract (`commands/issue.md` Programmatic Invocation Contract, added in #2085) instead of calling `gh issue create` directly. `/issue`'s Phase 2D runs the same `scripts/issue-dedup.sh` check this file used to run manually — dedup is enforced inside the create-hook on every call, with no bypass path. <!-- Changed: forge#2086 — route through /issue create-hook -->

Initialise once before the loop: `CREATED_NUMBERS=""` (comma-separated, for the result block) and `SKIPPED_NOTES=""`.

**Sanitise the title and compose the sub-issue body to a temp file** (avoids quoting issues when passed as `--body-file`):

```bash
SUB_TITLE="{fix|feat|refactor}: {SUB_ISSUE_TITLE}"
# Defense-in-depth: /issue's arg tokenizer (commands/issue.md, forge#2094) uses
# an xargs-based tokenizer that never expands backtick/$(...) substitution, so
# this is no longer required for safety — but strip it anyway so the raw title
# stays readable if it round-trips through any other eval-based consumer.
SUB_TITLE=$(printf '%s' "$SUB_TITLE" | tr '`' "'" | sed 's/\$(/$ (/g')
SUB_BODY_FILE="$(mktemp)"
cat > "$SUB_BODY_FILE" <<'SUB_BODY_EOF'
## Problem

{1-3 sentences: what this sub-issue specifically addresses. What's wrong or what needs to be built for this sub-task.}

## Root Cause (if known)

{Specific root cause for this sub-task from the parent investigation. If unknown: "Root cause unknown — investigation needed."}

## Affected Files

Files that need changes:
1. `{filepath}` — {what needs to change}
2. `{filepath}` — {what needs to change}

## Acceptance Criteria

- [ ] {Specific, testable criterion}
- [ ] {Specific, testable criterion}
- [ ] No regression in {related feature}

## Context

**Parent**: #{NUMBER}
{If depends on another sub-issue: "**Depends on**: #{SUB_ISSUE_N} — {reason}"}
SUB_BODY_EOF
```

**Build the milestone arg** (only when the parent has a milestone — a parent with no milestone must not receive `--milestone ""`):

```bash
MILESTONE_ARG=""
[ -n "$MILESTONE_TITLE" ] && MILESTONE_ARG=" --milestone \"${MILESTONE_TITLE}\""
```

**Invoke `/issue` in programmatic mode**:

```
ISSUE_SKILL_OUTPUT=$(Skill(skill="{FORGE_SKILL_PREFIX}issue", args="--title \"${SUB_TITLE}\" --body-file \"${SUB_BODY_FILE}\" --label \"{PRIORITY_LABEL}\"${MILESTONE_ARG}"))
```

If the skill is not found → BLOCKED, blocker: "skill not found: issue".

`/issue` runs Phase 2D dedup, Phase 3F body validation, then creates the issue (Phase 4) — no separate pre-check needed on this side.

If the `--milestone` flag fails (milestone not found by name): re-invoke without `${MILESTONE_ARG}`, set `MILESTONE_SKIPPED=1`, and note in the FORGE:DECOMPOSED comment that milestone assignment was skipped.

**Extract the created sub-issue number from the Skill output** (see `commands/issue.md` Phase 4C/4E — it echoes `Created: {url}` and reports `**#{NUMBER}**: {title}`). If parsing yields nothing, fall back to an exact-title search scoped to this parent (covers `/issue` output not being captured by the Skill harness):

```bash
# Match either the "Created: {url}" line (extract trailing /issues/N) or the "**#{NUMBER}**" bold report line.
SUB_NUMBER=$(echo "$ISSUE_SKILL_OUTPUT" | grep -oE 'issues/[0-9]+' | head -1 | grep -oE '[0-9]+')
[ -z "$SUB_NUMBER" ] && SUB_NUMBER=$(echo "$ISSUE_SKILL_OUTPUT" | grep -oE '\*\*#[0-9]+\*\*' | head -1 | grep -oE '[0-9]+')

# Fallback: exact-title search, restricted to issues whose body carries this parent's reference
# (so a pre-existing near-duplicate that /issue dedup stopped on is never mistaken for the new child).
# Retries absorb GitHub Search API indexing lag.
if [ -z "$SUB_NUMBER" ]; then
  for _resolve_attempt in 1 2 3; do
    SUB_NUMBER=$(gh issue list {GH_FLAG} --search "in:title \"${SUB_TITLE}\"" --state open --limit 10 --json number,title,body 2>/dev/null \
      | jq -r --arg t "$SUB_TITLE" --arg p "**Parent**: #{NUMBER}" '[.[] | select(.title == $t and (.body | contains($p)))][0].number // empty')
    [ -n "$SUB_NUMBER" ] && break
    sleep 2
  done
fi

rm -f "$SUB_BODY_FILE"

if [ -z "$SUB_NUMBER" ]; then
  echo "WARNING: /issue did not report a created issue number for sub-issue '${SUB_TITLE}' — likely a Phase 2D dedup STOP (near-duplicate found) or a usage error. Skipping this sub-issue: do not reference it in the parent tracker or in dependent sub-issue bodies. Review the Skill output above and, if a near-duplicate exists, comment on the existing issue instead."
  SKIPPED_NOTES="${SKIPPED_NOTES}
- ${SUB_TITLE} — not created (dedup stop or /issue error)"
else
  CREATED_NUMBERS="${CREATED_NUMBERS:+${CREATED_NUMBERS}, }${SUB_NUMBER}"
fi
```

If `SUB_NUMBER` is empty, treat this sub-issue as not created — do not add it to the parent tracker checklist (Phase D4) and do not reference it as a dependency in later sub-issues.

**Append Prior Investigation section** (conditional — only if `GIST_URLS` from Phase D1.5 is non-empty):

After creating each sub-issue, append the `## Prior Investigation` section containing all parent Gist URLs. This keeps the Gist references machine-readable for downstream agents.

```bash
if [ -n "$GIST_URLS" ]; then
  SUB_BODY=$(gh issue view {SUB_NUMBER} {GH_FLAG} --json body --jq '.body')

  PRIOR_SECTION="

## Prior Investigation

Investigation findings from the parent issue are available as Knowledge Gists:
"
  while IFS= read -r url; do
    PRIOR_SECTION="${PRIOR_SECTION}
<!-- FORGE:PRIOR_GIST: ${url} -->
- ${url}"
  done <<< "$GIST_URLS"

  gh issue edit {SUB_NUMBER} {GH_FLAG} --body "${SUB_BODY}${PRIOR_SECTION}"
fi
```

After the loop, if `CREATED_NUMBERS` is empty (no sub-issue was created) → BLOCKED, blocker: "No sub-issues were created (all skipped or deduplicated) — review the /issue output".

---

## Phase D4: Update Parent Issue Body

Add a tracker checklist to the parent issue body showing all sub-issues in dependency order:

```bash
CURRENT_BODY=$(gh issue view {NUMBER} {GH_FLAG} --json body --jq '.body')

TRACKER="

---

## Sub-Issue Tracker

{if sub-issue B depends on A, note it inline}
- [ ] #{SUB_ISSUE_1_NUMBER} — {SUB_ISSUE_1_TITLE}
- [ ] #{SUB_ISSUE_2_NUMBER} — {SUB_ISSUE_2_TITLE} _(depends on #{SUB_ISSUE_1_NUMBER})_
..."

gh issue edit {NUMBER} {GH_FLAG} --body "${CURRENT_BODY}${TRACKER}" # allowlist:check-command-side-effects
```

---

## Phase D5: Post FORGE:DECOMPOSED Comment

**Before posting, read the attribution config**:
```bash
SHOW_ATTRIBUTION=$(yq '.branding.show_attribution // "true"' forge.yaml 2>/dev/null || echo "true")
[ "$SHOW_ATTRIBUTION" = "false" ] && ATTRIBUTION_LINE="" || ATTRIBUTION_LINE="
> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"
```

Compose the comment body. Include the `### Skipped Sub-Issues` section only when `SKIPPED_NOTES` is non-empty (each owner-override-obsolete sub-issue and each not-created sub-issue, with its reason), an `### Owner Override` line when Phase D0 detected one (the direction the owner steered), and a milestone-skipped note when `MILESTONE_SKIPPED=1`.

```bash
[ "${DRY_RUN:-false}" = "true" ] && { echo "[DRY_RUN] would post the comment below"; exit 0; }
COMMENT_URL=$(gh issue comment {NUMBER} {GH_FLAG} --body "<!-- FORGE:DECOMPOSED -->
## Decomposition Complete

This issue has been broken into sub-issues. Each sub-issue runs through its own /work-on pipeline independently.

### Sub-Issues Created

{for each sub-issue, in dependency order:}
- #{SUB_ISSUE_NUMBER}: {TITLE}{if has dependency: _(depends on #{DEP_NUMBER})_}

{if SKIPPED_NOTES non-empty:}
### Skipped Sub-Issues

${SKIPPED_NOTES}

{if owner override detected:}
### Owner Override

{override direction and how it changed the sub-issue scopes/order}

### Decomposition Rationale

{brief summary of why this issue was decomposed and the dependency ordering chosen}
${ATTRIBUTION_LINE}
<!-- FORGE:DECOMPOSED:COMPLETE -->") # allowlist:check-command-side-effects
```

---

## Phase D6: Update Labels

Decompose is the SOLE owner of the `workflow:decomposed` label. Transition with tiered dispatch; a transition to `decomposed` removes every other workflow label. Also run this block (idempotently) on both ALREADY_DONE exits.

```bash
run() { if [ -n "${DRY_RUN:-}" ]; then echo "DRY_RUN: $*"; else "$@"; fi; }
RESOLUTION=$(resolve_script 'transition-label'); TIER="${RESOLUTION%%:*}"; SCRIPT_PATH="${RESOLUTION#*:}"
case "$TIER" in
  adaptive|universal) run bash "$SCRIPT_PATH" {NUMBER} {GH_FLAG} decomposed ;;
  prose)
    run gh issue edit {NUMBER} {GH_FLAG} --add-label "workflow:decomposed" \
      --remove-label "workflow:investigating,workflow:ready-to-build,workflow:building,workflow:in-review,workflow:remediating,workflow:awaiting-merge,workflow:merged,workflow:invalid" 2>/dev/null || true
    ;;
esac
```

---

## Phase D7: STOP

Decomposition is a terminal route for the parent issue. Each sub-issue will be picked up separately by /work-on.

Print the result block (see Result emission) as the final reply, with `status: COMPLETE`, `sub_issues: [${CREATED_NUMBERS}]` (numbers only) and `comment_url: ${COMMENT_URL}`.

**Router behavior after DECOMPOSE_RESULT**: `break` — do not continue to build/review/close for the parent issue.

---

## Output

The subcommand writes its results to GitHub (FORGE:DECOMPOSED comment + sub-issues created). The router breaks after this subcommand returns.

```
DECOMPOSE_RESULT:
  status: COMPLETE | ALREADY_DONE | BLOCKED
  sub_issues: [N, N, ...]
  comment_url: {url of posted FORGE:DECOMPOSED comment}
  blocker: {description if status=BLOCKED}
```
