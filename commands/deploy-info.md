---
description: Show what will deploy next — diff staging vs main with issue/PR summary, risk assessment, and deploy checklist
argument-hint: [staging | milestone/{slug} | compare {branch}]
install: extras
---

# /deploy-info — Pre-Deploy Summary

**Input**: $ARGUMENTS (default: `staging`)

**Config variables used by this command** (set in `forge.yaml`):
- `{REPO_PATH}` ← `paths.root` — project repository root
- `{HEALTH_ENDPOINT}` ← `services.health_endpoint` (optional) — URL used in post-deploy health check
- `{DEPLOY_WORKFLOW}` ← `deploy.workflow` (optional) — GitHub Actions workflow filename to trigger a deploy (e.g., `hotfix-deploy.yml`). When absent or empty, workflow-trigger steps are omitted.
- `{DEPLOY_SECRETS_BACKEND}` ← `deploy.secrets_backend` (optional) — secrets delivery method (`sops`, `aws-sm`, `vault`, `ci-env`, `none`). Controls whether secret-chain checks run.

You are the pipeline's deploy awareness layer. Before the user merges staging → main (triggering CI/CD deployment), this command shows exactly what's going out: which PRs, which issues, what changed, and what risks exist.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. User can override with `--model <name>`. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.

**NEVER use plan mode (EnterPlanMode)** — it breaks execution context.

<!-- FORGE:SPEC_LOADED — deploy-info.md loaded and active. Agent is bound by this spec. -->

---

## Phase 0: Review-Finding Readiness Check

**Purpose**: Surface open review-finding issues before the deploy workflow begins. Staging→main PRs that ship with open findings have a 50%+ failure rate — this check identifies the readiness gap at the earliest possible point. <!-- Added: forge#372 -->

**Non-blocking**: This phase emits a warning but does NOT block. Deploy-info is an informational tool. The authoritative gate is Phase 0A of `/review-pr-staging`.

```bash
cd {REPO_PATH}
git fetch origin main staging

SOURCE=${SOURCE_BRANCH:-staging}
TARGET=${TARGET_BRANCH:-main}

# Step 1: Find all PR numbers in the bundle (same logic as review-pr-staging Phase 0A)
BUNDLE_PRS=$(git log origin/$TARGET..origin/$SOURCE --oneline \
  | grep -oE '#[0-9]+' \
  | sort -u \
  | tr -d '#')

MERGE_PRS=$(git log origin/$TARGET..origin/$SOURCE --merges --oneline \
  | grep -oE 'pull request #[0-9]+' \
  | grep -oE '[0-9]+' \
  | sort -u)

ALL_PR_NUMBERS=$(echo "$BUNDLE_PRS $MERGE_PRS" | tr ' ' '\n' | sort -u | grep -E '^[0-9]+$')

if [ -z "$ALL_PR_NUMBERS" ]; then
  echo "ℹ️  No PRs detected in bundle — skipping review-finding readiness check."
else
  # Step 2: Check for open review-finding issues referencing each PR
  OPEN_FINDINGS_SUMMARY=""
  for pr_num in $ALL_PR_NUMBERS; do
    OPEN_FINDINGS=$(gh issue list -R {GH_REPO} \
      --label "review-finding" \
      --state open \
      --search "PR #${pr_num}" \
      --limit 20 \
      --json number,title \
      --jq ".[] | \"  - #\(.number): \(.title)\"" 2>/dev/null)

    if [ -n "$OPEN_FINDINGS" ]; then
      OPEN_FINDINGS_SUMMARY="${OPEN_FINDINGS_SUMMARY}
**PR #${pr_num}** has open review findings:
${OPEN_FINDINGS}"
    fi
  done

  # Step 3: Report readiness state
  if [ -n "$OPEN_FINDINGS_SUMMARY" ]; then
    echo ""
    echo "⚠️  READINESS WARNING — Open review-finding issues exist for PRs in this bundle."
    echo ""
    echo "$OPEN_FINDINGS_SUMMARY"
    echo ""
    echo "These findings will block deploy when /review-pr-staging runs (Phase 0A gate)."
    echo "Fix the open findings and merge fixes to staging before deploying."
    echo "Or post 'OVERRIDE: shipping with open findings — <reason>' on the staging→main PR to bypass."
    echo ""
    echo "READINESS: NOT READY — open findings present"
  else
    echo "✅ Review-finding readiness: READY — no open findings for PRs in this bundle."
  fi
fi
```

---

## Phase 1: Resolve What to Compare

