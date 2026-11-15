#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Read-only git mirror (pool/services/docker-compose.yml): keeps a bare mirror of every URL in GIT_MIRROR_REPOS
# (space-separated https URLs of public repos) under /srv/git/<owner>/<name>.git and serves them over git://.
set -u
# git-daemon is a separate package on Alpine.
apk add --no-cache git git-daemon >/dev/null 2>&1 || echo "apk add git git-daemon failed (already present?)"
git daemon --reuseaddr --export-all --base-path=/srv/git --listen=0.0.0.0 --port=9418 /srv/git &
while true; do
  for url in ${GIT_MIRROR_REPOS:-}; do
    rel="$(printf '%s' "$url" | sed -e 's#^https\{0,1\}://[^/]*/##' -e 's#\.git$##').git"
    case "$rel" in *..*|/*) echo "skipped: $url"; continue ;; esac
    if [ -d "/srv/git/$rel" ]; then
      git -C "/srv/git/$rel" remote update --prune >/dev/null 2>&1 || echo "refresh failed: $rel"
    else
      mkdir -p "$(dirname "/srv/git/$rel")"
      git clone --mirror --quiet "$url" "/srv/git/$rel" || echo "clone failed: $url"
    fi
  done
  sleep "${GIT_MIRROR_INTERVAL:-60}"
done
