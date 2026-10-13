#!/usr/bin/env bash
# review-roster.sh — risk-tiered reviewer roster for /review-pr Phase 3B and /review-pr-staging (forge#3599).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Pure function: flags in, key=value lines out. No network, no git, no eval; every flag value is data.
# Resolve it through forge_resolve (trusted FORGE_ROOT / plugin cache), never from the repo under review.
#
# Usage: review-roster.sh [--scores "AUTH=n BILLING=n CONCURRENCY=n DATABASE=n INFRA=n SECURITY=n SCRAPING=n FRONTEND=n API=n"]
#          [--changed-lines N] [--changed-files N] [--files-file PATH|-] [--fix-pr true|false]
#          [--source-severity SEV] [--source-domain DOMAIN] [--contract-flags "HIGH_RISK CONTRACT_AUTH ..."]
#          [--churn true|false] [--danger-zone true|false] [--thorough true|false] [--milestone true|false]
#          [--scraping-configured true|false] [--database-container true|false] [--spec-cli true|false]
#          [--review-depth STANDARD|EXTENDED]
# Output (stdout): SELECTED_AGENTS=<canonical marker domains, space separated>  TIER=<tier>  REASON=<text>
# Exit: 0 always for a parseable call; 2 on an unknown flag (callers fall back to the full union, never a narrower roster).
#
# Tiers, evaluated in this order:
#   full      THOROUGH or milestone->staging: Security plus every domain with a score > 0.
#   fix-pr    the PR closes a `review-finding` issue AND has <= 150 changed lines with a known size: Security, plus the
#             source finding's domain when it was HIGH+. Larger or unknown-size fix PRs fall to the size ladder below.
#   small     <= 60 changed lines, or one file of <= 150 lines: Security only.
#   medium    61-150 lines: Security plus the score-escalation table (no top-2 baseline).
#   standard  > 150 lines, or an unknown size (fail toward more agents): top-2 domains by score plus the table.
# --review-depth EXTENDED (forge#3862: the build's FORGE:DIFF_SIZE review_weight or out-of-plan scope flagged extended
# review) only ever ADDS reviewers: a small, medium or fix-pr roster is lifted to standard and the standard baseline takes
# the top-3 domains instead of top-2. It never narrows a roster and never touches the Security floor. Anything but the
# exact value EXTENDED is STANDARD. An extended roster prints an extra DEPTH=extended line.
# Path triggers escalate in EVERY tier except full (which already runs the union): CONTRACT HIGH_RISK, cross-critical
# pairs, churn hot-spot, danger zone, bin/engine* (Concurrency + spec-cli), bin/ (spec-cli), auth/session/trust-filter
# files (Auth: auth*, not author*; oauth, jwt, login, password, permission, rbac, acl, token(s), api_key(s), credential, deps.py), CI/docker/deploy/infra files (Infra), migration/.sql files (Database), SDK/OpenAPI files (API).
# Auth and Infra are path-gated: a diff-text score alone never selects them. Security is a hard floor in every tier.
# spec-cli is added only with --spec-cli true (the persona file exists in the repo under review); in the standard tier it
# also covers commands/**. Bash 3.2 portable (no mapfile, associative arrays, grep -P).
set -u

S_AUTH=0; S_BILLING=0; S_CONCURRENCY=0; S_DATABASE=0; S_INFRA=0; S_SCRAPING=0; S_FRONTEND=0; S_API=0
LINES=""; NFILES=""; FILES_FILE=""; FIX_PR=false; SRC_SEV=""; SRC_DOM=""; CFLAGS=""
DEPTH=STANDARD; CHURN=false; DANGER=false; THOROUGH=false; MILESTONE=false; SCRAPING_ON=false; DB_CONTAINER=false; SPEC_CLI=false

