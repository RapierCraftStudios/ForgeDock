#!/usr/bin/env bash
# issue-create.sh — deterministic /issue create path (forge#4164): parse, integrity check, dedup, section repair,
# REST create with token read-back, milestone, project board. commands/issue.md calls it once.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: issue-create.sh --title T (--body B | --body-file F) [--label L]... [--milestone M] [--exclude N,N]
#                        [--dry-run] [--repo OWNER/NAME] [--config forge.yaml]
#        issue-create.sh --args "<raw \$ARGUMENTS string>" [--repo ...] [--config ...]
# --args is tokenized quote-aware by xargs (never eval: $(...), backticks, ; and | in caller text are never run, #2094).
# Repo: --repo, else yq .project.owner/.project.repo of --config (default ${FORGE_CONFIG:-forge.yaml}).
#
# Output: exactly one stdout line per run
#   ISSUE_CREATE_RESULT:CREATED number=N url=U   exit 0
#   ISSUE_CREATE_RESULT:DRY_RUN                  exit 0 (draft printed, nothing created)
#   ISSUE_CREATE_RESULT:DEDUP number=N           exit 1 (an open near-duplicate exists; nothing created)
#   ISSUE_CREATE_RESULT:USAGE                    exit 2 (bad flags, body or integrity marker, dedup usage error)
#   ISSUE_CREATE_RESULT:ERROR                    exit 3 (GitHub rejected the create or a read-back failed)
# Diagnostics go to stderr. Bash 3.2 portable: no mapfile, no assoc arrays, no ${arr[@]} under set -u.
set -o pipefail

usage() { echo "ERROR: $*" >&2; echo "ISSUE_CREATE_RESULT:USAGE"; exit 2; }
fail() { echo "ERROR: $*" >&2; echo "ISSUE_CREATE_RESULT:ERROR"; exit 3; }

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TITLE=""; BODY=""; BODY_FILE=""; HAVE_BODY=false; MILESTONE=""; EXCLUDE=""; DRY_RUN=false
REPO=""; CONFIG="${FORGE_CONFIG:-forge.yaml}"; RAW_ARGS=""; HAVE_RAW=false
LABELS=()

# --- tokenize --args (quote-aware, never executed) ---------------------------
TOKENS=()
take_tokens() { # tokenize $1 into TOKENS via a temp file so the real xargs exit status is seen
  local tmp tok
  case "$1" in *[![:space:]]*) ;; *) return 0 ;; esac
  tmp=$(mktemp "${TMPDIR:-/tmp}/issue-create-args.XXXXXX") || usage "mktemp failed"
  if ! printf '%s' "$1" | xargs -n1 printf '%s\0' > "$tmp"; then
    rm -f "$tmp"
    usage "failed to tokenize the arguments (unbalanced quote, or a token over xargs's limit; use --body-file for large content)"
  fi
  while IFS= read -r -d '' tok; do TOKENS+=("$tok"); done < "$tmp"
  rm -f "$tmp"
}

# Outer argv: --args/--repo/--config, or the flags themselves.
while [ $# -gt 0 ]; do
  case "$1" in
    --args) [ $# -ge 2 ] || usage "--args requires a value"; RAW_ARGS="$2"; HAVE_RAW=true; shift 2 ;;
    --repo) [ $# -ge 2 ] || usage "--repo requires a value"; REPO="$2"; shift 2 ;;
    --config) [ $# -ge 2 ] || usage "--config requires a value"; CONFIG="$2"; shift 2 ;;
    *) TOKENS+=("$1"); shift ;;
  esac
done
[ "$HAVE_RAW" = true ] && take_tokens "$RAW_ARGS"

# Flag mode only when a token is exactly a known flag: free text that mentions "--verbose" is not a flag typo.
FLAG_MODE=false
for t in ${TOKENS[@]+"${TOKENS[@]}"}; do
  case "$t" in --dry-run|--title|--body|--body-file|--label|--milestone|--exclude) FLAG_MODE=true; break ;; esac
done
[ "$FLAG_MODE" = true ] || usage "no recognised flag: free-text /issue requests are drafted interactively (commands/issue.md), not by this script"

