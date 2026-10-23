#!/usr/bin/env bash
# review-prepare.sh — deterministic review-pr preparation (Phases 1-3B plus the 3C delta-mode and diff-slice steps).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One self-contained shell: it re-derives every value it uses (no helper or variable is defined in one place and consumed in
# another), resolves ForgeDock's own helpers through forge_resolve (FORGEDOCK_HOME / plugin root / FORGE_ROOT / plugin cache; the
# working directory and the PR checkout are NEVER a script source), and treats everything author-controlled (PR title/body, comments,
# the PR checkout, a SPEC_CLI persona file, forge.yaml paths.root) as data.
#
# Usage: review-prepare.sh --pr N --repo owner/name [--merge-issue N] [--thorough true|false] [--out FILE] [--out-dir DIR]
#                          [--checkout-pr] [--no-delta] [--delta-from SHA] [--build-gate block|advisory]
#   --pr            PR number (numeric, required)          --repo        owner/name (required)
#   --merge-issue   issue the PR closes, from --issue (numeric; non-numeric is ignored)
#   --thorough      true restores the full-union roster    --out         write the context JSON here (default: stdout)
#   --out-dir       directory for per-domain diff slices, named slice-<sha7>-<domain>.diff (default: ${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}/review-prepare-<pr>)
#   --checkout-pr   `git checkout -f --detach <review sha>` in the CURRENT repo (must be a throwaway review checkout, never the
#                   main checkout); the recorded original ref is restored by restore_ref on every exit path
#   --build-gate    block (default): an empty trusted typescript.build / python.format on a full-build lane BLOCKs.
#                   advisory: record it as a SKIPPED Phase 2 finding instead (review-pr-staging: the deploy review only ever
#                   reported "SKIPPED — typescript.build not configured", and blocking it would stop every deploy of a repo
#                   with plain .js files and no build command, ForgeDock itself included).
#   --no-delta      skip the FULL/DELTA/BASE_SYNC_ONLY resolver: the review mode is always FULL (a staging bundle review always reviews the
#                   whole bundle), without widening the roster to the full union the way --thorough does; it also enables the pinned
#                   local-git diff fallback when `gh pr diff` fails (e.g. HTTP 406 over 20,000 lines), which a milestone->staging PR gets without it
#   --delta-from    explicit DELTA from a caller-supplied earlier reviewed head (forge#4360, `forgedock review-staging --delta`): skips the
#                   resolver (even with --no-delta), narrows diff, slices and roster to SHA..review sha (the roster is the domains the delta
#                   files touch). BLOCKED when SHA is not a full commit id in the checkout, equals or is not an ancestor of the review sha,
#                   or has no trusted FORGE:REVIEW-AGENT body with `Reviewed-SHA: SHA` (no earlier pass to credit). An empty file delta
#                   is FULL. Not combinable with --thorough true (exit 2).
# Env: FORGE_CONFIG (forge.yaml path; default: the main checkout's forge.yaml, then the git top-level one),
#      REVIEW_PREPARE_SLEEP (seconds between mergeability retries, default 5),
#      REVIEW_PREPARE_INDEX_TIMEOUT (seconds the code-index build may take, default 120; on timeout or failure the slices say
#      "Code index not available" and agents grep instead — forge#4126).
# Exit: 0 context emitted (status OK) | 3 context emitted with status BLOCKED (the caller must stop, never skip) | 2 usage error
#
# Moved from the spec and still in the spec (the caller keeps running them): Phase 2 lint/typecheck/test/build EXECUTION (long-running,
# needs the throwaway worktree), Phase 3B.5 provenance trust escalation, the FORGE:REVIEW_TIER comment and the carry-record post.
#
# Behavior changes vs the prose fences (intentional, documented in the issue): (1) an empty trusted typescript.build / python.format on a
# full-build lane (staging->main or milestone->staging) is BLOCKED, not SKIPPED; (2) forge.yaml is loaded BEFORE the roster, so
# review.domains.scraping gates scraping on the first pass; (3) an absent yq key is empty, never the literal string "null"; (4) the
# contract comment is read through scripts/trusted-comments.sh; (5) the ISSUE_NUM extraction is numeric-validated (lib/pr-issue-number.sh).
#
# Context JSON on stdout / --out (schema_version 1):
#   schema_version  1
#   status          "OK" | "BLOCKED";  blockers: [string] (non-empty iff BLOCKED)
#   pr              {number, repo, title, author, head_ref, base_ref, review_sha, review_sha_short, additions, deletions,
#                    changed_files, first_time_contributor}
#   lane            {is_staging_to_main, is_milestone_to_staging, requires_full_build, thorough}
#   merge_health    {mergeable: MERGEABLE|CONFLICTING|UNKNOWN, state: CLEAN|DIRTY|BLOCKED|UNSTABLE|UNKNOWN, retries}
#   classification  {services: [..], domains: [..]}
#   phase2          {build_config: {typescript_build, python_format, status}, findings: [string]}   (2D env, 2E secrets, 2F sql)
#   broken_assumptions [string]   (Phase 2.5 verify-*.sh BLOCKING/WARNING lines and the sibling-workflow drift check)
#   risk_signals    [string];  churn_context: string;  churn_escalation: bool;  danger_zone: bool
#   scores          {AUTH, BILLING, CONCURRENCY, DATABASE, INFRA, SECURITY, SCRAPING, FRONTEND, API}
#   contract        {issue: N|null, flags: string}
#   roster          {tier, reason, agents: [canonical marker domains]}   (the effective roster; [] for BASE_SYNC_ONLY)
#   delta           {mode: FULL|DELTA|BASE_SYNC_ONLY, from, carried_from, full_rounds, files: [string]}
#   config          {project_name, project_context, domains: {auth, billing, ...}, scraping_configured, repo_path}
#   templates       {source, base, monolithic_catalog}
#   index_slices    {auth, billing, database, api, frontend, infrastructure}: "Domain files (...): ..." strings
#   slices          {<canonical domain>: {paths: [string], diff_file: path}}   (diffs live in files, never inline; capped at 100K chars)
#   full_files      [string]   the whole PR file list (context under DELTA)
# Bash 3.2 portable (no mapfile, associative arrays, grep -P).

set -u

PR_NUMBER=""; REPO=""; MERGE_ISSUE=""; THOROUGH="false"; OUT=""; OUT_DIR=""; CHECKOUT_PR="false"; NO_DELTA="false"; BUILD_GATE="block"; DELTA_FROM_OPT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --pr|--repo|--merge-issue|--thorough|--out|--out-dir|--delta-from)
            [ $# -ge 2 ] || { echo "review-prepare: $1 requires a value" >&2; exit 2; } ;;
    esac
    case "$1" in
        --pr) PR_NUMBER="${2:-}"; shift 2 ;;
        --repo) REPO="${2:-}"; shift 2 ;;
        --merge-issue) MERGE_ISSUE="${2:-}"; shift 2 ;;
        --thorough) THOROUGH="${2:-false}"; shift 2 ;;
        --out) OUT="${2:-}"; shift 2 ;;
        --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
        --checkout-pr) CHECKOUT_PR="true"; shift ;;
        --no-delta) NO_DELTA="true"; shift ;;
        --delta-from) DELTA_FROM_OPT="${2:-}"; [ -n "$DELTA_FROM_OPT" ] || DELTA_FROM_OPT="-"; shift 2 ;;
        --build-gate) case "${2:-}" in block|advisory) BUILD_GATE="$2" ;; *) echo "review-prepare: --build-gate must be block or advisory" >&2; exit 2 ;; esac; shift 2 ;;
        *) echo "review-prepare: unknown argument: $1" >&2; exit 2 ;;
    esac
done
case "$PR_NUMBER" in ''|*[!0-9]*) echo "review-prepare: --pr must be numeric" >&2; exit 2 ;; esac
case "$REPO" in */*) ;; *) echo "review-prepare: --repo must be owner/name" >&2; exit 2 ;; esac
case "$REPO" in *[!A-Za-z0-9._/-]*|*/*/*|/*|*/) echo "review-prepare: invalid --repo" >&2; exit 2 ;; esac
case "$MERGE_ISSUE" in *[!0-9]*) MERGE_ISSUE="" ;; esac
[ "$THOROUGH" = "true" ] || THOROUGH="false"
if [ -n "$DELTA_FROM_OPT" ] && [ "$THOROUGH" = "true" ]; then echo "review-prepare: --delta-from cannot be combined with --thorough true" >&2; exit 2; fi

