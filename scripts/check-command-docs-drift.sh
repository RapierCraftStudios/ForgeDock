#!/usr/bin/env bash
# check-command-docs-drift.sh
#
# Drift check: every installable command spec in commands/ must have a section
# in docs/site/command-reference.md, and every command section in the reference
# must have a corresponding spec file.
#
# "Installable" means: install: core (or no install: key) in YAML frontmatter.
# Commands with install: internal or install: extras are excluded.
#
# Exit codes:
#   0 — no drift
#   1 — drift detected (missing docs or orphaned reference sections)
#
# Usage:
#   bash scripts/check-command-docs-drift.sh [commands-dir] [reference-file]
#
# Defaults:
#   commands-dir   = commands/
#   reference-file = docs/site/command-reference.md

set -euo pipefail

# Normalise COMMANDS_DIR: strip trailing slash so path arithmetic is consistent
# regardless of whether the caller passes "commands" or "commands/".
COMMANDS_DIR="${1:-commands}"
COMMANDS_DIR="${COMMANDS_DIR%/}"
REFERENCE="${2:-docs/site/command-reference.md}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# get_install_tier <file>
# Reads the first `install:` key from YAML frontmatter. Echoes: core | extras | internal
get_install_tier() {
  local file="$1"
  # Read up to 20 lines looking for frontmatter and the install key.
  local in_fm=0
  local line_no=0
  while IFS= read -r line; do
    line_no=$(( line_no + 1 ))
    if [ $line_no -eq 1 ]; then
      if [[ "$line" == "---"* ]]; then in_fm=1; continue; fi
      # No frontmatter — default to core
      echo "core"; return
    fi
    if [ $in_fm -eq 1 ]; then
      if [[ "$line" == "---"* ]]; then
        # End of frontmatter — key not found, default to core
        echo "core"; return
      fi
      if [[ "$line" =~ ^install:[[:space:]]*(.*) ]]; then
        local val="${BASH_REMATCH[1]}"
        # Strip surrounding quotes
        val="${val#\"}" ; val="${val%\"}"
        val="${val#\'}" ; val="${val%\'}"
        val="${val// /}"  # trim spaces
        case "$val" in
          internal|extras) echo "$val"; return ;;
          core)            echo "core"; return ;;
          *)               echo "core"; return ;;
        esac
      fi
    fi
  done < <(head -25 "$file")
  echo "core"
}

# ---------------------------------------------------------------------------
# 1. Collect installable command names from commands/
# ---------------------------------------------------------------------------

declare -a INSTALLABLE_COMMANDS=()

while IFS= read -r -d '' spec; do
  tier="$(get_install_tier "$spec")"
  if [[ "$tier" == "core" ]]; then
    # Derive command name from path relative to COMMANDS_DIR.
    # e.g. commands/work-on.md           → /work-on
    #      commands/work-on/build.md      → /work-on/build
    #      commands/work-on/build/impl.md → /work-on/build/impl
    rel="${spec#${COMMANDS_DIR}/}"
    cmd="/${rel%.md}"
    INSTALLABLE_COMMANDS+=("$cmd")
  fi
done < <(find "$COMMANDS_DIR" -name '*.md' -print0 | sort -z)

# ---------------------------------------------------------------------------
# 2. Extract documented command names from command-reference.md
# ---------------------------------------------------------------------------
# We look for lines of the form: ### `/some-command`
# The reference uses backtick-wrapped command names under H3 headings.

declare -a DOCUMENTED_COMMANDS=()

while IFS= read -r line; do
  # Match H3 heading: ### `/command-name` or ### `/command/sub`
  # Character class includes `.` to support dotted phase filenames (e.g.
  # commands/orchestrate/phase-2.5-synthesis.md -> /orchestrate/phase-2.5-synthesis).
  if [[ "$line" =~ ^###[[:space:]]+\`(/[a-zA-Z0-9_./-]+)\` ]]; then
    cmd="${BASH_REMATCH[1]}"
    DOCUMENTED_COMMANDS+=("$cmd")
  # Match table cell containing a bare command path: | `/command-name` | ...
  # This covers the Sub-Phase Commands table which lists commands without H3 headings.
  # We require the line to look like a markdown table row (starts with |) to avoid
  # matching inline code examples in prose or fix-instruction blocks.
  elif [[ "$line" =~ ^\| ]]; then
    # Extract all backtick-wrapped tokens that look like command paths
    while [[ "$line" =~ \`(/[a-zA-Z0-9_./-]+)\` ]]; do
      cmd="${BASH_REMATCH[1]}"
      DOCUMENTED_COMMANDS+=("$cmd")
      # Remove the matched portion so the loop can find multiple tokens per line
      line="${line#*\`${cmd}\`}"
    done
  fi
done < "$REFERENCE"

# Deduplicate DOCUMENTED_COMMANDS (table rows may repeat H3-listed commands)
declare -a _DEDUPED=()
declare -A _SEEN=()
for cmd in "${DOCUMENTED_COMMANDS[@]}"; do
  if [[ -z "${_SEEN[$cmd]+x}" ]]; then
    _DEDUPED+=("$cmd")
    _SEEN[$cmd]=1
  fi
done
DOCUMENTED_COMMANDS=("${_DEDUPED[@]}")

# ---------------------------------------------------------------------------
# 3. Compare
# ---------------------------------------------------------------------------

FAIL=0

echo "=== ForgeDock command docs drift check ==="
echo ""
echo "Installable specs  : ${#INSTALLABLE_COMMANDS[@]}"
echo "Documented commands: ${#DOCUMENTED_COMMANDS[@]}"
echo ""

# 3a. Installable commands missing from the reference
echo "--- Installable commands not documented in command-reference.md ---"
MISSING_DOCS=0
for cmd in "${INSTALLABLE_COMMANDS[@]}"; do
  found=0
  for doc_cmd in "${DOCUMENTED_COMMANDS[@]}"; do
    if [[ "$doc_cmd" == "$cmd" ]]; then
      found=1
      break
    fi
  done
  if [[ $found -eq 0 ]]; then
    echo "  MISSING DOC: $cmd"
    MISSING_DOCS=$(( MISSING_DOCS + 1 ))
    FAIL=1
  fi
done
if [[ $MISSING_DOCS -eq 0 ]]; then
  echo "  OK — all installable commands are documented"
fi
echo ""

# 3b. Reference sections whose spec no longer exists (orphaned docs)
echo "--- Reference sections with no matching installable spec ---"
ORPHANED=0
for doc_cmd in "${DOCUMENTED_COMMANDS[@]}"; do
  found=0
  for cmd in "${INSTALLABLE_COMMANDS[@]}"; do
    if [[ "$cmd" == "$doc_cmd" ]]; then
      found=1
      break
    fi
  done
  if [[ $found -eq 0 ]]; then
    echo "  ORPHANED REF: $doc_cmd  (no matching installable spec)"
    ORPHANED=$(( ORPHANED + 1 ))
    FAIL=1
  fi
done
if [[ $ORPHANED -eq 0 ]]; then
  echo "  OK — all reference sections have a matching spec"
fi
echo ""

# ---------------------------------------------------------------------------
# 4. Result
# ---------------------------------------------------------------------------

if [[ $FAIL -eq 1 ]]; then
  echo "FAIL: command/docs drift detected."
  echo ""
  echo "Fix:"
  echo "  - MISSING DOC  → add a section for the command to docs/site/command-reference.md"
  echo "  - ORPHANED REF → remove the section or restore the spec under commands/"
  exit 1
else
  echo "OK: no drift between commands/ and docs/site/command-reference.md"
  exit 0
fi
