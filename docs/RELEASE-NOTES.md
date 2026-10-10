# Release Notes

Operator-facing notes for behavior changes that need action or awareness. Newest first.

## Review provenance gates and noise share (#3452)

`/review-pr` §6B.4 now checks each finding before it can become a `review-finding` issue: the cited line must exist at the reviewed head SHA (else dropped as stale), must be added or changed by the PR diff (else routed as `pre-existing`), and must carry a concrete `**Failure scenario**` (else demoted to a note; CRITICAL/HIGH CONFIRMED are exempt). Pre-existing defects are never counted as this PR's findings or in the amplification ratio; CRITICAL/HIGH or safety-domain ones are filed once with the new `pre-existing` label. The `FORGE:NOTE_DISPOSITION` record gains `findings_dropped_stale`, `findings_preexisting`, `notes_demoted_no_scenario`, and `/pipeline-health` reports a noise share (2E.5).

Action: run `npx forgedock labels setup` to create the `pre-existing` label (the review also creates it on demand).

## Diff-size gate in `/work-on` build (#3450)

`/work-on` build now measures the changed lines (added plus deleted) after implement stages its changes and before validate commits them. The gate is **on by default at 1000 lines**. Review findings per PR rise steeply with diff size, so an oversized build is split instead of validated.

- **Over the threshold**: the build posts a `FORGE:DIFF_SIZE` comment with a split proposal and exits `NEEDS_DECOMPOSE`; the router then runs `work-on:decompose`.
- **Tune or disable**: set `build.diff_size.threshold` in `forge.yaml` (`0` disables the gate) and add exclusions with `build.diff_size.exclude_globs`. Lockfiles, `*.min.*`, `*.snap` and vendored/generated directories are excluded by default.
- **Per-issue bypass**: post a `FORGE:SIZE_OVERRIDE` comment with a non-empty justification on the line after the marker. Only comments from trusted authors count.
- **No re-decomposition**: an issue that is already a decomposed child, or has `FORGE:DECOMPOSED`, blocks until an override is posted instead of being split again.

Action: if your builds routinely exceed 1000 changed lines, raise `build.diff_size.threshold` or set it to `0`. See the `build` section of [CONFIG.md](CONFIG.md).

## Stricter `review-pr` / `review-pr-staging` argument rejection (#3466)

`/review-pr` and `/review-pr-staging` now reject an argument string as a whole if it contains a quote, backtick, `$`, backslash, newline or tab. Nothing is parsed from a rejected string, so no PR number, repo, merge value or flag survives, and `--auto-merge` is not honoured. `/review-pr-staging` stops with nothing reviewed and nothing posted.

Action: callers must pass `--gh-flag -R owner/repo` unquoted, and must not forward untrusted text (issue titles, comment bodies) into the argument string.

## Spec bash no longer corrupted by Claude Code argument substitution

Claude Code replaces `$0`..`$9` in a skill body with the invocation's arguments (0-based), so spec bash loaded via `Skill(...)` with args was silently rewritten: `awk '{print $2}'` became `awk '{print --issue}'`, `local AGENT="$1"` became `local AGENT="--auto-merge"`, which broke `/review-pr` agent selection and the CI/deploy comparisons with no error. `${N}`, `$(N)`, `$NF`, `$@`, `$#` and `$10`+ are not substituted.

- Skill-loaded specs now use `${1}` in shell and `$(1)` in awk (`printf "%s", $(0)` instead of `printf $0`). Behavior is otherwise unchanged. The shared FORGE_ROOT bootstrap block was updated byte-identically everywhere, including `orchestrate/**`.
- New `scripts/check-spec-bash.sh --positional` fails CI on `$0`..`$9` inside fenced blocks of Skill-loaded specs (suppress a deliberate hit with `allowlist:positional-arg` on the line). Read-loaded `orchestrate/**`, `pipeline-health/**` and the `review-pr-agents` catalog are exempt.

Action: none.

## In-PR fix round for CONFIRMED MEDIUM findings (#3387, narrowed)

Under `--auto-merge` with `--issue` (the `/work-on` pipeline), a review finding that is **MEDIUM + CONFIRMED** in a file the PR itself changed is no longer merged and filed as a follow-up issue. `/review-pr` §6B.6 posts a `FORGE:INPR_FIX` work order on the PR, and Phase 8 holds the merge for that head (`blocker: in-pr fix required`). `/work-on` review then runs **one** remediation round (bound: `FORGE:INPR_REMEDIATION` on the issue) that fixes exactly those findings and re-reviews.

