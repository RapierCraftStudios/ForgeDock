#!/bin/bash
# Compatibility entrypoint. The maintained installer is cross-platform Node.
set -euo pipefail

FORGE_HOME="$(cd "$(dirname "$0")" && pwd)"
exec node "$FORGE_HOME/bin/forgedock.mjs" opencode install "$@"
