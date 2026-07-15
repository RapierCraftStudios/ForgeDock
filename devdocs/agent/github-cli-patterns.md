---
authority: reference
scope: agent
applies_to: [work-on, review-pr, orchestrate, quality-gate]
domain: github
last_validated: "2026-06-15"
version: "1.0.15"
---

# GitHub CLI Patterns — Pipeline Cheat Sheet

Authoritative reference for `gh` command classes used by ForgeDock pipeline agents. Verified against CLI output.

---

## Critical Rules

| Rule | Detail |
|------|--------|
| `gh api --jq` takes **exactly 1 arg** | `--jq --arg x y` is broken — pipe to standalone `jq` |
| State in JSON output is **UPPERCASE** | `"OPEN"` / `"CLOSED"` / `"MERGED"` |
| State in filter flags is **lowercase** | `--state open` / `--state closed` |
| `gh project` uses `--format json` | NOT `--json` (different from `gh issue`/`gh pr`) |
| `gh issue view --json comments` caps at 100 | Use `gh api ... --paginate` for >100 comments |

---

## Common Wrong Patterns

```bash
# WRONG — gh api does not support --jq --arg (error: "accepts 1 arg(s), received 4")
gh api repos/OWNER/REPO/milestones --jq --arg slug "v2" '.[] | select(.title == $slug) | .number'
# CORRECT — pipe to standalone jq
gh api repos/OWNER/REPO/milestones | jq --arg slug "v2" '.[] | select(.title == $slug) | .number'

# WRONG — state is "OPEN" not "open" in JSON
gh issue view 123 --json state --jq 'select(.state == "open")'
# CORRECT
gh issue view 123 --json state --jq 'select(.state == "OPEN")'

# WRONG — gh project does not support --json
gh project item-list 1 --owner org --json number
# CORRECT
gh project item-list 1 --owner org --format json

# WRONG — gh gist edit does not accept stdin '-' (opens interactive editor)
echo "$CONTENT" | gh gist edit "$GIST_ID" -f "file.md" -
# CORRECT — use temp file
TMPFILE=$(mktemp) && echo "$CONTENT" > "$TMPFILE" && gh gist edit "$GIST_ID" -f "file.md" "$TMPFILE" && rm "$TMPFILE"
```

---

## gh issue

```bash
gh issue view {N} -R {REPO} --json number,title,body,labels,state,comments,milestone
gh issue list -R {REPO} --state open --label "workflow:building" --json number,title
gh issue edit {N} -R {REPO} --add-label "workflow:building" --remove-label "workflow:investigating"
gh issue comment {N} -R {REPO} --body "..."
# >100 comments — use paginated API:
gh api repos/{OWNER}/{REPO}/issues/{N}/comments --paginate --jq '.[] | {id:.id,body:.body}'
```

`--json` field notes: `state` → `"OPEN"|"CLOSED"` (uppercase); `labels` → `[{name,color}]`; `comments` → max 100 entries; `milestone` → `{number,title}`.

**`gh issue create` is NOT in the list above.** See "Issue Creation — Use `/issue`" below — creating an issue is not a raw `gh issue` operation in this pipeline.

---

## Issue Creation — Use `/issue`

**Rule**: All issue creation MUST go through the `/issue` create-hook (`commands/issue.md`) — either the interactive free-text form (`/issue "description"`) or the programmatic form for callers that have already composed their own title/body:

```
Skill(skill="issue", args="--title \"fix: ...\" --body-file /path/to/body.md --label bug --label P2 [--milestone \"...\"] [--dry-run]")
```

`/issue` is the enforced path, not just a convention — it runs mandatory-section validation and dedup (`scripts/issue-dedup.sh`) on every invocation, interactive or programmatic. A raw `gh issue create` call bypasses both checks. See `devdocs/agent/using-forgedock.md` for a worked example of the programmatic form.

