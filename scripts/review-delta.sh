#!/usr/bin/env bash
# review-delta.sh — fail-closed reviewed-SHA delta resolver for /review-pr.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Classifies how the PR head moved since the last FULLY reviewed head, so callers can skip or shrink the
# domain panel. Pure bash + git + jq, no LLM. Standalone so the engine and the specs can both call it.
#
# Usage:
#   review-delta.sh --pr <n> --head <40|64-hex> --base <branch> --trusted-script <abs path>
#                   [--comments-file <json>] [--repo <owner/repo>] [--labels <csv>] [--repo-path <dir>]
#
#   --trusted-script  REQUIRED absolute path to an existing trusted-comments.sh. The caller passes the path it
#                     resolved from the trusted install; this script never derives it from the working
#                     directory, the repo under review or its own location (a PR-controlled copy would let the
#                     PR author decide which comments count).
#   --comments-file   JSON of `gh api --paginate repos/<repo>/issues/<pr>/comments` (one array or several
#                     concatenated arrays). When absent the comments are fetched (needs --repo).
#   --labels          comma-separated PR labels. When absent they are fetched (needs --repo). A `review-degraded`
#                     label always yields FULL. `--labels ""` means "no labels" and is allowed.
#   --repo-path       git checkout to inspect (default: the current directory). Needs origin/<base> fetched.
#
# Output (always exit 0; two lines):
#   line 1  FULL | BASE_SYNC_ONLY <reviewed> | DELTA <reviewed>..<head>
#   line 2  FULL_ROUNDS=<n>   number of distinct trusted full-panel SHAs (0 when none or on error)
#
# Contract notes for callers (#3637/#3638):
#   - Every error path prints FULL. FULL is always safe (a full review), never a skipped one.
#   - head == reviewed prints `DELTA <sha>..<sha>` (empty delta). The caller's same-head re-entry handles that
#     case before calling; this classifier does not special-case it.
#   - Checkpoint = newest full 40/64-hex `Reviewed-SHA:` on a trusted, complete-shape FORGE:REVIEW-AGENT body that
#     also has a post-panel-guard proof (a synthesized body naming the SHA, or a `# PR Review Summary` whose
#     **Reviewed commit** is the SHA and whose **Agents** count equals the distinct domains that posted). The
#     FORGE:REVIEW_ROUTE sha= value is 7 chars and is never a checkpoint. A trusted review-panel-integrity gate
#     failure / REVIEW_DEGRADED / REVIEW_BLOCKED marker posted after a SHA's first agent body disqualifies it.
#   - FULL also when forge.yaml, the review specs, this script or the trust script changed in reviewed..head.
#   - BASE_SYNC_ONLY also needs the per-path diff shape (modes, status, binary blob ids) of both 3-dot diffs
#     to match: the +/- line comparison cannot see binary content or mode changes.
#
# bash 3.2 portable. No `set -e`: every read is captured and status-tested, never behind a pipe.

set -uo pipefail

ROUNDS=0
full() { echo "FULL"; echo "FULL_ROUNDS=${ROUNDS}"; exit 0; }

PR=""; HEAD_SHA=""; BASE=""; TRUSTED=""; COMMENTS_FILE=""; REPO=""; LABELS=""; LABELS_SET=0; REPO_PATH="."
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) [ $# -ge 2 ] || full; PR="$2"; shift 2 ;;
    --head) [ $# -ge 2 ] || full; HEAD_SHA="$2"; shift 2 ;;
    --base) [ $# -ge 2 ] || full; BASE="$2"; shift 2 ;;
    --trusted-script) [ $# -ge 2 ] || full; TRUSTED="$2"; shift 2 ;;
    --comments-file) [ $# -ge 2 ] || full; COMMENTS_FILE="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || full; REPO="$2"; shift 2 ;;
    --labels) [ $# -ge 2 ] || full; LABELS="$2"; LABELS_SET=1; shift 2 ;;
    --repo-path) [ $# -ge 2 ] || full; REPO_PATH="$2"; shift 2 ;;
    *) full ;;
  esac
done

valid_sha() { # 40 or 64 lowercase hex
  case "$1" in *[!0-9a-f]*|"") return 1 ;; esac
  [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]
}

