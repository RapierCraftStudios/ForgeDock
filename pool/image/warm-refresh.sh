#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Refreshes a warm sandbox's checkout to the lane's base ref (#4912): an incremental fetch into the existing clone, then
# a hard reset, so installed dependencies and ignored files stay. Usage: warm-refresh.sh [<ref>] (run in the checkout).
set -euo pipefail
ref="${1:-}"
if [ -n "$ref" ]; then
  git fetch --quiet origin "$ref"
  git checkout --quiet --force -B "$ref" FETCH_HEAD
else
  git fetch --quiet origin HEAD
fi
git reset --quiet --hard FETCH_HEAD