num() { case "${1:-}" in ''|*[!0-9]*) printf '0' ;; *) printf '%s' "$1" ;; esac; }
agent_domain() { local l; l=$(printf '%s' "${1}" | tr '[:upper:]' '[:lower:]'); case "$l" in infrastructure) l=infra ;; scraping) l=scraper ;; web) l=frontend ;; esac; printf '%s' "$l"; }
add_agent() {
    local AGENT CUR HAVE=""
    AGENT=$(agent_domain "${1}")
    for CUR in $SELECTED_AGENTS; do
        [ "$(agent_domain "$CUR")" = "$AGENT" ] && HAVE=1
    done
    [ -n "$HAVE" ] || SELECTED_AGENTS="$SELECTED_AGENTS $AGENT"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --scores)
            for kv in ${2:-}; do
                v=$(num "${kv#*=}")
                case "${kv%%=*}" in
                    AUTH) S_AUTH=$v ;; BILLING) S_BILLING=$v ;; CONCURRENCY) S_CONCURRENCY=$v ;; DATABASE) S_DATABASE=$v ;;
                    INFRA) S_INFRA=$v ;; SCRAPING) S_SCRAPING=$v ;; FRONTEND) S_FRONTEND=$v ;; API) S_API=$v ;;
                esac
            done; shift 2 ;;
        --changed-lines) LINES="${2:-}"; shift 2 ;;
        --changed-files) NFILES="${2:-}"; shift 2 ;;
        --files-file) FILES_FILE="${2:-}"; shift 2 ;;
        --fix-pr) FIX_PR="${2:-false}"; shift 2 ;;
        --source-severity) SRC_SEV="${2:-}"; shift 2 ;;
        --source-domain) SRC_DOM="${2:-}"; shift 2 ;;
        --contract-flags) CFLAGS="${2:-}"; shift 2 ;;
        --churn) CHURN="${2:-false}"; shift 2 ;;
        --danger-zone) DANGER="${2:-false}"; shift 2 ;;
        --thorough) THOROUGH="${2:-false}"; shift 2 ;;
        --milestone) MILESTONE="${2:-false}"; shift 2 ;;
        --scraping-configured) SCRAPING_ON="${2:-false}"; shift 2 ;;
        --database-container) DB_CONTAINER="${2:-false}"; shift 2 ;;
        --spec-cli) SPEC_CLI="${2:-false}"; shift 2 ;;
        --review-depth) [ "${2:-}" = "EXTENDED" ] && DEPTH=EXTENDED; shift 2 ;;
        *) echo "review-roster: unknown argument: $1" >&2; exit 2 ;;
    esac
done

FILES=""
if [ "$FILES_FILE" = "-" ]; then FILES=$(cat)
elif [ -n "$FILES_FILE" ] && [ -f "$FILES_FILE" ]; then FILES=$(cat "$FILES_FILE"); fi
[ -n "$NFILES" ] || NFILES=$(printf '%s\n' "$FILES" | grep -c . || true)
case "$LINES" in ''|*[!0-9]*) LINES_KNOWN=false; LINES=0 ;; *) LINES_KNOWN=true ;; esac
case "$NFILES" in ''|*[!0-9]*) NFILES=0 ;; esac

SELECTED_AGENTS="security"
TIER=""; REASON=""

# Domains that may be picked by score alone. Auth and Infra are path-gated, Scraping is opt-in.
top_domains() { # $1 = how many
    local d out="" list=""
    list="$S_BILLING:BILLING $S_CONCURRENCY:CONCURRENCY $S_DATABASE:DATABASE $S_FRONTEND:FRONTEND $S_API:API"
    [ "$SCRAPING_ON" = "true" ] && list="$list $S_SCRAPING:SCRAPING"
    for d in $(printf '%s\n' "$list" | tr ' ' '\n' | sort -t: -k1,1 -rn | head -n "$1"); do
        [ "${d%%:*}" -gt 0 ] && out="$out ${d#*:}"
    done
    printf '%s' "$out"
}

if [ "$THOROUGH" = "true" ] || [ "$MILESTONE" = "true" ]; then
    TIER=full; REASON="thorough or milestone-to-staging: full union"
    [ "$S_AUTH" -gt 0 ] && add_agent Auth
    [ "$S_BILLING" -gt 0 ] && { add_agent Billing; add_agent Concurrency; }
    [ "$S_DATABASE" -gt 0 ] && add_agent Database
    [ "$S_INFRA" -gt 0 ] && add_agent Infra
    [ "$S_SCRAPING" -gt 0 ] && [ "$SCRAPING_ON" = "true" ] && add_agent Scraping
    [ "$S_FRONTEND" -gt 0 ] && add_agent Frontend
    [ "$S_API" -gt 0 ] && add_agent API
    printf 'SELECTED_AGENTS=%s\nTIER=%s\nREASON=%s\n' "${SELECTED_AGENTS# }" "$TIER" "$REASON"
    exit 0
fi