- **Narrow by design.** LIKELY/POSSIBLE, findings outside the PR's changed files, and standalone reviews are unchanged. HIGH/CRITICAL already block through §7B.
- **One round only.** Anything still present on the re-review is filed as an issue, as before.
- **Never a `needs-human` stop because of this gate.** If the round does not land, `/work-on` posts `FORGE:INPR_FIX_WAIVED` for the current head and re-reviews once, so the findings are filed and the PR merges as it did before.
- **A missing finding path never gates.** If a finding has no file path, or the PR diff cannot be read, it is filed as before.

Action: none. Expect a few PRs to take one extra fix round before merging, and fewer MEDIUM `review-finding` issues.

## Cascade follow-ups: script resolution, domain-agent notes, verification in worktrees, spec bash check

- **Script resolution works in consumer repos.** `/review-pr` §6B.5 and the orchestrator breaker now find `classify-finding.sh` and `amplification-breaker.sh` through the newest pinned ForgeDock plugin cache under `CLAUDE_CONFIG_DIR`, then `~/.claude`. They also check `FORGEDOCK_HOME` and the repo's own `scripts/`, as before. Previously the plugin-root placeholder was often left unsubstituted in forked review runs, so 4 of 9 AlterLab reviews fell back to `classifier=manual`.
- **Domain reviewers no longer file speculative LOW findings.** A finding from the Auth, Billing, Concurrency or Database reviewer is still filed as an issue only when it is MEDIUM+ or CONFIRMED. A LOW/POSSIBLE finding becomes a note whichever reviewer raised it. Security/billing keyword content still files as before.
- **Validate reads your real `forge.yaml` in worktrees.** `forge.yaml` is usually gitignored, so it never existed in the per-issue worktree, and every `verification.commands` entry, `learned.test_commands` entry and the SOPS chain check were silently skipped. Validate now falls back to the main checkout's `forge.yaml`.
- **The quality gate parses spec bash.** New step 2G.10 runs `scripts/check-spec-bash.sh`, which applies `bash -n` (plus advisory `shellcheck -S error`) to every changed fenced bash block in `commands/**/*.md`. Pre-existing blocks are never checked. Mark an intentional fragment with `<!-- allowlist:check-spec-bash -->` on the line before its fence.

Action: expect verification commands that you configured in `forge.yaml` to start running in `/work-on` builds. If a configured command (for example a SOPS chain with `deploy.secrets_backend: sops`) was failing unnoticed, builds will now report it.

## Review-finding cascade is now bounded by code, not prose

An audit of one `/orchestrate` batch found 93 `review-finding` issues filed for 46 merges, a ratio of 2.02. The §6B.5 note-disposition step was supposed to stop LOW/POSSIBLE findings from becoming issues. It was bypassed in two ways: every finding from the always-on General Security & Quality reviewer was exempt by origin, and reviewers often skipped the step entirely.

- `scripts/classify-finding.sh` now decides ISSUE versus NOTE deterministically. The safety exemption is content-based (security/billing keywords) or applies to dedicated Auth/Billing/Concurrency/Database agents. Origin from the always-on reviewer no longer exempts a finding. On PRs that fix a review finding, LOW and POSSIBLE findings are always notes. HIGH and CRITICAL findings always file, as before. Replayed on the audited batch, 41 of the 93 would be filed, which is a ratio of 0.89, and no HIGH finding is demoted.
- `/review-pr` posts a `FORGE:NOTE_DISPOSITION` record. Auto-merge, in `/review-pr` Phase 8 and `/work-on` review, refuses to merge a PR that has findings but no disposition record. `/work-on` re-runs the review once instead of escalating to `needs-human`.
- `scripts/amplification-breaker.sh` measures findings per merged unit since `BATCH_T0` from GitHub state. `/orchestrate` must run it before dispatching any P3 review finding, on every dispatch path including the Agent-spawn fallback. Exit 3 (tripped) or 4 (unreadable) defers P3 findings to bounded batches.

Action: none required. LOW review notes now appear in the PR's `Non-blocking notes` section and the disposition comment instead of as issues. A PR reviewed by an older plugin version gets one re-review before auto-merge.

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
