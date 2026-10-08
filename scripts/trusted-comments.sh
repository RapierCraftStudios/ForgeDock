#!/usr/bin/env bash
# trusted-comments.sh — the ONE trust predicate for FORGE marker comments read by the review/merge gates.
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Reads the JSON of `gh api --paginate repos/<repo>/issues/<n>/comments` on stdin (one array, or several
# concatenated arrays from pagination) and keeps only comments from a trusted author. A comment is trusted when
#   - its author_association is in FORGE_TRAIL_TRUSTED_ASSOCIATIONS (default OWNER,MEMBER,COLLABORATOR), OR
#   - its user.type is "Bot" (a GitHub App installation always reports author_association NONE), OR
#   - its user.login is in FORGE_TRAIL_TRUSTED_LOGINS (default empty).
# This is the same predicate as scripts/verify-phase-trail.sh; trusted-comments.test.sh guards against drift.
# ${VAR-default} (no colon): an explicitly empty association list trusts no association (fail closed).
#
# Usage:
#   gh api --paginate ... | bash scripts/trusted-comments.sh count  '<jq regex>'   # prints the number of trusted comments whose body matches
#   gh api --paginate ... | bash scripts/trusted-comments.sh bodies '<jq regex>'   # prints each matching trusted body as one JSON string per line
# The regex is matched against the raw body (use ^ to anchor at the marker start).
# Exit: 0 ok; 2 usage error, invalid regex or unparsable input (stdout empty) so callers fail closed.

set -uo pipefail

MODE="${1:-}"; RE="${2-}"
case "$MODE" in count|bodies) ;; *) echo "usage: trusted-comments.sh count|bodies <regex>" >&2; exit 2 ;; esac
[ -n "$RE" ] || { echo "trusted-comments.sh: empty regex" >&2; exit 2; }

TRUSTED_ASSOC="${FORGE_TRAIL_TRUSTED_ASSOCIATIONS-OWNER,MEMBER,COLLABORATOR}"
TRUSTED_LOGINS="${FORGE_TRAIL_TRUSTED_LOGINS-}"

if [ "$MODE" = "count" ]; then OUT='length'; JQ_FLAGS=(-r); else OUT='.[]'; JQ_FLAGS=(-c); fi

OUTPUT=$(jq -s "${JQ_FLAGS[@]}" --arg assoc "$TRUSTED_ASSOC" --arg logins "$TRUSTED_LOGINS" --arg re "$RE" '
  ($assoc | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $A
  | ($logins | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $L
  | [ .[][]
      | select(
          ((.author_association // "") as $x | $A | index($x) != null)
          or ((.user.type // "") == "Bot")
          or ((.user.login // "") as $x | $L | index($x) != null)
        )
      | select((.body // "") | test($re))
      | (.body // "")
    ] | '"$OUT" 2>/dev/null) || { echo "trusted-comments.sh: could not parse comments or regex" >&2; exit 2; }
[ -z "$OUTPUT" ] && [ "$MODE" = "count" ] && { echo "trusted-comments.sh: no output" >&2; exit 2; }
[ -z "$OUTPUT" ] || printf '%s\n' "$OUTPUT"
exit 0
