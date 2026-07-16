---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 1: Resolve the Issue Set

## Phase 1: Resolve the Issue Set

Parse `$ARGUMENTS` to determine which issues to work on:

### Input Patterns

| Input | Resolution |
|-------|------------|
| `milestone <slug>` | All open issues assigned to that GitHub milestone (default repo) |
| `#1 #2 #3` or `1 2 3` | Specific issue numbers, optionally repo-prefixed (e.g., `#123 mcp:5 n8n:12`) |
| `next <N>` | Top N priority open issues (P0 first, then P1, etc. — accepts both `priority:P<n>` and bare `P<n>` labels, see "Priority label schema" note under P3 batching below) |
| `next <N> all-repos` | Top N across ALL ecosystem repos |
| `fast-lane` or `fast` | All open fast-lane issues (no milestone, bugs/fixes) |
| `priority:P0` or `priority:P1` | All open issues with that priority label (matches both `priority:P<n>` and bare `P<n>` on the target repo — see "Priority label schema" note below) |
| `mcp:fast` or `n8n:next 3` | Repo-scoped queries |
| `cascade`, `review-findings`, or `findings` (optionally `--include-deferred` / `--allow-gen2`) | All open `review-finding` issues (default repo, or repo-scoped e.g. `mcp:cascade`). See "Cascade / Review-Finding Resolution" below — by default this admits up to `orchestration.cascade.max_generation` (default 1, i.e. generation ≥ 2 `PERMANENT_DEFERRED` findings excluded); the CLI flags force `unlimited` for this one run, overriding config. <!-- Added: forge#2231, forge#2234 -->|
| `<slug>` (no keyword) | Try milestone first, then fall back to label search. If both resolve to zero issues, report near-miss label candidates instead of silently resolving to nothing — see "Near-Miss Suggestion" below. <!-- Added: forge#2231 -->|

### Cascade / Review-Finding Resolution

<!-- Added: forge#2231 -->

When the input matches `cascade`, `review-findings`, or `findings` (case-insensitive, optionally repo-prefixed), resolve to open `review-finding`-labeled issues instead of a milestone or plain label search, then apply a generation depth check so the default set here matches what Step 4C would actually admit:

