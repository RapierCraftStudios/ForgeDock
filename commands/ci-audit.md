---
description: Stack-aware CI gap detection — audits a project's GitHub Actions workflows against its declared tech stack and files issues for missing config validation checks
argument-hint: [--repo <prefix>] [--dry-run]
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /ci-audit — Stack-Aware CI Gap Detection

**Input**: $ARGUMENTS

You are the CI hygiene auditor. Given a project's declared tech stack (from `forge.yaml`), determine what config validation tools exist for each stack component and audit whether the project's GitHub Actions workflows include those validation steps. File GitHub issues for any gaps found.

This command enforces ForgeDock's separation-of-concerns principle:

| Layer | What runs | Tokens | Example |
|-------|-----------|--------|---------|
| **CI (automated)** | Deterministic tool validators | Zero | `traefik validate`, `nginx -t`, `kubectl --dry-run` |
| **ForgeDock (autonomous)** | Reasoning about architecture, logic, security | Yes | "Is this timeout chain coherent?", "Does this wiring match the deploy script?" |
| **ForgeDock CI hygiene** | Audit that CI has the right checks for the stack | Once | "Project uses Traefik v3 but CI has no `traefik validate` step → file issue" |

Config validation runs in CI (zero tokens). ForgeDock's role is to ensure the right CI checks exist — not to run them itself. <!-- Added: forge#1104 -->

This command is designed to be run:
- **Once after project setup** to establish CI hygiene baseline
- **After stack changes** (adding Traefik, upgrading K8s, adopting Terraform)
- **As part of `/autopilot`** periodic review cycle
- **After a production incident** caused by a structurally invalid config

This is NOT a PR review — it does not approve or block. It creates issues for each CI gap found.

**Agent model policy**: `model: "sonnet"` (standard tier). Fallback: `model: "opus"` if rate-limited. Feature gate: pass `effort` in Task/Skill spawns only on Claude Code >= 2.1.154.
**NEVER use plan mode (EnterPlanMode).**

---

## Config Preamble

Before executing any phase, read `forge.yaml` to resolve project references:

```bash
GH_REPO=$(yq '.project.owner + "/" + .project.repo' forge.yaml 2>/dev/null)
GH_FLAG="-R ${GH_REPO}"
REPO_PATH=$(yq '.paths.root' forge.yaml 2>/dev/null || echo ".")
TECH_STACK=$(yq '.review.tech_stack // ""' forge.yaml 2>/dev/null || echo "")
TOOL_VERSIONS=$(yq '.review.tool_versions // {}' forge.yaml 2>/dev/null || echo '{}')
```

**Optional `forge.yaml` fields used by this command**:

```yaml
review:
  tech_stack: "Traefik v3, nginx 1.25, Terraform 1.6, Kubernetes 1.28"  # Free-form stack description
  tool_versions:                                                            # Structured version declarations
    traefik: "3"
    nginx: "1.25"
    terraform: "1.6"
    kubernetes: "1.28"
    docker_compose: "2"

# Optional: override which CI workflows to audit (default: all files in .github/workflows/)
ci_audit:
  workflow_paths:
    - ".github/workflows/ci.yml"
    - ".github/workflows/deploy-production.yml"
  dry_run: false   # When true: print findings without creating issues
```

If `forge.yaml` is missing: stop and tell the user to run `npx forgedock init` to generate it.

---

## Phase 1: Discover Stack Components

### 1A: Parse declared stack

Extract stack components from `forge.yaml → review.tech_stack` (free-form) and `forge.yaml → review.tool_versions` (structured).

```bash
echo "=== Stack from forge.yaml ==="
echo "TECH_STACK: $TECH_STACK"
echo "TOOL_VERSIONS: $TOOL_VERSIONS"
```

**Parse `TECH_STACK` (free-form text) for known tool names**:

Scan the `TECH_STACK` string for these tool keywords (case-insensitive):

