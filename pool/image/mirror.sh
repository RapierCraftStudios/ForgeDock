#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Shared bare-mirror hygiene for checkout_repo (#5947). Usage: mirror.sh prepare <repo-url> <mirror-dir>
# Prints `ok` (the mirror is valid: clone with --reference) or `direct` (clone straight from the URL; the mirror is
# quarantined, missing or being rebuilt). Never exits non-zero for a mirror problem: a bad mirror must not fail a lane.
# A mirror is valid when it has refs and no zero-length file under objects/ (and, with MIRROR_FSCK=1, passes
# `git fsck --connectivity-only`). Builds go into <mirror>.tmp-<pid> under a per-repo flock and are renamed into place
# only after a successful clone with refs, so a timed-out clone never leaves a half mirror behind.
# Env: MIRROR_FETCH_RETRIES (3), MIRROR_RETRY_SLEEP (5s), MIRROR_LOCK_WAIT (900s), MIRROR_FSCK, MIRROR_BUILD_LOG (one line per build attempt).

mirror_valid() {
  local m="$1"
  [ -d "$m/objects" ] || return 1
  [ -n "$(git -C "$m" for-each-ref --count=1 2>/dev/null)" ] || return 1
  [ -z "$(find "$m/objects" -type f -size 0 -print -quit 2>/dev/null)" ] || return 1
  if [ "${MIRROR_FSCK:-}" = "1" ]; then git -C "$m" fsck --connectivity-only --no-dangling >/dev/null 2>&1 || return 1; fi
  return 0
}

mirror_quarantine() {
  local m="$1" dest
  dest="$m.corrupt-$(date +%s)-$$"
  mv "$m" "$dest" 2>/dev/null || rm -rf "$m"
}

# Caller holds the lock. Returns 0 only when a valid mirror now sits at $2.
mirror_build() {
  local url="$1" m="$2" tmp="$2.tmp-$$" i=1 n="${MIRROR_FETCH_RETRIES:-3}"
  rm -rf "$m".tmp-* 2>/dev/null # leftovers of a killed build (the lock makes us the only builder)
  while [ "$i" -le "$n" ]; do
    [ -z "${MIRROR_BUILD_LOG:-}" ] || echo "build $i $$" >> "$MIRROR_BUILD_LOG"
    if git clone --mirror --quiet "$url" "$tmp" >/dev/null 2>&1 && mirror_valid "$tmp"; then
      mv "$tmp" "$m" && return 0
    fi
    rm -rf "$tmp"
    [ "$i" -lt "$n" ] && sleep "${MIRROR_RETRY_SLEEP:-5}"
    i=$((i + 1))
  done
  return 1
}

mirror_prepare() {
  local url="$1" m="$2" lock
  mkdir -p "$(dirname "$m")" 2>/dev/null
  lock="$m.lock"
  if [ -d "$m" ] && ! mirror_valid "$m"; then
    # Bad mirror: set it aside for everyone, rebuild once in the background, this lane clones directly.
    ( flock -w "${MIRROR_LOCK_WAIT:-900}" 9 || exit 0
      if [ -d "$m" ] && ! mirror_valid "$m"; then mirror_quarantine "$m"; fi
      [ -d "$m" ] || mirror_build "$url" "$m" ) 9>"$lock" >/dev/null 2>&1 </dev/null &
    echo direct; return 0
  fi
  (
    flock -w "${MIRROR_LOCK_WAIT:-900}" 9 || { echo direct; exit 0; }
    if [ -d "$m" ]; then
      git -C "$m" fetch --prune --quiet origin '+refs/heads/*:refs/heads/*' >/dev/null 2>&1 || true
      if mirror_valid "$m"; then echo ok; else echo direct; fi
    elif mirror_build "$url" "$m"; then echo ok
    else echo direct; fi
  ) 9>"$lock"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    prepare) [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "usage: mirror.sh prepare <url> <mirror-dir>" >&2; exit 2; }
             mirror_prepare "$2" "$3" ;;
    valid) mirror_valid "${2:?mirror dir}" ;;
    *) echo "usage: mirror.sh prepare <url> <mirror-dir> | valid <mirror-dir>" >&2; exit 2 ;;
  esac
fi