```bash
# Fetch all open review-finding issues, including body (needed for the generation check below —
# unlike a plain label search, we cannot skip straight to {number,title,labels,milestone} here).
CASCADE_CANDIDATES=$(gh issue list {GH_FLAG} --label "review-finding" --state open --limit 500 \
  --json number,title,labels,milestone,body)

# --- Cascade admission policy resolution (forge#2234) ---
# orchestration.cascade.max_generation is the config-driven, granular successor to the
# pre-#2234 --include-deferred/--allow-gen2 flags: instead of an all-or-nothing "admit
# every deferred generation," an operator can say "admit up to generation 3" and no
# further. Preset table mirrors phase-4-execution.md's Step 4A.pre resolution exactly
# (see bin/engine/admission.mjs for the typed, unit-tested reference implementation).
CASCADE_POLICY_NAME=$(yq '.orchestration.cascade.policy // "balanced"' forge.yaml 2>/dev/null || echo "balanced")
[ "$CASCADE_POLICY_NAME" = "null" ] && CASCADE_POLICY_NAME="balanced"
case "$CASCADE_POLICY_NAME" in
  all) PRESET_MAX_GEN="unlimited" ;;
  conservative|balanced) PRESET_MAX_GEN=1 ;;
  *) echo "WARNING: forge.yaml → orchestration.cascade.policy \"${CASCADE_POLICY_NAME}\" is not one of: all, balanced, conservative — falling back to \"balanced\""
     CASCADE_POLICY_NAME="balanced"; PRESET_MAX_GEN=1 ;;
esac
MAX_GENERATION=$(yq ".orchestration.cascade.max_generation // \"${PRESET_MAX_GEN}\"" forge.yaml 2>/dev/null || echo "$PRESET_MAX_GEN")
[ "$MAX_GENERATION" = "null" ] && MAX_GENERATION="$PRESET_MAX_GEN"
if [ "$MAX_GENERATION" != "unlimited" ] && ! echo "$MAX_GENERATION" | grep -qE '^[1-9][0-9]*$'; then
  echo "WARNING: forge.yaml → orchestration.cascade.max_generation is not a positive integer or \"unlimited\" (\"${MAX_GENERATION}\") — falling back to default ${PRESET_MAX_GEN}"
  MAX_GENERATION="$PRESET_MAX_GEN"
fi

# Pre-#2234 CLI override — still honored for this resolve step specifically. Either flag
# forces MAX_GENERATION to "unlimited" for this run only, taking precedence over both the
# preset and any explicit orchestration.cascade.max_generation value (a human typing
# --allow-gen2 at the CLI is asking for everything, right now, overriding config).
echo "{ARGUMENTS}" | grep -qE -- '--include-deferred|--allow-gen2' && MAX_GENERATION="unlimited"

echo "Cascade resolve: policy=${CASCADE_POLICY_NAME} max_generation=${MAX_GENERATION} (forge.yaml → orchestration.cascade.max_generation; --include-deferred/--allow-gen2 forces unlimited)"
# --- End cascade admission policy resolution ---

# Generation depth — walks the "spawned from issue #N" / "source issue #N" chain up to
# MAX_HOPS times, counting how many review-finding-labeled ancestors precede this finding.
# Generation 1 = not spawned from a review-finding (an original issue). Generation 2 = spawned
# from a review-finding. Generation 3 = spawned from a finding that was itself spawned from a
# review-finding. This numeric walk (rather than the pre-#2234 single-hop boolean) is what
# makes "admit gen-2, stop at gen-3" (max_generation: 3) expressible — a binary flag cannot
# say that; it can only say "admit everything deferred" or "admit nothing deferred." Bounded
# at MAX_HOPS to guard against a malformed/cyclic reference chain.
MAX_HOPS=10
compute_generation() {
  local body="$1"
  local generation=1
  local hops=0
  while [ "$hops" -lt "$MAX_HOPS" ]; do
    # Portable two-step extraction (grep -E, not -P/PCRE — macOS BSD grep lacks \K support):
    # first match the whole "spawned from issue #N" / "source issue: #N" phrase, then pull
    # the trailing digits off that match.
    local source_num
    source_num=$(echo "$body" | grep -ioE 'spawned from issue #[0-9]+|source issue[: #]+[0-9]+' | head -1 | grep -oE '[0-9]+$')
    [ -z "$source_num" ] && break
    local source_data
    source_data=$(gh issue view "$source_num" {GH_FLAG} --json labels,body 2>/dev/null) || break
    echo "$source_data" | jq -e '[.labels[].name] | index("review-finding")' >/dev/null 2>&1 || break
    generation=$((generation + 1))
    body=$(echo "$source_data" | jq -r '.body')
    hops=$((hops + 1))
  done
  echo "$generation"
}

CASCADE_RESOLVED="[]"
echo "$CASCADE_CANDIDATES" | jq -c '.[]' | while IFS= read -r FINDING; do
  FINDING_BODY=$(echo "$FINDING" | jq -r '.body')
  GENERATION=$(compute_generation "$FINDING_BODY")
  if [ "$MAX_GENERATION" = "unlimited" ] || [ "$GENERATION" -le "$MAX_GENERATION" ]; then
    echo "$FINDING" | jq --argjson gen "$GENERATION" '{number, title, labels: [.labels[].name], milestone: .milestone.title, generation: $gen}'
  fi
done
```