# --- trusted helper resolution (install roots only; never cwd) ---
# shellcheck source=/dev/null  # the resolver lib is found at runtime in the trusted install root
type forge_resolve >/dev/null 2>&1 || { setopt nonomatch 2>/dev/null || true; _SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"; for _r in "$(cygpath -u "${FORGEDOCK_HOME:-}" 2>/dev/null || printf %s "${FORGEDOCK_HOME:-}")" "${CLAUDE_PLUGIN_ROOT:-}" "${FORGE_ROOT:-}" "${FORGE_HOME:-}" "$(readlink -f "$HOME/.claude/commands/work-on.md" 2>/dev/null | sed 's|/commands/work-on\.md$||')" "$(head -n 1 "${CODEX_HOME:-$HOME/.codex}/forge-home" 2>/dev/null)" "$HOME/.claude/plugins/marketplaces/forgedock" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/forgedock/forgedock/* "$HOME/.claude"/plugins/cache/forgedock/forgedock/* "$_SELF_ROOT"; do case "$_r" in /*) [ -f "$_r/scripts/lib/forge-resolve.sh" ] && { . "$_r/scripts/lib/forge-resolve.sh"; break; };; esac; done; type forge_resolve >/dev/null 2>&1 || forge_resolve() { :; }; }

ROSTER_SCRIPT=$(forge_resolve review-roster.sh)
TRUSTED_SCRIPT=$(forge_resolve trusted-comments.sh)
# shellcheck disable=SC2034  # read by lib/review-delta-mode.sh (sourced below)
REVIEW_DELTA_SCRIPT=$(forge_resolve review-delta.sh)
CODE_INDEX_SCRIPT=$(forge_resolve code-index.sh)
_l=$(forge_resolve lib/pr-issue-number.sh)
# shellcheck source=/dev/null  # resolved at runtime from the trusted install root
if [ -n "$_l" ]; then . "$_l"; else pr_issue_number() { return 0; }; fi
_l=$(forge_resolve lib/review-template-resolve.sh)
# shellcheck source=/dev/null  # resolved at runtime from the trusted install root
if [ -n "$_l" ]; then . "$_l"; else review_template_resolve() { TEMPLATE_BASE=""; TEMPLATE_SOURCE="none"; MONOLITHIC_CATALOG=""; }; fi
_l=$(forge_resolve lib/review-delta-mode.sh)
# shellcheck source=/dev/null disable=SC2329  # resolved at runtime; the fallback stubs mirror the lib's API
if [ -n "$_l" ]; then . "$_l"; else review_delta_mode() { echo "FULL - 0"; }; carry_verified_from() { :; }; fi

# --- state, scratch and the ref-restore guard ---
BLOCKERS=""
block() { BLOCKERS="${BLOCKERS}${1}"$'\n'; }
[ -n "$OUT_DIR" ] || OUT_DIR="${FORGE_SCRATCHPAD:-$PWD/.forge-scratch}/review-prepare-${PR_NUMBER}"
mkdir -p "$OUT_DIR" 2>/dev/null || { echo "review-prepare: cannot create $OUT_DIR" >&2; exit 2; }
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/review-prepare.XXXXXX") || exit 2
ORIG_REF=""; CHECKED_OUT=""
# restore_ref: put the checkout back exactly where it was. -f so a dirty review checkout can never wedge the restore.
# shellcheck disable=SC2329  # called from cleanup (EXIT trap) and the checkout paths
restore_ref() {
    if [ -n "$CHECKED_OUT" ] && [ -n "$ORIG_REF" ]; then
        git checkout -f "$ORIG_REF" >/dev/null 2>&1 || echo "review-prepare: WARNING could not restore $ORIG_REF" >&2
    fi
    CHECKED_OUT=""
}
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() { restore_ref; rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# --- Phase 1A: fetch ---
PR_INFO=$(gh pr view "$PR_NUMBER" -R "$REPO" --json number,title,author,baseRefName,headRefName,headRefOid,isCrossRepository,additions,deletions,changedFiles,labels 2>/dev/null) || PR_INFO=""
printf '%s' "$PR_INFO" | jq -e . >/dev/null 2>&1 || PR_INFO=""
if [ -z "$PR_INFO" ]; then block "gh pr view failed for #${PR_NUMBER}"; fi
pj() { printf '%s' "$PR_INFO" | jq -r "$1 // empty" 2>/dev/null; }
TITLE=$(pj .title); PR_AUTHOR=$(pj .author.login); HEAD=$(pj .headRefName); BASE=$(pj .baseRefName)
REVIEW_SHA=$(pj .headRefOid); REVIEW_SHA_SHORT=$(printf '%s' "$REVIEW_SHA" | cut -c1-7)
ADDITIONS=$(pj .additions); DELETIONS=$(pj .deletions); NFILES=$(pj .changedFiles)
case "$ADDITIONS" in ''|*[!0-9]*) ADDITIONS=0 ;; esac; case "$DELETIONS" in ''|*[!0-9]*) DELETIONS=0 ;; esac
case "$NFILES" in ''|*[!0-9]*) NFILES="" ;; esac
LINES=$((ADDITIONS + DELETIONS))
[ -z "$PR_INFO" ] || [ -n "$REVIEW_SHA" ] || block "could not read the PR head SHA"

