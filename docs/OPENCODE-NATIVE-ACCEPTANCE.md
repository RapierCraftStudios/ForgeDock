# OpenCode Native Pre-Staging Acceptance

Use this runbook before authorizing a merge of the OpenCode native control plane
to `staging`. The procedure keeps the implementation branch, OpenCode config,
GitHub test issues, and PR base isolated from production branches.

## Pass Criteria

Authorize the merge only when all of these are true:

- the exact tested commit is checked out with an empty index and worktree,
  including no untracked files;
- the full repository test suite passes;
- the implementation diff contains no change under `commands/`, `install.sh`,
  or `install-codex.sh`;
- installation succeeds from an npm-packed and extracted payload on Node 18,
  including the persisted `packages/protocol/package.json` module boundary;
- the persisted native controller imports successfully before adapter files are
  generated;
- the isolated adapter installs with manifest v2 and no managed
  `work-on/**`/`orchestrate/**` skills;
- an ordinary non-native OpenCode command still receives the persisted
  `FORGE_HOME` and `FORGE_RUNTIME=opencode` environment;
- native dry runs report zero mutations;
- a disposable work-on issue reaches a merged PR and closed issue on a sandbox
  base branch;
- cancellation resumes from the last committed phase without duplicate
  annotations, branches, commits, or PRs;
- a dependency batch never starts a successor before its predecessor completes;
- no phase session has a parent session or background completion injection; and
- the compact native phase-card budget remains below 35,000 bytes total.

## 1. Verify The Branch

Run from this implementation worktree:

```bash
set -euo pipefail
IMPLEMENTATION_ROOT="$(git rev-parse --show-toplevel)"
cd "$IMPLEMENTATION_ROOT"
git fetch origin staging
TESTED_SHA="$(git rev-parse HEAD)"

git status --short --branch
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git diff --check origin/staging...HEAD
git diff --exit-code origin/staging...HEAD -- commands/ install.sh install-codex.sh .agents/skills/
test -z "$(git ls-files --others --exclude-standard -- commands install.sh install-codex.sh .agents/skills)"
git diff --name-status origin/staging...HEAD
git diff origin/staging...HEAD
```

The porcelain-status and both boundary commands must print nothing and exit
zero. The final two commands enumerate and display every committed
implementation and test change, rather than relying on a hand-maintained path
list that can omit a new file. Do not continue from a dirty tree or test a
commit other than `$TESTED_SHA`.

## 2. Run Automated Gates

The full `npm test` command uses the default `node` on `PATH` and must run on
Node 24, matching CI. Its quoted recursive globs are not a Node 18 compatibility
gate and can fail before test discovery on a Node-18-only machine. Switch the
default runtime to Node 24 first; use the separately configured `$NODE18` only
for the explicit-file compatibility gates below.

