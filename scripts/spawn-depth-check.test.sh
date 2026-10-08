#!/usr/bin/env bash
# spawn-depth-check.test.sh — cases for scripts/spawn-depth-check.sh (forge#3398).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/spawn-depth-check.sh"
PASS=0; FAILN=0
t() { # name want-rc want-prefix env-assignments... -- args...
  local name="$1" want="$2" prefix="$3"; shift 3
  local envs=() args=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ $# -gt 0 ] && shift
  args=(); [ $# -gt 0 ] && args=("$@")
  local out rc
  out=$(env -u CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH -u FORGE_CLAUDE_VERSION -u FORGE_RUNTIME \
        -u OPENCODE_SESSION_ID -u OPENCODE_PID -u OPENCODE ${envs[@]+"${envs[@]}"} bash "$S" ${args[@]+"${args[@]}"} 2>&1); rc=$?
  if [ "$rc" = "$want" ] && [ "${out#"$prefix"}" != "$out" ]; then PASS=$((PASS+1))
  else FAILN=$((FAILN+1)); echo "FAIL: $name (rc=$rc want $want; out=$out)"; fi
}
# Version defaults: 2.1.219+ = 3, 2.1.217-218 = 1, 2.1.172-216 = 5.
t "current default solo"          0 "SPAWN_DEPTH: OK"      FORGE_CLAUDE_VERSION="2.1.294 (Claude Code)" --
t "current default orchestrated"  0 "SPAWN_DEPTH: OK"      FORGE_CLAUDE_VERSION=2.1.294 -- --router-layer 1
t "boundary 2.1.219 orchestrated" 0 "SPAWN_DEPTH: OK"      FORGE_CLAUDE_VERSION=2.1.219 -- --router-layer 1
t "depth-1 window solo"           1 "SPAWN_DEPTH: FAIL"    FORGE_CLAUDE_VERSION=2.1.217 --
t "depth-1 window 2.1.218"        1 "SPAWN_DEPTH: FAIL"    FORGE_CLAUDE_VERSION=2.1.218 -- --router-layer 1
t "five-layer era orchestrated"   0 "SPAWN_DEPTH: OK"      FORGE_CLAUDE_VERSION=2.1.200 -- --router-layer 1
t "boundary 2.1.172"              0 "SPAWN_DEPTH: OK"      FORGE_CLAUDE_VERSION=2.1.172 -- --router-layer 1
t "pre-nesting version unknown"   0 "SPAWN_DEPTH: UNKNOWN" FORGE_CLAUDE_VERSION=2.1.100 -- --router-layer 1
t "future minor uses 3"           0 "SPAWN_DEPTH: OK"      FORGE_CLAUDE_VERSION=2.2.0 -- --router-layer 1
t "unparseable version unknown"   0 "SPAWN_DEPTH: UNKNOWN" FORGE_CLAUDE_VERSION=garbage --
# Explicit env wins over the version default.
t "env 2 orchestrated fails"      1 "SPAWN_DEPTH: FAIL"    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2 FORGE_CLAUDE_VERSION=2.1.294 -- --router-layer 1
t "env 2 solo ok"                 0 "SPAWN_DEPTH: OK"      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2 FORGE_CLAUDE_VERSION=2.1.294 --
t "env 1 disables nesting"        1 "SPAWN_DEPTH: FAIL"    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 --
t "env raises old window"         0 "SPAWN_DEPTH: OK"      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=3 FORGE_CLAUDE_VERSION=2.1.217 -- --router-layer 1
t "env non-integer unknown"       0 "SPAWN_DEPTH: UNKNOWN" CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=abc --
# Non-Claude runtimes skip.
t "codex skip"                    0 "SPAWN_DEPTH: SKIP"    FORGE_RUNTIME=codex CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 --
t "opencode marker skip"          0 "SPAWN_DEPTH: SKIP"    OPENCODE_SESSION_ID=x CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 --
# Usage errors.
t "bad router layer"              2 "spawn-depth-check:"   -- --router-layer x
t "unknown flag"                  2 "usage:"               -- --nope
echo "spawn-depth-check: ${PASS} passed, ${FAILN} failed"
[ "$FAILN" -eq 0 ]