# Lane (the router already diverted staging->main; these gate the diff fallback, the full-build check and the roster).
IS_STAGING_TO_MAIN="false"; [ "$HEAD" = "staging" ] && [ "$BASE" = "main" ] && IS_STAGING_TO_MAIN="true"
IS_MILESTONE_TO_STAGING="false"; case "$HEAD" in milestone/*) [ "$BASE" = "staging" ] && IS_MILESTONE_TO_STAGING="true" ;; esac
REQUIRES_FULL_BUILD="false"
{ [ "$IS_STAGING_TO_MAIN" = "true" ] || [ "$IS_MILESTONE_TO_STAGING" = "true" ]; } && REQUIRES_FULL_BUILD="true"

FILES=""; DIFF=""
if [ -z "$BLOCKERS" ]; then
    FILES=$(gh pr diff "$PR_NUMBER" -R "$REPO" --name-only 2>/dev/null) || FILES="__FAILED__"
    [ "$FILES" = "__FAILED__" ] || DIFF=$(gh pr diff "$PR_NUMBER" -R "$REPO" 2>/dev/null) || FILES="__FAILED__"
    if [ "$FILES" = "__FAILED__" ]; then
        # A staging bundle or a milestone->staging PR can exceed the API's diff size limit: read it from the long-lived branches instead
        # (--no-delta or the milestone lane only, both always FULL; any other per-PR review blocks — forge#4154).
        FILES=""; DIFF=""
        # Pinned (forge#3935): same-repo PRs only (a fork's branch name resolves to origin's own branch), and the fetched tip must equal REVIEW_SHA; the diff is taken against REVIEW_SHA, never the branch name.
        if { [ "$NO_DELTA" = "true" ] || [ "$IS_MILESTONE_TO_STAGING" = "true" ]; } && [ -n "$BASE" ] && [ -n "$HEAD" ] && [ "$(printf '%s' "$PR_INFO" | jq -r .isCrossRepository 2>/dev/null)" = "false" ] && printf '%s' "$REVIEW_SHA" | grep -qE '^[0-9a-f]{40}$' \
           && git fetch -q origin "$BASE" "$HEAD" 2>/dev/null && [ "$(git rev-parse -q --verify "refs/remotes/origin/${HEAD}^{commit}" 2>/dev/null)" = "$REVIEW_SHA" ]; then
            # shellcheck disable=SC2015  # either assignment failing resets both, by design
            FILES=$(git diff --name-only "origin/${BASE}...${REVIEW_SHA}" 2>/dev/null) && DIFF=$(git diff "origin/${BASE}...${REVIEW_SHA}" 2>/dev/null) || { FILES=""; DIFF=""; }
        fi
        [ -n "$FILES" ] || block "gh pr diff failed"
    fi
    [ -n "$FILES" ] || [ -n "$BLOCKERS" ] || block "PR #${PR_NUMBER} has an empty file list"
fi

# Mergeability: GitHub computes it asynchronously; retry up to 3x on UNKNOWN.
merge_health() { gh pr view "$PR_NUMBER" -R "$REPO" --json mergeable,mergeStateStatus --jq '"\(.mergeable)|\(.mergeStateStatus)"' 2>/dev/null || echo "UNKNOWN|UNKNOWN"; }
MH=$(merge_health); MERGE_HEALTH=${MH%%|*}; MERGE_HEALTH_STATE=${MH##*|}; MERGE_RETRY=0
while [ "$MERGE_HEALTH" = "UNKNOWN" ] && [ "$MERGE_RETRY" -lt 3 ]; do
    MERGE_RETRY=$((MERGE_RETRY + 1)); sleep "${REVIEW_PREPARE_SLEEP:-5}"
    MH=$(merge_health); MERGE_HEALTH=${MH%%|*}; MERGE_HEALTH_STATE=${MH##*|}
done
case "$MERGE_HEALTH" in MERGEABLE|CONFLICTING|UNKNOWN) ;; *) MERGE_HEALTH="UNKNOWN" ;; esac
case "$MERGE_HEALTH_STATE" in CLEAN|DIRTY|BLOCKED|UNSTABLE|HAS_HOOKS|BEHIND|DRAFT|UNKNOWN) ;; *) MERGE_HEALTH_STATE="UNKNOWN" ;; esac

# First-time contributor (consumed by Phase 9): no prior merged PR by this author.
IS_FIRST_TIME_CONTRIBUTOR="false"
if [ -n "$PR_AUTHOR" ]; then
    PRIOR_MERGED_COUNT=$(gh pr list -R "$REPO" --author "$PR_AUTHOR" --state merged --limit 1 --json number --jq 'length' 2>/dev/null || echo "1")
    case "$PRIOR_MERGED_COUNT" in ''|*[!0-9]*) PRIOR_MERGED_COUNT=1 ;; esac
    [ "$PRIOR_MERGED_COUNT" -eq 0 ] && IS_FIRST_TIME_CONTRIBUTOR="true"
fi

# --- optional PR checkout (throwaway review checkout only) ---
if [ "$CHECKOUT_PR" = "true" ] && [ -z "$BLOCKERS" ]; then
    ORIG_REF=$(git symbolic-ref -q --short HEAD 2>/dev/null || git rev-parse HEAD 2>/dev/null || echo "")
    git fetch origin "pull/${PR_NUMBER}/head" >/dev/null 2>&1
    if git checkout -f --detach "$REVIEW_SHA" >/dev/null 2>&1; then CHECKED_OUT="1"; else block "could not check out review SHA ${REVIEW_SHA_SHORT}"; fi
fi

# --- config load (BEFORE scoring and the roster) ---
TOP=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
_gcd=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")
MAIN_ROOT=""; [ -n "$_gcd" ] && MAIN_ROOT=$(cd "$_gcd/.." 2>/dev/null && pwd || echo "")
CONFIG_FILE="${FORGE_CONFIG:-}"
if [ -z "$CONFIG_FILE" ]; then
    for _c in "$MAIN_ROOT/forge.yaml" "$TOP/forge.yaml"; do [ -f "$_c" ] && { CONFIG_FILE="$_c"; break; }; done
fi
CONFIG_READABLE="false"; [ -n "$CONFIG_FILE" ] && [ -f "$CONFIG_FILE" ] && CONFIG_READABLE="true"
cfg() { [ "$CONFIG_READABLE" = "true" ] || return 0; yq "$1 // \"\"" "$CONFIG_FILE" 2>/dev/null || true; }
PROJECT_NAME=$(cfg .project.name); [ -n "$PROJECT_NAME" ] || PROJECT_NAME="this project"
PROJECT_CONTEXT=$(cfg .review.context)
DOMAIN_CONTEXT_AUTH=$(cfg .review.domains.auth); DOMAIN_CONTEXT_BILLING=$(cfg .review.domains.billing)
DOMAIN_CONTEXT_CONCURRENCY=$(cfg .review.domains.concurrency); DOMAIN_CONTEXT_INFRA=$(cfg .review.domains.infra)
DOMAIN_CONTEXT_DATABASE=$(cfg .review.domains.database); DOMAIN_CONTEXT_FRONTEND=$(cfg .review.domains.frontend)
DOMAIN_CONTEXT_SECURITY=$(cfg .review.domains.security); DOMAIN_CONTEXT_API=$(cfg .review.domains.api)
DOMAIN_CONTEXT_SCRAPING=$(cfg .review.domains.scraping)   # also gates spawning the scraping agent
REPO_PATH=$(cfg .paths.root); [ -n "$REPO_PATH" ] || REPO_PATH="${TOP:-$PWD}"   # data only: the index target, never a script source

# --- Phase 1B: classify ---
SERVICES=""; DOMAINS=""
svc() { printf '%s\n' "$FILES" | grep -qE "$2" && SERVICES="$SERVICES $1"; }
dom_f() { printf '%s\n' "$FILES" | grep -qE "$2" && DOMAINS="$DOMAINS $1"; }
dom_d() { printf '%s\n' "$DIFF" | grep -qE "$2" && DOMAINS="$DOMAINS $1"; }
svc API "(^services/api/|/api/|/backend/)"; svc WORKER "(^services/worker/|/worker/|/jobs/|/tasks/)"
svc WEB "(^web/|/frontend/|/app/|\.tsx?$|\.jsx?$)"; svc SHARED "(^shared/|/shared/|/common/|/lib/)"
svc INFRA "^(docker|infra/|\.github|Makefile|traefik|k8s/|terraform/)"
dom_d AUTH "get_current_user|jwt|oauth|login|logout|require_auth|authenticated_user|x.forwarded.for|x_forwarded_for|forwarded_for|rate.limit.*ip|ip.*rate.limit|algorithm.*HS256|algorithm.*RS256|NEXTAUTH_SECRET|JWT_SECRET"
dom_d BILLING "credit|balance|debit|reconcil|pricing|charge|refund|stripe|subscription|payment"
dom_d SCRAPING "scrape|tier.*escalat|anti_bot|stealth|playwright.*scrape|scrape.*playwright|playbook_min_tier|browser.*pool|proxy.*scrape|web.*scrape"
dom_d CONCURRENCY "FOR UPDATE|atomic|transaction|pipeline|MULTI|distributed_lock|acquire_lock|reserved_by|promo.*claim|voucher.*redeem"
dom_f DATABASE "migration|\.sql$"
dom_d DB_CONFIG "create_async_engine|AsyncSession|connect_args|pool_size|prepared_statement|engine_from_config|sessionmaker"
dom_f API_DESIGN "router|routes"

# --- Phase 2: read-only checks + the trusted full-build config gate ---
P2_FINDINGS=""
p2() { P2_FINDINGS="${P2_FINDINGS}${1}"$'\n'; }
HAS_TS=$(printf '%s\n' "$FILES" | grep -E '\.(tsx?|jsx?)$' | head -1)
HAS_PY=$(printf '%s\n' "$FILES" | grep -E '\.py$' | head -1)
TS_BUILD=$(cfg .verification.commands.typescript.build); PY_FORMAT=$(cfg .verification.commands.python.format)
BUILD_CONFIG_STATUS="not_required"
if [ "$REQUIRES_FULL_BUILD" = "true" ]; then
    BUILD_CONFIG_STATUS="ok"
    if [ "$CONFIG_READABLE" != "true" ]; then
        BUILD_CONFIG_STATUS="blocked"; block "full-build lane but no readable trusted forge.yaml (checked FORGE_CONFIG, the main checkout and the git top-level)"
    else
        if [ "$BUILD_GATE" = "advisory" ]; then
            if [ -n "$HAS_TS" ] && [ -z "$TS_BUILD" ]; then BUILD_CONFIG_STATUS="skipped"; p2 "1B: SKIPPED — typescript.build not configured in verification.commands (build not run)"; fi
            if [ -n "$HAS_PY" ] && [ -z "$PY_FORMAT" ]; then BUILD_CONFIG_STATUS="skipped"; p2 "1A: SKIPPED — python.format not configured in verification.commands"; fi
        else
            if [ -n "$HAS_TS" ] && [ -z "$TS_BUILD" ]; then BUILD_CONFIG_STATUS="blocked"; block "BLOCKED: typescript.build is empty in verification.commands on a full-build lane (typecheck alone misses prerender failures)"; fi
            if [ -n "$HAS_PY" ] && [ -z "$PY_FORMAT" ]; then BUILD_CONFIG_STATUS="blocked"; block "BLOCKED: python.format is empty in verification.commands on a full-build lane"; fi
        fi
    fi
fi
# 2D env vars, 2E secrets (CRITICAL), 2F SQL, over the diff text
while IFS= read -r _l; do [ -n "$_l" ] && p2 "2D env: $_l"; done <<EOF2
$(printf '%s\n' "$DIFF" | grep -E "os\.getenv|os\.environ|process\.env" | head -30)
EOF2
while IFS= read -r _l; do [ -n "$_l" ] && p2 "2E secret?: $_l"; done <<EOF2
$(printf '%s\n' "$DIFF" | grep -iE "(api[_-]?key|secret[_-]?key|password|token|credential|private[_-]?key)" | grep -vE "(#|//|\.example|placeholder|PLACEHOLDER|YOUR_|<|>)" | head -20)
EOF2
while IFS= read -r _l; do [ -n "$_l" ] && p2 "2E secret?: high-entropy literal ${_l}"; done <<EOF2
$(printf '%s\n' "$DIFF" | grep -oE "['\"][A-Za-z0-9+/=]{40,}['\"]" | head -10)
EOF2
file_at_head() { git show "${REVIEW_SHA}:${1}" 2>/dev/null || cat "$1" 2>/dev/null || true; }
for f in $(printf '%s\n' "$FILES" | grep '\.sql$'); do
    _c=$(file_at_head "$f"); [ -n "$_c" ] || continue
    printf '%s\n' "$_c" | grep -E "FOR UPDATE" | grep -qE "(SUM|COUNT|AVG|MIN|MAX)\s*\(" && p2 "2F ERROR: FOR UPDATE with aggregate in $f"
    printf '%s\n' "$_c" | grep -qE "DROP (TABLE|COLUMN|INDEX)" && ! printf '%s\n' "$_c" | grep -qE "IF EXISTS" && p2 "2F WARNING: DROP without IF EXISTS in $f"
    printf '%s\n' "$_c" | grep -qE "ALTER TABLE.*ADD COLUMN.*NOT NULL" && ! printf '%s\n' "$_c" | grep -qE "DEFAULT" && p2 "2F WARNING: NOT NULL without DEFAULT in $f"
done

# --- Phase 2.5: integration assumptions (verify-*.sh via the trusted resolver) ---
ASSUMPTIONS=""
asm() { ASSUMPTIONS="${ASSUMPTIONS}${1}"$'\n'; }
printf '%s\n' "$FILES" > "$TMP_DIR/changed.txt"; printf '%s\n' "$DIFF" > "$TMP_DIR/diff.txt"
LAYOUT_PAGES=$(cfg .review.layout.pages); LAYOUT_ROUTERS=$(cfg .review.layout.api_routers_dir); LAYOUT_MAIN=$(cfg .review.layout.api_main); LAYOUT_MW=$(cfg .review.layout.api_middleware_dir)
[ -n "$LAYOUT_PAGES" ] && export FORGE_PAGES_ROOT="$LAYOUT_PAGES"; [ -n "$LAYOUT_ROUTERS" ] && export FORGE_API_ROUTERS_DIR="$LAYOUT_ROUTERS"
[ -n "$LAYOUT_MAIN" ] && export FORGE_API_MAIN="$LAYOUT_MAIN"; [ -n "$LAYOUT_MW" ] && export FORGE_API_MIDDLEWARE_DIR="$LAYOUT_MW"
FORGE_INTERNAL_PATTERNS=""
if [ "$CONFIG_READABLE" = "true" ]; then
    FORGE_INTERNAL_PATTERNS=$(grep -A 999 'internal_service_patterns:' "$CONFIG_FILE" 2>/dev/null | grep -E '^\s*-\s+' | sed 's/^\s*-\s*//' | tr -d "\"'" | awk 'NR>1{printf "|"}{printf "%s", $0}END{print ""}')
