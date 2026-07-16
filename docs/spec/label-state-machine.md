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

`workflow:awaiting-merge` vs `needs-human`: both are terminal (the pipeline stops advancing the issue automatically), but they mean different things. `needs-human` means the pipeline hit a condition it cannot resolve on its own (genuinely blocked — conflicting PR, failed verdict, calibration/trust escalation, etc.) and a human must diagnose and act. `workflow:awaiting-merge` means the opposite: the PR was previously escalated to `needs-human`, has since been remediated and re-reviewed to a clean `APPROVED` verdict with no mergeability blockers, but does not yet meet the automated auto-land bar (see forge#1809 Q1) — a human only needs to click merge, not diagnose a problem. `scripts/transition-label.sh` only clears `needs-human` (best-effort) when the target state is `workflow:awaiting-merge` — every other forward transition leaves a pre-existing `needs-human` label untouched, preserving its sticky/terminal semantics.

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
```

## Terminal Labels

Processing stops when any of these labels is set:

- `workflow:merged`
- `workflow:invalid`
- `workflow:decomposed`
- `workflow:awaiting-merge`
- `needs-human`

## Label Exclusivity

At most one `workflow:*` label should be active on an issue at any time. When transitioning, always remove all other `workflow:*` labels:

```bash
gh issue edit {NUMBER} -R {REPO} \
  --add-label "workflow:building" \
  --remove-label "workflow:investigating,workflow:ready-to-build,workflow:in-review,workflow:awaiting-merge,workflow:merged,workflow:invalid,workflow:decomposed"
```

This is enforced by `scripts/transition-label.sh` — use `resolve_script 'transition-label'` rather than calling `gh issue edit` directly when possible.