case "$PR" in ''|*[!0-9]*) full ;; esac
valid_sha "$HEAD_SHA" || full
case "$BASE" in ''|-*|*[!A-Za-z0-9._/-]*|*..*) full ;; esac
case "$TRUSTED" in /*) ;; *) full ;; esac
[ -f "$TRUSTED" ] || full
case "$REPO" in *[!A-Za-z0-9._/-]*) full ;; esac
[ -d "$REPO_PATH" ] || full
command -v jq >/dev/null 2>&1 || full

G() { git -C "$REPO_PATH" -c core.quotepath=off "$@"; }

# ---- inputs: comments + labels --------------------------------------------------------------------------------
if [ -n "$COMMENTS_FILE" ]; then
  [ -f "$COMMENTS_FILE" ] && [ -r "$COMMENTS_FILE" ] || full
  COMMENTS_JSON=$(cat "$COMMENTS_FILE" 2>/dev/null) || full
else
  [ -n "$REPO" ] || full
  COMMENTS_JSON=$(gh api --paginate "repos/${REPO}/issues/${PR}/comments" 2>/dev/null) || full
fi
[ -n "$COMMENTS_JSON" ] || full

if [ "$LABELS_SET" -eq 0 ]; then
  [ -n "$REPO" ] || full
  LABELS=$(gh pr view "$PR" -R "$REPO" --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null) || full
fi
case ",${LABELS}," in *,review-degraded,*) full ;; esac

# ---- checkpoint: newest SHA with a trusted, complete, proven panel ---------------------------------------------
RE='^(?=[\s\S]*<!-- REVIEW-FINDINGS-START -->)<!-- FORGE:REVIEW-AGENT:[a-z-]+ -->|^<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->|# PR Review Summary|<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity|<!-- FORGE:REVIEW_DEGRADED|<!-- FORGE:REVIEW_BLOCKED'
BODIES=$(bash "$TRUSTED" bodies "$RE" 2>/dev/null <<< "$COMMENTS_JSON"); rc=$?
[ "$rc" -eq 0 ] || full

# Bodies arrive in comment order, one JSON string per line. Everything is decided in one jq pass over that order
# (the degraded markers carry no SHA and no timestamp, so relative order is the only signal).
JQ_PROG='
  def shas($t; $re): [ $t | scan($re) | .[0] ];
  def one($a): if ($a | length) == 1 then $a[0] else null end;
  to_entries as $E
  | ($E | map(select(.value | test("<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity|<!-- FORGE:REVIEW_DEGRADED|<!-- FORGE:REVIEW_BLOCKED")) | .key)) as $DEG
  | ([ $E[] | .key as $i | .value as $t
       | select($t | test("^(?=[\\s\\S]*<!-- REVIEW-FINDINGS-START -->)<!-- FORGE:REVIEW-AGENT:[a-z-]+ -->"))
       | one(shas($t; "(?:^|\\n)Reviewed-SHA: ([0-9a-f]{40}|[0-9a-f]{64})\\r?(?:\\n|$)")) as $s
       | select($s != null)
       | {i: $i, sha: $s, d: ($t | capture("^<!-- FORGE:REVIEW-AGENT:(?<d>[a-z-]+) -->").d)} ]) as $AG
  | ([ $E[] | .key as $i | .value as $t
       | select($t | startswith("<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->"))
       | one(shas($t; "(?:^|\\n)Reviewed-SHA: ([0-9a-f]{40}|[0-9a-f]{64})\\r?(?:\\n|$)")) as $s
       | select($s != null)
       | {i: $i, sha: $s} ]) as $SY
  | ([ $E[] | .key as $i | .value as $t
       | select($t | test("# PR Review Summary"))
       | one(shas($t; "\\*\\*Reviewed commit\\*\\*: `?([0-9a-f]{40}|[0-9a-f]{64})`?(?:[ |\\r\\n]|$)")) as $s
       | one(shas($t; "\\*\\*Agents\\*\\*: ([0-9]+)")) as $n
       | select($s != null and $n != null)
       | {i: $i, sha: $s, n: ($n | tonumber)} ]) as $SU
  | ([ $AG | group_by(.sha)[]
       | {sha: .[0].sha, first: (map(.i) | min), domains: (map(.d) | unique | length)}
       | . as $g
       | select(
           (($SY | map(select(.sha == $g.sha)) | length) > 0
            or ($SU | map(select(.sha == $g.sha and .n == $g.domains)) | length) > 0)
           and (($DEG | map(select(. > $g.first)) | length) == 0))
       | . + {last: ([ ($AG[] | select(.sha == $g.sha) | .i), ($SY[] | select(.sha == $g.sha) | .i),
                       ($SU[] | select(.sha == $g.sha) | .i) ] | max)} ]) as $OK
  | (if ($OK | length) == 0 then "-" else ($OK | max_by(.last) | .sha) end), ($OK | length)'
PARSED=$(jq -s -r "$JQ_PROG" 2>/dev/null <<< "$BODIES"); rc=$?
[ "$rc" -eq 0 ] || full
REVIEWED=$(printf '%s\n' "$PARSED" | sed -n '1p'); N=$(printf '%s\n' "$PARSED" | sed -n '2p')
case "$N" in ''|*[!0-9]*) full ;; esac
ROUNDS="$N"
[ "$REVIEWED" = "-" ] && full
valid_sha "$REVIEWED" || full

# ---- classification --------------------------------------------------------------------------------------------
G cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null || full
G cat-file -e "${REVIEWED}^{commit}" 2>/dev/null || full
G merge-base --is-ancestor "$REVIEWED" "$HEAD_SHA" 2>/dev/null; rc=$?
[ "$rc" -eq 0 ] || full   # 1 = force-push / rebase, >1 = git error: both FULL

NAMES=$(G diff --name-only --no-renames "$REVIEWED" "$HEAD_SHA" 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] || full
while IFS= read -r f; do
  case "$f" in
    forge.yaml|commands/review-pr*.md|commands/review-pr-agents/*|scripts/review-delta.sh|scripts/trusted-comments.sh) full ;;
  esac
done <<< "$NAMES"

DELTA_OUT="DELTA ${REVIEWED}..${HEAD_SHA}"

G rev-parse --verify --quiet "origin/${BASE}^{commit}" >/dev/null 2>&1 || full
CHAIN=$(G rev-list --first-parent "${REVIEWED}..${HEAD_SHA}" 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] || full
if [ -z "$CHAIN" ]; then echo "$DELTA_OUT"; echo "FULL_ROUNDS=${ROUNDS}"; exit 0; fi

# BASE_SYNC_ONLY needs every first-parent commit to be a clean merge of origin/<base>
SYNC=1
while IFS= read -r c; do
  [ -n "$c" ] || continue
  PARENTS=$(G rev-list --parents -n 1 "$c" 2>/dev/null); rc=$?
  [ "$rc" -eq 0 ] || full
  set -- $PARENTS
  if [ $# -ne 3 ]; then SYNC=0; break; fi            # not a plain two-parent merge
  G merge-base --is-ancestor "$3" "origin/${BASE}" 2>/dev/null; rc=$?
  [ "$rc" -le 1 ] || full
  if [ "$rc" -ne 0 ]; then SYNC=0; break; fi         # second parent is not base history
  CC=$(G diff-tree --cc --no-commit-id -r "$c" 2>/dev/null); rc=$?
  [ "$rc" -eq 0 ] || full
  if [ -n "$CC" ]; then SYNC=0; break; fi            # conflict-resolution content in the merge
done <<< "$CHAIN"

# per-path shape of a diff: modes, status and path for every file, plus both blob ids for binary files
# (whose content the +/- line comparison cannot see). Text blob ids are left out: they shift when base moves.
diff_shape() {
  local raw bin
  raw=$(G diff --raw --no-abbrev --no-renames "$1" 2>/dev/null) || return 1
  bin=$(G diff --numstat --no-renames "$1" 2>/dev/null) || return 1
  { printf '%s\n' "$bin"; printf '%s\n' '--RAW--'; printf '%s\n' "$raw"; } | awk -F'\t' '
    $0 == "--RAW--" { r = 1; next }
    !r { if ($1 == "-" && $2 == "-") b[$3] = 1; next }
    $0 == "" { next }
    { split($1, m, " "); line = m[1] " " m[2] " " m[5] "\t" $2; if ($2 in b) line = line " " m[3] " " m[4]; print line }'
}

if [ "$SYNC" -eq 1 ]; then
  # the PR's own change must be unchanged: compare the +/- lines of both 3-dot diffs (index/hunk numbers shift
  # when base moves, content lines do not)
  D_OLD=$(G diff --no-color --no-ext-diff --no-renames -U0 "origin/${BASE}...${REVIEWED}" 2>/dev/null); rc=$?
  [ "$rc" -eq 0 ] || full
  D_NEW=$(G diff --no-color --no-ext-diff --no-renames -U0 "origin/${BASE}...${HEAD_SHA}" 2>/dev/null); rc=$?
  [ "$rc" -eq 0 ] || full
  L_OLD=$(printf '%s\n' "$D_OLD" | sed -n '/^[-+]/p'); L_NEW=$(printf '%s\n' "$D_NEW" | sed -n '/^[-+]/p')
  # +/- lines miss binary content and mode changes, so the per-path shape must match too
  S_OLD=$(diff_shape "origin/${BASE}...${REVIEWED}") || full
  S_NEW=$(diff_shape "origin/${BASE}...${HEAD_SHA}") || full
  if [ "$L_OLD" = "$L_NEW" ] && [ "$S_OLD" = "$S_NEW" ]; then
    echo "BASE_SYNC_ONLY ${REVIEWED}"; echo "FULL_ROUNDS=${ROUNDS}"; exit 0
  fi
fi

echo "$DELTA_OUT"; echo "FULL_ROUNDS=${ROUNDS}"; exit 0
