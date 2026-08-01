---
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Phase 2.5: Investigation Synthesis

## Phase 2.5: Investigation Synthesis

<!-- Added: forge#1192 -->

**Purpose**: Reconcile *competing recommendations* across investigation outputs BEFORE they fan out to implementation agents. Phase 3's conflict detection (Step 3C) deconflicts issues at the **file** layer only — it prevents git merge conflicts. It performs **zero semantic deconfliction**: two issues can touch entirely different files while proposing **contradictory approaches to the same problem**, and the file-overlap detector passes both straight to parallel dispatch. This phase closes that gap by clustering investigations semantically (by target subsystem, not by file) and arbitrating incompatible plans into a single decision — or serializing them so the second agent inherits the first's decision.

**This phase operates ONLY on FORGE annotations and issue bodies. It NEVER reads code, and it NEVER closes, skips, or merges issues.** Reconciling plans/annotations is distinct from adjudicating *duplicate validity* (Safety Rule 9, the #3842/#4039 scar): the anti-dedup rule forbids the orchestrator from deciding two issues are the same bug and closing one — that call belongs to `/work-on` investigation agents examining actual code. Plan reconciliation touches neither code nor issue state; it only writes a synthesis brief annotation and adds `Depends on #X` serialization edges. It therefore does not violate Hard Rule 2 (dispatcher, not builder) or Safety Rule 9.

**No-op guard**: This entire phase is skipped when the batch contains **0 or 1 investigations** — there is nothing to reconcile against. Proceed directly to Phase 3.

### Step 2.5A: No-op guard

```bash
# Count investigations that completed in Wave 0 (Phase 2), regardless of whether each
# has an available repository comment reference. Use the full completed-investigation
# set (the same {investigation_numbers} that Steps 2C.5, 2.5B and 2.5C iterate) so an
# investigation is not silently dropped when its repository context is unavailable.
# If < 2, skip synthesis entirely.
INVESTIGATION_NUMS=( {investigation_numbers} )
INVESTIGATION_COUNT=${#INVESTIGATION_NUMS[@]}
if [ "$INVESTIGATION_COUNT" -lt 2 ]; then
  echo "Phase 2.5 skipped: ${INVESTIGATION_COUNT} investigation(s) in batch — nothing to reconcile. Proceeding to Phase 3."
  SYNTHESIS_RAN=false
  RECONCILED_COUNT=0
  # Skip to Phase 3.
else
  SYNTHESIS_RAN=true
fi
```

If `SYNTHESIS_RAN` is false, do NOT execute Steps 2.5B–2.5D — proceed directly to Phase 3. Step 4A's `{GIST_CONTEXT}` generation will use the repository-scoped investigator-comment behavior (no synthesis brief exists).

### Step 2.5B: Cluster investigations by target subsystem

For each investigation that completed in Wave 0, read its `FORGE:INVESTIGATOR` comment (and the newly spawned implementation issue bodies from Step 2D) and extract its **Recommendation** and **Affected Files / target subsystem** — NOT to compare files for merge conflicts, but to group investigations that operate on the **same conceptual surface** (e.g. "auth session lifecycle", "credit metering", "orchestrate DAG construction").

```bash
# For each investigation, pull its recommendation + affected-files block (annotations only — no code reads)
declare -A INV_RECOMMENDATION
declare -A INV_SUBSYSTEM
declare -A INV_RELEVANCE
if ! declare -p INVESTIGATION_CONTEXT >/dev/null 2>&1; then
  declare -A INVESTIGATION_CONTEXT
fi

# Normalize the directories named in an annotation's affected-files section. The same
# helper is used for investigations and implementation issues so subsystem matching is
# deterministic and does not depend on the batch's size or ordering.
forge_annotation_subsystems() {
  AFFECTED_FILES_SECTION=$(printf '%s\n' "$1" \
    | awk '
      (/^##[[:space:]]+Affected Files([[:space:]]|$)/ || /^###[[:space:]]+Affected Files([[:space:]]|$)/) { in_section=1; next }
      in_section && (/^#[[:space:]]/ || /^##[[:space:]]/ || /^###[[:space:]]/) { in_section=0 }
      in_section { print }
    ')
  printf '%s\n' "$AFFECTED_FILES_SECTION" \
    | grep -oP '`[^`]+/[^`]+`' 2>/dev/null \
    | tr -d '`' \
    | while IFS= read -r path; do dirname "$path"; done \
    | sort -u
}

