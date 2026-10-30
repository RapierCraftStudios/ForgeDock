# Issue watch

`forgedock issue-watch` keeps feeding matching open issues into lanes until a cap is reached. Each **watch** is named, scoped and capped; several run on one repo.

```
forgedock issue-watch run [--name <w>] [--repo owner/repo] [--once] [--interval <s>]
forgedock issue-watch status [--name <w>] [--repo owner/repo]
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

All optional, AND-ed. Only issues from an owner, member or collaborator are claimed (bot-filed issues only through `include_followups`).

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

- `max_issues: N`: total claims over the watch's lifetime. At N the watch **drains**: no new claims, retry and verify only. When nothing is inflight it exits with a summary.
- `until: <ISO time>`: the same, at that time.
- `max_inflight` (default 4): claims in flight at once.
- With neither `max_issues` nor `until` the watch runs forever: it keeps claiming, retrying (a deferred lane, exit 75, is relaunched up to 3 times) and verifying (an issue counts as verified once it is closed).

## Modes

- `mode: per-issue` (default): one `forgedock run-issue` per claim.
- `mode: batch`: claims are `--add`ed to one long-lived `orchestrate` batch, so its K (`parallel:`), the `Depends on` DAG (claims are ordered dependencies first), the supervisor and the report apply. When the batch writes its report the watch starts a new one with the next claims.

## Follow-ups

`include_followups: defer-only` claims bot-filed `follow-up:` issues that have an unchecked `— defer` item. Post-deploy-only follow-ups are not claimed: with `postdeploy_rollup: <issue>` each is appended once as a checklist line to that release issue. Other bot issues stay excluded.

## Status

`status` prints the selector, claims against `max_issues`, inflight, merged, verified, failed and the time remaining.