| Keyword pattern | Tool | Validator(s) |
|-----------------|------|-------------|
| `traefik` | Traefik | `traefik validate`, `traefik healthcheck` |
| `nginx` | nginx | `nginx -t`, `nginx -T` |
| `kubernetes\|k8s\|kubectl` | Kubernetes | `kubectl apply --dry-run=client`, `kubeval`, `kustomize build \| kubectl apply --dry-run=client` |
| `terraform` | Terraform | `terraform validate`, `terraform plan`, `tflint` |
| `helm` | Helm | `helm lint`, `helm template \| kubectl apply --dry-run=client` |
| `docker.compose\|docker-compose` | Docker Compose | `docker compose config` |
| `pydantic\|fastapi` | Python (Pydantic) | `python -c "from app.main import app"` (startup validation) |
| `ansible` | Ansible | `ansible-playbook --syntax-check`, `ansible-lint` |
| `pulumi` | Pulumi | `pulumi preview --non-interactive` |

**Parse `TOOL_VERSIONS` (structured)** — for each key present, add to the detected components map with its version.

**Version-aware validator selection**:

The correct validator depends on the tool version. Version mismatches (e.g., using Traefik v2 flags on a v3 install) produce misleading results.

| Tool | Version | Preferred validator | Notes |
|------|---------|---------------------|-------|
| Traefik | v2.x | `traefik validate --configFile=traefik.yml` | v2 flag syntax |
| Traefik | v3.x | `traefik validate` (no `--configFile` flag needed in v3) | v3 changed CLI |
| nginx | any | `nginx -t -c /etc/nginx/nginx.conf` | Standard across versions |
| Terraform | ≥0.13 | `terraform validate` (in-directory) | Requires `terraform init` first |
| Terraform | all | `tflint` (linter, catches schema errors `terraform validate` misses) | Complementary |
| Kubernetes | any | `kubectl apply --dry-run=client -f k8s/` | Client-side, no cluster needed |
| Helm | ≥3.x | `helm lint ./chart` | v3 only (v2 deprecated) |
| Docker Compose | v2 | `docker compose config` | v2 CLI (`docker compose`, not `docker-compose`) |
| Docker Compose | v1 | `docker-compose config` | v1 CLI (legacy) |

If tool version is unknown: use the most permissive/universal validator form and note version ambiguity in the filed issue.

### 1B: Discover config file locations

For each detected tool, check whether config files exist in the repo:

```bash
REPO_PATH="${REPO_PATH:-.}"

# Traefik
TRAEFIK_CONFIGS=$(find "$REPO_PATH/traefik" -name "*.yml" -o -name "*.yaml" -o -name "*.toml" 2>/dev/null | head -10)
[ -n "$TRAEFIK_CONFIGS" ] && echo "Traefik configs found: $TRAEFIK_CONFIGS"

# nginx
NGINX_CONFIGS=$(find "$REPO_PATH/infra/nginx" "$REPO_PATH/nginx" -name "*.conf" 2>/dev/null | head -10)
[ -n "$NGINX_CONFIGS" ] && echo "nginx configs found: $NGINX_CONFIGS"

# Kubernetes
K8S_CONFIGS=$(find "$REPO_PATH/k8s" "$REPO_PATH/kubernetes" "$REPO_PATH/manifests" -name "*.yml" -o -name "*.yaml" 2>/dev/null | head -10)
[ -n "$K8S_CONFIGS" ] && echo "Kubernetes manifests found: $K8S_CONFIGS"

# Terraform
TF_CONFIGS=$(find "$REPO_PATH/terraform" "$REPO_PATH/infra/terraform" -name "*.tf" 2>/dev/null | head -10)
[ -n "$TF_CONFIGS" ] && echo "Terraform configs found: $TF_CONFIGS"

# Helm charts
HELM_CHARTS=$(find "$REPO_PATH" -name "Chart.yaml" 2>/dev/null | head -10)
[ -n "$HELM_CHARTS" ] && echo "Helm charts found: $HELM_CHARTS"

# Docker Compose
COMPOSE_FILES=$(find "$REPO_PATH" -maxdepth 2 -name "docker-compose*.yml" 2>/dev/null | head -10)
[ -n "$COMPOSE_FILES" ] && echo "Docker Compose files found: $COMPOSE_FILES"
```

