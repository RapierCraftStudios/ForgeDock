---
description: Autonomous dependency upgrade pipeline — detect outdated dependencies, create upgrade issues, and run /work-on to investigate, build, test, and merge each upgrade
argument-hint: [--dry-run | --ecosystem npm|pip|cargo | --allow-major | --limit N | --batch]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /upgrade-deps — Autonomous Dependency Upgrade Pipeline

**Input**: $ARGUMENTS

You are a dependency upgrade agent. Your job is to detect outdated packages, triage them by semver risk level, create GitHub issues for eligible upgrades, and run them through the full `/work-on` pipeline — so each upgrade gets investigation, compatibility verification, quality gate, review, and merge — rather than a blind version bump PR.

**Agent model policy**: Default `model: "sonnet"`. If Sonnet is rate-limited, fall back to `model: "opus"`.
Plan mode: see `commands/shared/agent-policies.md` § Plan mode ban if not already in context.

---

## Argument Parsing

| Flag | Effect |
|------|--------|
| (none) | Detect + triage + report (no issue creation, no fixing) |
| `--dry-run` | Run all phases but do NOT create issues, PRs, or labels — report only |
| `--ecosystem npm` | Limit detection to npm only |
| `--ecosystem pip` | Limit detection to pip only |
| `--ecosystem cargo` | Limit detection to cargo only |
| `--allow-major` | Include major upgrades in issue creation (default: flag for human review only) |
| `--limit N` | Cap issue creation to at most N issues per run (default: 10) |
| `--batch` | Group all patch upgrades into one batch issue instead of one-per-package |
| `--fix` | After issue creation, also invoke `/work-on` on each created issue |

Parse `$ARGUMENTS`:

```bash
DRY_RUN=false
ECOSYSTEM_FILTER=""
ALLOW_MAJOR=false
ISSUE_LIMIT=10
BATCH_PATCHES=false
DO_FIX=false
NEXT_IS_ECOSYSTEM=false
NEXT_IS_LIMIT=false

for arg in $ARGUMENTS; do
  case "$arg" in
    --dry-run)       DRY_RUN=true ;;
    --allow-major)   ALLOW_MAJOR=true ;;
    --batch)         BATCH_PATCHES=true ;;
    --fix)           DO_FIX=true ;;
    --ecosystem)     NEXT_IS_ECOSYSTEM=true ;;
    --limit)         NEXT_IS_LIMIT=true ;;
    *)
      if [ "$NEXT_IS_ECOSYSTEM" = "true" ]; then
        ECOSYSTEM_FILTER="$arg"
        NEXT_IS_ECOSYSTEM=false
      elif [ "$NEXT_IS_LIMIT" = "true" ]; then
        ISSUE_LIMIT="$arg"
        NEXT_IS_LIMIT=false
      fi
      ;;
  esac
done
```

If `DRY_RUN=true`, prefix all actions with `[DRY RUN]` and skip all `gh issue create`, `gh issue edit`, and `Skill()` invocations — report what would happen instead.

---

## Phase 0: Config Resolution

**Config variables used by this command** (set in `forge.yaml → upgrade_deps`):
- `{ECOSYSTEMS}` ← `upgrade_deps.ecosystems` — list of ecosystems to check (default: `["npm"]`)
- `{ALLOW_MAJOR_CONFIG}` ← `upgrade_deps.allow_major` (default: `false`) — whether to create issues for major upgrades
- `{EXCLUDE_PACKAGES}` ← `upgrade_deps.exclude` — list of package names to skip regardless of semver level
- `{ISSUE_BATCH_SIZE}` ← `upgrade_deps.issue_batch_size` — how many patch packages to group per batch issue (default: 5)

Config resolution: see `commands/shared/config-resolution.md` (resolves `GH_REPO`, `GH_FLAG`, `REPO_PATH`) if not already in context.