i=0; n=${#TOKENS[@]}
while [ "$i" -lt "$n" ]; do
  arg="${TOKENS[$i]}"
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --title|--body|--body-file|--label|--milestone|--exclude)
      [ $((i + 1)) -lt "$n" ] || usage "$arg requires a value"
      i=$((i + 1)); v="${TOKENS[$i]}"
      case "$arg" in
        --title) TITLE="$v" ;;
        --body) BODY="$v"; HAVE_BODY=true ;;
        --body-file) BODY_FILE="$v" ;;
        --label) LABELS+=("$v") ;;
        --milestone) MILESTONE="$v" ;;
        --exclude) EXCLUDE="$v" ;;
      esac ;;
    --*) usage "unrecognized flag: $arg" ;;
    *) ;;   # stray words are ignored, as in the spec's flag loop
  esac
  i=$((i + 1))
done

# --- body and integrity marker ------------------------------------------------
[ -n "$TITLE" ] || usage "programmatic mode requires --title"
if [ "$HAVE_BODY" = true ] && [ -n "$BODY_FILE" ]; then
  usage "programmatic mode requires exactly one of --body or --body-file (both given)"
elif [ "$HAVE_BODY" != true ] && [ -z "$BODY_FILE" ]; then
  usage "programmatic mode requires exactly one of --body or --body-file (neither given)"
fi
MARKER=""
if [ -n "$BODY_FILE" ]; then
  [ -f "$BODY_FILE" ] && [ -r "$BODY_FILE" ] || usage "--body-file '$BODY_FILE' is missing or unreadable"
  BODY=$(cat "$BODY_FILE") || usage "--body-file '$BODY_FILE' is missing or unreadable"
  MARKERS=$(printf '%s' "$BODY" | grep -oE '<!-- FORGE:BODY-INTEGRITY:[^>]+ -->' || true)
  count=0; [ -n "$MARKERS" ] && count=$(printf '%s\n' "$MARKERS" | wc -l | tr -d ' ')
  [ "$count" -eq 1 ] || usage "--body-file must contain exactly one FORGE:BODY-INTEGRITY marker (found $count)"
  MARKER="$MARKERS"
fi

# --- repository ----------------------------------------------------------------
if [ -z "$REPO" ] && [ -f "$CONFIG" ] && command -v yq >/dev/null 2>&1; then
  REPO=$(yq '.project.owner + "/" + .project.repo' "$CONFIG" 2>/dev/null | tr -d '"')
fi
case "$REPO" in ?*/?*) ;; *) usage "no target repository: pass --repo OWNER/NAME or a forge.yaml with project.owner/project.repo" ;; esac