| Input | Source Branch | Target Branch | Scenario |
|-------|--------------|---------------|----------|
| `staging` or empty | `staging` | `main` | Normal fast-lane deploy |
| `milestone/{slug}` | `milestone/{slug}` | `staging` | Ship milestone to staging |
| `compare {branch}` | `{branch}` | `main` | Custom comparison |

```bash
cd {REPO_PATH}
git fetch origin main staging

# Determine source and target
SOURCE=${SOURCE_BRANCH:-staging}
TARGET=${TARGET_BRANCH:-main}

# Check if there are any differences
AHEAD=$(git rev-list --count origin/$TARGET..origin/$SOURCE)
if [ "$AHEAD" -eq 0 ]; then
  echo "✅ $SOURCE is up to date with $TARGET — nothing to deploy."
  exit 0
fi
echo "$AHEAD commits ahead"
```

---

## Phase 2: Gather Deploy Payload

### Step 2A: Commit log

```bash
# All commits that will deploy
git log --oneline origin/$TARGET..origin/$SOURCE --format="%h %s" | head -50
```

### Step 2B: PRs included

```bash
# Extract PR numbers from merge commits
PR_NUMBERS=$(git log origin/$TARGET..origin/$SOURCE --merges --format="%s" | grep -oE '#[0-9]+' | sort -u)

# Get PR details
for PR in $PR_NUMBERS; do
  NUM=${PR#\#}
  gh pr view $NUM --json number,title,author,labels,mergedAt --jq '"\(.number) | \(.title) | \(.author.login) | \([.labels[].name] | join(","))"' 2>/dev/null
done
```

### Step 2C: Issues being closed

```bash
# Extract issue references from PR bodies
for PR in $PR_NUMBERS; do
  NUM=${PR#\#}
  CLOSES=$(gh pr view $NUM --json body --jq '.body' 2>/dev/null | grep -oE 'Closes #[0-9]+' | grep -oE '[0-9]+')
  for ISSUE in $CLOSES; do
    gh issue view $ISSUE --json number,title,labels --jq '"\(.number) | \(.title) | \([.labels[].name] | join(","))"' 2>/dev/null
  done
done
```

### Step 2D: Files changed

```bash
# Full file diff summary
git diff --stat origin/$TARGET..origin/$SOURCE

# Read layout paths from forge.yaml, fall back to forge.yaml defaults
LAYOUT_API=$(yq '.review.layout.api // "services/api"' forge.yaml 2>/dev/null || echo "services/api")
LAYOUT_WORKER=$(yq '.review.layout.worker // "services/worker"' forge.yaml 2>/dev/null || echo "services/worker")
LAYOUT_PAGES=$(yq '.review.layout.pages // "web/src/app"' forge.yaml 2>/dev/null || echo "web/src/app")
# Derive web root from pages root (strip trailing /src/app or similar suffix if present)
LAYOUT_WEB=$(echo "$LAYOUT_PAGES" | sed 's|/src/app$||; s|/src$||')

# Categorize by service
echo "=== By Service ==="
git diff --name-only origin/$TARGET..origin/$SOURCE | sort | while read f; do
  case "$f" in
    ${LAYOUT_API}/*) echo "API: $f" ;;
    ${LAYOUT_WORKER}/*) echo "WORKER: $f" ;;
    ${LAYOUT_WEB}/*) echo "WEB: $f" ;;
    shared/*) echo "SHARED: $f" ;;
    infra/*) echo "INFRA: $f" ;;
    *) echo "OTHER: $f" ;;
  esac
done | sort
```

### Step 2E: Migration check

```bash
# Read migrations path from forge.yaml, fall back to infra/migrations
LAYOUT_MIGRATIONS=$(yq '.review.layout.migrations // "infra/migrations"' forge.yaml 2>/dev/null || echo "infra/migrations")

# Are there new migrations?
MIGRATIONS=$(git diff --name-only origin/$TARGET..origin/$SOURCE | grep "^${LAYOUT_MIGRATIONS}/" | sort)
if [ -n "$MIGRATIONS" ]; then
  echo "⚠️ DATABASE MIGRATIONS INCLUDED:"
  echo "$MIGRATIONS"
  # Show migration content for review
  # $MIGRATIONS is one path per line (`git diff --name-only`) — herestring,
  # not a piped `| while read`, for consistency with the newline-safe pattern
  # used elsewhere in this sweep.
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    echo "--- $m ---"
    git show origin/$SOURCE:$m 2>/dev/null | head -30
  done <<< "$MIGRATIONS"
fi
```

---

## Phase 3: Risk Assessment

Analyze the deploy payload and flag risks:

### Risk Signals