```bash
CONFIG_FILE="${FORGE_CONFIG:-forge.yaml}"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: forge.yaml not found. Run: npx forgedock init && /forgedock-init"
  exit 1
fi

GH_REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG_FILE")
GH_FLAG="-R $GH_REPO"
REPO_PATH=$(yq '.paths.root' "$CONFIG_FILE")
STAGING_BRANCH=$(yq '.branches.staging // "staging"' "$CONFIG_FILE")

# upgrade_deps section (all optional — fall back to defaults)
ECOSYSTEMS_CONFIG=$(yq '.upgrade_deps.ecosystems // ["npm"] | join(" ")' "$CONFIG_FILE" 2>/dev/null || echo "npm")
ALLOW_MAJOR_CONFIG=$(yq '.upgrade_deps.allow_major // false' "$CONFIG_FILE" 2>/dev/null || echo "false")
EXCLUDE_PACKAGES=$(yq '.upgrade_deps.exclude // [] | join(" ")' "$CONFIG_FILE" 2>/dev/null || echo "")
ISSUE_BATCH_SIZE=$(yq '.upgrade_deps.issue_batch_size // 5' "$CONFIG_FILE" 2>/dev/null || echo "5")

# CLI flags override config values
[ "$ECOSYSTEM_FILTER" != "" ] && ECOSYSTEMS_CONFIG="$ECOSYSTEM_FILTER"
[ "$ALLOW_MAJOR" = "true" ] && ALLOW_MAJOR_CONFIG="true"
```

---

## Phase 1: Detect Outdated Dependencies

Run dependency detection for each configured ecosystem. Skip an ecosystem if its tool is not installed.

### 1A: npm

```bash
if echo "$ECOSYSTEMS_CONFIG" | grep -q "npm"; then
  if command -v npm >/dev/null 2>&1; then
    echo "--- npm ecosystem ---"
    cd "$REPO_PATH"
    NPM_OUTDATED=$(npm outdated --json 2>/dev/null || echo "{}")
    echo "$NPM_OUTDATED" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for pkg, info in data.items():
    current = info.get('current', 'N/A')
    wanted = info.get('wanted', 'N/A')
    latest = info.get('latest', 'N/A')
    print(f'{pkg}|{current}|{wanted}|{latest}')
" 2>/dev/null || true
  else
    echo "npm not installed — skipping npm ecosystem"
  fi
fi
```

### 1B: pip

```bash
if echo "$ECOSYSTEMS_CONFIG" | grep -q "pip"; then
  PIP_CMD=""
  command -v pip3 >/dev/null 2>&1 && PIP_CMD="pip3"
  command -v pip >/dev/null 2>&1 && PIP_CMD="${PIP_CMD:-pip}"

  if [ -n "$PIP_CMD" ]; then
    echo "--- pip ecosystem ---"
    $PIP_CMD list --outdated --format=json 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for pkg in data:
    print(f'{pkg[\"name\"]}|{pkg[\"version\"]}|{pkg[\"latest_version\"]}')
" 2>/dev/null || true
  else
    echo "pip/pip3 not installed — skipping pip ecosystem"
  fi
fi
```

### 1C: cargo

```bash
if echo "$ECOSYSTEMS_CONFIG" | grep -q "cargo"; then
  if command -v cargo >/dev/null 2>&1 && command -v cargo-outdated >/dev/null 2>&1; then
    echo "--- cargo ecosystem ---"
    cd "$REPO_PATH"
    cargo outdated --format json 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for dep in data.get('dependencies', []):
        name = dep.get('name', '')
        project = dep.get('project', 'N/A')
        latest = dep.get('latest', 'N/A')
        print(f'{name}|{project}|{latest}')
except: pass
" 2>/dev/null || true
  else
    command -v cargo >/dev/null 2>&1 || echo "cargo not installed — skipping cargo ecosystem"
    command -v cargo-outdated >/dev/null 2>&1 || echo "cargo-outdated not installed — run: cargo install cargo-outdated"
  fi
fi
```

### 1D: Aggregate results

Collect all detected outdated packages into a structured list:

```
OUTDATED_PACKAGES = [
  { name, current_version, latest_version, semver_level, ecosystem }
]
```

Compute `semver_level` for each package:
- **patch**: major and minor match (e.g., 1.2.3 → 1.2.9)
- **minor**: major matches, minor differs (e.g., 1.2.3 → 1.5.0)
- **major**: major version differs (e.g., 1.x.x → 2.x.x)