**Skip any tool whose config files are NOT found in the repo** — a declared stack component with no config files has no CI validation gap to audit.

---

## Phase 2: Audit GitHub Actions Workflows

### 2A: Read all workflow files

```bash
WORKFLOW_DIR="$REPO_PATH/.github/workflows"
WORKFLOW_FILES=$(ls "$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml 2>/dev/null | head -30)

if [ -z "$WORKFLOW_FILES" ]; then
    echo "AUDIT GAP: No GitHub Actions workflows found in $WORKFLOW_DIR"
    echo "A project without CI has no automated validation at all — see Phase 3 for issue creation."
fi

echo "=== Workflows to audit ==="
echo "$WORKFLOW_FILES"
```

**Override with `forge.yaml → ci_audit.workflow_paths`** if that section is present:
```bash
CUSTOM_PATHS=$(yq '.ci_audit.workflow_paths // []' forge.yaml 2>/dev/null | yq '.[]' 2>/dev/null || echo "")
[ -n "$CUSTOM_PATHS" ] && WORKFLOW_FILES="$CUSTOM_PATHS"
```

### 2B: Check for each tool's validator

For each tool detected in Phase 1 with config files present, search all workflow files for a validation step:

```bash
# Build a combined search corpus from all workflow files
WORKFLOW_CORPUS=$(cat $WORKFLOW_FILES 2>/dev/null)

declare -A TOOL_VALIDATOR_FOUND
declare -A TOOL_VALIDATOR_PATTERN

# Traefik
TOOL_VALIDATOR_PATTERN[traefik]="traefik.*validate|traefik.*healthcheck|traefik.*check"

# nginx
TOOL_VALIDATOR_PATTERN[nginx]="nginx.*-t|nginx.*-T|nginx.*configtest|nginx.*test"

# Kubernetes
TOOL_VALIDATOR_PATTERN[kubernetes]="kubectl.*--dry-run|kubeval|kustomize.*\|.*kubectl|kubectl.*validate"

# Terraform
TOOL_VALIDATOR_PATTERN[terraform]="terraform.*validate|terraform.*plan|tflint"

# Helm
TOOL_VALIDATOR_PATTERN[helm]="helm.*lint|helm.*template"

# Docker Compose
TOOL_VALIDATOR_PATTERN[docker_compose]="docker.*compose.*config|docker-compose.*config"

for tool in "${!TOOL_VALIDATOR_PATTERN[@]}"; do
    PATTERN="${TOOL_VALIDATOR_PATTERN[$tool]}"
    if echo "$WORKFLOW_CORPUS" | grep -qiE "$PATTERN"; then
        TOOL_VALIDATOR_FOUND[$tool]="YES"
        FOUND_IN=$(grep -liE "$PATTERN" $WORKFLOW_FILES 2>/dev/null | head -3 | tr '\n' ', ')
        echo "OK: $tool validator found in: $FOUND_IN"
    else
        TOOL_VALIDATOR_FOUND[$tool]="NO"
        echo "GAP: No $tool validation step found in any CI workflow"
    fi
done
```

### 2C: Check validator placement

A validation step that runs only in a deployment workflow (not in the CI workflow that runs on every PR) provides partial coverage — config errors reach `main` undetected if the deploy-only validator only runs at deploy time.

```bash
CI_WORKFLOW=$(ls "$WORKFLOW_DIR/ci.yml" "$WORKFLOW_DIR/test.yml" "$WORKFLOW_DIR/build.yml" 2>/dev/null | head -1)

if [ -n "$CI_WORKFLOW" ]; then
    echo "=== Checking validator placement (CI workflow: $CI_WORKFLOW) ==="
    for tool in "${!TOOL_VALIDATOR_FOUND[@]}"; do
        if [ "${TOOL_VALIDATOR_FOUND[$tool]}" = "YES" ]; then
            PATTERN="${TOOL_VALIDATOR_PATTERN[$tool]}"
            if grep -qiE "$PATTERN" "$CI_WORKFLOW" 2>/dev/null; then
                echo "OK: $tool validator is in the CI workflow (runs on every PR)"
            else
                echo "PLACEMENT GAP: $tool validator exists but is NOT in $CI_WORKFLOW — it may only run at deploy time, missing PR-time validation"
            fi
        fi
    done
fi
```