fi
export FORGE_INTERNAL_PATTERNS
run_verify() {   # <script name> <args...>; BLOCKING/WARNING lines become broken assumptions
    local name="$1" path out; shift
    path=$(forge_resolve "$name")
    [ -n "$path" ] || { asm "WARNING: ${name} unresolved (trusted install root not found); integration check not run"; return 0; }
    out=$(bash "$path" "$@" 2>&1) || true
    while IFS= read -r _l; do case "$_l" in BLOCKING:*|WARNING:*) asm "${name}: ${_l}" ;; esac; done <<EOF2
$out
EOF2
}
run_verify verify-route-registration.sh "$TMP_DIR/changed.txt" "."
run_verify verify-env-vars.sh "$TMP_DIR/diff.txt" "."
run_verify verify-host-headers.sh "$TMP_DIR/changed.txt" "."
run_verify verify-sops-chain.sh "$TMP_DIR/diff.txt" "$TMP_DIR/changed.txt" "."
# Sibling workflow drift (always for staging->main; otherwise when a workflow file changed)
if { [ "$IS_STAGING_TO_MAIN" = "true" ] || printf '%s\n' "$FILES" | grep -qE "^\.github/workflows/.*\.yml$"; } && [ -f .github/workflows/ci.yml ] && [ -f .github/workflows/deploy-production.yml ]; then
    for JOB in test-api test-web; do
        job_env() { awk -v pat="^  ${JOB}:" 'BEGIN{p=0} $0~pat{p=1; print; next} p && /^  [a-z]/{p=0} p{print}' "$1" 2>/dev/null | grep "PYTHONPATH" | sed 's/^ *//' | sort; }
        CI_PYPATH=$(job_env .github/workflows/ci.yml); DEPLOY_PYPATH=$(job_env .github/workflows/deploy-production.yml)
        [ "$CI_PYPATH" = "$DEPLOY_PYPATH" ] || asm "BLOCKING: PYTHONPATH differs between ci.yml and deploy-production.yml for job '${JOB}'"
    done
fi

# --- Phase 3A: risk signals + churn ---
RISK=""
sig_d() { printf '%s\n' "$DIFF" | grep -qE "$2" && RISK="$RISK $1"; }
sig_d UNTRUSTED_INPUT_PROCESSING "subprocess|exec|eval|system\(|popen|heredoc"; sig_d SHELL_SCRIPT "\.sh$|bash|shell|cron"
sig_d FINANCIAL "credit|balance|debit|charge|refund|stripe"
sig_d AUTH_SENSITIVE "jwt|oauth|password|token|secret|x.forwarded.for|x_forwarded_for|forwarded_for|rate.limit.*ip|ip.*rate.limit|algorithm.*HS256|algorithm.*RS256|NEXTAUTH_SECRET|JWT_SECRET|get_current_user|require_auth"
sig_d DATABASE_MUTATION "\.sql$|migration|DROP|ALTER|DELETE FROM"; sig_d INFRASTRUCTURE "docker|deploy|traefik|nginx|\.yml.*service"
sig_d DATABASE_CONTAINER "docker-compose.*postgres|docker-compose.*redis|postgres.*command:|redis.*command:|image:.*postgres|image:.*redis"
sig_d DB_CONFIG "create_async_engine|AsyncSession|connect_args|pool_size|prepared_statement|engine_from_config|sessionmaker"
sig_d CODE_EXECUTION "subprocess|os\.system|eval\(|exec\(|pickle|yaml\.load[^_]"
printf '%s\n' "$FILES" | grep -qE "^sdk/|openapi.*\.json$|openapi-versions/" && RISK="$RISK SDK_OPENAPI"

CHURN_WINDOW="90 days ago"   # must match architect.md Phase A5
CHURN_CONTEXT=""
DANGER_ZONES_INDEX="${HOME}/.forge/index/danger-zones.json"; DZ_DATA=""
[ -f "$DANGER_ZONES_INDEX" ] && DZ_DATA=$(cat "$DANGER_ZONES_INDEX" 2>/dev/null || true)
while IFS= read -r FILE; do
    [ -z "$FILE" ] && continue
    COMMITS=$(git log --oneline --since="$CHURN_WINDOW" -- "$FILE" 2>/dev/null | wc -l | tr -d ' ')
    COMMIT_TAG=""; [ "${COMMITS:-0}" -ge 15 ] && COMMIT_TAG=" — HOT (${COMMITS} commits/90d)"
    FINDING_TAG=""
    if [ -n "$DZ_DATA" ]; then
        FINDING_COUNT=$(printf '%s' "$DZ_DATA" | jq -r --arg f "$FILE" '.files[$f].findingCount90d // 0' 2>/dev/null || echo 0)
        case "$FINDING_COUNT" in ''|*[!0-9]*) FINDING_COUNT=0 ;; esac
        [ "$FINDING_COUNT" -ge 3 ] && FINDING_TAG=" — HOT-FINDINGS (${FINDING_COUNT} findings/90d)"
    fi
    if [ -n "$COMMIT_TAG" ] || [ -n "$FINDING_TAG" ]; then CHURN_CONTEXT="${CHURN_CONTEXT}${FILE}${COMMIT_TAG}${FINDING_TAG}"$'\n'; fi
done <<< "$FILES"
[ -n "$CHURN_CONTEXT" ] || CHURN_CONTEXT="No hot-spot files detected (all changed files under 15 commits and under 3 findings in the last 90 days)."
CHURN_ESCALATION=false; printf '%s\n' "$CHURN_CONTEXT" | grep -q "HOT" && CHURN_ESCALATION=true
DANGER=false; printf '%s\n' "$CHURN_CONTEXT" | grep -q "HOT-FINDINGS" && DANGER=true

# --- Phase 3B step 1: domain scores ---
SCORE_AUTH=0; SCORE_BILLING=0; SCORE_CONCURRENCY=0; SCORE_DATABASE=0; SCORE_INFRA=0; SCORE_SECURITY=1; SCORE_SCRAPING=0; SCORE_FRONTEND=0; SCORE_API=0
sc_d() { printf '%s\n' "$DIFF" | grep -qE "$2" && eval "$1=\$(( $1 + $3 ))"; }
sc_f() { printf '%s\n' "$FILES" | grep -qE "$2" && eval "$1=\$(( $1 + $3 ))"; }
sc_d SCORE_AUTH "jwt|oauth|login|logout|password|NEXTAUTH_SECRET|JWT_SECRET|auth_token|access_token|refresh_token" 3
sc_d SCORE_AUTH "get_current_user|Depends\(get_|x.forwarded.for|forwarded_for|rate.limit.*ip|ip.*rate.limit" 2
sc_d SCORE_AUTH "algorithm.*HS256|algorithm.*RS256|admin.proxy" 2
sc_d SCORE_BILLING "credit|balance|debit|charge|refund|stripe|subscription" 3
sc_d SCORE_BILLING "pricing|tier_cost|reconcil" 2
sc_d SCORE_CONCURRENCY "FOR UPDATE|atomic|transaction|pipeline|MULTI|distributed_lock|acquire_lock" 3
sc_d SCORE_CONCURRENCY "reserved_by|promo.*claim|voucher.*redeem" 2
sc_f SCORE_DATABASE "migration|\.sql$" 3
sc_d SCORE_DATABASE "DROP|ALTER|DELETE FROM" 2
sc_d SCORE_DATABASE "create_async_engine|AsyncSession|pool_size|prepared_statement|sessionmaker" 2
sc_d SCORE_INFRA "docker-compose.*postgres|docker-compose.*redis|postgres.*command:|redis.*command:" 3
sc_d SCORE_INFRA "docker|deploy|traefik|nginx" 1
sc_f SCORE_INFRA "^\.github/workflows/" 2
sc_f SCORE_INFRA "Dockerfile|docker-compose" 2
sc_d SCORE_SECURITY "subprocess|exec|eval|system\(|popen" 3
sc_d SCORE_SECURITY "os\.system|eval\(|exec\(|pickle|yaml\.load[^_]" 3
sc_d SCORE_SECURITY "\.sh$|bash|shell|cron" 2
sc_d SCORE_SCRAPING "scrape|tier.*escalat|anti_bot|stealth|playwright.*scrape|scrape.*playwright|playbook_min_tier|browser.*pool|web.*scrape" 3
sc_f SCORE_FRONTEND "^web/src/" 1
sc_f SCORE_FRONTEND "^web/src/app/|^web/src/components/" 2
sc_f SCORE_API "router|routes" 2
sc_f SCORE_API "^sdk/|openapi.*\.json$|openapi-versions/" 3