for INV_NUM in {investigation_numbers}; do
  EXPECTED_ISSUE_URL="https://api.github.com/repos/{GH_REPO}/issues/${INV_NUM}"
  INVESTIGATOR_JSON=$(gh api --paginate --slurp \
    "repos/{GH_REPO}/issues/${INV_NUM}/comments?per_page=100" 2>/dev/null \
    | jq -c --arg expected_issue_url "$EXPECTED_ISSUE_URL" \
      'add | map(select(.issue_url == $expected_issue_url and (.body | contains("<!-- FORGE:INVESTIGATOR -->")) and (.body | contains("<!-- INVESTIGATION:COMPLETE -->")))) | sort_by(.id) | last // empty' \
    || true)
  INV_BODY=$(printf '%s' "$INVESTIGATOR_JSON" | jq -r '.body // empty' 2>/dev/null || true)
  if [ -n "$INVESTIGATOR_JSON" ] && [ -z "${INVESTIGATION_CONTEXT[$INV_NUM]:-}" ]; then
    COMMENT_ID=$(printf '%s' "$INVESTIGATOR_JSON" | jq -r '.id // empty')
    COMMENT_URL=$(printf '%s' "$INVESTIGATOR_JSON" | jq -r '.html_url // empty')
    INVESTIGATION_CONTEXT[$INV_NUM]="Investigation #${INV_NUM} — exact completed FORGE:INVESTIGATOR comment #${COMMENT_ID}: ${COMMENT_URL}"
  fi
  # Extract the Recommendation section (annotation prose only)
  INV_RECOMMENDATION[$INV_NUM]=$(printf '%s' "$INV_BODY" | awk '/^### Recommendation/{p=1;next}/^### /{p=0}p')
  # Derive the same coarse subsystem boundary later used for implementation issues.
  INV_SUBSYSTEM[$INV_NUM]=$(forge_annotation_subsystems "$INV_BODY")
  # Direct parent/sibling edges are added during Step 2.5D, once implementation
  # issue bodies are available; initialize the reverse relation here.
  INV_RELEVANCE[$INV_NUM]=""
done
```

**Cluster rule**: Two investigations are in the same cluster when they share a target subsystem (overlapping affected-file directories OR the same domain tag from Step 3B applied to their recommendations). Clustering is by **conceptual surface**, deliberately coarser than Step 3C's file-level analysis — the goal is to surface plan-level contradictions the file layer cannot see.

**Forward reference — related future signal** <!-- Added: forge#1196 -->: This clustering step (Step 2.5B) runs before Phase 3, so no Layer 5 data exists yet at this point — do not treat it as an input here. For readers extending this clustering rule in the future: Step 3C Layer 5 (historical co-change coupling, computed later in Phase 3) is a related signal worth reusing — two investigations whose affected files have historically co-changed would be good candidates for the same subsystem cluster. This is purely a forward reference, not a functional dependency or phase-reordering.

### Step 2.5C: Detect and resolve competing recommendations

Within each cluster (2+ investigations on the same subsystem), compare the **Recommendation** sections for incompatibility — e.g. one recommends adding a cache layer while another recommends removing caching from the same path; one proposes a new abstraction another proposes to delete. This is a semantic comparison of *proposed approaches*, read purely from the annotation prose.

For each detected conflict, resolve it in exactly ONE of two ways:

1. **Arbitration decision** — When the two recommendations are directly incompatible and one is clearly correct given the combined evidence, record a single deconflicted decision for BOTH issues. State which approach wins and why. This decision is written into each affected issue's `FORGE:SYNTHESIS_BRIEF` (Step 2.5D) — it does NOT close either issue; both still run, but against a reconciled plan.
2. **Serialization edge** — When the approaches are interdependent (the second issue's correct approach depends on what the first decides) or arbitration cannot pick a winner from annotations alone, add a `Depends on #{FIRST}` marker to the SECOND issue's body so the two serialize. The second agent then inherits the first's merged result during its own investigation/context phase.