| Signal | Risk Level | Action |
|--------|-----------|--------|
| Database migrations present | MEDIUM | Verify migrations are reversible |
| `shared/` changes | LOW | Restart-only deploy possible (no rebuild) |
| `.env.example` changes | HIGH | Verify secrets backend has new vars (see `deploy.secrets_backend`) |
| `docker-compose.prod.yml` changes | HIGH | Review infrastructure changes carefully |
| `infra/traefik/` changes | HIGH | Routing changes — test before full deploy |
| 10+ PRs in one deploy | MEDIUM | Consider deploying in smaller batches |
| P0 fixes included | LOW | Good — these should deploy ASAP |
| New endpoints added | MEDIUM | Verify auth model and proxy wiring |

### Automated Checks

```bash
# Check for new env vars that might not be in the configured secrets backend
NEW_ENV=$(git diff origin/$TARGET..origin/$SOURCE -- '.env.example' | grep "^+" | grep -v "^+++" | grep -v "^#")
if [ -n "$NEW_ENV" ]; then
  echo "⚠️ NEW ENVIRONMENT VARIABLES — verify they exist in your secrets backend ({DEPLOY_SECRETS_BACKEND}):"
  echo "$NEW_ENV"
  # Cross-check with SOPS chain (only when deploy.secrets_backend == "sops")
  # If your project uses a different backend, skip this block and verify manually.
  if [ "{DEPLOY_SECRETS_BACKEND}" = "sops" ]; then
    for var in $(echo "$NEW_ENV" | grep -oE '^\+[A-Z_]+' | sed 's/^\+//'); do
      if [ -f "{REPO_PATH}/scripts/decrypt-secrets.sh" ]; then
        grep -q "$var" "{REPO_PATH}/scripts/decrypt-secrets.sh" 2>/dev/null || echo "  ❌ $var NOT in decrypt-secrets.sh ENV_MAPPING"
      else
        echo "  ℹ️  scripts/decrypt-secrets.sh not found — skipping ENV_MAPPING cross-check for $var. Verify manually in your SOPS chain."
      fi
    done
  else
    echo "  ℹ️  SOPS chain check skipped — deploy.secrets_backend is '{DEPLOY_SECRETS_BACKEND}'. Verify new vars in your configured backend."
  fi
fi
```

---

## Phase 4: Deploy Checklist

Generate a checklist based on what's in the deploy:

```markdown
## Deploy Checklist

### Pre-Deploy
- [ ] All PRs in this deploy have been reviewed
- [ ] No open `needs-human` issues blocking deploy
- [ ] {If migrations} Database backup verified
- [ ] {If new env vars} Secrets backend ({DEPLOY_SECRETS_BACKEND}) updated with new vars; verify via your configured secrets chain
- [ ] {If traefik changes} Routing tested locally

### Deploy Command
```
# Standard deploy (merge staging → main via GitHub web UI)
# CI/CD auto-triggers on push to main

# Or manual trigger for specific services (requires deploy.workflow set in forge.yaml):
gh workflow run {deploy.workflow} --ref main -f {deploy.workflow_inputs.services}={affected_services} -f {deploy.workflow_inputs.reason}="Deploy: {summary}"
# If deploy.workflow is not configured, deploy via the GitHub web UI or your CI/CD provider.
```

### Post-Deploy
- [ ] Health check: `curl -s {HEALTH_ENDPOINT} | jq .`
- [ ] {If migrations} Verify migration applied: check new tables/columns exist
- [ ] {If new features} Smoke test the new functionality
- [ ] Monitor error rates for 15 minutes
```

---

## Phase 5: Output Summary

```
## Deploy Summary: {SOURCE} → {TARGET}

**Commits**: {N} | **PRs**: {N} | **Issues closed**: {N} | **Files changed**: {N}

### Services Affected
| Service | Files Changed | Rebuild Required |
|---------|---------------|-----------------|
| API | {N} | Yes |
| Worker | {N} | Yes |
| Web | {N} | Yes |
| Shared | {N} | No (restart only) |
| Infra | {N} | N/A |

### PRs Included
| # | Title | Author | Labels |
|---|-------|--------|--------|
{table of PRs}

### Issues Being Resolved
| # | Title | Priority |
|---|-------|----------|
{table of issues}

### Risk Assessment
- **Overall risk**: {LOW / MEDIUM / HIGH}
- **Flags**: {list of risk signals triggered}

### Migrations
{migration details or "None"}

### New Environment Variables
{new vars or "None"}

---

**Ready to deploy?** Merge staging → main via GitHub web UI, or run:
`gh workflow run {deploy.workflow} --ref staging -f {deploy.workflow_inputs.services}={services} -f {deploy.workflow_inputs.reason}="Batch deploy"`
*(requires `deploy.workflow` set in `forge.yaml`; omit this line if not configured)*
```