```bash
set -euo pipefail
node -e "if (Number(process.versions.node.split('.')[0]) !== 24) { console.error('Default Node 24 required for npm test, got ' + process.version); process.exit(1) }"
NODE18="${NODE18:-node}"
"$NODE18" -e "if (Number(process.versions.node.split('.')[0]) !== 18) { console.error('Node 18 required, got ' + process.version); process.exit(1) }"
: "${GH_TOKEN:?Set GH_TOKEN for the private sandbox repository}"
: "${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY explicitly for live OpenCode checks}"
ACCEPTANCE_GH_TOKEN="$GH_TOKEN"
ACCEPTANCE_ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
export -n ACCEPTANCE_GH_TOKEN ACCEPTANCE_ANTHROPIC_API_KEY
unset GH_TOKEN GITHUB_TOKEN ANTHROPIC_API_KEY

TEST_ROOT="$(mktemp -d)"
TEST_HOME="$TEST_ROOT/home"
TEST_OC_CONFIG="$TEST_ROOT/opencode-config"
TEST_NPM_CACHE="$TEST_ROOT/npm-cache"
TEST_NPM_CONFIG="$TEST_ROOT/npmrc"
TEST_NPM_GLOBAL_CONFIG="$TEST_ROOT/global-npmrc"
TEST_XDG_CACHE="$TEST_ROOT/xdg-cache"
TEST_XDG_CONFIG="$TEST_ROOT/xdg-config"
TEST_XDG_DATA="$TEST_ROOT/xdg-data"
TEST_XDG_STATE="$TEST_ROOT/xdg-state"
TEST_GH_CONFIG="$TEST_ROOT/gh-config"
PACK_DIR="$TEST_ROOT/pack"
PACK_EXTRACT="$TEST_ROOT/extracted"
mkdir -p "$TEST_HOME" "$TEST_OC_CONFIG" "$TEST_NPM_CACHE" "$TEST_XDG_CACHE" \
  "$TEST_XDG_CONFIG" "$TEST_XDG_DATA" "$TEST_XDG_STATE" "$TEST_GH_CONFIG" \
  "$PACK_DIR" "$PACK_EXTRACT"
: > "$TEST_NPM_CONFIG"
: > "$TEST_NPM_GLOBAL_CONFIG"

env -u GH_TOKEN -u GITHUB_TOKEN -u ANTHROPIC_API_KEY HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  XDG_CACHE_HOME="$TEST_XDG_CACHE" XDG_CONFIG_HOME="$TEST_XDG_CONFIG" XDG_DATA_HOME="$TEST_XDG_DATA" XDG_STATE_HOME="$TEST_XDG_STATE" APPDATA="$TEST_XDG_CONFIG" \
  npm_config_cache="$TEST_NPM_CACHE" \
  npm_config_userconfig="$TEST_NPM_CONFIG" npm_config_globalconfig="$TEST_NPM_GLOBAL_CONFIG" \
  FORGE_RUNTIME= npm test
env -u GH_TOKEN -u GITHUB_TOKEN -u ANTHROPIC_API_KEY HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  XDG_CACHE_HOME="$TEST_XDG_CACHE" XDG_CONFIG_HOME="$TEST_XDG_CONFIG" XDG_DATA_HOME="$TEST_XDG_DATA" XDG_STATE_HOME="$TEST_XDG_STATE" APPDATA="$TEST_XDG_CONFIG" \
  npm_config_cache="$TEST_NPM_CACHE" \
  npm_config_userconfig="$TEST_NPM_CONFIG" npm_config_globalconfig="$TEST_NPM_GLOBAL_CONFIG" \
  "$NODE18" --test bin/tests/journey.test.mjs bin/tests/router.test.mjs \
  bin/tests/opencode-native.test.mjs
env -u GH_TOKEN -u GITHUB_TOKEN -u ANTHROPIC_API_KEY HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  XDG_CACHE_HOME="$TEST_XDG_CACHE" XDG_CONFIG_HOME="$TEST_XDG_CONFIG" XDG_DATA_HOME="$TEST_XDG_DATA" XDG_STATE_HOME="$TEST_XDG_STATE" APPDATA="$TEST_XDG_CONFIG" \
  npm_config_cache="$TEST_NPM_CACHE" \
  npm_config_userconfig="$TEST_NPM_CONFIG" npm_config_globalconfig="$TEST_NPM_GLOBAL_CONFIG" \
  "$NODE18" --test bin/tests/opencode-adapter.test.mjs \
  bin/tests/engine.test.mjs bin/tests/engine-crash.test.mjs
env -u GH_TOKEN -u GITHUB_TOKEN -u ANTHROPIC_API_KEY npm_config_cache="$TEST_NPM_CACHE" npm_config_userconfig="$TEST_NPM_CONFIG" \
  npm_config_globalconfig="$TEST_NPM_GLOBAL_CONFIG" \
  npm pack --dry-run --json --ignore-scripts
```

Expected native coverage includes fresh root sessions, recursive-tool denial,
usage normalization, provider-error reconciliation, cancellation, dependency
unlocking, failed-predecessor blocking, resume, and truncated batch-log repair.

Check the prompt budget directly:

```bash
set -euo pipefail
env -u GH_TOKEN -u GITHUB_TOKEN -u ANTHROPIC_API_KEY \
  "$NODE18" -e "import('./bin/opencode/runner.mjs').then(({phasePromptBytes}) => { const p=phasePromptBytes(); const total=Object.values(p).reduce((a,b)=>a+b,0); console.log(p, total); if(total>=35000) process.exit(1) })"
```

