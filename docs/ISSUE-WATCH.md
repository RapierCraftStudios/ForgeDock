# Issue watch

`forgedock issue-watch` keeps feeding matching open issues into lanes until a cap is reached. Each **watch** is named, scoped and capped; several run on one repo.

```
forgedock issue-watch run [--name <w>] [--repo owner/repo] [--once] [--interval <s>] [--dry-run]
forgedock issue-watch status [--name <w>] [--repo owner/repo]
forgedock issue-watch install [--name <w>] [--repo owner/repo] [--interval <s>]
forgedock issue-watch watchdog
```

`--name` defaults to the only watch in forge.yaml, else `default` (every trusted issue, no caps). `--once` does one pass. `--interval` is the seconds between passes (default 300).

## Config

```yaml
issue_watch:
  watches:
    nomilestone:
      milestone: none
      exclude_labels: [epic, post-deploy]
      include_followups: defer-only
      mode: batch
      parallel: 12
    release-1-4:
      version: "1.4"
      max_issues: 300
      until: 2026-11-15T00:00:00Z
```

Keys are listed in [CONFIG.md](CONFIG.md#issue_watch-optional). An unknown key, a bad mode, regex, number or date fails the watch at load.

## State and claims

Each watch has `~/.forge/watch/<owner>__<repo>/<name>/` (or `$FORGEDOCK_WATCH_DIR`) with a `lock` and `status.json`. The lock is per (repo, name): a second `run` of the same watch is refused while the first is alive, and a dead holder is taken over. Different names run side by side. `~/.forge/watch/<owner>__<repo>/claims.json` is shared by every watch of the repo, so an issue has at most one claim across all of them. The claim is taken under a directory lock before anything is launched.

## Selectors

All optional, AND-ed. Only issues from an owner, member or collaborator are claimed (bot-filed issues only through `include_followups` or `trust_app`).

| Key | Meaning |
|---|---|
| `milestone` | a milestone title or slug, or `none` for issues without one |
| `labels` / `exclude_labels` | every listed label present / none present |
| `search` | a `gh search` query, passed to `gh issue list --search` |
| `title_regex` | JavaScript regex tested against the title |
| `since` | ISO time; only issues created at or after it |
| `version` | `x.y`, from the milestone title (first `x.y` in it) or else a `version:x.y` label |

The lane follows the repo rule: a milestone issue goes to `milestone/<slug>` (forge.yaml `branches.feature_pattern`), anything else to `branches.staging`. `lane:` pins one lane for the watch but is refused when it is a default branch.

## Caps and forever mode

- `max_issues: N`: total claims over the watch's lifetime. At N the watch **drains**: no new claims, retry and verify only. When nothing is inflight and no merge is mid-verification it exits with a summary.
- `until: <ISO time>`: the same, at that time.
- `max_inflight` (default 4; in `mode: batch` the watch's `parallel`): claims in flight at once.
- With neither `max_issues` nor `until` the watch runs forever: it keeps claiming, retrying (a deferred lane, exit 75, is relaunched up to 3 times) and verifying merges (see [Merge verification](#merge-verification)).

## Modes

- `mode: per-issue` (default): one `forgedock run-issue` per claim.
- `mode: batch`: claims are `--add`ed to one long-lived `orchestrate` batch, so its K (`parallel:`), the `Depends on` DAG (claims are ordered dependencies first), the supervisor and the report apply. When the batch writes its report the watch starts a new one with the next claims. If another running (not reported, not cancelled) batch of the same repo and lane exists, claims are `--add`ed to it instead of starting a new one. A slow `orchestrate` start (no batch dir within 60 s) never stops the watch: the claims are kept in a `pendingStart` record, later passes adopt the batch when it appears, and after 10 minutes without one the claims are released. An error in any pass is logged, saved as `passError` in `status.json`, shown by `issue-watch status`, and the next pass runs (with `--once` the process still exits non-zero).

- `mode: release`: see [Release mode](#release-mode).

## Follow-ups

`include_followups: defer-only` claims bot-filed `follow-up:` issues that have an unchecked `— defer` item. Post-deploy-only follow-ups are not claimed: with `postdeploy_rollup: <issue>` each is appended once as a checklist line to that release issue. Other bot issues stay excluded.

## Issues filed by the ForgeDock App

When agents and `gh` run as the ForgeDock App, the issues they file are authored by `rapiercraft-forgedock[bot]` with association `NONE`, so a watch skips them. `trust_app: true` (default false) claims issues authored by this repo's own ForgeDock App. Other bots and outsiders (`NONE` humans) stay excluded. It is an explicit opt-in because the App also files issues from untrusted inputs (prod-watch, ingestion). `trust_app_labels: [operator]` (needs `trust_app`) narrows it further: the App issue must carry one of those labels. `follow-up:` issues from the App still follow `include_followups`.

## Parity with an owner-run intake script

A watch never claims a pull request: only issues are listed, a PR-shaped item is dropped, a `search` that selects PRs (`is:pr`, `type:pr`) fails the watch at load, and an issue an open PR closes is skipped (`skip #N: open closing PR #M`). `skip_labels` (default for `mode: batch`: `epic`, `needs-human`, `post-deploy`, `workflow:merged`, `awaiting-promotion`, `host-task`) skips by label. One watch per selector gives each its own created-since window:

```yaml
issue_watch:
  watches:
    nomilestone: { milestone: none, since: 2026-11-08T00:00:00Z, include_followups: defer-only, postdeploy_rollup: 100, mode: batch }
    release-1-5: { milestone: "1.5", since: 2026-11-01T00:00:00Z, include_followups: defer-only, postdeploy_rollup: 100, mode: batch }
```

`--dry-run` lists what each would claim. A batch that reported is never added to: the next claims start a new one.

## Intake pause from GitHub (#5555)

With `release.managed` on, the watch also reads the pause from GitHub on every pass, so every host honours it and nothing depends on a local state file: `_active.intake.paused` on the ledger control branch, an active ledger entry (the lease's release has no end `status`), or any open `release/*`, `train/*` or `hotfix/*` PR. `forgedock intake pause|resume|status [--reason <text>] [--tracker <issue>] [--release <id>]` writes `_active.intake` (with an audit line in `controls.jsonl`) and the `forge:intake-paused` label on the tracker (`--tracker` or `release.tracker`). With `freeze.intake_auto_resume: true` a pause that names `--release <id>` is cleared by the watch once that release's ledger has an end status. Unmanaged repos make no extra call. A failed GitHub read does not pause (it shows as `pauseError` in `status.json`).

## Release pause and liveness

With `release_pause` (default in `mode: batch`) the watch pauses while a `forgedock release` job is in flight (its `~/.forge/releases/<id>/state.json` has no end `status` and was written in the last 6 hours): no claims, retries or decisions. The next pass after the job ends resumes by itself. Every pass writes `heartbeat` to `status.json`, and `forgedock issue-watch status` prints it:

```
  state: paused (release r20261110-110000-9 in flight (preflight))  last heartbeat: 2026-11-10T12:00:00.000Z (30s ago)
```

`running`, `paused`, `stale` (no heartbeat for 3 intervals: the watch is not running) or `done`. `watchLiveness` (`bin/lean/issuewatch-parity.mjs`) is the read for tools such as doctor; it never greps processes.

## Dry run

In `per-issue` and `batch` mode, `forgedock issue-watch run --name <w> --dry-run` prints what one pass would claim and why, then the needs-human classification. It writes nothing: no claim, no status, no launch.

```
would claim #12 -> staging: ForgeDock App author (trust_app)
would fold #14
skip #13: excluded label epic
skip #15: untrusted author mallory (NONE)
skip #16: already claimed by watch other
skip #17: over capacity (room 4)
```

## gh errors

A failed `gh` call raises an error that names the call. An HTTP 401 or 403 also prints one line naming the call and its effect on the pass, for example `issue-watch: gh api repos/o/r/issues?state=open&per_page=100 --paginate -> HTTP 403: ...; effect: pass degraded: author associations unknown, every author untrusted (nothing claimed or settled this pass)`. Under an App token, `gh api user` (403) and `gh api app` (401) report `no effect`.

## Merge verification

A closed issue is not taken on trust. When a claimed issue closes (in `per-issue` and `batch` modes), the watch checks:

1. a PR from `feat/issue-<n>-lean` merged into the issue's lane;
2. the PR does not carry `review-degraded`;
3. the issue's latest trusted `FORGE:REVIEW` passed: enforced `CONFORMS`, shadow `would PASS`, or a `review.trigger` skip. A shadow `would BLOCK` fails: shadow mode merges it anyway, and the watch reports that;
4. every required check of the lane (branch protection and rulesets) is green on the merged head;
5. the merge commit is on the lane (`compare` reports `behind` or `identical`);
6. no check on the merge commit failed (report-only `forgedock/verify` is ignored). While those checks run, verification waits up to 60 minutes and then fails.

All pass: the issue counts as **verified**, and a `FORGE:WATCH_VERIFY` comment records the evidence. Any fails: the issue is **unverified**. It is reopened with `needs-human`, `workflow:merged` is replaced by `workflow:merged-unverified` (so the open issue does not look merged; best effort: the label is created if missing, and a failed swap never stops the reopen or `needs-human`), and a "merge NOT verified" comment that lists the evidence and the failed check. Nothing is reverted; a human decides between a revert, a follow-up fix and accepting the merge. An issue that closed with no merged lane PR (invalid, already fixed, decomposed) counts as **closed unmerged**, never as verified.

## Status

`status` prints the selector, claims against `max_issues`, inflight, merged, verified, unverified, closed unmerged, failed and the time remaining.

## Release mode

`mode: release` claims nothing immediately. It pools the issues that match the selectors and cut a **themed release** when a trigger fires, then orchestrates just that set.

Once the batch reports and the deploy PR is open, the watch starts `forgedock release` for it (resumable; promotion stays opt-in via `--merge` / `release.auto_merge`, the watch never merges).

```yaml
issue_watch:
  watches:
    staging-releases:
      milestone: none
      mode: release
      threshold: { min_issues: 15, min_score: 40, max_age_days: 5 }
      immediate: [label:security, priority:P0]
      max_release_issues: 40
      theme_map:
        security: [label:security, path:infra/ssh-guard/**]
        stealth: [path:services/worker/**/anti_detection/**, label:scraper]
```

- **Triggers** (any one fires): `min_issues`; a priority-weighted `min_score` (P0=8, P1=4, P2=2, P3=1, no priority label = 1; labels `P1` or `priority:P1`); `max_age_days` (the oldest pooled issue); `immediate` entries (`label:<name>` or `priority:P0..P3`), which cut a release now with only the theme of the highest-priority immediate issue.
- **Themes**: `theme_map` rules `label:`, `scope:` (the conventional-commit scope of the title) and `path:` (a glob matched against paths named in the title or body); the first theme in config order wins, and a title scope equal to a theme name also matches. Issues no rule classifies get one LLM call (`claude --print`), counted in `status` as `llm-classified`; without an answer they join theme `general`.
- **Decision**: each theme scores Σ priority weights + age (0.1 per day, at most 3 per issue) + a rank bonus from an ordered `Release priorities:` list in the repo's NORTHSTAR.md (inline `a, b` or bullets); ties go to that order, then the name. The top theme (or the forced immediate theme) ships with the closure of its `Depends on` issues: a prerequisite from another theme is pulled in and marked, and the set is capped at `max_release_issues` (default 40; an issue whose closure does not fit stays pooled).
- **Run**: the watch posts a `FORGE:RELEASE_PLAN` comment (theme, reasons, included, pulled and excluded issues, policy) on `tracker:` (default: the first issue of the set), tags the set (milestone `release/<theme>-<date>` for a milestone target, else label `release:<theme>-<date>`), and starts one `orchestrate` batch. When the batch reports it opens the deploy PR (lane to the default branch) once. **The watch never merges it**; promotion stays human-only.
- **Roll over**: issues left out stay pooled and keep their age. `max_issues` and `until` stop new releases.
- `forgedock issue-watch run --name <w> --dry-run` prints `would cut: <theme> (N issues, score S; ...)`, the triggers, the theme scores and each issue's theme, and writes nothing.

## Resilience, supervision and DEAD detection (#5465)

- **Retry.** A transient `gh` failure (TLS handshake timeout, connection reset, DNS, HTTP 5xx or 429, secondary rate limit) is retried 3 times with doubling backoff (2 s, 4 s, 8 s) inside the same call. A call that still fails fails its pass only: the pass is logged and recorded as `passError`, and the next pass runs. A 4xx is never retried.
- **Exit state.** Whenever `run` stops (crash, SIGTERM/SIGINT, `--once`) `status.json` gets `phase: exited`, `exitReason` and `exitedAt`; it is never left as `running`. A restart resumes it.
- **Supervision.** `forgedock issue-watch install --name <w>` writes a systemd user unit `forgedock-issue-watch-<w>.service` (`Restart=on-failure`, run from the current directory so `forge.yaml` is found) and a 60 s watchdog timer, or a launchd agent (`KeepAlive` on failure) on macOS. A finished (`done`) or stopped watch exits 0 and stays down.
- **Lane environment (#5529).** systemd starts a user unit with almost no environment (`PATH=/usr/local/bin:/usr/bin`), so the unit carries the lane environment resolved from the installing shell: `PATH` with the tokenbaton shim and the resolved `claude` directory first, `TMPDIR` (else `/tmp`), `TOKENBATON_HOME`/`TOKENBATON_SWITCH_AT` when set, and `UnsetEnvironment=CLAUDE_CONFIG_DIR`. The computeshare token is read when the unit starts (keychain `service forgedock account COMPUTESHARE_TOKEN`, else the router's `forgedock_token_file`); only the file path is in the unit, never the value. The launchd agent gets the same variables in `EnvironmentVariables` (no token). Reinstall after moving `claude`.
- **claude check (#5529).** Each pass the watcher records in `status.json` whether it can resolve `claude` on its own PATH (the PATH its lanes inherit). `issue-watch status`, `forgedock status` and `forgedock doctor` warn when it cannot.
- **Stranded re-drive (#5529).** A stranded claim (a final batch result that is not merged, needs-human or parked) is re-driven, not only counted: requeued into its batch (`orchestrate --requeue`), or its claim released when the batch is gone, at most twice per issue. An `engine-error` whose lane could not find its CLI (`Failed to find executable`, `spawn ... ENOENT`, `command not found`) is re-driven only once the watcher resolves `claude` again. `status` shows the `re-driven` count.
- **DEAD.** A heartbeat older than 3 × `heartbeatEveryMs` (+60 s grace) is shown as `state: DEAD` by `issue-watch status` and in a `issue-watch` section of `forgedock status`. `issue-watch watchdog` (the install timer) and `forgedock status` post a `watch.dead` event once per dead heartbeat to `events.webhook_url` (see EVENTS.md).