```bash
# Serialization is expressed as a standard "Depends on #X" edge so Step 3A consumes it
# with no new plumbing (see Step 3A dependency-marker parsing).
RECONCILED_COUNT=0
N_ARBITRATED=0
N_SERIALIZED=0
for CONFLICT in "${DETECTED_CONFLICTS[@]}"; do
  # CONFLICT = "FIRST SECOND RESOLUTION" where RESOLUTION is "arbitrate" or "serialize"
  set -- $CONFLICT; FIRST=$1; SECOND=$2; RESOLUTION=$3
  if [ "$RESOLUTION" = "serialize" ]; then
    # Reverse-direction cycle guard: before adding "#SECOND depends on #FIRST", check
    # whether #FIRST already declares "Depends on #SECOND". If it does, the requested
    # edge would close a 2-node cycle (#FIRST -> #SECOND -> #FIRST) that Step 3D.5's
    # cycle detector would later have to exclude from dispatch entirely (both issues
    # stuck behind needs-human). Skip the edge and fall back to arbitration-in-place
    # instead, so both issues still run.
    FIRST_BODY=$(gh issue view $FIRST -R {GH_REPO} --json body --jq '.body')
    if echo "$FIRST_BODY" | grep -qiE "depends on #${SECOND}\b"; then
      echo "Phase 2.5: skipping serialization edge #${FIRST} -> #${SECOND}: reverse edge #${SECOND} -> #${FIRST} already exists (would create a cycle). Falling back to arbitration-in-place."
      RESOLUTION="arbitrate"
    else
      SECOND_BODY=$(gh issue view $SECOND -R {GH_REPO} --json body --jq '.body')
      if ! echo "$SECOND_BODY" | grep -qiE "depends on #${FIRST}\b"; then
        gh issue edit $SECOND -R {GH_REPO} \
          --body "${SECOND_BODY}

Depends on #${FIRST}
<!-- Serialized by orchestrate Phase 2.5: competing recommendation reconciled via dependency edge. -->"
      fi
    fi
  fi
  # Re-check RESOLUTION (may have been downgraded from "serialize" to "arbitrate" above)
  # so the breakdown counters and the Step 2.5D per-issue decision recording both reflect
  # the resolution that was actually applied, not the one originally proposed.
  if [ "$RESOLUTION" = "serialize" ]; then
    N_SERIALIZED=$((N_SERIALIZED + 1))
  else
    N_ARBITRATED=$((N_ARBITRATED + 1))
  fi
  RECONCILED_COUNT=$((RECONCILED_COUNT + 1))
done
echo "Phase 2.5 reconciled ${RECONCILED_COUNT} competing recommendation(s) (${N_ARBITRATED} arbitrated, ${N_SERIALIZED} serialized)."
```

**MUST NOT**: close, skip, or merge any issue on the basis of a detected conflict. Two issues with competing recommendations are BOTH valid work items — Phase 2.5 makes their plans coherent, it does not eliminate either. (This is the Safety Rule 9 boundary — see the Purpose note above.)

### Step 2.5D: Emit one deconflicted brief per issue

For each implementation issue about to be dispatched, write a single `FORGE:SYNTHESIS_BRIEF` annotation containing ONLY the reconciled context relevant to *that* issue — the arbitration decisions affecting it and exact repository comment references to the investigator reports it actually needs. This keeps every handoff repository-scoped and prevents agents from independently re-arbitrating the same contradictions.