No individual phase should exceed 5,000 bytes and the total must be below
35,000 bytes. This compares with roughly 938 KB in the prior installed workflow
payload; only one phase card is loaded per attempt.

## 3. Install The Packed Payload Into An Isolated OpenCode Config

Do not install directly from the implementation worktree and do not overwrite
your normal adapter. Pack the npm payload, extract it, and run the installer
from that extraction with Node 18:

```bash
set -euo pipefail
PACK_NAME="$(env -u GH_TOKEN -u GITHUB_TOKEN -u ANTHROPIC_API_KEY npm_config_cache="$TEST_NPM_CACHE" \
  npm_config_userconfig="$TEST_NPM_CONFIG" npm_config_globalconfig="$TEST_NPM_GLOBAL_CONFIG" \
  npm pack --silent --ignore-scripts \
  --pack-destination "$PACK_DIR")"
tar -xzf "$PACK_DIR/$PACK_NAME" -C "$PACK_EXTRACT"
PACKED_FORGE_HOME="$PACK_EXTRACT/package"
test -f "$PACKED_FORGE_HOME/packages/protocol/package.json"

env -u GH_TOKEN -u GITHUB_TOKEN -u ANTHROPIC_API_KEY HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" OPENCODE_CONFIG_DIR="$TEST_OC_CONFIG" \
  XDG_CACHE_HOME="$TEST_XDG_CACHE" XDG_CONFIG_HOME="$TEST_XDG_CONFIG" \
  XDG_DATA_HOME="$TEST_XDG_DATA" XDG_STATE_HOME="$TEST_XDG_STATE" \
  npm_config_cache="$TEST_NPM_CACHE" OPENCODE_DISABLE_AUTOUPDATE=1 \
  "$NODE18" "$PACKED_FORGE_HOME/bin/forgedock.mjs" opencode install \
  --extras --forge-home "$PACKED_FORGE_HOME"
env -u GH_TOKEN -u GITHUB_TOKEN -u ANTHROPIC_API_KEY HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" OPENCODE_CONFIG_DIR="$TEST_OC_CONFIG" \
  XDG_CACHE_HOME="$TEST_XDG_CACHE" XDG_CONFIG_HOME="$TEST_XDG_CONFIG" \
  XDG_DATA_HOME="$TEST_XDG_DATA" XDG_STATE_HOME="$TEST_XDG_STATE" OPENCODE_DISABLE_AUTOUPDATE=1 \
  "$NODE18" "$PACKED_FORGE_HOME/bin/forgedock.mjs" opencode status
```

Verify the protocol package survived persistence and import both native plugin
entry modules from the persisted home on Node 18:

```bash
set -euo pipefail
PERSISTED_FORGE_HOME="$TEST_HOME/.forge"
test -f "$PERSISTED_FORGE_HOME/packages/protocol/package.json"
env -u GH_TOKEN -u GITHUB_TOKEN -u ANTHROPIC_API_KEY \
  "$NODE18" -e '(async () => {
  const { join } = require("node:path");
  const { pathToFileURL } = require("node:url");
  const root = process.argv[1];
  const control = await import(pathToFileURL(join(root, "bin", "opencode", "control.mjs")).href);
  const orchestrator = await import(pathToFileURL(join(root, "bin", "opencode", "orchestrator.mjs")).href);
  if (typeof control.runNativeWorkOn !== "function" || typeof orchestrator.runNativeOrchestrate !== "function") process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); })' "$PERSISTED_FORGE_HOME"
```

Inspect the manifest:

```bash
set -euo pipefail
"$NODE18" -e 'const fs=require("node:fs"); const path=require("node:path"); const m=JSON.parse(fs.readFileSync(process.argv[1])); const expected=path.resolve(process.argv[2]); console.log(m); if(m.version!==2||m.forgeHome!==expected||m.files.some(f=>/^skills\/(work-on|orchestrate)(\/|-)/.test(f))) process.exit(1)' "$TEST_OC_CONFIG/forgedock/manifest.json" "$PERSISTED_FORGE_HOME"
```

