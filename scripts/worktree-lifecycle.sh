#!/usr/bin/env bash
# worktree-lifecycle.sh — Deterministic git worktree create/reuse/cleanup engine
#
# Usage:
#   worktree-lifecycle.sh ensure <path> <branch> <base-ref>
#   worktree-lifecycle.sh cleanup <path> <branch>
#
# Subcommands:
#
#   ensure <path> <branch> <base-ref>
#     Idempotent worktree provisioning — replaces the LLM judgment call in
#     work-on.md Phase 3E ("If worktree already exists: verify correct
#     branch, reuse or remove and recreate.").
#
#       - No worktree registered at <path>:
#           - Local branch <branch> already exists and is NOT checked out
#             in another worktree  -> attach it at <path> (preserves any
#             existing commits — covers the "worktree was lost but the
#             branch survived" resume case).
#           - Local branch <branch> already exists and IS checked out in
#             another worktree      -> ERROR (exit 1). Two worktrees cannot
#             share one branch; this needs human intervention, not silent
#             repair.
#           - Local branch <branch> does not exist
#                                    -> git worktree add <path> -b <branch> <base-ref>
#       - A worktree is already registered at <path>:
#           - already on <branch>   -> reuse, no destructive action (OK).
#           - on a different branch -> git worktree remove <path> --force,
#                                       then re-run the "no worktree" logic above.
#
#   cleanup <path> <branch>
#     Removes the worktree at <path> (tolerant of already-removed state)
#     and force-deletes the local branch <branch> (tolerant of
#     already-deleted state). Matches work-on.md Phase 6E exactly.
#
# Exit codes:
#   0 = success (worktree ensured / cleaned up, including no-op reuse)
#   1 = error (bad args, branch already checked out elsewhere, git failure)
#
# Notes:
#   - Must be invoked from inside the target git repository (any worktree
#     of it — main or linked) OR with <path> pointing at an existing
#     worktree of it. `git worktree`/`git branch` subcommands operate on
#     the whole repository regardless of which worktree anchors the `-C`.
#
# Examples:
#   worktree-lifecycle.sh ensure /repo/.claude/worktrees/fix-123 fix/thing-123 origin/staging
#   worktree-lifecycle.sh cleanup /repo/.claude/worktrees/fix-123 fix/thing-123

set -euo pipefail

# Export universal script environment so per-repo adaptive scripts can
# delegate back into universal scripts (see devdocs/project/architecture.md
# → Script Precedence).
export FORGEDOCK_SCRIPTS
FORGEDOCK_SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
export FORGEDOCK_HOME
FORGEDOCK_HOME="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "Usage:" >&2
  echo "  worktree-lifecycle.sh ensure <path> <branch> <base-ref>" >&2
  echo "  worktree-lifecycle.sh cleanup <path> <branch>" >&2
}

# ---------------------------------------------------------------------------
# resolve_repo_anchor [fallback_path]
#
# Returns a directory suitable for `git -C <dir> worktree ...` /
# `git -C <dir> branch ...` — any directory inside the repository works,
# main or linked worktree alike, as long as it stays valid for the whole
# operation. Prefers the invoking cwd (matches the calling convention used
# throughout work-on.md — callers `cd {REPO_PATH}` before invoking scripts)
# so the anchor is never the same path that `ensure`/`cleanup` may remove
# mid-operation. Only falls back to `fallback_path` (e.g. the target
# worktree itself) when cwd is not inside a git repo at all.
# ---------------------------------------------------------------------------
resolve_repo_anchor() {
  local fallback="${1:-}"
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    pwd
    return 0
  fi
  if [ -n "$fallback" ] && [ -d "$fallback" ] && git -C "$fallback" rev-parse --show-toplevel >/dev/null 2>&1; then
    echo "$fallback"
    return 0
  fi
  echo "ERROR: not inside a git repository, and '$fallback' is not a valid worktree to anchor to" >&2
  exit 1
}

if [ "$#" -lt 1 ]; then
  echo "ERROR: subcommand required (ensure|cleanup)" >&2
  usage
  exit 1
fi

SUBCOMMAND="$1"
shift