# --- Phase 3B step 2: contract risk flags (trusted authors only) ---
CONTRACT_RISK_FLAGS=""
ISSUE_NUM=$(gh pr view "$PR_NUMBER" -R "$REPO" --json body --jq '.body // ""' 2>/dev/null | pr_issue_number)
case "$ISSUE_NUM" in ''|*[!0-9]*) ISSUE_NUM="" ;; esac
if [ -n "$ISSUE_NUM" ]; then
    CONTRACT_BODY=""; CONTRACT_OK="false"
    if [ -n "$TRUSTED_SCRIPT" ]; then
        # Each stage is checked on its own: in a pipeline `jq -r .` on empty stdin exits 0, so a failed read looked like success.
        # A failed or empty comment read, or a failing trusted-comments run, stays CONTRACT_OK=false (widen, never narrow).
        # A successful read with no trusted contract comment is the deliberate "no contract" case (empty body, no flags).
        if _cc=$(gh api --paginate "repos/${REPO}/issues/${ISSUE_NUM}/comments" 2>/dev/null) && [ -n "$_cc" ] \
           && _cb=$(printf '%s' "$_cc" | bash "$TRUSTED_SCRIPT" bodies 'FORGE:CONTRACT' 2>/dev/null); then
            CONTRACT_OK="true"
            [ -z "$_cb" ] || CONTRACT_BODY=$(printf '%s\n' "$_cb" | head -n 1 | jq -r . 2>/dev/null) || CONTRACT_OK="false"
        fi
    fi
    if [ "$CONTRACT_OK" != "true" ]; then
        CONTRACT_RISK_FLAGS="HIGH_RISK"   # cannot read the contract trust-filtered: widen, never narrow
    else
        printf '%s\n' "$CONTRACT_BODY" | grep -qiE "\*\*Risk\*\*.*HIGH|\*\*Risk\*\*.*CRITICAL|Risk.*:\s*(HIGH|CRITICAL)" && CONTRACT_RISK_FLAGS="HIGH_RISK"
        printf '%s\n' "$CONTRACT_BODY" | grep -qiE "auth|session|jwt" && CONTRACT_RISK_FLAGS="${CONTRACT_RISK_FLAGS} CONTRACT_AUTH"
        printf '%s\n' "$CONTRACT_BODY" | grep -qiE "billing|credit|payment" && CONTRACT_RISK_FLAGS="${CONTRACT_RISK_FLAGS} CONTRACT_BILLING"
        printf '%s\n' "$CONTRACT_BODY" | grep -qiE "migration|schema|database" && CONTRACT_RISK_FLAGS="${CONTRACT_RISK_FLAGS} CONTRACT_DATABASE"
    fi
fi
CONTRACT_RISK_FLAGS="${CONTRACT_RISK_FLAGS# }"

# --- Phase 3B step 4: roster (review-roster.sh; unresolved or failing means the full union) ---
agent_domain() { local l; l=$(printf '%s' "${1}" | tr '[:upper:]' '[:lower:]'); case "$l" in infrastructure) l=infra ;; scraping) l=scraper ;; web) l=frontend ;; esac; printf '%s' "$l"; }
FIX_PR=false; SRC_SEV=""; SRC_DOM=""
# Review depth (forge#3862): latest TRUSTED FORGE:DIFF_SIZE on the merge issue; unreadable or absent stays STANDARD (extended only adds reviewers).
REVIEW_DEPTH=STANDARD; REVIEW_WEIGHT=""
if [ -n "$MERGE_ISSUE" ]; then
    _ds=$(gh api --paginate "repos/$REPO/issues/$MERGE_ISSUE/comments" --jq '[.[] | select(.body | startswith("<!-- FORGE:DIFF_SIZE")) | select((.author_association | IN("OWNER","MEMBER","COLLABORATOR")) or (.user.type == "Bot"))] | last | .body // ""' 2>/dev/null) || _ds=""
    printf '%s\n' "$_ds" | grep -qE '^review_depth: *EXTENDED[[:space:]]*$' && REVIEW_DEPTH=EXTENDED
    REVIEW_WEIGHT=$(printf '%s\n' "$_ds" | sed -n 's/^review_weight: *\([0-9][0-9]*\).*/\1/p' | head -n 1)
fi
if [ -n "$MERGE_ISSUE" ]; then
    gh issue view "$MERGE_ISSUE" -R "$REPO" --json labels --jq '[.labels[].name] | any(. == "review-finding")' 2>/dev/null | grep -qx true && FIX_PR=true
    if [ "$FIX_PR" = "true" ]; then
        SRC_BODY=$(gh issue view "$MERGE_ISSUE" -R "$REPO" --json body --jq '.body' 2>/dev/null)
        SRC_SEV=$(printf '%s\n' "$SRC_BODY" | sed -n 's/^\*\*Severity\*\*: *\([A-Za-z]*\).*/\1/p' | head -n 1)
        SRC_DOM=$(printf '%s\n' "$SRC_BODY" | sed -n 's/^\*\*Agent\*\*: *//p' | head -n 1 | tr -c 'A-Za-z\n' ' ' | tr ' ' '\n' | grep -viE '^security$' | grep -v '^$' | head -n 1)
    fi
fi
SC="AUTH=$SCORE_AUTH BILLING=$SCORE_BILLING CONCURRENCY=$SCORE_CONCURRENCY DATABASE=$SCORE_DATABASE INFRA=$SCORE_INFRA SECURITY=$SCORE_SECURITY SCRAPING=$SCORE_SCRAPING FRONTEND=$SCORE_FRONTEND API=$SCORE_API"
SPEC_CLI=false; [ -n "$TOP" ] && [ -f "$TOP/commands/review-pr-agents/spec-cli.md" ] && SPEC_CLI=true   # existence only
SCRAPING_ON=false; [ -n "$DOMAIN_CONTEXT_SCRAPING" ] && SCRAPING_ON=true
DBC=false; printf '%s\n' "$DIFF" | grep -qE "docker-compose.*postgres|docker-compose.*redis|postgres.*command:|redis.*command:" && DBC=true
ROSTER_OUT=""
[ -n "$ROSTER_SCRIPT" ] && ROSTER_OUT=$(printf '%s\n' "$FILES" | bash "$ROSTER_SCRIPT" --files-file - --scores "$SC" --changed-lines "$LINES" --changed-files "$NFILES" \
    --fix-pr "$FIX_PR" --source-severity "$SRC_SEV" --source-domain "$SRC_DOM" --contract-flags "$CONTRACT_RISK_FLAGS" --churn "$CHURN_ESCALATION" --danger-zone "$DANGER" \
    --thorough "$THOROUGH" --milestone "$IS_MILESTONE_TO_STAGING" --scraping-configured "$SCRAPING_ON" --database-container "$DBC" --spec-cli "$SPEC_CLI" --review-depth "$REVIEW_DEPTH" 2>/dev/null)
SELECTED_AGENTS=$(printf '%s\n' "$ROSTER_OUT" | sed -n 's/^SELECTED_AGENTS=//p')
ROSTER_TIER=$(printf '%s\n' "$ROSTER_OUT" | sed -n 's/^TIER=//p')
ROSTER_REASON=$(printf '%s\n' "$ROSTER_OUT" | sed -n 's/^REASON=//p')
FULL_UNION="false"
if [ -z "$SELECTED_AGENTS" ]; then
    FULL_UNION="true"; THOROUGH=true; ROSTER_TIER=full; ROSTER_REASON="review-roster.sh unavailable or failed: full union"
