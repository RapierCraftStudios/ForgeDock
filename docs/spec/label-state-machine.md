# Workflow Label State Machine

**Canonical reference** — all pipeline commands and docs point here instead of restating this table inline.

See also: [FORGE Annotation Protocol §6](forge-protocol-v1.md#6-label-state-machine) for the protocol-level specification.

---

## States

| Label | Meaning | Set by |
|-------|---------|--------|
| `workflow:investigating` | Investigation phase active | Investigator agent |
| `workflow:ready-to-build` | Investigation complete, build not started | Investigator agent |
| `workflow:building` | Build phase active | Builder agent |
| `workflow:in-review` | PR created, review active | Orchestrator agent |
| `workflow:awaiting-merge` | Remediated + re-reviewed, awaiting a human merge decision | Review-pr Phase 8 (auto-merge guard) |
| `workflow:merged` | PR merged, issue closed | Close phase agent |
| `workflow:invalid` | Issue closed as invalid | Investigator agent |
| `workflow:decomposed` | Issue decomposed into sub-issues | Decomposer agent |
| `needs-human` | Pipeline blocked, human intervention required | Any agent on error |
| `workflow:engine-error` | Pipeline blocked by the engine/tool itself breaking (CLI crash, missing SDK/API key, exhausted retries with no attempt ever reaching a real outcome) — not a genuine content-level judgment call | `terminate()` in `bin/engine.mjs` |

`workflow:awaiting-merge` vs `needs-human`: both are terminal (the pipeline stops advancing the issue automatically), but they mean different things. `needs-human` means the pipeline hit a condition it cannot resolve on its own (genuinely blocked — conflicting PR, failed verdict, calibration/trust escalation, etc.) and a human must diagnose and act. `workflow:awaiting-merge` means the opposite: the PR was previously escalated to `needs-human`, has since been remediated and re-reviewed to a clean `APPROVED` verdict with no mergeability blockers, but does not yet meet the automated auto-land bar (see forge#1809 Q1) — a human only needs to click merge, not diagnose a problem. `scripts/transition-label.sh` only clears `needs-human` (best-effort) when the target state is `workflow:awaiting-merge` — every other forward transition leaves a pre-existing `needs-human` label untouched, preserving its sticky/terminal semantics.

`workflow:engine-error` vs `needs-human` (taxonomy split — commit `90376f5` / #2261): before this commit, `terminate()` wrote `needs-human` for *every* exhausted-retry blocked outcome, including cases where the engine/CLI tool itself was breaking (crash, missing API key, no SDK) rather than a genuine human-judgment call. As of `90376f5`, `runPhaseWithRetry()` tags an outcome `engine-error` when every exhausted attempt failed via a thrown runner exception (never reached `detectOutcome()`) — the engine/tool is broken, not the issue content — and `terminate()` writes `workflow:engine-error` instead of `needs-human` for that case. A genuine content-level block (unmerged PR, unresolved branch, a fixed-point zero-commits case) still writes `needs-human` unchanged. **Consequence for downstream consumers**: any dashboard, query, or health metric that counts `needs-human` issues computed a different, larger population before `90376f5` than after — a subset of what used to be `needs-human` now shows up as `workflow:engine-error` instead. This is a one-time taxonomy discontinuity, not a real change in pipeline reliability; consumers tracking `needs-human` counts over time should also track `workflow:engine-error` from this commit forward to get a like-for-like comparison. `bin/labels.json` already includes `workflow:engine-error` in this repo; syncing it to consumer/satellite repos is tracked separately (see forge#2346).

## Transitions

```
(open)
  → workflow:investigating      [Phase 1: Investigate]
  → workflow:ready-to-build     [Phase 2: Investigation complete]
  → workflow:building           [Phase 3: Build started]
  → workflow:in-review          [Phase 4: PR created]
  → workflow:awaiting-merge [TERMINAL] [Phase 5/review-pr: re-reviewed after needs-human, awaiting human merge]
  → workflow:merged  [TERMINAL] [Phase 5: PR merged]
  → workflow:invalid [TERMINAL] [Any phase: closed as invalid]
  → workflow:decomposed [TERMINAL] [Phase 2: split into sub-issues]
  → needs-human     [TERMINAL]  [Any phase: pipeline blocked]
  → workflow:engine-error [TERMINAL] [Any phase: the engine/tool itself broke — CLI crash, missing API key, no SDK — not a content-level judgment call]
```

**`workflow:invalid` after `ready-to-build`/`building`/`in-review`** (#2326): the enforcement hook (`bin/hooks/pre-tool-use.mjs`) allows `workflow:invalid` as a successor of these three states — not only of `workflow:investigating` — because invalidity is sometimes only discovered during architecture planning or build, once the actual code/tests are read (see #2312). This is gated, not unconditional: the hook requires a posted reversal comment already on the issue — a second `FORGE:INVESTIGATOR` annotation carrying `**Verdict**: INVALID` — before it allows the transition through. A bare relabel with no evidence trail is still blocked. `workflow:investigating → workflow:invalid` remains evidence-free (Phase 1D's normal path).

The reversal comment must also carry a trusted `authorAssociation` — `OWNER`, `MEMBER`, or `COLLABORATOR` (#2332). Marker+verdict text alone is forgeable by any commenter on a public issue with no repo write access; the hook additionally requires GitHub's own `authorAssociation` classification on that comment (returned by `gh issue view --json comments` at no extra cost) to be one of those three tiers. This check is deliberately identity-agnostic rather than a hardcoded bot-login allowlist, so it survives the pipeline's `gh` identity rotating between accounts (#1722) without needing to be updated.

## Terminal Labels

Processing stops when any of these labels is set:

- `workflow:merged`
- `workflow:invalid`
- `workflow:decomposed`
- `workflow:awaiting-merge`
- `needs-human`
- `workflow:engine-error`

## Label Exclusivity

At most one `workflow:*` label should be active on an issue at any time. When transitioning, always remove all other `workflow:*` labels:

```bash
gh issue edit {NUMBER} -R {REPO} \
  --add-label "workflow:building" \
  --remove-label "workflow:investigating,workflow:ready-to-build,workflow:in-review,workflow:awaiting-merge,workflow:merged,workflow:invalid,workflow:decomposed"
```

This is enforced by `scripts/transition-label.sh` — use `resolve_script 'transition-label'` rather than calling `gh issue edit` directly when possible.