This executable assertion requires the manifest's `forgeHome` to equal the
resolved `$PERSISTED_FORGE_HOME` exactly, never the packed extraction path.

Persistence uses per-file atomic replacement plus `$PERSISTED_FORGE_HOME/persist.lock`,
but it is not a whole-tree transaction. A process kill does not roll back files
already replaced and can leave the lock or its short-lived `.reclaim` guard
behind. After confirming no ForgeDock installer/update process is active,
remove only those lock artifacts and rerun this exact packed installer. Path
validation also cannot eliminate a hostile process swapping path components
between filesystem calls; this unavoidable TOCTOU residual is not treated as
process-kill rollback.

Inspect the generated entry commands:

```bash
set -euo pipefail
wc -c "$TEST_OC_CONFIG/commands/forge/work-on.md" "$TEST_OC_CONFIG/commands/forge/orchestrate.md"
```

Each should be under 1,500 bytes and reference `forge_work_on` or
`forge_orchestrate`, not a shared command spec.

## 4. Prepare A Disposable GitHub Target

Set an explicit private sandbox repository or fork with ForgeDock labels, a
committed `.forgedock-acceptance-sandbox` marker, and `paths.root: "."` in its
`forge.yaml`. The ForgeDock implementation repository is forbidden as a live
target. Use `gh` only for the authenticated clone, then enter and verify the
sandbox before any other `gh`, push, or live OpenCode workflow command:

```bash
set -euo pipefail
: "${SANDBOX_REPO:?Set SANDBOX_REPO to owner/private-sandbox}"
: "${SANDBOX_CONFIRM_REPO:?Re-enter the same disposable sandbox repository}"
test "$SANDBOX_CONFIRM_REPO" = "$SANDBOX_REPO"
test "$(printf '%s' "$SANDBOX_REPO" | tr '[:upper:]' '[:lower:]')" != "rapiercraftstudios/forgedock"
SANDBOX_DIR="$TEST_ROOT/sandbox"
env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  GH_TOKEN="$ACCEPTANCE_GH_TOKEN" \
  gh repo clone "$SANDBOX_REPO" "$SANDBOX_DIR"
cd "$SANDBOX_DIR"
test "$PWD" != "$IMPLEMENTATION_ROOT"
test -f forge.yaml
test -f .forgedock-acceptance-sandbox
CONFIG_OWNER="$(yq -r '.project.owner // ""' forge.yaml)"
CONFIG_REPO="$(yq -r '.project.repo // ""' forge.yaml)"
CONFIG_ROOT="$(yq -r '.paths.root // ""' forge.yaml)"
test "$CONFIG_OWNER/$CONFIG_REPO" = "$SANDBOX_REPO"
test "$CONFIG_ROOT" = "."
test "$(cd "$CONFIG_ROOT" && pwd -P)" = "$(cd "$SANDBOX_DIR" && pwd -P)"
test "$(env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  GH_TOKEN="$ACCEPTANCE_GH_TOKEN" \
  gh repo view --json visibility --jq .visibility)" = "PRIVATE"
SANDBOX_LABELS_PATH="$TEST_ROOT/sandbox-labels.json"
env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  GH_TOKEN="$ACCEPTANCE_GH_TOKEN" \
  gh label list --repo "$SANDBOX_REPO" --limit 1000 --json name > "$SANDBOX_LABELS_PATH"
"$NODE18" -e 'const fs=require("node:fs");const expected=JSON.parse(fs.readFileSync(process.argv[1],"utf-8")).map(({name})=>name);const actual=new Set(JSON.parse(fs.readFileSync(process.argv[2],"utf-8")).map(({name})=>name));const missing=expected.filter((name)=>!actual.has(name));if(missing.length){console.error("Missing sandbox labels: "+missing.join(", "));process.exit(1)}' \
  "$PACKED_FORGE_HOME/bin/labels.json" "$SANDBOX_LABELS_PATH"
env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  GH_TOKEN="$ACCEPTANCE_GH_TOKEN" gh auth setup-git
: "${TEST_GIT_NAME:?Set the sandbox commit author name}"
: "${TEST_GIT_EMAIL:?Set the sandbox commit author email}"
env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" \
  git config --global user.name "$TEST_GIT_NAME"
env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" \
  git config --global user.email "$TEST_GIT_EMAIL"

env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  GH_TOKEN="$ACCEPTANCE_GH_TOKEN" git fetch origin
git branch test/opencode-native-base origin/staging
env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  GH_TOKEN="$ACCEPTANCE_GH_TOKEN" \
  git push -u origin test/opencode-native-base
```