fi
if [ "$THOROUGH" = "true" ] || [ "$IS_MILESTONE_TO_STAGING" = "true" ]; then FULL_UNION="true"; fi
if [ "$FULL_UNION" = "true" ]; then
    SELECTED_AGENTS="Security"
    [ "$SCORE_AUTH" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Auth"
    [ "$SCORE_BILLING" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Billing Concurrency"
    [ "$SCORE_DATABASE" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Database"
    [ "$SCORE_INFRA" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Infrastructure"
    [ "$SCORE_SCRAPING" -gt 0 ] && [ "$SCRAPING_ON" = "true" ] && SELECTED_AGENTS="$SELECTED_AGENTS Scraping"
    [ "$SCORE_FRONTEND" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS Frontend"
    [ "$SCORE_API" -gt 0 ] && SELECTED_AGENTS="$SELECTED_AGENTS API"
    [ "$SPEC_CLI" = "true" ] && printf '%s\n' "$FILES" | grep -qE "^(commands|bin)/" && SELECTED_AGENTS="$SELECTED_AGENTS spec-cli"
fi
# Roster canonicalization: one canonical marker domain per persona.
canonical_roster() { local out="" a d; for a in $1; do d=$(agent_domain "$a"); case " $out " in *" $d "*) ;; *) out="$out $d" ;; esac; done; printf '%s' "${out# }"; }
SELECTED_AGENTS=$(canonical_roster "$SELECTED_AGENTS")

# --- Phase 3C: review mode (FULL | DELTA | BASE_SYNC_ONLY) ---
# shellcheck disable=SC2034  # both read by lib/review-delta-mode.sh
BASE_BRANCH="$BASE"
# shellcheck disable=SC2034
COMMENTS_JSON=$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments" 2>/dev/null || echo "")
delta_roster() {
    local rounds="${1}" full="${2}" files="${3}" out="security" root
    root="${REPO_PATH:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
    case "$rounds" in ''|*[!0-9]*) printf '%s' "$full"; return 0 ;; esac
    if [ "$rounds" -lt 2 ]; then printf '%s' "$full"; return 0; fi
    printf '%s\n' "$files" | grep -qiE "auth|session|login|logout|jwt|oauth|token|user|permission|middleware" && out="$out auth"
    printf '%s\n' "$files" | grep -qiE "billing|credit|payment|charge|refund|subscription|pricing|tier" && out="$out billing"
    printf '%s\n' "$files" | grep -qiE "lock|queue|atomic|transaction|worker|job|task|celery|redis|claim|lease|engine-state" && out="$out concurrency"
    printf '%s\n' "$files" | grep -qiE "migration|\.sql$|model|schema|db|database|alembic" && out="$out database"
    printf '%s\n' "$files" | grep -qiE "docker|nginx|traefik|\.github|Makefile|deploy|infra" && out="$out infra"
    printf '%s\n' "$files" | grep -qiE "scrape|crawler|stealth|browser.*pool|headless|anti.bot|detection.*keyword|captcha" && out="$out scraper"
    printf '%s\n' "$files" | grep -qiE "^web/|\.tsx?$|\.jsx?$|component|page|layout|style|css" && out="$out frontend"
    printf '%s\n' "$files" | grep -qiE "router|route|endpoint|openapi|sdk|api" && out="$out api"
    printf '%s\n' "$files" | grep -qE "^(commands|bin)/" && [ -f "$root/commands/review-pr-agents/spec-cli.md" ] && out="$out spec-cli"
    printf '%s' "$out"
}
REVIEW_MODE="FULL"; DELTA_FROM=""; CARRIED_FROM=""; FULL_ROUNDS=0; DELTA_FILES=""
if [ -n "$DELTA_FROM_OPT" ]; then
    # forge#4360: explicit delta. Every check fails closed (BLOCKED); only an empty file delta widens to FULL (below).
    _dtop="${TOP:-.}"
    case "$DELTA_FROM_OPT" in *[!0-9a-f]*|"") _dok=false ;; *) { [ "${#DELTA_FROM_OPT}" -eq 40 ] || [ "${#DELTA_FROM_OPT}" -eq 64 ]; } && _dok=true || _dok=false ;; esac
    if [ "$_dok" != "true" ]; then block "--delta-from is not a full commit id: $(printf '%s' "$DELTA_FROM_OPT" | tr -cd '0-9A-Za-z' | cut -c1-64)"
    elif [ "$DELTA_FROM_OPT" = "$REVIEW_SHA" ]; then block "--delta-from ${DELTA_FROM_OPT} is the review head: nothing to review"
    elif ! git -C "$_dtop" cat-file -e "${DELTA_FROM_OPT}^{commit}" 2>/dev/null; then block "--delta-from ${DELTA_FROM_OPT} is not a commit in this checkout (fetch it first)"
    elif ! git -C "$_dtop" merge-base --is-ancestor "$DELTA_FROM_OPT" "$REVIEW_SHA" 2>/dev/null; then block "--delta-from ${DELTA_FROM_OPT} is not an ancestor of ${REVIEW_SHA} (force-push or rebase): run a full review"
    elif printf '%s' "$PR_INFO" | jq -e '[.labels[]?.name] | index("review-degraded") != null' >/dev/null 2>&1; then block "--delta-from ${DELTA_FROM_OPT}: the PR is labelled review-degraded (an earlier panel was incomplete): run a full review"
    else
        # forge#4471: the earlier pass must be complete and non-degraded, as scripts/review-delta.sh requires of a checkpoint:
        # an agent body with a findings block for <from>, a post-panel-guard proof naming <from> (staging summary, synthesized
        # block, or a # PR Review Summary whose Agents count matches) and no degraded marker after its first agent body.
        _dv="error"
        if [ -n "$TRUSTED_SCRIPT" ] && [ -n "$COMMENTS_JSON" ]; then
            _db=$(printf '%s' "$COMMENTS_JSON" | bash "$TRUSTED_SCRIPT" bodies '^<!-- FORGE:REVIEW-AGENT:[a-z0-9-]+ -->|^<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->|# PR Review Summary|^<!-- FORGE:GATE_(PASS|FAILURE) -->|<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity|<!-- FORGE:REVIEW_DEGRADED|<!-- FORGE:REVIEW_BLOCKED' 2>/dev/null) \
                && _dv=$(printf '%s\n' "$_db" | jq -s -r --arg f "$DELTA_FROM_OPT" '
                    def shas($t; $re): [ $t | scan($re) | .[0] ];
                    def one($a): if ($a | length) == 1 then $a[0] else null end;
                    def rsha: "(?:^|\\n)Reviewed-SHA: ([0-9a-f]{40}|[0-9a-f]{64})\\r?(?:\\n|$)";
                    to_entries as $E
                    | [ $E[] | select((.value | test("\\A<!-- FORGE:REVIEW-AGENT:[a-z0-9-]+ -->")) and (.value | test("<!-- REVIEW-FINDINGS-START -->")))
                        | select(one(shas(.value; rsha)) == $f)
                        | {i: .key, d: (.value | capture("\\A<!-- FORGE:REVIEW-AGENT:(?<d>[a-z0-9-]+) -->").d)} ] as $AG
                    | if ($AG | length) == 0 then "no-agent" else
                        ($AG | map(.i) | min) as $first | ($AG | map(.d) | unique | length) as $nd
                        | ([ $E[] | .value as $t | select(
                              (($t | test("\\A<!-- FORGE:GATE_(?:PASS|FAILURE) -->\\r?\\n## Staging Review:"))
                                and one(shas($t; "\\*\\*Head\\*\\*: `([0-9a-f]{40}|[0-9a-f]{64})`")) == $f)
                              or (($t | startswith("<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->")) and one(shas($t; rsha)) == $f)
                              or (($t | test("# PR Review Summary"))
                                and one(shas($t; "\\*\\*Reviewed commit\\*\\*: `?([0-9a-f]{40}|[0-9a-f]{64})`?(?:[ |\\r\\n]|$)")) == $f
                                and one(shas($t; "\\*\\*Agents\\*\\*: ([0-9]+)")) == ($nd | tostring))) ] | length) as $proof
                        | ([ $E[] | select(.key > $first)
                             | select(.value | test("<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity|<!-- FORGE:REVIEW_DEGRADED|<!-- FORGE:REVIEW_BLOCKED")) ] | length) as $deg
                        | if $deg > 0 then "degraded" elif $proof == 0 then "no-proof" else "ok" end
                      end' 2>/dev/null) || _dv="error"
        fi
        case "$_dv" in
            ok) REVIEW_MODE="DELTA"; DELTA_FROM="$DELTA_FROM_OPT" ;;
            no-agent) block "--delta-from ${DELTA_FROM_OPT}: no trusted FORGE:REVIEW-AGENT comment with a findings block for that head, no earlier pass to credit: run a full review" ;;
            no-proof) block "--delta-from ${DELTA_FROM_OPT}: no trusted proof that the earlier panel completed (staging summary, synthesized block or PR Review Summary for that head): run a full review" ;;
            degraded) block "--delta-from ${DELTA_FROM_OPT}: the earlier pass is degraded (review-panel-integrity / REVIEW_DEGRADED / REVIEW_BLOCKED after its agents): run a full review" ;;
            *) block "--delta-from ${DELTA_FROM_OPT}: could not read the trusted review comments, no earlier pass to credit: run a full review" ;;
        esac
    fi