---

## Phase 3: File Issues for Gaps

For each gap detected (tool present in repo but no CI validation step found), file a GitHub issue.

**Skip issue creation if `--dry-run` flag is passed** (or `forge.yaml → ci_audit.dry_run: true`):
```bash
DRY_RUN=$(yq '.ci_audit.dry_run // "false"' forge.yaml 2>/dev/null || echo "false")
[ "$1" = "--dry-run" ] || [ "$2" = "--dry-run" ] && DRY_RUN="true"
```

### 3A: Determine validator recommendation

For each gap, compose a concrete, version-aware recommendation:

```bash
get_validator_recommendation() {
    local tool="$1"
    local version="$2"  # may be empty if unknown

    case "$tool" in
        traefik)
            if [ "${version%%.*}" = "3" ] || echo "$version" | grep -q "^v3"; then
                echo "Add a CI step that runs: \`docker run --rm -v \$(pwd)/traefik:/etc/traefik traefik:v${version:-3} validate\`"
                echo "Traefik v3 schema differs from v2 — the validator must use the same version as production."
            else
                echo "Add a CI step that runs: \`docker run --rm -v \$(pwd)/traefik:/etc/traefik traefik:v${version:-2} validate --configFile=/etc/traefik/traefik.yml\`"
            fi
            ;;
        nginx)
            echo "Add a CI step that runs: \`docker run --rm -v \$(pwd)/infra/nginx:/etc/nginx nginx:${version:-alpine} nginx -t\`"
            ;;
        kubernetes)
            echo "Add a CI step that runs: \`kubectl apply --dry-run=client -f k8s/\` (requires \`kubectl\` in CI environment, no cluster needed for client-side validation)"
            ;;
        terraform)
            echo "Add CI steps that run: (1) \`terraform init -backend=false\` then (2) \`terraform validate\`. Optionally add \`tflint\` for schema linting beyond what terraform validate catches."
            ;;
        helm)
            echo "Add a CI step that runs: \`helm lint ./chart\` (or the path to your chart directory)"
            ;;
        docker_compose)
            if [ "${version%%.*}" = "2" ]; then
                echo "Add a CI step that runs: \`docker compose config\` (validates compose file structure and interpolation)"
            else
                echo "Add a CI step that runs: \`docker-compose config\` (validates compose file structure and interpolation)"
            fi
            ;;
    esac
}
```

### 3B: Create issues for gaps

For each tool with `TOOL_VALIDATOR_FOUND[$tool] = "NO"`:

```bash
for tool in "${!TOOL_VALIDATOR_FOUND[@]}"; do
    if [ "${TOOL_VALIDATOR_FOUND[$tool]}" = "NO" ]; then
        TOOL_VERSION=$(yq ".review.tool_versions.${tool} // \"\"" forge.yaml 2>/dev/null || echo "")
        RECOMMENDATION=$(get_validator_recommendation "$tool" "$TOOL_VERSION")
        VERSION_NOTE=""
        [ -n "$TOOL_VERSION" ] && VERSION_NOTE="**Declared version**: \`$tool $TOOL_VERSION\`" || VERSION_NOTE="**Version**: Unknown — declare in \`forge.yaml → review.tool_versions.$tool\` for version-aware validation"

        ISSUE_BODY="## Problem

The project uses \`$tool\` (config files present in repo) but the CI pipeline has no structural validation step for \`$tool\` config files. Structural config errors (wrong nesting, missing required keys, version-incompatible syntax) are therefore not caught before merge or deploy.

**Upstream incident**: This CI gap was identified via \`/ci-audit\` following incident analysis showing that review agents verify logical correctness (coherent values, naming consistency, cross-file wiring) but cannot substitute for deterministic structural validators. <!-- Added: forge#1104 -->

## Root Cause

**Failure pattern**: The \`$tool\` validator has not been added to CI. Config changes are reviewed for logical correctness by the INFRA review agent but structural correctness (schema conformance) is not deterministically checked before merge.

**Separation of concerns**:
- ForgeDock review agents: verify logical correctness (architecture, wiring, security)
- CI validators: verify structural correctness (schema conformance, tool version compatibility)

Both layers are required. This issue tracks the CI layer gap.

## Affected Files

Files to be identified during investigation:
1. \`.github/workflows/ci.yml\` (or equivalent) — add validation step
2. \`$tool/\` config directory — files to be validated

## Expected Behavior

Every PR that changes \`$tool\` config files triggers a CI step that runs the \`$tool\` validator. Structural errors (wrong YAML nesting, missing required keys, version-incompatible syntax) are caught before merge — not after deploy.

## Acceptance Criteria

- [ ] A CI step runs \`$tool\` structural validation on every PR that changes \`$tool\` config files
- [ ] The CI step uses the same \`$tool\` version as production (version-pinned)
- [ ] The CI step runs in the PR-time workflow (not only at deploy time)
- [ ] Validation failure blocks merge
- [ ] No regression in existing CI workflows

## Recommendation

${RECOMMENDATION}

${VERSION_NOTE}

**Where to add**: Add the validation step to the CI workflow that runs on every PR (\`ci.yml\` or equivalent), not only the deploy workflow. A validator that only runs at deploy time allows structural errors to merge to \`staging\` undetected.

**Implementation**: File this issue → \`/work-on\` pipeline → builder adds the CI step → review verifies version pinning and trigger conditions → merge.

## Severity

**P2** — Structural config errors are silently ignored by the tool at runtime. A project without a \`$tool\` validator in CI will ship broken configs whenever a config refactor changes YAML nesting. The failure mode is silent and only surfaces at deploy time (or not at all, if the tool silently ignores the misconfiguration)."

        if [ "$DRY_RUN" = "true" ]; then
            echo "=== DRY RUN: Would create issue for $tool CI gap ==="
            echo "Title: ci($tool): add structural config validation step to CI pipeline"
            echo "Body:"
            echo "$ISSUE_BODY"
            echo "Labels: bug,P2,audit-finding"
        else
            CREATED_ISSUE=$(gh issue create $GH_FLAG \
                --title "ci($tool): add structural config validation step to CI pipeline" \
                --body "$ISSUE_BODY" \
                --label "bug,P2,audit-finding" 2>&1)
            echo "Created issue for $tool gap: $CREATED_ISSUE"
        fi
    fi
done
```

### 3C: Handle placement gaps

For each tool whose validator exists but is only in the deploy workflow (not in the CI workflow):

```bash
# (Populated in Phase 2C)
for tool in "${!PLACEMENT_GAPS[@]}"; do
    TOOL_VERSION=$(yq ".review.tool_versions.${tool} // \"\"" forge.yaml 2>/dev/null || echo "")

    ISSUE_BODY="## Problem

The project has a \`$tool\` validation step in CI, but it only runs in the deployment workflow — not in the PR-time CI workflow. This means structural config errors in \`$tool\` configs can merge to \`staging\` undetected and only surface during deployment.

## Root Cause

**Failure pattern**: Validator placement is deploy-time only. PRs that introduce structural config errors pass all checks and merge normally. The error is only caught when the deploy pipeline runs.

## Acceptance Criteria

- [ ] The \`$tool\` validation step runs in the PR-time CI workflow (\`ci.yml\` or equivalent)
- [ ] Validation failure blocks merge (not just alerts)
- [ ] No regression in the existing deploy-time validation

## Severity

**P3** — Partial coverage. Structural errors are caught at deploy time but not at PR time, creating a window where broken configs exist on \`staging\` until a deploy is attempted."

    if [ "$DRY_RUN" = "true" ]; then
        echo "=== DRY RUN: Would create placement issue for $tool ==="
    else
        gh issue create $GH_FLAG \
            --title "ci($tool): move config validation to PR-time CI workflow" \
            --body "$ISSUE_BODY" \
            --label "bug,P3,audit-finding" 2>&1
    fi
done
```