**Generation > `max_generation` findings are excluded by default** by the loop above — a `review-finding` issue whose *source* chain is deeper than `orchestration.cascade.max_generation` (default: 1, i.e. generation ≥ 2 excluded — the pre-#2234 behavior, unchanged when the section is absent) is normally deferred permanently (`PERMANENT_DEFERRED`) by Step 4C's own absolute check. That cap is an **autonomy guard**, not a human-request guard: it exists to stop an unattended run from cascading forever, not to block an operator who explicitly asked for this exact bucket of work. See `phase-4-execution.md` Step 4C rule 1 and the reworded anti-pattern note for the full rationale.

This resolve step is a human-requested entry point (the operator typed `cascade`/`review-findings`/`findings` directly), so it honors an explicit override:

- `--include-deferred` or `--allow-gen2` appended to the input (e.g. `cascade --allow-gen2`, `review-findings --include-deferred`): forces `MAX_GENERATION="unlimited"` above, admitting every generation into the resolved set for this run. Without either flag, `orchestration.cascade.max_generation` (default 1) governs how deep the resolved set reaches — the flags/config only change what this **explicit** request is allowed to touch; they do not relax Step 4C's autonomous behavior for anything spawned *during* this run (see "Recursion safety" below).
- **`orchestration.cascade.max_generation`** (forge#2234) is the config-driven successor to the CLI flags above and supports a granularity the flags cannot: `max_generation: 3` admits generations 1-3 and stops at 4, expressing "admit gen-2, stop at gen-3" directly — something an all-or-nothing `--allow-gen2` flag could never say. The flags remain available and, when passed, override config with `unlimited` for that one invocation.

**Recursion safety (unchanged)**: findings spawned *during* this run by its own sweep agents are still never re-swept, regardless of whether `--include-deferred`/`--allow-gen2`/`orchestration.cascade.max_generation` was in effect at resolve time — see `phase-4-execution.md` Step 4C rules and the recursion-safety note near the anti-patterns list. The override above only widens what this one resolve step admits from the *pre-existing* open issue set; it has no effect on Step 4C's in-run admission logic.

### Near-Miss Suggestion

<!-- Added: forge#2231 -->

When a bare `<slug>` (no keyword) resolves to **zero** issues via both the milestone lookup and the label-search fallback, do not silently return an empty set. Fetch the repo's label list and suggest the closest matching label(s) instead:

```bash
ALL_LABELS=$(gh label list {GH_FLAG} --json name --jq '.[].name')
# Simple substring/prefix match against the attempted slug — no fuzzy-matching library required.
NEAR_MISS=$(echo "$ALL_LABELS" | grep -iE "${SLUG:0:4}" || true)
```

Report back to the caller: `No milestone or label matched "{SLUG}". Did you mean: {NEAR_MISS list, or "review-finding"/"batch" if SLUG resembles "cascade"}?` This directly fixes the case reported in #2231 — `cascade` is not itself a label in most repos (the only cascade-adjacent labels are `review-finding` and `batch`), so a bare `cascade` slug previously resolved to nothing with no feedback. Note that `cascade`/`review-findings`/`findings` are now handled by the dedicated resolution rule above and never reach this bare-slug fallback path at all — this near-miss path remains for any other unmatched slug.

### Fetch the issues

For each resolved repo, use the appropriate `-R` flag:

```bash
# Default repo (no flag needed if using GH_FLAG="" for the default):
gh issue list {GH_FLAG} --milestone "{TITLE}" --state open --limit 500 --json number,title,labels,milestone --jq '.[] | {number, title, labels: [.labels[].name], milestone: .milestone.title}'

# Satellite repos — always include -R flag with the satellite repo from forge.yaml:
# For each satellite in forge.yaml → repos.satellites:
gh issue list -R {SATELLITE_REPO} --milestone "{TITLE}" --state open --limit 500 --json number,title,labels,milestone

# For specific numbers with repo prefix:
gh issue view {NUMBER} -R {SATELLITE_REPO} --json number,title,labels,state,milestone,body

# For "all-repos" — fetch from all configured repos and combine:
gh issue list {GH_FLAG} --state open --limit {N} --json number,title,labels,milestone
# For each satellite in forge.yaml → repos.satellites:
gh issue list -R {SATELLITE_REPO} --state open --limit 500 --json number,title,labels,milestone
# Combine, sort by priority, take top N.
# Priority rank when sorting: read each issue's labels and normalize to bare P<n> form —
# `priority:P<n>` and bare `P<n>` both resolve to the same rank (see "Priority label schema"
# note under P3 batching below); an issue with neither label form sorts last, not first, and
# should be logged as untriaged rather than silently treated as top priority. <!-- Added: forge#2232 -->
```

**Count validation**: After fetching issues, log the count returned. If a milestone query returns exactly 30 issues, warn the user: "WARNING: Exactly 30 issues returned — gh CLI default may have truncated results. Re-running with --limit 500 is recommended." (The --limit 500 above prevents this for standard runs, but verify if the count seems suspiciously low relative to milestone expectations.)

**Tag each issue with its project prefix** in your internal tracking so sub-agents receive the correct repo context.

### Filter out ineligible issues

Remove issues that should NOT be worked on:
- Already closed or has `workflow:merged` label
- Has `workflow:invalid` label
- Has `needs-human` label (requires manual action)
- Has `workflow:decomposed` label (parent tracker — its sub-issues should be picked up instead)
- Has `workflow:building` or `workflow:in-review` label (already in progress)
- Is an epic (`epic` label) — these are planning containers, not buildable

If a `workflow:decomposed` issue is found, automatically expand it to its open sub-issues instead.

### P3 Review-Finding Batching (deterministic grouping rule)

<!-- Added: forge#1333 -->
<!-- Extended: forge#1818 — default-batchable eligibility, surface-area grouping, lowered same-file threshold -->
<!-- Extended: forge#2232 — priority-label schema tolerance (bare P<n> vs priority:P<n>) -->

Before finalizing the issue set, apply the P3 batching rule to reduce full-pipeline overhead on low-severity review findings.

**Priority label schema**: ForgeDock's own issue creator (`review-pr.md`) writes only the canonical `priority:P<n>` label form. Some repos this pipeline operates against (issues opened externally, imported, or predating ForgeDock adoption) instead carry a bare `P<n>` label with no `priority:` prefix. Every priority-read check in this section — and its mirrors in `phase-4-execution.md` and `cleanup.md` — MUST accept both forms. `priority:P<n>` wins when (unusually) both are present on the same issue. Issue-*creation* call sites (the batch-issue creation below) are unaffected and keep writing canonical `priority:P<n>` only — there is no case where this pipeline needs to *write* the bare form. <!-- Added: forge#2232 -->

**Trigger conditions** (default-batchable — no opt-in marker required):
1. The issue has label `review-finding` + a P3 priority label (`priority:P3` or bare `P3`)
2. The issue does NOT match any Safety exclusion below

The `<!-- FORGE:BATCHABLE -->` marker (still appended by `review-pr.md` at finding-creation time) is honored when present but is no longer REQUIRED for eligibility — a `review-finding`+`priority:P3` issue is batchable by default unless explicitly excluded. This closes the gap where cascade-spawned findings that never carried the marker sat un-batched indefinitely. <!-- Added: forge#1818 -->

**Safety exclusions — NEVER batch, at any priority** (override all trigger conditions):
- Issue body contains the word "security", "billing", "anti-bot", or "auth" anywhere in the title or `## Problem` section
- Issue has a `security`, `billing`, `anti-bot`, or `auth` label

These exclusions apply regardless of priority: P1/P2 findings are already never batched (see Important limits), and P3 findings in these domains are excluded even though they would otherwise qualify for default-batchable treatment. <!-- Added: forge#1818 -->

**Grouping algorithm (surface area — same file first, leaf directory as broader fallback):** <!-- Changed: forge#1818 — was domain-only -->
```bash
# Fetch all open batchable P3 issues (default-batchable; marker no longer required).
# NOTE: `--label` is an exact-match GH filter and cannot OR "priority:P3" with bare "P3" in
# one query, so the P3 test moves into the jq predicate below (schema-tolerant, forge#2232).
# Only "review-finding" stays in the --label filter.
BATCHABLE_P3=$(gh issue list {GH_FLAG} \
  --state open \
  --label "review-finding" \
  --limit 500 \
  --json number,title,body,labels \
  --jq '.[] | select([.labels[].name] | any(test("^(priority:)?P3$")))
         | select((.title | test("security|billing|anti-bot|auth"; "i")) | not)
         | select(.body | test("## Problem[\\s\\S]{0,500}(security|billing|anti-bot|auth)"; "i") | not)
         | select(([.labels[].name] | any(. == "security" or . == "billing" or . == "anti-bot" or . == "auth")) | not)')

# Surface area = the exact affected file path listed first under "## Affected Files" (primary grouping key).
# Leaf directory = dirname of that file (broader fallback grouping key, formerly called "domain").
# e.g., "services/api/auth/login.py"              → EXCLUDED (auth path)
#        "web/src/app/billing/page.tsx"           → EXCLUDED (billing path)
#        "commands/orchestrate/phase-1-resolve.md" → file "commands/orchestrate/phase-1-resolve.md", leaf-dir "commands/orchestrate"
#        "commands/review-pr.md"                   → file "commands/review-pr.md", leaf-dir "commands"
```

**Batch creation rule (two-tier threshold):** <!-- Changed: forge#1818 — added lower same-file tier -->
- **Same-file cluster** (primary, low threshold): When **2+** batchable P3 issues share the exact same affected file, create a batch issue for that file cluster. Same-file P3 findings are the dominant low-value token sink (dead imports, stale comments, style nits) and already conflict with each other if built individually — the low threshold reflects that they'd otherwise serialize into slow one-at-a-time chains regardless of count.
- **Leaf-directory cluster** (broader grouping, existing threshold preserved): When **5+** batchable P3 issues share the same leaf directory but are not already covered by a same-file cluster above, OR the oldest batchable P3 in that leaf directory exceeds 72 hours, create a batch issue for that leaf-directory cluster.
- Form same-file clusters first; evaluate any remaining ungrouped findings for leaf-directory clustering. A finding is claimed by at most one batch.

**Sanitize the surface-area path before interpolation (MANDATORY):** `{SURFACE_AREA}` is an affected-file path derived from an issue body, and git filenames can legally carry shell metacharacters (`` ` ``, `$()`, quotes). Restrict it to a validated `[A-Za-z0-9._/-]` charset before templating it into `--title` / `--body`, so an untrusted issue body cannot break the `gh` argument boundary. The same guard is applied at the mirror site in `phase-4-execution.md`. <!-- forge#1833, forge#1835 -->

**Route batch issue creation through `/issue`'s programmatic invocation contract** (`commands/issue.md`, added #2085) instead of calling `gh issue create` directly — this gets dedup (Phase 2D) and mandatory-section body validation (Phase 3F) for free. <!-- Changed: forge#2086 — route through /issue create-hook -->

```bash
SAFE_SURFACE_AREA=$(printf '%s' "{SURFACE_AREA}" | tr -cd 'A-Za-z0-9._/-')
BATCH_BODY_FILE="$(mktemp)"
cat > "$BATCH_BODY_FILE" <<'BATCH_EOF'
## Problem

Batch of P3 review findings in **{SURFACE_AREA}** (same file or leaf directory), grouped to reduce per-finding pipeline overhead.

## Member Findings

<!-- FORGE:BATCH_MEMBERS -->
{for each member issue: "- [ ] #{NUM}: {TITLE}"}
<!-- /FORGE:BATCH_MEMBERS -->

## Acceptance Criteria

- [ ] All member findings addressed or closed as false-positive
- [ ] Member issues auto-closed with reference to this batch PR on merge
- [ ] No security, billing, anti-bot, or auth paths touched (validated before batching)

## Context

**Batch policy**: 2+ open P3 findings sharing the same file, or 5+ sharing the same leaf directory, or oldest > 72h.
**Member issues**: #{N1}, #{N2}, #{N3}, ...

<!-- FORGE:BATCHABLE -->
BATCH_EOF
```

```
ISSUE_SKILL_OUTPUT=$(Skill(skill="issue", args="--title \"fix(batch): P3 review findings — ${SAFE_SURFACE_AREA} (batch #{BATCH_N})\" --body-file \"${BATCH_BODY_FILE}\" --label \"review-finding\" --label \"priority:P3\" --label \"batch\""))
```

**Extract the created batch issue number from the Skill output** (see `commands/issue.md` Phase 4C/4E — it echoes `Created: {url}` and reports `**#{NUMBER}**: {title}`):

```bash
BATCH_ISSUE_NUM=$(echo "$ISSUE_SKILL_OUTPUT" | grep -oE 'issues/[0-9]+' | head -1 | grep -oE '[0-9]+')
[ -z "$BATCH_ISSUE_NUM" ] && BATCH_ISSUE_NUM=$(echo "$ISSUE_SKILL_OUTPUT" | grep -oE '\*\*#[0-9]+\*\*' | head -1 | grep -oE '[0-9]+')

if [ -z "$BATCH_ISSUE_NUM" ]; then
  echo "WARNING: /issue did not report a created batch issue number — likely a Phase 2D dedup STOP (near-duplicate found) or a usage error. Do not replace member issues with a batch issue for this cluster; leave the members on the standard individual pipeline instead."
fi
```

**Replace member issues with the batch issue** in the resolved issue set. Member issues are NOT individually dispatched to `/work-on` — the batch issue is the single pipeline unit.

**Important limits**:
- Max **8** members per batch issue — if more than 8 batchable P3s exist in a surface-area cluster, create multiple batch issues of ≤ 8 each <!-- Changed: forge#1818 — was 10 -->
- P1 and P2 issues are NEVER batched — they keep the standard one-issue-one-PR path
- Security/billing/anti-bot/auth findings are NEVER batched at any priority (see Safety exclusions above) <!-- Added: forge#1818 -->
- Batch issues themselves are never nested inside other batch issues

If fewer than 2 batchable P3 findings share a file, AND fewer than 5 share a leaf directory, AND none exceed 72h, skip batch creation entirely — individual P3s run through the standard pipeline.

### CRITICAL: No duplicate detection at orchestrator level

**The orchestrator NEVER closes, merges, or deduplicates issues.** Even if two issues look like duplicates (similar titles, same error message, same symptoms), they may target different code paths, different ORM objects, or different failure modes. Only a `/work-on` investigation agent — after reading the actual code — can determine whether an issue is truly a duplicate.

**What the orchestrator must NOT do:**
- Close an issue as "duplicate" based on title/symptom similarity
- Skip an issue because another issue "covers it"
- Merge two issues into one agent
- Make ANY judgment about issue validity

**What the orchestrator SHOULD do:**
- If two issues look related, add a note in the agent prompt: "Note: #{OTHER} has similar symptoms — investigate whether this is the same root cause or a different code path"
- Let both agents run independently — if one finds it's truly a duplicate, `/work-on`'s investigation phase will close it as invalid with evidence
- Flag potential overlap in the DAG plan for the user's awareness, but NEVER act on it

**Why**: Surface-level similarity hides critical differences. #3842 (api_key.id lazy load) and #4039 (user.id lazy load) had identical error messages but targeted completely different ORM objects. Closing #4039 as a "duplicate" would have left a customer-impacting P0 bug unfixed.

---

