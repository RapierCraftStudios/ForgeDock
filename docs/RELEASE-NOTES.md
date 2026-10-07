# Release Notes

Operator-facing notes for behavior changes that need action or awareness. Newest first.

## Staging to main bundle (PR #3120)

### Amplification breaker is on by default

`orchestration.cascade.amplification_breaker` now defaults to `on`. Existing configs that do not set the key get the breaker automatically: once the findings-spawned / merged-units ratio stays at or above 1.0 for `convergence_window` units (it can trip at exactly 1.0 over 3 units), P3-and-below cascade admission pauses and paused P3s route to bounded P3 batches. P1/P2 are unaffected.

Action: to keep the previous behavior, set `orchestration.cascade.amplification_breaker: off` (or `false`). See the upgrade note in [CONFIG.md](CONFIG.md).

### Phase-trail merge gate and new markers

Merging now requires a complete phase trail, verified by `scripts/verify-phase-trail.sh`. The trail includes the `FORGE:QUALITY_GATE` marker. Only markers from trusted commenters count: `author_association` in `OWNER,MEMBER,COLLABORATOR`, a `Bot` account, or a login listed in `FORGE_TRAIL_TRUSTED_LOGINS`. Markers from anyone else are ignored and reported `MISSING`. The verifier exits 0 on pass, 1 when artifacts are missing and 2 when the trail cannot be read (fail closed). If the install root cannot be resolved, the gate refuses to merge.

Issues whose `FORGE:BUILDER:COMPLETE` comment was last updated before `FORGE_TRAIL_QG_SINCE` (default `2026-10-07T03:40:12Z`) have `QUALITY_GATE` waived. Set it to an empty string to disable the grace.

Actions:
- Pipelines that run under a non-Bot login without OWNER/MEMBER/COLLABORATOR association must set `FORGE_TRAIL_TRUSTED_LOGINS` (or widen `FORGE_TRAIL_TRUSTED_ASSOCIATIONS`).
- Make sure `FORGEDOCK_HOME` or `FORGE_HOME` resolves to the ForgeDock install (required on Codex).
- Set `FORGE_SKILL_NAMESPACE` if skill-prefix auto-detection picks the wrong runtime.

All variables, defaults and trust caveats are documented in the Environment Variables section of [CONFIG.md](CONFIG.md); Codex specifics are in [CODEX.md](CODEX.md).

### Review step 6B.5: non-blocking note disposition

`/review-pr` no longer files a standalone `review-finding` issue for every low-signal finding. Findings with `Severity: LOW`, or `Confidence: POSSIBLE` below HIGH severity, become notes. This includes CONFIRMED LOW findings. Notes are fixed in the PR (comment, documentation or test-only changes), listed under `## Non-blocking notes` in the PR body, or dropped, and each disposition is recorded in the review summary (`notes_fixed`, `notes_listed`, `notes_dropped`, `findings_filed`). Findings from the Security, Auth, Billing, Concurrency or Database agents, or matching the safety keyword set, are never demoted. On PRs that fix a `review-finding` + `priority:P3` issue, the rule is stricter.

Impact: `review-finding` issue volume, and metrics derived from it (findings per PR, `/pipeline-health` finding rates, amplification ratio), drop relative to earlier history. Compare against the `notes_*` counts in the review summary when judging review depth.