```bash
# Build the implementation issue -> investigation relation before appending any
# references. A reference is relevant when the issue shares the normalized subsystem
# with the investigation, or when the issue body explicitly names that investigation
# as its parent/spawned-from issue. There is deliberately no batch-wide fallback.
declare -A ISSUE_BODY_CACHE
declare -A ISSUE_SUBSYSTEM
for ISSUE_NUM in {implementation_issue_numbers}; do
  ISSUE_BODY_CACHE[$ISSUE_NUM]=$(gh issue view "$ISSUE_NUM" -R {GH_REPO} --json title,body --jq '.title + "\n" + .body' 2>/dev/null || true)
  ISSUE_SUBSYSTEM[$ISSUE_NUM]=$(forge_annotation_subsystems "${ISSUE_BODY_CACHE[$ISSUE_NUM]:-}")
done

for ISSUE_NUM in {implementation_issue_numbers}; do
  # Assemble the per-issue brief: arbitration decisions touching this issue's subsystem +
  # exact repository-scoped investigator references. Never copy a raw investigator body;
  # its reserved markers must remain in the authoritative source comment.
  REPOSITORY_INVESTIGATION_REFS=""
  for INV_NUM in "${INVESTIGATION_NUMS[@]}"; do
    RELEVANT_INVESTIGATION=false
    SHARED_SUBSYSTEM=$(comm -12 \
      <(printf '%s\\n' "${INV_SUBSYSTEM[$INV_NUM]:-}" | sed '/^$/d' | sort -u) \
      <(printf '%s\\n' "${ISSUE_SUBSYSTEM[$ISSUE_NUM]:-}" | sed '/^$/d' | sort -u) \
      || true)
    if [ -n "$SHARED_SUBSYSTEM" ]; then
      RELEVANT_INVESTIGATION=true
    fi

    # Parent/spawned-from and FORGE:PARENT_CONTEXT references are explicit relevance
    # edges even when affected-file subsystem tags are absent or coarse.
    if printf '%s\\n' "${ISSUE_BODY_CACHE[$ISSUE_NUM]:-}" \
      | grep -qiE "(parent|spawned[ -]from|sibling)[^#[:cntrl:]]*#${INV_NUM}([^0-9]|$)"; then
      RELEVANT_INVESTIGATION=true
    elif printf '%s\\n' "${ISSUE_BODY_CACHE[$ISSUE_NUM]:-}" \
      | grep -qiE "FORGE:PARENT_CONTEXT:[^[:cntrl:]]*issue=${INV_NUM}([^0-9]|$)"; then
      RELEVANT_INVESTIGATION=true
    fi

    if [ "$RELEVANT_INVESTIGATION" = true ]; then
      INV_RELEVANCE[$INV_NUM]="${INV_RELEVANCE[$INV_NUM]:-} ${ISSUE_NUM}"
      # Only validated completed comment references may be forwarded. If a relevant
      # investigation is unavailable, the final no-reference sentinel below remains
      # explicit instead of silently broadening to every investigation in the batch.
      if [ -n "${INVESTIGATION_CONTEXT[$INV_NUM]:-}" ] && \
        printf '%s' "${INVESTIGATION_CONTEXT[$INV_NUM]}" | grep -qF 'exact completed FORGE:INVESTIGATOR comment'; then
        REPOSITORY_INVESTIGATION_REFS="${REPOSITORY_INVESTIGATION_REFS}
- ${INVESTIGATION_CONTEXT[$INV_NUM]}"
      fi
    fi
  done
  BRIEF_BODY="Reconciled context for this issue (see orchestrate Phase 2.5):

### Repository Investigator References
${REPOSITORY_INVESTIGATION_REFS:-No completed investigator comment references were available; treat that as an explicit unavailable-context result.}

### Reconciled Decisions
${PER_ISSUE_DECISIONS[$ISSUE_NUM]}"
  gh issue comment $ISSUE_NUM -R {GH_REPO} --body "<!-- FORGE:SYNTHESIS_BRIEF -->
## Synthesis Brief

${BRIEF_BODY}

<!-- FORGE:SYNTHESIS_BRIEF:COMPLETE -->"
done
```

The `FORGE:SYNTHESIS_BRIEF` annotation is consumed by Step 4A's `{GIST_CONTEXT}` generation (which prefers the reconciled repository brief when present) and its reconciled count (`RECONCILED_COUNT`) feeds the Step 6B `Competing recommendations reconciled (Phase 2.5)` metric.

**Report**: Post a brief Phase 2.5 summary to the user before proceeding to Phase 3:

```
## Phase 2.5: Investigation Synthesis

**Investigations reconciled**: {INVESTIGATION_COUNT}
**Competing recommendations detected**: {RECONCILED_COUNT}
  - Arbitrated in place: {N_ARBITRATED} (includes any serialization edges downgraded by the reverse-cycle guard)
  - Serialized via dependency edge: {N_SERIALIZED}
**Per-issue synthesis briefs emitted**: {N_briefs}

Proceeding to dependency analysis with a deconflicted plan set...
```

---

