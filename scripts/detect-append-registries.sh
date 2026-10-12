#!/usr/bin/env bash
# detect-append-registries.sh — find append-only registry files and prove a merge=union policy is safe (forge#3969).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# A registry is a hand-maintained list that most PRs append to (test paths, cron targets). Two PRs appending at the
# same spot conflict textually although every line is independent, which costs a base-sync remediation round.
#
# Usage:
#   detect-append-registries.sh --detect [--repo <dir>] [--since <git date>] [--min-commits N] [--ratio PCT] [--limit N]
#       Rank files from `git log --numstat`: touched by >= N commits (default 5), >= PCT% of them add-only (default 80).
#       Output, one per line: <touches> <add-only> <path>   (sorted by touches, descending). Read-only.
#   detect-append-registries.sh --check-union <path> [--repo <dir>]
#       Prove in a throwaway repo (mktemp -d) that two branches appending different lines to <path> conflict without
#       merge=union and merge cleanly with it, both lines surviving. Never touches the caller's repo or git config.
#       Structured files (JSON/YAML/TOML/XML/lock files) are always rejected: union would corrupt ordering or structure.
# Exit:  0 detect ok / union safe, 1 union NOT safe, 2 usage error
# Bash 3.2 portable: no assoc arrays, mapfile, grep -P. Honours no FORGEDOCK_HOME (self-contained).
set -uo pipefail

usage() { sed -n '6,17p' "$0" >&2; exit 2; }
MODE=""; REPO="."; SINCE="90 days ago"; MIN=5; RATIO=80; LIMIT=20; TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --detect) MODE=detect ;;
    --check-union) MODE=check; TARGET="${2-}"; [ $# -ge 2 ] || usage; shift ;;
    --repo) REPO="${2-}"; [ $# -ge 2 ] || usage; shift ;;
    --since) SINCE="${2-}"; [ $# -ge 2 ] || usage; shift ;;
    --min-commits) MIN="${2-}"; [ $# -ge 2 ] || usage; shift ;;
    --ratio) RATIO="${2-}"; [ $# -ge 2 ] || usage; shift ;;
    --limit) LIMIT="${2-}"; [ $# -ge 2 ] || usage; shift ;;
    *) usage ;;
  esac
  shift
done
[ -n "$MODE" ] || usage
for n in "$MIN" "$RATIO" "$LIMIT"; do case "$n" in ''|*[!0-9]*) echo "detect-append-registries: numeric option expected, got '$n'" >&2; exit 2 ;; esac; done

if [ "$MODE" = detect ]; then
  git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "detect-append-registries: not a git repo: $REPO" >&2; exit 2; }
  # numstat: "<added>\t<deleted>\t<path>"; binaries show "-". Merge commits are skipped (--no-merges).
  LOG=$(git -C "$REPO" log --no-merges --since="$SINCE" --numstat --format= 2>/dev/null) || LOG=""
  printf '%s\n' "$LOG" | awk -F'\t' -v min="$MIN" -v ratio="$RATIO" '
    NF >= 3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {
      p = $3; t[p]++; if ($2 == 0 && $1 > 0) a[p]++
    }
    END { for (p in t) if (t[p] >= min && (a[p] + 0) * 100 >= ratio * t[p]) printf "%d %d %s\n", t[p], a[p] + 0, p }
  ' | sort -rn -k1,1 -k2,2 | head -n "$LIMIT"
  exit 0
fi

# --- --check-union
[ -n "$TARGET" ] || usage
case "$TARGET" in /*|../*|*/../*|..) echo "detect-append-registries: path must be repo-relative: $TARGET" >&2; exit 2 ;; esac
case "$TARGET" in *[[:space:]]*|*'['*|*'*'*|*'?'*|*'\'*) echo "UNION UNSAFE: $TARGET (whitespace or glob characters in path)"; exit 1 ;; esac
case "$(printf '%s' "$TARGET" | tr 'A-Z' 'a-z')" in
  *.json|*.jsonc|*.yml|*.yaml|*.toml|*.xml|*.lock|*lock.json|*.sum|*.csv|*.md)
    echo "UNION UNSAFE: $TARGET is a structured or ordered file type (union can corrupt structure, ordering or uniqueness)"; exit 1 ;;
esac

TMP=$(mktemp -d) || { echo "detect-append-registries: mktemp failed" >&2; exit 2; }
trap 'rm -rf "$TMP"' EXIT
# hermetic git: no user config, hooks or signing; never reads or writes the caller's repo configuration
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
W="$TMP/w"
g() { git -C "$W" -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }
git init -q "$W" 2>/dev/null || { echo "detect-append-registries: git init failed" >&2; exit 2; }
g checkout -q -b base 2>/dev/null
mkdir -p "$W/$(dirname "$TARGET")"
# seed with the real file's committed content when available, else a small stand-in list
if git -C "$REPO" cat-file -e "HEAD:$TARGET" 2>/dev/null; then
  git -C "$REPO" show "HEAD:$TARGET" > "$W/$TARGET" 2>/dev/null
else
  printf 'entry-1\nentry-2\nentry-3\n' > "$W/$TARGET"
fi
[ -s "$W/$TARGET" ] && [ -n "$(tail -c1 "$W/$TARGET")" ] && printf '\n' >> "$W/$TARGET"
g add -A >/dev/null; g commit -q -m seed >/dev/null

append_branch() { # name line
  g checkout -q -b "$1" base 2>/dev/null
  printf '%s\n' "$2" >> "$W/$TARGET"
  g add -A >/dev/null; g commit -q -m "append $2" >/dev/null
}
append_branch side-a "forge-union-probe-a"
append_branch side-b "forge-union-probe-b"

# 1. without union the same-spot appends must conflict (otherwise the probe proves nothing)
g checkout -q side-a 2>/dev/null
if g merge -q --no-edit side-b >/dev/null 2>&1; then
  echo "UNION UNSAFE: $TARGET does not conflict without union (probe is not meaningful)"; exit 1
fi
g merge --abort >/dev/null 2>&1

# 2. with union both lines must survive
g reset -q --hard side-a
printf '%s merge=union\n' "$TARGET" > "$W/.git/info/attributes"
if ! g merge -q --no-edit side-b >/dev/null 2>&1; then
  echo "UNION UNSAFE: $TARGET still conflicts with merge=union"; exit 1
fi
if ! grep -qxF 'forge-union-probe-a' "$W/$TARGET" || ! grep -qxF 'forge-union-probe-b' "$W/$TARGET"; then
  echo "UNION UNSAFE: $TARGET lost an appended line under merge=union"; exit 1
fi
echo "UNION SAFE: $TARGET (same-spot appends conflict without union, merge cleanly with it)"
echo "REMINDER: this proves the mechanism only. Add the .gitattributes entry only if every line in $TARGET is independent."
exit 0
