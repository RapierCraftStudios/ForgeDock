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
# (`origin/<default>:forge.yaml`, falling back to the contents API) or of an
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

CFG_DEFAULT=""
# Committed default-branch config only (a ref, never the working tree).
CFG_DEFAULT=$(git show "origin/${GH_DEFAULT}:forge.yaml" 2>/dev/null | _cfg_default)
if [ -z "$CFG_DEFAULT" ]; then
  CFG_DEFAULT=$(gh api "repos/${REPO}/contents/forge.yaml?ref=${GH_DEFAULT}" --jq .content 2>/dev/null \
    | base64 -d 2>/dev/null | _cfg_default)
fi
[ -n "$CFG_DEFAULT" ] && [ "$CFG_DEFAULT" != "null" ] && [ "$BASE" = "$CFG_DEFAULT" ] && emit true

if [ -n "${FORGE_TRUSTED_CONFIG:-}" ] && [ -f "$FORGE_TRUSTED_CONFIG" ]; then
  TRUSTED=$(_cfg_default < "$FORGE_TRUSTED_CONFIG")
  [ -n "$TRUSTED" ] && [ "$TRUSTED" != "null" ] && [ "$BASE" = "$TRUSTED" ] && emit true
fi

emit false