HIGH_RISK=false
case " $CFLAGS " in *" HIGH_RISK "*) HIGH_RISK=true ;; esac

# The fix-pr tier is author-controlled (Closes #N), so it is capped by size: a larger or unknown-size fix PR follows the size ladder.
FIX_PR_MAX_LINES=150
FIX_PR_CAPPED=false
if [ "$FIX_PR" = "true" ] && [ "$LINES_KNOWN" = "true" ] && [ "$LINES" -le "$FIX_PR_MAX_LINES" ]; then
    TIER=fix-pr; REASON="fix PR for a review-finding issue"
elif [ "$LINES_KNOWN" = "true" ] && { [ "$LINES" -le 60 ] || { [ "$NFILES" -eq 1 ] && [ "$LINES" -le 150 ]; }; }; then
    TIER=small; REASON="lines=$LINES files=$NFILES"
elif [ "$LINES_KNOWN" = "true" ] && [ "$LINES" -le 150 ]; then
    TIER=medium; REASON="lines=$LINES"
else
    TIER=standard
    if [ "$LINES_KNOWN" = "true" ]; then REASON="lines=$LINES"; else REASON="size unknown"; fi
fi
if [ "$FIX_PR" = "true" ] && [ "$TIER" != "fix-pr" ]; then
    FIX_PR_CAPPED=true; REASON="$REASON; fix-pr tier capped by size (max $FIX_PR_MAX_LINES lines, known size)"
fi
# CONTRACT HIGH_RISK is never narrowed: a small, medium or fix-PR roster is lifted to the standard roster.
BASE_TIER="$TIER"
if [ "$HIGH_RISK" = "true" ] && [ "$TIER" != "standard" ]; then TIER=standard; REASON="$REASON; CONTRACT HIGH_RISK lifts $BASE_TIER to standard"; fi
# Extended review depth (forge#3862) is only ever additive: lift to standard, widen the standard baseline to top-3.
TOP_N=2
if [ "$DEPTH" = "EXTENDED" ]; then
    TOP_N=3
    if [ "$TIER" != "standard" ]; then REASON="$REASON; extended review depth lifts $TIER to standard"; TIER=standard; else REASON="$REASON; extended review depth"; fi
fi

TRIG=""
trig() { case " $TRIG " in *" $1 "*) ;; *) TRIG="$TRIG $1" ;; esac; }

# Tier baseline
case "$TIER" in
    fix-pr)
        case "$(printf '%s' "$SRC_SEV" | tr '[:lower:]' '[:upper:]')" in
            HIGH|CRITICAL|BLOCKER)
                if [ -n "$SRC_DOM" ]; then add_agent "$SRC_DOM"; else for d in $(top_domains 1); do add_agent "$d"; done; fi
                REASON="$REASON; source finding ${SRC_SEV} adds its domain" ;;
        esac ;;
    standard) for d in $(top_domains "$TOP_N"); do add_agent "$d"; done ;;
esac
# A size-capped fix PR keeps the source finding's domain (size only ever ADDS depth).
if [ "$FIX_PR_CAPPED" = "true" ] && [ -n "$SRC_DOM" ]; then
    case "$(printf '%s' "$SRC_SEV" | tr '[:lower:]' '[:upper:]')" in
        HIGH|CRITICAL|BLOCKER) add_agent "$SRC_DOM"; REASON="$REASON; source finding ${SRC_SEV} adds its domain" ;;
    esac
fi

# Score escalation table (medium and standard only; diff-text signals, so never in the small or fix-pr tiers)
if [ "$TIER" = "medium" ] || [ "$TIER" = "standard" ]; then
    [ "$S_BILLING" -ge 3 ] && { add_agent Billing; add_agent Concurrency; trig billing-score; }
    [ "$S_DATABASE" -ge 3 ] && { add_agent Database; trig database-score; }
    [ "$S_SCRAPING" -ge 3 ] && [ "$SCRAPING_ON" = "true" ] && { add_agent Scraping; trig scraping; }
    [ "$S_INFRA" -ge 3 ] && [ "$DB_CONTAINER" = "true" ] && { add_agent Infra; trig db-container; }
fi