# --- dedup (helper resolved from this script's own install, never the cwd) ---
DEDUP_SCRIPT="$SELF_DIR/issue-dedup.sh"
[ -f "$DEDUP_SCRIPT" ] || fail "issue-dedup.sh not found next to issue-create.sh ($SELF_DIR)"
DEDUP_ARGS=("$TITLE" -R "$REPO")
[ -n "$EXCLUDE" ] && DEDUP_ARGS+=(--exclude "$EXCLUDE")
DEDUP_RESULT=$(bash "$DEDUP_SCRIPT" "${DEDUP_ARGS[@]}" 2>&1); DEDUP_EXIT=$?
if [ "$DEDUP_EXIT" -eq 1 ]; then
  echo "Near-duplicate detected: $DEDUP_RESULT" >&2
  DEDUP_NUMBER=$(printf '%s\n' "$DEDUP_RESULT" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
  [ -n "$DEDUP_NUMBER" ] || usage "dedup STOP returned no issue number"
  echo "ISSUE_CREATE_RESULT:DEDUP number=${DEDUP_NUMBER}"
  exit 1
elif [ "$DEDUP_EXIT" -ne 0 ]; then
  usage "dedup check usage error: $DEDUP_RESULT"
fi

# --- mandatory sections (repair, never block) ----------------------------------
section_repair() { # body -> text to append for missing sections
  local b="$1" add=""
  printf '%s\n' "$b" | grep -q "^## Problem" || add="$add
## Problem

Root cause unknown — investigation needed."
  printf '%s\n' "$b" | grep -q "^## Affected Files" || add="$add
## Affected Files

Files to be identified during investigation."
  printf '%s\n' "$b" | grep -q "^## Acceptance Criteria" || add="$add
## Acceptance Criteria

- [ ] Fix confirmed during investigation."
  printf '%s' "$add"
}
APPEND=$(section_repair "$BODY")
if [ -n "$APPEND" ]; then
  BODY="${BODY}${APPEND}"
  echo "WARNING: body was missing mandatory sections; placeholders added before creation" >&2
fi

if [ "$DRY_RUN" = true ]; then
  LABEL_TEXT=""; for l in ${LABELS[@]+"${LABELS[@]}"}; do LABEL_TEXT="${LABEL_TEXT:+$LABEL_TEXT, }$l"; done
  printf '## Issue Draft (--dry-run — not created)\n\n**Repo**: %s\n**Title**: %s\n**Labels**: %s\n**Milestone**: %s\n\n---\n\n%s\n\n---\n\nRe-run without --dry-run to create this issue.\n' \
    "$REPO" "$TITLE" "${LABEL_TEXT:-none}" "${MILESTONE:-none}" "$BODY" >&2
  echo "ISSUE_CREATE_RESULT:DRY_RUN"
  exit 0
fi

# --- REST create + create-token read-back (never gh issue create: it can swallow a 403) ---
CREATE_TOKEN="forge-create-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
CREATE_BODY="${BODY}

<!-- issue-create-token:${CREATE_TOKEN} -->"
API_LABELS=()
for l in ${LABELS[@]+"${LABELS[@]}"}; do API_LABELS+=(-f "labels[]=$l"); done
CREATE_RESPONSE=$(gh api "repos/${REPO}/issues" --method POST -f title="$TITLE" -f body="$CREATE_BODY" ${API_LABELS[@]+"${API_LABELS[@]}"}) \
  || fail "GitHub rejected issue creation; no issue was created."
NEW_NUMBER=$(printf '%s' "$CREATE_RESPONSE" | jq -r '.number // empty' 2>/dev/null)
case "$NEW_NUMBER" in ''|*[!0-9]*) fail "issue creation returned no issue number." ;; esac
ISSUE_URL=$(printf '%s' "$CREATE_RESPONSE" | jq -r '.html_url // empty' 2>/dev/null)
CREATED_BODY=$(gh issue view "$NEW_NUMBER" -R "$REPO" --json body --jq '.body') || fail "could not read back issue #${NEW_NUMBER}."
printf '%s' "$CREATED_BODY" | grep -qF "issue-create-token:${CREATE_TOKEN}" \
  || fail "issue #${NEW_NUMBER} did not contain this create token; refusing to report success."
if [ -n "$MARKER" ] && ! printf '%s\n' "$CREATED_BODY" | grep -Fqx "$MARKER"; then
  fail "created issue #${NEW_NUMBER} body is missing expected integrity marker $MARKER"
fi

if [ -n "$MILESTONE" ]; then
  gh issue edit "$NEW_NUMBER" -R "$REPO" --milestone "$MILESTONE" >&2 || fail "could not set milestone '$MILESTONE' on #${NEW_NUMBER}."
fi

# Post-create safety net: GitHub or a transform may have altered the body; extend, never replace.
APPEND=$(section_repair "$CREATED_BODY")
if [ -n "$APPEND" ]; then
  gh issue edit "$NEW_NUMBER" -R "$REPO" --body "${CREATED_BODY}${APPEND}" >&2 || echo "WARNING: could not append missing sections to #${NEW_NUMBER}" >&2
fi

# Project board (best effort), from forge.yaml project_board.
if [ -f "$CONFIG" ] && command -v yq >/dev/null 2>&1; then
  PROJECT_NUMBER=$(yq '.project_board.project_number // ""' "$CONFIG" 2>/dev/null | tr -d '"')
  PROJECT_OWNER=$(yq '.project_board.owner // .project.owner' "$CONFIG" 2>/dev/null | tr -d '"')
  if [ -n "$PROJECT_NUMBER" ] && [ "$PROJECT_NUMBER" != "null" ] && [ -n "$ISSUE_URL" ]; then
    gh project item-add "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --url "$ISSUE_URL" >/dev/null 2>&1 || true
  fi
fi

[ -n "$ISSUE_URL" ] || ISSUE_URL="https://github.com/${REPO}/issues/${NEW_NUMBER}"
echo "Created: ${ISSUE_URL}" >&2
echo "ISSUE_CREATE_RESULT:CREATED number=${NEW_NUMBER} url=${ISSUE_URL}"
exit 0