---

## Phase 2: Triage

**Goal**: Filter, classify, and rank the detected upgrades.

### 2A: Apply exclusions

```bash
# Filter out packages in the EXCLUDE_PACKAGES list
for pkg in $EXCLUDE_PACKAGES; do
  echo "Skipping excluded package: $pkg"
  # Remove from OUTDATED_PACKAGES
done
```

### 2B: Apply semver gate

- **patch** and **minor**: eligible for issue creation (default behavior)
- **major**: eligible only if `ALLOW_MAJOR_CONFIG=true` or `--allow-major` was passed; otherwise, flag for human review

### 2C: Deduplication — skip if open issue already tracks this upgrade

Before creating any issue, check for existing open issues that already track the same package upgrade:

```bash
for pkg in ${ELIGIBLE_PACKAGES}; do
  # Pass $pkg to jq via the environment (env.PKG) instead of splicing it into the
  # jq program text — avoids breaking the outer quoting if $pkg ever contained a
  # single quote or other shell-meaningful character.
  export PKG="$pkg"
  EXISTING=$(gh issue list $GH_FLAG --state open \
    --search "upgrade $pkg" --limit 5 \
    --json number,title \
    --jq '.[] | select(.title | test("upgrade.*" + env.PKG; "i")) | .number' 2>/dev/null | head -1)

  if [ -n "$EXISTING" ]; then
    echo "Skipping $pkg — open issue #$EXISTING already tracks this upgrade"
    # Add $pkg to SKIPPED list with reason "existing-issue:#$EXISTING"
  fi
done
```

### 2D: Apply limit

Cap the final eligible list to `$ISSUE_LIMIT` packages. Prioritize by semver impact:
1. minor upgrades (higher value)
2. patch upgrades (lower value, safe to batch)

If `BATCH_PATCHES=true`, group all patch-level packages into one batch issue (up to `$ISSUE_BATCH_SIZE` per batch issue).

### 2E: Major upgrade report (human review required)

For major upgrades when `ALLOW_MAJOR_CONFIG=false`, collect them for the summary report but do NOT create issues. Print:

```
Major upgrades detected (not auto-processed — require human review):
  {package}: {current} → {latest} [major]
```

---

## Phase 3: Issue Creation

For each eligible package (or batch), create a GitHub issue:

### 3A: Per-package issue (patch or minor, non-batched)

```bash
# DRY_RUN guard — must stay above the create it guards. In dry-run
# mode print the would-be issue and move on; never create it.
if [ "$DRY_RUN" = "true" ]; then
  echo "[DRY RUN] Would create issue: feat(deps): upgrade {PACKAGE} from {CURRENT} to {LATEST} ({SEMVER_LEVEL})"
else
gh issue create $GH_FLAG \
  --title "feat(deps): upgrade {PACKAGE} from {CURRENT} to {LATEST} ({SEMVER_LEVEL})" \
  --label "enhancement" \
  --body "$(cat <<'ISSUE_EOF'
## Problem

{PACKAGE} is outdated: current version {CURRENT}, latest is {LATEST} ({SEMVER_LEVEL} bump).

Dependency upgrades are repetitive, well-scoped work. This issue tracks the upgrade through the full ForgeDock pipeline: investigate compatibility, implement the upgrade, run tests, review, and merge.

## Affected Files

Files that may need changes:
1. `package.json` / `requirements.txt` / `Cargo.toml` — version constraint update
2. Lockfile (`package-lock.json` / `poetry.lock` / `Cargo.lock`) — regenerated by install command

Additional files will be identified if the new version has breaking changes requiring code updates.

## Expected Behavior

- Package is updated to {LATEST} (or the highest compatible version within {SEMVER_LEVEL} range)
- All existing tests pass
- No breaking changes introduced

## Acceptance Criteria

- [ ] `{PACKAGE}` version updated from `{CURRENT}` to `{LATEST}` in the manifest
- [ ] Lockfile regenerated (`npm install` / `pip install` / `cargo update`)
- [ ] Test suite passes (no regressions)
- [ ] Breaking changes identified and addressed (especially for minor upgrades)
- [ ] CHANGELOG or release notes consulted for deprecation notices

## Context

**Ecosystem**: {ECOSYSTEM}
**Semver level**: {SEMVER_LEVEL}
**Detected by**: `/upgrade-deps` cycle on {DATE}
**Release notes**: https://www.npmjs.com/package/{PACKAGE}/v/{LATEST} (adjust URL for ecosystem)

---
*Created by `/upgrade-deps`. Will be validated before any changes are applied.*
ISSUE_EOF
)"
fi
```

