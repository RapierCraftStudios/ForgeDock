# Release Notes

Operator-facing notes for behavior changes that need action or awareness. Newest first.

## Override candidate filter hardening (forge#3307)

The break-glass override prefilter now uses `FORGE_TRAIL_OVERRIDE_ASSOCIATIONS` instead of a hardcoded `OWNER,MEMBER,COLLABORATOR` list. It defaults to the resolved `FORGE_TRAIL_TRUSTED_ASSOCIATIONS` value, so default behavior is unchanged, and it never affects which FORGE markers count toward the merge gate. An empty list yields no override candidates. The verifier prints `NOTE: N override candidate(s) ignored: author_association not in override-approver set` to stderr when candidates are filtered this way, so an approver with concealed org membership (shown as `CONTRIBUTOR`/`NONE`) is diagnosable.

Action: if your override approvers have concealed membership, add `CONTRIBUTOR` to `FORGE_TRAIL_OVERRIDE_ASSOCIATIONS`. Do not add it to the trail list: that lets any contributor forge FORGE markers.

## Phase-trail break-glass override (forge#3152)

A human can now clear a misfiring phase-trail gate with a `FORGE:PHASE_TRAIL_OVERRIDE` comment instead of a revert or manual merge. The override is bound to the head commit and the exact MISSING set, must be newer than the latest `FORGE:BUILDER:COMPLETE`, must be unedited, and must come from a human with repo write/admin permission who is not a pipeline identity. The verifier takes a new `--head-sha` flag, and the accepted override is recorded on the PR by code. Exit 2 (unreadable trail) is never overridable.

Action: optionally set `FORGE_TRAIL_PIPELINE_LOGINS` to the pipeline's own login(s). A solo operator running the pipeline under their own token cannot self-approve; a second human with write access must post the override. Format and rules are in [CONFIG.md](CONFIG.md).

## Staging to main bundle (PR #3120)

### Amplification breaker is on by default

`orchestration.cascade.amplification_breaker` now defaults to `on`. Existing configs that do not set the key get the breaker automatically: once the findings-spawned / merged-units ratio stays at or above 1.0 for `convergence_window` units (it can trip at exactly 1.0 over 3 units), P3-and-below cascade admission pauses and paused P3s route to bounded P3 batches. P1/P2 are unaffected.

Action: to keep the previous behavior, set `orchestration.cascade.amplification_breaker: off` (or `false`). See the upgrade note in [CONFIG.md](CONFIG.md).

### Phase-trail merge gate and new markers

Merging now requires a complete phase trail, verified by `scripts/verify-phase-trail.sh`. The trail includes the `FORGE:QUALITY_GATE` marker. Only markers from trusted commenters count: `author_association` in `OWNER,MEMBER,COLLABORATOR`, a `Bot` account, or a login listed in `FORGE_TRAIL_TRUSTED_LOGINS`. Markers from anyone else are ignored and reported `MISSING`. The verifier exits 0 on pass, 1 when artifacts are missing and 2 when the trail cannot be read (fail closed). If the install root cannot be resolved, the gate refuses to merge.

Issues whose `FORGE:BUILDER:COMPLETE` comment was last updated before `FORGE_TRAIL_QG_SINCE` (default `2026-10-07T03:40:12Z`) have `QUALITY_GATE` waived. Set it to an empty string to disable the grace.

Actions:
- Pipelines that run under a non-Bot login without OWNER/MEMBER/COLLABORATOR association must set `FORGE_TRAIL_TRUSTED_LOGINS` (preferred; widening `FORGE_TRAIL_TRUSTED_ASSOCIATIONS` also lets those associations forge markers).
- Make sure `FORGEDOCK_HOME` or `FORGE_HOME` resolves to the ForgeDock install (required on Codex).
- Set `FORGE_SKILL_NAMESPACE` if skill-prefix auto-detection picks the wrong runtime.

All variables, defaults and trust caveats are documented in the Environment Variables section of [CONFIG.md](CONFIG.md); Codex specifics are in [CODEX.md](CODEX.md).

### Review step 6B.5: non-blocking note disposition

`/review-pr` no longer files a standalone `review-finding` issue for every low-signal finding. Findings with `Severity: LOW`, or `Confidence: POSSIBLE` below HIGH severity, become notes. This includes CONFIRMED LOW findings. Notes are fixed in the PR (comment, documentation or test-only changes), listed under `## Non-blocking notes` in the PR body, or dropped, and each disposition is recorded in the review summary (`notes_fixed`, `notes_listed`, `notes_dropped`, `findings_filed`). Findings from the Security, Auth, Billing, Concurrency or Database agents, or matching the safety keyword set, are never demoted. On PRs that fix a `review-finding` + `priority:P3` issue, the rule is stricter.

Impact: `review-finding` issue volume, and metrics derived from it (findings per PR, `/pipeline-health` finding rates, amplification ratio), drop relative to earlier history. Compare against the `notes_*` counts in the review summary when judging review depth.