# Path and contract triggers (every tier)
if [ "$HIGH_RISK" = "true" ]; then
    trig contract-high-risk
    case " $CFLAGS " in *" CONTRACT_AUTH "*) add_agent Auth ;; esac
    case " $CFLAGS " in *" CONTRACT_BILLING "*) add_agent Billing; add_agent Concurrency ;; esac
    case " $CFLAGS " in *" CONTRACT_DATABASE "*) add_agent Database ;; esac
fi
{ [ "$S_AUTH" -ge 2 ] && [ "$S_BILLING" -ge 2 ]; } && { add_agent Auth; add_agent Billing; add_agent Concurrency; trig cross-critical; }
{ [ "$S_AUTH" -ge 2 ] && [ "$S_DATABASE" -ge 3 ]; } && { add_agent Auth; add_agent Database; trig cross-critical; }
{ [ "$S_BILLING" -ge 2 ] && [ "$S_CONCURRENCY" -ge 2 ]; } && { add_agent Billing; add_agent Concurrency; add_agent Database; trig cross-critical; }
if [ "$CHURN" = "true" ] || [ "$DANGER" = "true" ]; then
    for d in $(top_domains 1); do add_agent "$d"; trig churn-or-danger-zone; done
fi
hit() { printf '%s\n' "$FILES" | grep -qiE "$1"; }
# Auth path gate (forge#4071). Docs and prose are never auth by path (the content gate still applies). Strong names match
# any path segment; weak names (session, login, permission, token) only as a whole word in a code file outside design-system
# and asset dirs, so design-tokens/, SessionTimeline.tsx, LoginButton.tsx and cursor-token files do not spawn Auth. A CamelCase
# weak name (LoginController.java, PermissionGuard.ts) still counts outside UI component files and dirs.
AUTH_FILES=$(printf '%s\n' "$FILES" | grep -viE '(^|/)docs?/|\.(md|mdx|markdown|rst|adoc|txt)$' || true)
AUTH_CODE=$(printf '%s\n' "$AUTH_FILES" | grep -iE '\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|kts|scala|rs|php|cs|ex|exs|swift|c|cc|cpp|h|hpp|sh|bash|lua|dart|groovy|pl|vue|svelte)$' \
    | grep -viE '(^|/)(design[-_]?(system|tokens?)|assets?|static|images?|icons?|fonts?|styles?|themes?)/' || true)
if printf '%s\n' "$AUTH_FILES" | grep -qiE '(^|[/_.-])(auth([^o]|o[^r]|$)|authori[sz]|oauth|jwt|passw(or)?d|rbac|acl([/_.-]|$)|api[-_]?keys?|credential|trust[-_]?filter|trusted[-_a-z]*)|(^|/)deps\.py$' \
    || printf '%s\n' "$AUTH_CODE" | grep -qiE '(^|[/_])(sessions?|login|logout|permissions?|tokens?)([/_.-]|$)' \
    || printf '%s\n' "$AUTH_CODE" | grep -viE '\.(tsx|jsx|vue|svelte)$|(^|/)(components?|pages|views|ui|widgets)/' \
        | grep -qE '(^|[/_])([Ss]essions?|[Ll]ogin|[Ll]ogout|[Pp]ermissions?|[Tt]okens?)[A-Z]'; then
    add_agent Auth; trig auth-path
fi
hit '^\.github/|(^|/)Dockerfile|docker-compose|(^|/)(docker-)?compose[^/]*\.ya?ml$|(^|/)deploy[^/]*\.sh$|(^|/)docker-entrypoint[^/]*$|(^|/)(deploy|infra|traefik|nginx|k8s|helm|terraform)/|\.tf$' && { add_agent Infra; trig infra-path; }
hit 'migration|\.sql$' && { add_agent Database; trig migration-path; }
hit '^sdk/|openapi.*\.json$|openapi-versions/' && { add_agent API; trig sdk-path; }
hit '^bin/engine' && { add_agent Concurrency; trig bin-engine; }
if [ "$SPEC_CLI" = "true" ]; then
    hit '^bin/' && { add_agent spec-cli; trig bin; }
    [ "$TIER" = "standard" ] && hit '^commands/' && { add_agent spec-cli; trig commands; }
fi

[ -n "$TRIG" ] && REASON="$REASON; triggers:$TRIG"
printf 'SELECTED_AGENTS=%s\nTIER=%s\nREASON=%s\n' "${SELECTED_AGENTS# }" "$TIER" "$REASON"
[ "$DEPTH" = "EXTENDED" ] && printf 'DEPTH=extended\n'
exit 0
