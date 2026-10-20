---
issue: 4164
status: fresh
anchor: scripts/issue-create.sh
created: 2026-10-20
---

# ADR — /issue's deterministic procedure moves into scripts/issue-create.sh; every command spec gets a size budget

## Context

`commands/issue.md` was 50,992 bytes (~13k tokens), mostly inline bash plus fix-history commentary, and every create loaded all of it, including programmatic callers (audit, decompose, review-finding filing, test-gate) that skip drafting. The model ran each step (tokenize, integrity check, dedup, section repair, REST create, token read-back, milestone, board) as a separate tool turn. `scripts/check-spec-size.sh` budgeted only five review specs, so the other 78 specs could grow without limit.

## Decision

- `scripts/issue-create.sh` runs the whole create path: quote-aware `xargs` tokenizing of `--args` (no `eval`), the `--body-file` exactly-one-marker check, `issue-dedup.sh` from its own directory, section repair, `gh api` POST, create-token read-back, whole-line integrity-marker read-back, milestone, post-create section check and project board. It prints exactly one `ISSUE_CREATE_RESULT:` line. Exit codes: 0 CREATED/DRY_RUN, 1 DEDUP, 2 USAGE, 3 ERROR.
- `commands/issue.md` (now under 12 KB) keeps routing, the caller integrity contract and the interactive drafting guidance. Programmatic mode is one stub-resolved script call; interactive mode drafts, then creates through the same script.
- `check-spec-size.sh` budgets every `commands/**/*.md`: growth up to 2% and 4 KB, new specs up to 4 KB, and per-file hard ceilings (`commands/issue.md:15360`).

Cost delta: a programmatic create loads ~12 KB instead of ~51 KB (about −10k tokens) and makes one tool call instead of one model-driven tool turn per step.

## Rejected options

- **Keeping exit 1 for parse usage errors and create failures** (the old spec shared 1 with the dedup STOP and told them apart only by text). Usage errors are now 2, matching `issue-dedup.sh`, and GitHub failures are 3, so an exit code alone never confuses a failed create with a dedup STOP. Callers parse the result line, which is unchanged.
- **Keeping the LLM semantic dedup fallback for programmatic creates.** It cost a model turn per create, and programmatic callers have already scoped their finding; it stays in interactive mode only.
- **A `--force` flag on the script.** A human override in interactive mode re-runs with `--exclude <matched number>`, so no unconditional bypass exists in the deterministic path.
- **Raising the default threshold for small specs.** Small specs keep the same 2%/4 KB rule; the `spec-size-exempt` label remains the escape hatch.