elif [ "$THOROUGH" != "true" ] && [ "$IS_MILESTONE_TO_STAGING" != "true" ] && [ "$NO_DELTA" != "true" ]; then
    read -r RD_KIND RD_ARG RD_ROUNDS <<< "$(review_delta_mode)"
    FULL_ROUNDS="${RD_ROUNDS:-0}"
    case "$RD_KIND" in
        DELTA) REVIEW_MODE="DELTA"; DELTA_FROM="$RD_ARG" ;;
        BASE_SYNC_ONLY) REVIEW_MODE="BASE_SYNC_ONLY"; CARRIED_FROM="$RD_ARG" ;;
    esac
fi
if [ "$REVIEW_MODE" = "DELTA" ]; then
    DELTA_FILES=$(git -C "${TOP:-.}" -c core.quotepath=off diff --name-only --no-renames "${DELTA_FROM}" "${REVIEW_SHA}" 2>/dev/null) || DELTA_FILES=""
    if [ -z "$DELTA_FILES" ]; then REVIEW_MODE="FULL"; DELTA_FROM=""
    else
        # an explicit --delta-from always narrows the roster to the domains the delta touches (no full-rounds gate)
        _drounds="$FULL_ROUNDS"
        # forge#4471: an explicit delta that changes the review specs/config cannot credit the earlier pass (same list as
        # scripts/review-delta.sh, which answers FULL there; review-prepare.test.sh checks the two lists match)
        if [ -n "$DELTA_FROM_OPT" ]; then
            while IFS= read -r _df; do
                case "$_df" in
                    forge.yaml|commands/review-pr*.md|commands/review-pr-agents/*|scripts/review-delta.sh|scripts/trusted-comments.sh|scripts/verify-phase-trail.sh|docs/spec/review-protocol.md|scripts/classify-finding.sh) block "--delta-from ${DELTA_FROM}: the delta changes ${_df} (review spec/config), the earlier pass cannot be credited: run a full review"; break ;;
                esac
            done <<< "$DELTA_FILES"
        fi
        [ -n "$DELTA_FROM_OPT" ] && { _drounds=2; ROSTER_REASON="delta ${DELTA_FROM:0:7}..${REVIEW_SHA:0:7}: domains the delta touches"; }
        SELECTED_AGENTS=$(canonical_roster "$(delta_roster "$_drounds" "$SELECTED_AGENTS" "$DELTA_FILES")")
    fi
fi
[ "$REVIEW_MODE" = "BASE_SYNC_ONLY" ] && SELECTED_AGENTS=""

# --- templates, code index, per-domain slices (skipped for BASE_SYNC_ONLY: zero reviewers) ---
TEMPLATE_SOURCE="none"; TEMPLATE_BASE=""; MONOLITHIC_CATALOG=""
IDX_AUTH=""; IDX_BILLING=""; IDX_DATABASE=""; IDX_API=""; IDX_FRONTEND=""; IDX_INFRA=""
SLICES_JSON="{}"
if [ "$REVIEW_MODE" != "BASE_SYNC_ONLY" ]; then
    review_template_resolve "$REPO_PATH"
    if [ "$TEMPLATE_SOURCE" = "none" ]; then
        block "no review-pr-agents template source resolved: run \`npx forgedock update\`; NEVER review inline"
        # forge#3936: keep the setup-error trace and the needs-human alert the old spec bash posted before returning BLOCKED.
        _msg="Review of PR #${PR_NUMBER} could not start: no review-pr-agents template source resolved (broken install). Run \`npx forgedock update\`, then re-run the review. Reviews are never done inline."
        gh pr comment "$PR_NUMBER" -R "$REPO" --body "$_msg" >/dev/null 2>&1 || true # allowlist:check-command-side-effects
        [ -z "$MERGE_ISSUE" ] || gh issue edit "$MERGE_ISSUE" -R "$REPO" --add-label needs-human >/dev/null 2>&1 || true # allowlist:check-command-side-effects
    fi
    # forge#4126: the index build is bounded and visible. A hung build used to block review prep silently (output was discarded).
    INDEX_OK=0
    if [ -n "$CODE_INDEX_SCRIPT" ]; then
        _ito="${REVIEW_PREPARE_INDEX_TIMEOUT:-120}"; case "$_ito" in ''|*[!0-9]*|0) _ito=120 ;; esac
        _tbin=$(command -v timeout || command -v gtimeout || true)
        echo "review-prepare: building code index (limit ${_ito}s)" >&2
        # forge#4235: keep the build's stderr so a failure is diagnosable (its tail is echoed below); stdout stays discarded.
        _ierr=$(mktemp "$OUT_DIR/.code-index-err-XXXXXX" 2>/dev/null) || _ierr=/dev/null
        if [ -n "$_tbin" ]; then "$_tbin" "$_ito" bash "$CODE_INDEX_SCRIPT" --repo-path "$REPO_PATH" >/dev/null 2>"$_ierr"; _irc=$?
        else bash "$CODE_INDEX_SCRIPT" --repo-path "$REPO_PATH" >/dev/null 2>"$_ierr"; _irc=$?; fi
        if [ "$_irc" -eq 0 ]; then INDEX_OK=1
        elif [ "$_irc" -eq 124 ]; then echo "review-prepare: code index timed out after ${_ito}s — skipping index slices (agents grep instead)" >&2
        else
            echo "review-prepare: code index failed (exit $_irc) — skipping index slices (agents grep instead)" >&2
            # forge#4316: the tail can name repo files; show the repo root as <repo>, strip control chars, cap each line
            [ -s "$_ierr" ] && tail -n 20 "$_ierr" | tr -d '\000-\010\013-\037\177' \
                | awk -v r="$REPO_PATH" '{ l = $0; if (r != "") { o = ""; while ((i = index(l, r)) > 0) { o = o substr(l, 1, i - 1) "<repo>"; l = substr(l, i + length(r)) } l = o l } print substr(l, 1, 200) }' \
                | sed 's/^/review-prepare: code-index: /' >&2
        fi
        [ "$_ierr" = /dev/null ] || rm -f "$_ierr"
    fi
    build_index_slice() {
        local domain="${1}" files
        if [ "$INDEX_OK" -eq 1 ]; then
            files=$(bash "$CODE_INDEX_SCRIPT" query --domain "$domain" --repo-path "$REPO_PATH" 2>/dev/null | awk -F'\t' '{print $1}' | head -30 | tr '\n' ' ')
            echo "Domain files (${domain}): ${files:-none}"
        else echo "Code index not available — agent will use grep exploration"; fi
    }
    IDX_AUTH=$(build_index_slice auth); IDX_BILLING=$(build_index_slice billing); IDX_DATABASE=$(build_index_slice database)
    IDX_API=$(build_index_slice api); IDX_FRONTEND=$(build_index_slice frontend); IDX_INFRA=$(build_index_slice infrastructure)

    FULL_DIFF="$DIFF"
    if [ "$REVIEW_MODE" = "DELTA" ]; then
        DELTA_DIFF=$(git -C "${TOP:-.}" -c core.quotepath=off diff --no-color --no-ext-diff "${DELTA_FROM}..${REVIEW_SHA}" 2>/dev/null) || DELTA_DIFF=""
        [ -n "$DELTA_DIFF" ] && FULL_DIFF="$DELTA_DIFF"
    fi
    SLICE_FILES_SRC="$FILES"; [ "$REVIEW_MODE" = "DELTA" ] && SLICE_FILES_SRC="$DELTA_FILES"
    # slice <domain> <diff-header regex|ALL> <file-path regex|ALL>
    slice() {
        local dom="$1" dre="$2" fre="$3" body paths tmp df="$OUT_DIR/slice-${REVIEW_SHA_SHORT:-unresolved}-$1.diff"
        if [ "$dre" = "ALL" ]; then body="$FULL_DIFF"
        else
            body=$(printf '%s\n' "$FULL_DIFF" | awk -v re="$dre" '/^diff --git/ { in_block=0 } $0 ~ re { in_block=1 } in_block { print }')
            [ -n "$body" ] || body="$FULL_DIFF"
        fi
        if [ "$fre" = "ALL" ]; then paths="$SLICE_FILES_SRC"
        else paths=$(printf '%s\n' "$SLICE_FILES_SRC" | grep -iE "$fre" || echo ""); [ -n "$paths" ] || paths="$SLICE_FILES_SRC"; fi
        # 100K-char cap, same as the runner's tool-result cap
        if [ "${#body}" -gt 102400 ]; then body="$(printf '%s' "$body" | head -c 102400)"$'\n'"... [TRUNCATED — diff exceeded 100K chars; focus on the files listed]"; fi
        # Publish atomically: temp file in $OUT_DIR (same filesystem) then rename, so a concurrent reader sees nothing or the whole file.
        tmp=$(mktemp "$OUT_DIR/.slice-XXXXXX") || { echo "review-prepare: cannot create temp slice in $OUT_DIR" >&2; exit 2; }
        if printf '%s\n' "$body" > "$tmp" && chmod 644 "$tmp"; then mv -f "$tmp" "$df"; else rm -f "$tmp"; echo "review-prepare: cannot write slice $df" >&2; exit 2; fi
        SLICES_JSON=$(printf '%s' "$SLICES_JSON" | jq -c --arg d "$dom" --arg df "$df" --arg p "$paths" '. + {($d): {paths: ($p | split("\n") | map(select(length > 0))), diff_file: $df}}')
    }
    slice security ALL ALL
    slice auth '^diff --git.*/(auth|session|jwt|oauth|permission|middleware|login|token)' "auth|session|login|logout|jwt|oauth|token|user|permission|middleware"
    slice billing '^diff --git.*/(billing|payment|credit|pricing|stripe|subscription|invoice|charge|refund)' "billing|credit|payment|charge|refund|subscription|pricing|tier"
    slice concurrency '^diff --git.*/(worker|queue|task|async|lock|transaction|pipeline|job)' "lock|queue|atomic|transaction|worker|job|task|celery|redis|claim|lease|engine-state"
    slice database '^diff --git.*/(migration|model|schema|\.sql$|orm|database|db)' "migration|\.sql$|model|schema|db|database|alembic"
    slice frontend '^diff --git.*(web/src|components|pages|styles|\.tsx|\.jsx|\.css|\.scss)' "^web/|\.tsx?$|\.jsx?$|component|page|layout|style|css"
    slice api '^diff --git.*/(router|route|endpoint|openapi|serializer|schema|api)' "router|route|endpoint|openapi|sdk|api"
    slice infra '^diff --git.*/(docker|nginx|infra|\.github|deploy|ci|traefik|k8s|helm)' "docker|nginx|traefik|\.github|Makefile|deploy|infra"
    slice scraper '^diff --git.*/(scrape|scraper|stealth|browser_pool|headless|anti_bot|captcha|crawl)' "scrape|crawler|stealth|browser.*pool|headless|anti.bot|detection.*keyword|captcha"
    slice spec-cli '^diff --git a/(commands|bin)/' "^(commands|bin)/"