case "$SUBCOMMAND" in
  ensure)
    if [ "$#" -ne 3 ]; then
      echo "ERROR: ensure requires exactly 3 arguments: <path> <branch> <base-ref>" >&2
      usage
      exit 1
    fi
    WT_PATH="$1"
    BRANCH="$2"
    BASE_REF="$3"

    if [ -z "$WT_PATH" ] || [ -z "$BRANCH" ] || [ -z "$BASE_REF" ]; then
      echo "ERROR: <path>, <branch>, and <base-ref> must all be non-empty" >&2
      exit 1
    fi

    ANCHOR=$(resolve_repo_anchor "$WT_PATH")

    # -----------------------------------------------------------------
    # attach_or_create <path> <branch> <base-ref>
    # Assumes no worktree is currently registered at <path>.
    # -----------------------------------------------------------------
    attach_or_create() {
      local path="$1" branch="$2" base_ref="$3"

      if git -C "$ANCHOR" show-ref --verify --quiet "refs/heads/$branch"; then
        local existing_wt
        existing_wt=$(git -C "$ANCHOR" worktree list --porcelain | awk -v b="refs/heads/$branch" '
            /^worktree /{wt=$2}
            /^branch /{if ($2==b) print wt}
          ')
        if [ -n "$existing_wt" ]; then
          echo "ERROR: branch '$branch' is already checked out in worktree '$existing_wt' — cannot attach it at '$path'" >&2
          echo "       Resolve manually: remove the stale worktree, or choose a different branch/path." >&2
          exit 1
        fi
        echo "Branch '$branch' exists locally — attaching it at '$path' (preserving existing commits)..."
        git -C "$ANCHOR" worktree add -- "$path" "$branch"
      else
        echo "Creating new branch '$branch' from '$base_ref' at '$path'..."
        git -C "$ANCHOR" worktree add -b "$branch" -- "$path" "$base_ref"
      fi
      echo "OK: worktree ready at '$path' on branch '$branch'"
    }

    ABS_WT_PATH=$(realpath -m "$WT_PATH")
    REGISTERED=$(git -C "$ANCHOR" worktree list --porcelain | awk -v p="$ABS_WT_PATH" '
        /^worktree /{if ($2==p) print $2}
      ')

    if [ -z "$REGISTERED" ]; then
      # No worktree registered at this path per git. If a stray non-worktree
      # directory already exists there, fail loud rather than silently
      # clobbering unrelated content.
      if [ -e "$WT_PATH" ] && [ ! -e "$WT_PATH/.git" ]; then
        echo "ERROR: '$WT_PATH' exists but is not a registered git worktree — refusing to overwrite it" >&2
        exit 1
      fi
      attach_or_create "$WT_PATH" "$BRANCH" "$BASE_REF"
    else
      CURRENT_BRANCH=$(git -C "$REGISTERED" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
      if [ "$CURRENT_BRANCH" = "$BRANCH" ]; then
        echo "OK: worktree at '$REGISTERED' already on branch '$BRANCH' — reusing (no action)"
      else
        echo "Worktree at '$REGISTERED' is on branch '${CURRENT_BRANCH:-<detached>}', expected '$BRANCH' — removing and recreating..."
        git -C "$ANCHOR" worktree remove "$REGISTERED" --force
        attach_or_create "$WT_PATH" "$BRANCH" "$BASE_REF"
      fi
    fi
    ;;

  cleanup)
    if [ "$#" -ne 2 ]; then
      echo "ERROR: cleanup requires exactly 2 arguments: <path> <branch>" >&2
      usage
      exit 1
    fi
    WT_PATH="$1"
    BRANCH="$2"

    if [ -z "$WT_PATH" ] || [ -z "$BRANCH" ]; then
      echo "ERROR: <path> and <branch> must both be non-empty" >&2
      exit 1
    fi

    ANCHOR=$(resolve_repo_anchor "$WT_PATH")

    echo "Removing worktree at '$WT_PATH' (if present)..."
    git -C "$ANCHOR" worktree remove "$WT_PATH" --force 2>/dev/null || true

    echo "Deleting local branch '$BRANCH' (if present)..."
    git -C "$ANCHOR" branch -D -- "$BRANCH" 2>/dev/null || true

    echo "OK: cleanup complete for '$WT_PATH' / '$BRANCH'"
    ;;

  *)
    echo "ERROR: unknown subcommand '$SUBCOMMAND' (expected: ensure|cleanup)" >&2
    usage
    exit 1
    ;;
esac