Do not use `main` or `staging` as the test PR base. Create one small issue whose
acceptance criterion can be verified by a focused test:

```bash
set -euo pipefail
: "${ISSUE_TITLE:?Set a disposable issue title}"
: "${ISSUE_BODY_FILE:?Set a file containing one focused acceptance criterion}"
ISSUE_URL="$(env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" \
  GH_CONFIG_DIR="$TEST_GH_CONFIG" GH_TOKEN="$ACCEPTANCE_GH_TOKEN" \
  gh issue create --title "$ISSUE_TITLE" --body-file "$ISSUE_BODY_FILE")"
ISSUE="${ISSUE_URL##*/}"
```

Now verify an ordinary command that does not invoke either native controller
still gets the plugin environment. This isolated command does not change shared
Claude commands or Codex skills:

```bash
set -euo pipefail
cat > "$TEST_OC_CONFIG/commands/env-probe.md" <<'EOF'
---
description: Print the ForgeDock shell environment
---
Run exactly one shell command:
node -e 'console.log(`FORGE_HOME=${process.env.FORGE_HOME}`); console.log(`FORGE_RUNTIME=${process.env.FORGE_RUNTIME}`)'
Return its output verbatim. Do not call forge_work_on or forge_orchestrate.
EOF

ENV_PROBE="$(env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" \
  OPENCODE_CONFIG_DIR="$TEST_OC_CONFIG" XDG_CACHE_HOME="$TEST_XDG_CACHE" \
  XDG_CONFIG_HOME="$TEST_XDG_CONFIG" XDG_DATA_HOME="$TEST_XDG_DATA" \
  XDG_STATE_HOME="$TEST_XDG_STATE" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  OPENCODE_CONFIG= OPENCODE_CONFIG_CONTENT= \
  ANTHROPIC_API_KEY="$ACCEPTANCE_ANTHROPIC_API_KEY" OPENCODE_DISABLE_AUTOUPDATE=1 \
  opencode run --command env-probe)"
printf '%s\n' "$ENV_PROBE"
printf '%s\n' "$ENV_PROBE" | grep -F "FORGE_HOME=$PERSISTED_FORGE_HOME"
printf '%s\n' "$ENV_PROBE" | grep -F "FORGE_RUNTIME=opencode"
rm "$TEST_OC_CONFIG/commands/env-probe.md"

acceptance_opencode() {
  ACCEPTANCE_OPENCODE_STATUS=0
  env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" OPENCODE_CONFIG_DIR="$TEST_OC_CONFIG" \
    XDG_CACHE_HOME="$TEST_XDG_CACHE" XDG_CONFIG_HOME="$TEST_XDG_CONFIG" \
    XDG_DATA_HOME="$TEST_XDG_DATA" XDG_STATE_HOME="$TEST_XDG_STATE" \
    GH_CONFIG_DIR="$TEST_GH_CONFIG" OPENCODE_CONFIG= OPENCODE_CONFIG_CONTENT= \
    GH_TOKEN="$ACCEPTANCE_GH_TOKEN" ANTHROPIC_API_KEY="$ACCEPTANCE_ANTHROPIC_API_KEY" \
    OPENCODE_DISABLE_AUTOUPDATE=1 opencode || ACCEPTANCE_OPENCODE_STATUS=$?
}
```

Keep using this controlling shell. Each native step below prints the command,
then starts the isolated OpenCode TUI; paste the printed command, wait for the
stated result, and exit the TUI to return to the runbook.

## 5. Verify Work-On Dry Run

Render the exact command from the shell variable, then paste its output inside
OpenCode:

