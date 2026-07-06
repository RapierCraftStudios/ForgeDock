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
| `workflow:merged` | PR merged, issue closed | Close phase agent |
| `workflow:invalid` | Issue closed as invalid | Investigator agent |
| `workflow:decomposed` | Issue decomposed into sub-issues | Decomposer agent |
| `needs-human` | Pipeline blocked, human intervention required | Any agent on error |

## Transitions

```
(open)
  → workflow:investigating      [Phase 1: Investigate]
  → workflow:ready-to-build     [Phase 2: Investigation complete]
  → workflow:building           [Phase 3: Build started]
  → workflow:in-review          [Phase 4: PR created]
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
- `needs-human`

## Label Exclusivity

At most one `workflow:*` label should be active on an issue at any time. When transitioning, always remove all other `workflow:*` labels:

```bash
gh issue edit {NUMBER} -R {REPO} \
  --add-label "workflow:building" \
  --remove-label "workflow:investigating,workflow:ready-to-build,workflow:in-review,workflow:merged,workflow:invalid,workflow:decomposed"
```

This is enforced by `scripts/transition-label.sh` — use `resolve_script 'transition-label'` rather than calling `gh issue edit` directly when possible.