---

## Phase 4: Post Audit Summary

```bash
gh issue comment $(gh issue list $GH_FLAG --search "ci-audit" --limit 1 --json number --jq '.[0].number // ""' 2>/dev/null || echo "") $GH_FLAG --body "## CI Audit Summary

**Audit date**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
**Stack audited**: ${TECH_STACK:-"(no tech_stack declared in forge.yaml)"}

### Results

| Tool | Config Files Found | CI Validator Found | Placement | Issues Filed |
|------|--------------------|-------------------|-----------|-------------|
$(for tool in "${!TOOL_VALIDATOR_FOUND[@]}"; do
    CONFIG_FOUND=$([ -n "${TOOL_CONFIG_FOUND[$tool]}" ] && echo "Yes" || echo "No")
    VALIDATOR="${TOOL_VALIDATOR_FOUND[$tool]:-NO}"
    PLACEMENT="${TOOL_PLACEMENT[$tool]:-"N/A"}"
    echo "| $tool | $CONFIG_FOUND | $VALIDATOR | $PLACEMENT | (see above) |"
done)

### Actions Required

$([ -n "$(for t in "${!TOOL_VALIDATOR_FOUND[@]}"; do [ "${TOOL_VALIDATOR_FOUND[$t]}" = "NO" ] && echo "$t"; done)" ] && \
    echo "Issues filed for: $(for t in "${!TOOL_VALIDATOR_FOUND[@]}"; do [ "${TOOL_VALIDATOR_FOUND[$t]}" = "NO" ] && echo "$t"; done | tr '\n' ' ')" || \
    echo "No CI gaps found — all detected stack components have CI validators.")

### Next Steps

1. Run \`/work-on\` on each filed issue to implement the CI validation step
2. Re-run \`/ci-audit\` after implementation to verify gaps are closed
3. Add \`forge.yaml → review.tool_versions\` entries for any tools whose version was marked Unknown
" 2>/dev/null || echo "Audit complete. Summary printed above (no issue to comment on in dry-run mode)."
```

Print the summary to stdout regardless:

```bash
echo ""
echo "=== /ci-audit Complete ==="
echo "Stack: ${TECH_STACK:-"(no tech_stack declared)"}"
echo "Workflows audited: $(echo $WORKFLOW_FILES | tr ' ' '\n' | wc -l | tr -d ' ')"
echo "Tools with config files: $(echo "${!TOOL_CONFIG_FOUND[@]}" | wc -w | tr -d ' ')"
echo "CI gaps found: $(for t in "${!TOOL_VALIDATOR_FOUND[@]}"; do [ "${TOOL_VALIDATOR_FOUND[$t]}" = "NO" ] && echo "$t"; done | wc -w | tr -d ' ')"
echo ""
echo "Issues filed:"
echo "${ISSUES_FILED:-"  (none — dry-run or no gaps)"}"
```

---

## Error Handling

- **`forge.yaml` missing**: Stop and tell the user to run `npx forgedock init`
- **No stack declared** (`TECH_STACK` empty and `TOOL_VERSIONS` empty): Print advisory — "No tech stack declared in forge.yaml. Add `review.tech_stack` or `review.tool_versions` to enable stack-aware CI auditing." Do not file issues.
- **No config files found for a declared tool**: Skip that tool's CI audit — presence in `TECH_STACK` without actual config files may mean the project is in the process of adopting the tool, not that CI is missing a validator.
- **No GitHub Actions workflows found**: File a single high-severity issue: "Project has no CI — all stack components lack automated validation."
- **`gh` auth failure**: Print `gh auth status` output and stop.