```bash
set -euo pipefail
printf '/forge/work-on %s --lane test/opencode-native-base --dry-run\n' "$ISSUE"
acceptance_opencode
test "$ACCEPTANCE_OPENCODE_STATUS" -eq 0
```

Expected:

- status is `dry-run`;
- repository, lane, deterministic branch, and `.opencode/worktrees` path are
  shown;
- total phase prompt bytes are below 35,000;
- no issue comment, label, branch, worktree, commit, or PR is created.

Confirm no mutation:

```bash
set -euo pipefail
env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  GH_TOKEN="$ACCEPTANCE_GH_TOKEN" gh issue view "$ISSUE" --comments
git worktree list
```

## 6. Verify A Live Work-On Run

Render and paste the live command:

```bash
set -euo pipefail
printf '/forge/work-on %s --lane test/opencode-native-base --keep-worktree\n' "$ISSUE"
acceptance_opencode
test "$ACCEPTANCE_OPENCODE_STATUS" -eq 0
```

Observe these durable transitions:

1. `FORGE:INVESTIGATOR` with the correct terminal sentinel.
2. `FORGE:CONTEXT:COMPLETE` or a visible partial/skip.
3. `FORGE:ARCHITECT:COMPLETE`.
4. A real branch/worktree, non-empty commit, and
   `FORGE:BUILDER:COMPLETE`.
5. A PR targeting only `test/opencode-native-base`.
6. Independent review evidence and required checks.
7. A merged PR, `FORGE:TRAJECTORY`, `workflow:merged`, and a closed issue.

Verify independently:

```bash
set -euo pipefail
env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  GH_TOKEN="$ACCEPTANCE_GH_TOKEN" gh issue view "$ISSUE" --json state,labels,comments
env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" GH_CONFIG_DIR="$TEST_GH_CONFIG" \
  GH_TOKEN="$ACCEPTANCE_GH_TOKEN" gh pr list --state all --search "$ISSUE" \
  --json number,state,baseRefName,headRefName,mergedAt
git log --oneline origin/test/opencode-native-base -10
```

Because `--keep-worktree` was used, inspect the retained diff/history manually,
then remove it with normal `git worktree remove` after acceptance.

## 7. Verify Cancellation And Resume

Create another disposable issue and capture it separately from the already
terminal `$ISSUE`, then render and paste its work-on command:

```bash
set -euo pipefail
: "${CANCEL_ISSUE_TITLE:?Set a cancellation-test issue title}"
: "${CANCEL_ISSUE_BODY_FILE:?Set its focused acceptance body file}"
CANCEL_ISSUE_URL="$(env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" \
  GH_CONFIG_DIR="$TEST_GH_CONFIG" GH_TOKEN="$ACCEPTANCE_GH_TOKEN" \
  gh issue create --title "$CANCEL_ISSUE_TITLE" --body-file "$CANCEL_ISSUE_BODY_FILE")"
CANCEL_ISSUE="${CANCEL_ISSUE_URL##*/}"
printf '/forge/work-on %s --lane test/opencode-native-base\n' "$CANCEL_ISSUE"
acceptance_opencode
test "$ACCEPTANCE_OPENCODE_STATUS" -eq 0
```

Cancel the ForgeDock tool while a phase session is active using OpenCode's
normal cancellation control. Do not kill the machine for this test.

Expected cancellation behavior:

- the active phase session receives `session.abort`;
- the issue run log ends with `RUN_INTERRUPTED`, not `RUN_TERMINAL`;
- the compact `FORGE:STATE` has `terminal:false` and `lease:null`;
- no success marker is fabricated.

Render and paste the same command again:

```bash
set -euo pipefail
printf '/forge/work-on %s --lane test/opencode-native-base\n' "$CANCEL_ISSUE"
acceptance_opencode
test "$ACCEPTANCE_OPENCODE_STATUS" -eq 0
```

It must resume from the last GitHub-committed phase and must not duplicate
completed comments, branches, commits, or PRs.

For hard-crash behavior, create a third disposable issue, start it, and
terminate OpenCode after a marker is posted. The helper captures the expected
nonzero exit instead of letting strict mode destroy the controlling shell:

```bash
set -euo pipefail
: "${CRASH_ISSUE_TITLE:?Set a hard-crash-test issue title}"
: "${CRASH_ISSUE_BODY_FILE:?Set its focused acceptance body file}"
CRASH_ISSUE_URL="$(env HOME="$TEST_HOME" USERPROFILE="$TEST_HOME" \
  GH_CONFIG_DIR="$TEST_GH_CONFIG" GH_TOKEN="$ACCEPTANCE_GH_TOKEN" \
  gh issue create --title "$CRASH_ISSUE_TITLE" --body-file "$CRASH_ISSUE_BODY_FILE")"
CRASH_ISSUE="${CRASH_ISSUE_URL##*/}"
printf '/forge/work-on %s --lane test/opencode-native-base\n' "$CRASH_ISSUE"
acceptance_opencode
test "$ACCEPTANCE_OPENCODE_STATUS" -ne 0
```

Wait for the best-effort issue lease to expire, then restart through the same
scoped helper:

```bash
set -euo pipefail
printf '/forge/work-on %s --lane test/opencode-native-base\n' "$CRASH_ISSUE"
acceptance_opencode
test "$ACCEPTANCE_OPENCODE_STATUS" -eq 0
```

GitHub markers, not the lost model session, must determine continuation.

## 8. Verify Orchestration

Create two sandbox issues where issue B says `Depends on #<A>`, and store their
numeric issue IDs in shell variables `$A` and `$B`.

Dry run first:

```bash
set -euo pipefail
printf '/forge/orchestrate %s %s --lane test/opencode-native-base --dry-run\n' "$A" "$B"
acceptance_opencode
test "$ACCEPTANCE_OPENCODE_STATUS" -eq 0
```

Then compile the confirmation plan without authorization:

```bash
set -euo pipefail
printf '/forge/orchestrate %s %s --lane test/opencode-native-base\n' "$A" "$B"
acceptance_opencode
test "$ACCEPTANCE_OPENCODE_STATUS" -eq 0
```

Expected: `confirmation-required`, a batch ID, plan path, and zero mutations.
Store the returned ID in the shell variable `$BATCH_ID`.

Authorize explicitly:

```bash
set -euo pipefail
printf '/forge/orchestrate --resume %s --confirm\n' "$BATCH_ID"
acceptance_opencode
test "$ACCEPTANCE_OPENCODE_STATUS" -eq 0
```

Inspect
`$TEST_HOME/.forge/batches/<owner_repo>/<batch-id>/events.jsonl`, never the
operator's real `~/.forge`. Issue B must not have `ISSUE_STARTED` before issue A
has terminal state `done`. A failed or gated A must leave B `blocked`, never
dispatched.

Also test two independent issues with `--max-concurrent 2`; both may run while
the dependent issue remains queued.

## 9. Inspect OpenCode Sessions

Use OpenCode's session list or local session database to inspect phase sessions.
For every ForgeDock phase session:

- title is `ForgeDock #<issue> <phase>`;
- `parentID` is absent;
- one user prompt contains one native phase card and invocation context;
- `task`, `skill`, `forge_work_on`, and `forge_orchestrate` are disabled;
- no synthetic `state="completed"` user message appears; and
- a new session ID is used for every phase attempt.

## 10. Authorize Or Reject

Record:

- commit SHA tested;
- OpenCode version;
- provider/model used;
- automated test totals;
- sandbox issue and PR URLs;
- batch ID and event-log path;
- prompt-byte output; and
- any deviations from this runbook.

Before authorizing, prove that the implementation checkout is still the exact,
clean commit tested at the start:

```bash
set -euo pipefail
test "$(git -C "$IMPLEMENTATION_ROOT" rev-parse HEAD)" = "$TESTED_SHA"
test -z "$(git -C "$IMPLEMENTATION_ROOT" status --porcelain=v1 --untracked-files=all)"
unset ACCEPTANCE_GH_TOKEN ACCEPTANCE_ANTHROPIC_API_KEY
```

Authorize merge to `staging` only for the exact tested SHA. If any gate fails,
leave the branch unmerged and attach the evidence to the implementation PR.