**Exception**: `gh issue create` (and `gh issue comment`) remain the correct tool for non-issue GitHub artifacts that are not going through the pipeline's issue lifecycle — e.g. writing to the orchestrate claims board (issue #2039, see #2072) is a `gh issue comment` call on an existing tracking issue, not issue creation, and is unaffected by this rule.

---

## gh pr

```bash
gh pr view {N} -R {REPO} --json number,title,state,headRefName,baseRefName,mergeable,mergeStateStatus,url,files,changedFiles
gh pr list -R {REPO} --state open --base main --json number,title,headRefName
gh pr diff {N} -R {REPO} --name-only   # text only — no --json support
gh pr create -R {REPO} --title "..." --body "..." --base {BRANCH} --head {BRANCH}
gh pr merge {N} -R {REPO} --squash --delete-branch
```

`--json` field notes: `state` → `"OPEN"|"CLOSED"|"MERGED"` (uppercase); `changedFiles` → integer count; `files` → `[{path,additions,deletions}]` array; `headRefOid` → commit SHA (not `sha`/`commitSha`); `mergeable` → `"MERGEABLE"|"CONFLICTING"|"UNKNOWN"`; `mergeStateStatus` → `"UNKNOWN"` on stale PRs is expected.

---

## gh api

```bash
# Basic
gh api repos/{OWNER}/{REPO}/issues/{N}
# jq filter — ONE expression, no --arg
gh api repos/{OWNER}/{REPO}/milestones --jq '.[0].number'
# jq with variable — pipe to standalone jq
gh api repos/{OWNER}/{REPO}/milestones | jq --arg title "My Milestone" '.[] | select(.title==$title) | .number'
# Paginate
gh api repos/{OWNER}/{REPO}/issues --paginate --jq '.[].number'
# Mutate
gh api repos/{OWNER}/{REPO}/issues/{N} -X PATCH -f state=closed
gh api repos/{OWNER}/{REPO}/issues/comments/{ID} -X DELETE
```

---

## gh project

```bash
gh project item-list {NUM} --owner {OWNER} --format json           # --format json, NOT --json
gh project item-add {NUM} --owner {OWNER} --url {ISSUE_URL}
gh project item-edit --project-id {PID} --id {ITEM_ID} --field-id {FID} --single-select-option-id {OPT}
```

---

## gh label / gh gist / gh run / gh workflow

```bash
# label — --force prevents error if already exists
gh label create "workflow:building" --color "0075ca" --force -R {REPO}
# Warning: /issue (and the raw gh issue create it wraps) fails if a label doesn't
# exist — always create labels first. See "Issue Creation — Use /issue" above;
# do not use raw `gh issue create` for issue creation even to work around this.

# gist — create supports stdin '-'; edit does NOT
echo "$CONTENT" | gh gist create -f "file.md" -                    # create: stdin ok
TMPFILE=$(mktemp) && echo "$CONTENT" > "$TMPFILE"
gh gist edit "$GIST_ID" -f "file.md" "$TMPFILE" && rm "$TMPFILE"   # edit: temp file required
gh api gists/{GIST_ID} --jq '.files | to_entries[0].value.content' # view raw

# run/workflow — status/conclusion values are lowercase
gh run list -R {REPO} --workflow {FILE} --limit 5 --json status,conclusion,databaseId
gh run view {RUN_ID} -R {REPO} --json status,conclusion,jobs
gh workflow run {FILE} -R {REPO} --field key=value
# status: "completed"|"in_progress"|"queued"  conclusion: "success"|"failure"|"cancelled"
```

---

## Confirmed Safe Patterns

- `gh issue edit --remove-label "nonexistent"` — silent success (safe to call defensively)
- `gh pr diff --name-only` — valid; no `--json` support on `gh pr diff`
- `gh project item-list` accepts both `-q` and `--jq`
- `gh pr view --json headRefOid` — correct field name (not `sha` or `commitSha`)
- `gh pr view --json mergeable,mergeStateStatus` returning `"UNKNOWN"` on stale PRs is expected
