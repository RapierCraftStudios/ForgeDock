#!/usr/bin/env bash
# postdeploy-rollup-link.sh — print the deploy PR's link to the release lane's post-deploy rollup (#4727).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: postdeploy-rollup-link.sh --repo OWNER/REPO
# Finds the lowest open, trusted, non-PR issue carrying <!-- FORGE:POSTDEPLOY_ROLLUP: <lane> --> (same search and trust
# rule as find_rollup in file-deferred-followups.sh) and prints `Post-deploy checklist: #N`.
# Prints nothing and exits 0 when there is none or a lookup fails: a missing link never blocks a deploy.
# Env: FORGE_RELEASE_LANE (default `default`), FORGE_TRAIL_TRUSTED_ASSOCIATIONS (default OWNER,MEMBER,COLLABORATOR),
#      FORGE_TRAIL_TRUSTED_LOGINS (default empty). bash 3.2 portable.

set -uo pipefail
REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || { echo "postdeploy-rollup-link: --repo requires a value" >&2; exit 2; }; REPO="$2"; shift 2 ;;
    *) echo "usage: postdeploy-rollup-link.sh --repo OWNER/REPO" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "postdeploy-rollup-link: --repo required" >&2; exit 2; }

LANE="${FORGE_RELEASE_LANE:-default}"
MARKER="<!-- FORGE:POSTDEPLOY_ROLLUP: ${LANE} -->"
TRUSTED_ASSOC="${FORGE_TRAIL_TRUSTED_ASSOCIATIONS-OWNER,MEMBER,COLLABORATOR}"
TRUSTED_LOGINS="${FORGE_TRAIL_TRUSTED_LOGINS-}"
JQ_PRE='def lst: split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0));
  def trusted: ((.author_association // "") as $x | ($assoc | lst) | index($x) != null)
    or ((.user.type // "") == "Bot")
    or ((.user.login // "") as $x | ($logins | lst) | index($x) != null);'

cands=$(gh api -X GET search/issues -f per_page=50 -f q="\"FORGE:POSTDEPLOY_ROLLUP: ${LANE}\" in:body repo:${REPO} is:issue is:open" 2>/dev/null \
  | jq -r '[.items[].number] | sort_by(.) | .[]' 2>/dev/null) || exit 0
for n in $cands; do
  out=$(gh api "repos/${REPO}/issues/${n}" 2>/dev/null) || exit 0
  hit=$(printf '%s' "$out" | jq -r --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg m "$MARKER" "$JQ_PRE"'
      select(.pull_request == null) | select(trusted) | select(.state == "open") | select((.body // "") | contains($m)) | .number' 2>/dev/null) || exit 0
  if [ -n "$hit" ]; then echo "Post-deploy checklist: #${hit}"; exit 0; fi
done
exit 0