fi

# --- emit ---
STATUS="OK"; [ -n "$BLOCKERS" ] && STATUS="BLOCKED"
j_lines() { printf '%s' "${1}" | jq -R -s -c 'split("\n") | map(select(length > 0))'; }
j_words() { printf '%s' "${1}" | jq -R -s -c 'split(" ") | map(select(length > 0))'; }
CTX=$(jq -n \
    --arg status "$STATUS" --argjson blockers "$(j_lines "$BLOCKERS")" \
    --argjson pr_number "$PR_NUMBER" --arg repo "$REPO" --arg title "$TITLE" --arg author "$PR_AUTHOR" --arg head "$HEAD" --arg base "$BASE" \
    --arg sha "$REVIEW_SHA" --arg sha7 "$REVIEW_SHA_SHORT" --argjson adds "$ADDITIONS" --argjson dels "$DELETIONS" --arg nfiles "${NFILES:-}" --arg first "$IS_FIRST_TIME_CONTRIBUTOR" \
    --arg s2m "$IS_STAGING_TO_MAIN" --arg m2s "$IS_MILESTONE_TO_STAGING" --arg rfb "$REQUIRES_FULL_BUILD" --arg thorough "$THOROUGH" \
    --arg mh "$MERGE_HEALTH" --arg mhs "$MERGE_HEALTH_STATE" --argjson mhr "$MERGE_RETRY" \
    --argjson services "$(j_words "$SERVICES")" --argjson domains "$(j_words "$DOMAINS")" \
    --arg tsb "$TS_BUILD" --arg pyf "$PY_FORMAT" --arg bcs "$BUILD_CONFIG_STATUS" --argjson p2 "$(j_lines "$P2_FINDINGS")" \
    --argjson asm "$(j_lines "$ASSUMPTIONS")" --argjson risk "$(j_words "$RISK")" --arg churn "$CHURN_CONTEXT" --arg churn_esc "$CHURN_ESCALATION" --arg danger "$DANGER" \
    --argjson sa "$SCORE_AUTH" --argjson sb "$SCORE_BILLING" --argjson sc "$SCORE_CONCURRENCY" --argjson sd "$SCORE_DATABASE" --argjson si "$SCORE_INFRA" \
    --argjson ss "$SCORE_SECURITY" --argjson ssc "$SCORE_SCRAPING" --argjson sf "$SCORE_FRONTEND" --argjson sap "$SCORE_API" \
    --arg cissue "$ISSUE_NUM" --arg cflags "$CONTRACT_RISK_FLAGS" \
    --arg rdepth "$REVIEW_DEPTH" --arg rweight "$REVIEW_WEIGHT" --arg rtier "$ROSTER_TIER" --arg rreason "$ROSTER_REASON" --argjson agents "$(j_words "$SELECTED_AGENTS")" \
    --arg dmode "$REVIEW_MODE" --arg dfrom "$DELTA_FROM" --arg dcarried "$CARRIED_FROM" --argjson drounds "$FULL_ROUNDS" --argjson dfiles "$(j_lines "$DELTA_FILES")" \
    --arg pname "$PROJECT_NAME" --arg pctx "$PROJECT_CONTEXT" --arg scraping_on "$SCRAPING_ON" --arg rpath "$REPO_PATH" \
    --arg d_auth "$DOMAIN_CONTEXT_AUTH" --arg d_billing "$DOMAIN_CONTEXT_BILLING" --arg d_conc "$DOMAIN_CONTEXT_CONCURRENCY" --arg d_infra "$DOMAIN_CONTEXT_INFRA" \
    --arg d_db "$DOMAIN_CONTEXT_DATABASE" --arg d_fe "$DOMAIN_CONTEXT_FRONTEND" --arg d_sec "$DOMAIN_CONTEXT_SECURITY" --arg d_api "$DOMAIN_CONTEXT_API" --arg d_scr "$DOMAIN_CONTEXT_SCRAPING" \
    --arg tsrc "$TEMPLATE_SOURCE" --arg tbase "$TEMPLATE_BASE" --arg tmono "$MONOLITHIC_CATALOG" \
    --arg i_auth "$IDX_AUTH" --arg i_billing "$IDX_BILLING" --arg i_db "$IDX_DATABASE" --arg i_api "$IDX_API" --arg i_fe "$IDX_FRONTEND" --arg i_infra "$IDX_INFRA" \
    --argjson slices "$SLICES_JSON" --argjson full_files "$(j_lines "$FILES")" '
    {schema_version: 1, status: $status, blockers: $blockers,
     pr: {number: $pr_number, repo: $repo, title: $title, author: $author, head_ref: $head, base_ref: $base, review_sha: $sha, review_sha_short: $sha7,
          additions: $adds, deletions: $dels, changed_files: ($nfiles | tonumber? // null), first_time_contributor: ($first == "true")},
     lane: {is_staging_to_main: ($s2m == "true"), is_milestone_to_staging: ($m2s == "true"), requires_full_build: ($rfb == "true"), thorough: ($thorough == "true")},
     merge_health: {mergeable: $mh, state: $mhs, retries: $mhr},
     classification: {services: $services, domains: $domains},
     phase2: {build_config: {typescript_build: $tsb, python_format: $pyf, status: $bcs}, findings: $p2},
     broken_assumptions: $asm, risk_signals: $risk, churn_context: $churn, churn_escalation: ($churn_esc == "true"), danger_zone: ($danger == "true"),
     scores: {AUTH: $sa, BILLING: $sb, CONCURRENCY: $sc, DATABASE: $sd, INFRA: $si, SECURITY: $ss, SCRAPING: $ssc, FRONTEND: $sf, API: $sap},
     contract: {issue: ($cissue | tonumber? // null), flags: $cflags},
     roster: {tier: $rtier, review_depth: $rdepth, review_weight: $rweight, reason: $rreason, agents: $agents},
     delta: {mode: $dmode, from: $dfrom, carried_from: $dcarried, full_rounds: $drounds, files: $dfiles},
     config: {project_name: $pname, project_context: $pctx, scraping_configured: ($scraping_on == "true"), repo_path: $rpath,
              domains: {auth: $d_auth, billing: $d_billing, concurrency: $d_conc, infra: $d_infra, database: $d_db, frontend: $d_fe, security: $d_sec, api: $d_api, scraping: $d_scr}},
     templates: {source: $tsrc, base: $tbase, monolithic_catalog: $tmono},
     index_slices: {auth: $i_auth, billing: $i_billing, database: $i_db, api: $i_api, frontend: $i_fe, infrastructure: $i_infra},
     slices: $slices, full_files: $full_files}') || { echo "review-prepare: could not assemble the context JSON" >&2; exit 2; }
if [ -n "$OUT" ]; then printf '%s\n' "$CTX" > "$OUT" || { echo "review-prepare: cannot write $OUT" >&2; exit 2; }; else printf '%s\n' "$CTX"; fi
[ "$STATUS" = "OK" ] && exit 0
exit 3
