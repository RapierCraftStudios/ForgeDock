#!/usr/bin/env bash
# resolve-deploy-gate.sh — trusted deploy-gate resolver (forge#3753)
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Usage: resolve-deploy-gate.sh <base> <owner/repo>
#
# Prints exactly one line: `true` (deploy gate, strict human bar) or `false`
# (fast lane). Always exits 0; every failure path prints `true` (fail closed).
#
# A base is the deploy gate when it is empty/`null`, the literal `main` (hard
# floor), the repository's GitHub default branch (`default_branch`), or the
# `branches.default` of the default branch's COMMITTED forge.yaml
# (`refs/remotes/origin/<default>:forge.yaml`, falling back to the contents API;
# if neither source is readable the result is `true`, never `false`; a source that
# cleanly reports forge.yaml absent is "no config" and falls through) or of an
# explicit trusted config (FORGE_TRUSTED_CONFIG, orchestrator-supplied).
#
# It NEVER reads forge.yaml from $PWD: the PR worktree is author-controlled, so
# a PR could otherwise redefine which branch counts as the deploy gate.
# Config sources can only ADD gate branches; main and the GitHub default are
# unconditional, so no source relaxes the bar below the literal-main floor.
set -uo pipefail

BASE="${1:-}"
REPO="${2:-}"

emit() { printf '%s\n' "$1"; exit 0; }

{ [ -z "$BASE" ] || [ "$BASE" = "null" ] || [ "$BASE" = "main" ]; } && emit true
[ -n "$REPO" ] || emit true

GH_DEFAULT=$(gh api "repos/${REPO}" --jq .default_branch 2>/dev/null || echo "")
{ [ -z "$GH_DEFAULT" ] || [ "$GH_DEFAULT" = "null" ]; } && emit true
[ "$BASE" = "$GH_DEFAULT" ] && emit true

_cfg_default() { yq '.branches.default // ""' 2>/dev/null || true; }

# Parse stdin's branches.default. Returns non-zero when yq is missing or the
# parse fails, so "config unreadable" is distinguishable from "no branches.default".
_cfg_parse() { command -v yq >/dev/null 2>&1 && yq '.branches.default // ""' 2>/dev/null; }

CFG_DEFAULT=""
READ_OK=""
# Committed default-branch config only (a ref, never the working tree). The
# fully-qualified ref cannot be shadowed by a local tag/branch named origin/<default>.
# A present ref with no forge.yaml at that path is a clean "no config" read (READ_OK,
# empty default); an unfetched ref, missing yq or parse error stays unreadable.
CFG_REF="refs/remotes/origin/${GH_DEFAULT}"
if git rev-parse -q --verify "${CFG_REF}^{commit}" >/dev/null 2>&1; then
  if git cat-file -e "${CFG_REF}:forge.yaml" 2>/dev/null; then
    CFG_RAW=$(git show "${CFG_REF}:forge.yaml" 2>/dev/null) && [ -n "$CFG_RAW" ] \
      && CFG_DEFAULT=$(printf '%s\n' "$CFG_RAW" | _cfg_parse) && READ_OK=1
  else
    READ_OK=1
  fi
fi
if [ -z "$READ_OK" ]; then
  CFG_DEFAULT=""
  API_OUT=$(gh api "repos/${REPO}/contents/forge.yaml?ref=${GH_DEFAULT}" --jq .content 2>&1); API_RC=$?
  if [ "$API_RC" -eq 0 ]; then
    CFG_RAW=$(printf '%s' "$API_OUT" | base64 -d 2>/dev/null) && [ -n "$CFG_RAW" ] \
      && CFG_DEFAULT=$(printf '%s\n' "$CFG_RAW" | _cfg_parse) && READ_OK=1
  elif printf '%s' "$API_OUT" | grep -q 'HTTP 404'; then
    READ_OK=1   # API says the file does not exist: clean "no config", not a read failure
  fi
fi
# Config unreadable from every source (no yq, ref unfetched, API failing): fail closed.
[ -n "$READ_OK" ] || emit true
[ -n "$CFG_DEFAULT" ] && [ "$CFG_DEFAULT" != "null" ] && [ "$BASE" = "$CFG_DEFAULT" ] && emit true

if [ -n "${FORGE_TRUSTED_CONFIG:-}" ] && [ -f "$FORGE_TRUSTED_CONFIG" ]; then
  TRUSTED=$(_cfg_default < "$FORGE_TRUSTED_CONFIG")
  [ -n "$TRUSTED" ] && [ "$TRUSTED" != "null" ] && [ "$BASE" = "$TRUSTED" ] && emit true
fi

emit false