### 3B: Batch patch issue (when `--batch` is set)

Group multiple patch-level packages into one issue:

```bash
BATCH_PACKAGE_LIST=$(printf '- `%s`: %s → %s\n' {PACKAGE} {CURRENT} {LATEST})

# DRY_RUN guard — must stay above the create it guards.
if [ "$DRY_RUN" = "true" ]; then
  echo "[DRY RUN] Would create batch issue: feat(deps): batch patch upgrades — {COUNT} packages ({DATE})"
  echo "[DRY RUN] Packages: $BATCH_PACKAGE_LIST"
else
gh issue create $GH_FLAG \
  --title "feat(deps): batch patch upgrades — {COUNT} packages ({DATE})" \
  --label "enhancement" \
  --body "$(cat <<'BATCH_ISSUE_EOF'
## Problem

{COUNT} dependencies have patch-level updates available. Patch upgrades are low-risk (semver guarantees no breaking changes) and are batched here for efficiency.

## Packages in This Batch

{BATCH_PACKAGE_LIST}

## Affected Files

1. `package.json` / `requirements.txt` / `Cargo.toml` — version constraint updates
2. Lockfile — regenerated after all updates

## Expected Behavior

All listed packages updated to their latest patch version. Full test suite passes.

## Acceptance Criteria

- [ ] All listed packages updated in the manifest
- [ ] Lockfile regenerated
- [ ] Test suite passes with no regressions

## Context

**Ecosystem**: {ECOSYSTEM}
**Semver level**: patch (all)
**Detected by**: `/upgrade-deps` cycle on {DATE}

---
*Batch created by `/upgrade-deps`. Investigate step will verify each package's patch notes.*
BATCH_ISSUE_EOF
)"
fi
```

**DRY_RUN check**: enforced inline in 3A and 3B above — the guard wraps each `gh issue create` rather than being stated after it, so a dry run cannot create issues even if only one section is read in isolation.

Store created issue numbers as `CREATED_ISSUES` (empty when `DRY_RUN=true`).

---

## Phase 4: Fix (requires `--fix` flag)

**Skip unless `--fix` was passed.**

For each issue in `CREATED_ISSUES`, invoke `/work-on` via the Skill tool:

```
# DRY_RUN guard — must stay above the Skill() call it guards.
if [ "$DRY_RUN" = "true" ]; then
  echo "[DRY RUN] Would invoke: Skill(skill: \"work-on\", args: \"{ISSUE_NUMBER}\")"
else
  Skill(skill: "work-on", args: "{ISSUE_NUMBER}")
fi
```

Run **sequentially** — each `/work-on` invocation is heavyweight. If one fails, continue to the next and record the outcome.

Track outcomes:

```
FIX_RESULTS = [
  { issue: NUMBER, outcome: "merged" | "invalid" | "failed" | "needs-human", pr: PR_NUMBER | null }
]
```

**DRY_RUN check**: enforced inline above — the guard wraps the `Skill()` call rather than being stated after it, so a dry run cannot invoke `/work-on` even if only this section is read in isolation.

---

## Phase 5: Summary Report

Print a structured report at the end of every run:

```markdown
## /upgrade-deps Cycle Report — {DATE}

### Detection Results
| Ecosystem | Outdated | Eligible | Skipped (existing issue) | Skipped (excluded) | Major (human review) |
|-----------|----------|----------|--------------------------|-------------------|----------------------|
| npm       | {N}      | {N}      | {N}                      | {N}               | {N}                  |
| pip       | {N}      | {N}      | {N}                      | {N}               | {N}                  |

### Issues Created
{list with issue numbers and titles, or "None — use --fix=false dry-run or no --fix flag"}

### Major Upgrades (Human Review Required)
{list: package: current → latest [major], or "None detected"}

### Fix Results (only if --fix was passed)
| Issue | Package | Outcome | PR |
|-------|---------|---------|-----|
| #{N}  | {pkg}   | merged  | #{PR} |

### Next Steps
- [ ] Review major upgrades above and create issues manually if appropriate
- [ ] Set `upgrade_deps.exclude` in `forge.yaml` for packages that should never auto-upgrade
- [ ] Run `/upgrade-deps --fix` to also execute the pipeline for created issues
```

---

## Scheduling via GitHub Actions

To run `/upgrade-deps` on a schedule, add a workflow to `.github/workflows/upgrade-deps.yml` in your project:

```yaml
# .github/workflows/upgrade-deps.yml
# Runs /upgrade-deps weekly — creates GitHub issues for outdated deps.
# Issues flow through the ForgeDock pipeline: investigate → build → review → merge.
name: Weekly Dependency Upgrade Check

on:
  schedule:
    - cron: '0 9 * * 1'   # Every Monday at 09:00 UTC
  workflow_dispatch:        # Allow manual trigger

jobs:
  upgrade-deps:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write

    steps:
      - uses: actions/checkout@v4

      - name: Set up Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Run /upgrade-deps
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          claude -p "/upgrade-deps --limit 5" --allowedTools "Bash,Read,Write,Edit,Glob,Grep"
```

> **Note**: The workflow above creates issues only (no `--fix`). To also invoke `/work-on` from CI, add `--fix` to the claude command. Each `/work-on` run uses Anthropic API credits proportional to issue complexity. Review your budget before enabling `--fix` in scheduled workflows.

---

## forge.yaml Configuration Reference

Add an `upgrade_deps` section to your `forge.yaml` to configure the command:

```yaml
# upgrade_deps (OPTIONAL)
# Controls /upgrade-deps behavior.
upgrade_deps:
  # Ecosystems to check (default: ["npm"])
  ecosystems:
    - npm
    - pip
    # - cargo     # requires: cargo install cargo-outdated

  # Whether to create issues for major version upgrades (default: false)
  # Major upgrades carry breaking-change risk — enable only with human review process.
  allow_major: false

  # Packages to never auto-upgrade (excluded from issue creation and /work-on)
  # Useful for packages with known breaking changes or intentional version pins.
  exclude:
    # - "some-package"   # example: pinned intentionally

  # How many patch packages to group per batch issue when --batch is used (default: 5)
  issue_batch_size: 5
```

---

## Safety Rules

1. **NEVER bump a major version without `--allow-major`** — major upgrades have breaking-change risk and require human review.
2. **NEVER bypass the deduplication check** — if an open issue already tracks an upgrade, skip it.
3. **NEVER create more than `ISSUE_LIMIT` issues per run** — prevents runaway issue flooding.
4. **NEVER skip `/work-on` investigation** — every upgrade goes through full pipeline (investigate compatibility, build, test, review). A blind version bump PR is not a valid outcome.
5. **DRY_RUN means NO side effects** — no issues created, no `/work-on` calls. Report only.
6. **NEVER run cargo-outdated if cargo-outdated is not installed** — detect tool availability first.
7. **NEVER upgrade excluded packages** — respect the `upgrade_deps.exclude` list in `forge.yaml`.

---

## Integration with /autopilot

`/upgrade-deps` is a peer to `/autopilot` — both create issues and optionally invoke `/work-on`. They are complementary:

| Command | Signal source | Scope |
|---------|--------------|-------|
| `/autopilot` | Production health, CI failures, backlog | Platform operational health |
| `/upgrade-deps` | Package registries (npm, pip, cargo) | Dependency freshness |

`/autopilot` does NOT detect outdated dependencies. Use `/upgrade-deps` for dependency-specific work, and pair it with `/autopilot` for full-spectrum platform maintenance.
