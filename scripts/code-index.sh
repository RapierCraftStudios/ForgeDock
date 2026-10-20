#!/usr/bin/env bash
# code-index.sh — Per-commit symbol index and import graph for ForgeDock agents
#
# Builds a deterministic code map (symbols + import graph + file-to-domain mapping)
# keyed by HEAD SHA. Cached under .forge/index/ to avoid redundant rebuilds.
#
# Usage:
#   scripts/code-index.sh [--repo-path <path>] [--output <dir>] [--force]
#   scripts/code-index.sh query --symbol <name> [--repo-path <path>]
#   scripts/code-index.sh query --callers <name> [--repo-path <path>]
#   scripts/code-index.sh query --importers <file> [--repo-path <path>]
#   scripts/code-index.sh query --domain <label> [--repo-path <path>]
#
# Output files (under CACHE_DIR/{HEAD_SHA}/):
#   symbols.tsv       — symbol_name TAB file TAB line TAB kind (function|class|method|const)
#   imports.tsv       — importer_file TAB imported_module TAB imported_symbol
#   file_domain.tsv   — file_path TAB domain_label
#   callers.tsv       — callee_symbol TAB caller_file TAB caller_line
#   index.json        — machine-readable manifest with metadata
#
# Tooling:
#   Primary:  ctags (universal-ctags preferred) for symbol extraction
#   Fallback: grep-based extraction when ctags is unavailable
#   Import graph: language-specific grep patterns (Python, JS/TS, Go, Rust, shell)
#
# Cache key: HEAD SHA — cache is a hit on unchanged HEAD, miss on new commit.
# Works on Windows (Git Bash / WSL), Linux and macOS. Bash 3.2 portable: no associative arrays, mapfile, grep -P.
#
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
QUERY_MODE=""
QUERY_TYPE=""
QUERY_ARG=""
REPO_PATH="${PWD}"
OUTPUT_DIR=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    query)
      QUERY_MODE=1
      shift
      ;;
    --symbol)
      QUERY_TYPE="symbol"
      QUERY_ARG="$2"
      shift 2
      ;;
    --callers)
      QUERY_TYPE="callers"
      QUERY_ARG="$2"
      shift 2
      ;;
    --importers)
      QUERY_TYPE="importers"
      QUERY_ARG="$2"
      shift 2
      ;;
    --domain)
      QUERY_TYPE="domain"
      QUERY_ARG="$2"
      shift 2
      ;;
    --repo-path)
      REPO_PATH="$2"
      shift 2
      ;;
    --output)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
REPO_PATH=$(cd "$REPO_PATH" 2>/dev/null && pwd || echo "$REPO_PATH")
CACHE_BASE="${OUTPUT_DIR:-${REPO_PATH}/.forge/index}"

# Read HEAD SHA (portable: works when git is available, otherwise use timestamp)
if command -v git >/dev/null 2>&1 && git -C "$REPO_PATH" rev-parse HEAD >/dev/null 2>&1; then
  HEAD_SHA=$(git -C "$REPO_PATH" rev-parse HEAD)
else
  HEAD_SHA="no-git-$(date +%s)"
fi

CACHE_DIR="${CACHE_BASE}/${HEAD_SHA}"

# ---------------------------------------------------------------------------
# Query mode — serve cached data without rebuilding
# ---------------------------------------------------------------------------
if [[ -n "$QUERY_MODE" ]]; then
  if [[ ! -d "$CACHE_DIR" ]]; then
    echo "ERROR: No index found for HEAD ${HEAD_SHA:0:8}. Run code-index.sh to build first." >&2
    echo "Hint: cd \"${REPO_PATH}\" && scripts/code-index.sh --repo-path \"${REPO_PATH}\"" >&2
    exit 1
  fi

  case "$QUERY_TYPE" in
    symbol)
      if [[ -f "${CACHE_DIR}/symbols.tsv" ]]; then
        grep -i "^${QUERY_ARG}"$'\t' "${CACHE_DIR}/symbols.tsv" || true
      fi
      ;;
    callers)
      if [[ -f "${CACHE_DIR}/callers.tsv" ]]; then
        grep -i "^${QUERY_ARG}"$'\t' "${CACHE_DIR}/callers.tsv" || true
      fi
      ;;
    importers)
      if [[ -f "${CACHE_DIR}/imports.tsv" ]]; then
        grep -i $'\t'"${QUERY_ARG}"$'\t' "${CACHE_DIR}/imports.tsv" || \
        grep -i $'\t'"${QUERY_ARG}"$   "${CACHE_DIR}/imports.tsv" || true
      fi
      ;;
    domain)
      if [[ -f "${CACHE_DIR}/file_domain.tsv" ]]; then
        grep -i $'\t'"${QUERY_ARG}"$ "${CACHE_DIR}/file_domain.tsv" || true
      fi
      ;;
    *)
      echo "ERROR: Unknown query type. Use --symbol, --callers, --importers, or --domain" >&2
      exit 1
      ;;
  esac
  exit 0
fi

# ---------------------------------------------------------------------------
# Build mode — check cache hit first
# ---------------------------------------------------------------------------
if [[ -d "$CACHE_DIR" && -f "${CACHE_DIR}/index.json" && "$FORCE" -eq 0 ]]; then
  echo "INFO: Cache hit for HEAD ${HEAD_SHA:0:8} — skipping rebuild"
  echo "INFO: Index at ${CACHE_DIR}"
  cat "${CACHE_DIR}/index.json"
  exit 0
fi

echo "INFO: Building code index for HEAD ${HEAD_SHA:0:8}..."
mkdir -p "$CACHE_DIR"

# ---------------------------------------------------------------------------
# Step 0: File list (forge#4126)
# ---------------------------------------------------------------------------
# Enumerate files ONCE, from the git index when available: a filesystem walk also descends into nested
# worktrees (.forge/worktrees, .claude/worktrees), virtualenvs and build output inside the checkout —
# ~30x the tracked tree on a real repo. Outside git, fall back to a find that prunes those directories.
# Every step below reads this list (paths relative to REPO_PATH); none walks the tree itself.
FILE_LIST="${CACHE_DIR}/.files"
if command -v git >/dev/null 2>&1 && git -C "$REPO_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$REPO_PATH" -c core.quotepath=off ls-files > "$FILE_LIST" 2>/dev/null || true
else
  (cd "$REPO_PATH" && find . \( -name .git -o -name node_modules -o -name __pycache__ -o -name .forge \
    -o -name .claude -o -name .venv -o -name venv \) -prune -o -type f -print 2>/dev/null | sed 's|^\./||') \
    > "$FILE_LIST" || true
fi

# src_files <ext>... — absolute paths of listed files with one of the given extensions.
src_files() {
  local re
  re="\\.($(IFS='|'; echo "$*"))\$"
  grep -E "$re" "$FILE_LIST" 2>/dev/null | awk -v p="$REPO_PATH" '{print p "/" $0}' || true
}

# ---------------------------------------------------------------------------
# Step 1: Symbol extraction
# ---------------------------------------------------------------------------
SYMBOLS_FILE="${CACHE_DIR}/symbols.tsv"
> "$SYMBOLS_FILE"

echo "INFO: Extracting symbols..."

if command -v ctags >/dev/null 2>&1; then
  # --fields=+ne adds line number and end-of-scope — portable across universal-ctags
  # Use ctags for precise symbol extraction over the listed files only (-L, never -R: forge#4126).
  # Paths are relative to REPO_PATH, matching the grep fallback and the caller graph.
  (cd "$REPO_PATH" && ctags --output-format=json \
    --fields='nkz' \
    --languages=Python,JavaScript,TypeScript,Go,Rust,Java,C,C++ \
    -L "$FILE_LIST" -f - 2>/dev/null) \
  | grep -v '^!' \
  | while IFS= read -r line; do
      # Parse JSON output from universal-ctags. Portable (non-PCRE) extraction —
      # grep -oP is not supported by Git Bash's grep build on Windows, so use a
      # bash regex instead of a lookbehind.
      if [[ "$line" =~ \"name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
        name="${BASH_REMATCH[1]}"
      else
        name=""
      fi
      if [[ "$line" =~ \"path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
        path="${BASH_REMATCH[1]}"
      else
        path=""
      fi
      if [[ "$line" =~ \"line\"[[:space:]]*:[[:space:]]*([0-9]+) ]]; then
        line_num="${BASH_REMATCH[1]}"
      else
        line_num="0"
      fi
      if [[ "$line" =~ \"kind\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
        kind="${BASH_REMATCH[1]}"
      else
        kind="unknown"
      fi
      if [[ -n "$name" && -n "$path" ]]; then
        echo -e "${name}\t${path}\t${line_num}\t${kind}"
      fi
    done >> "$SYMBOLS_FILE" 2>/dev/null || true
fi

# Fallback: grep-based extraction for Python functions/classes
if [[ ! -s "$SYMBOLS_FILE" ]] || ! command -v ctags >/dev/null 2>&1; then
  echo "INFO: Falling back to grep-based symbol extraction"

  # Python: functions and classes
  src_files py | while read -r f; do
    grep -n "^def \|^    def \|^class " "$f" 2>/dev/null | while IFS=: read -r lnum content; do
      # Portable (non-PCRE) extraction — grep -oP is not supported by Git Bash's
      # grep build on Windows, so use a bash regex instead of a lookbehind.
      if [[ "$content" =~ (def|class)[[:space:]]+([A-Za-z_][A-Za-z0-9_]*) ]]; then
        name="${BASH_REMATCH[2]}"
      else
        name=""
      fi
      kind=$(echo "$content" | grep -q "^def \|    def " && echo "function" || echo "class")
      rel_path="${f#$REPO_PATH/}"
      [[ -n "$name" ]] && echo -e "${name}\t${rel_path}\t${lnum}\t${kind}"
    done || true
  done >> "$SYMBOLS_FILE" 2>/dev/null || true

  # JavaScript/TypeScript: functions and classes
  src_files js ts tsx jsx | while read -r f; do
    grep -n "^export function \|^function \|^export class \|^class \|^const .* = \(function\|async function\|() =>\)" \
      "$f" 2>/dev/null | while IFS=: read -r lnum content; do
      # Portable (non-PCRE) extraction — grep -oP is not supported by Git Bash's
      # grep build on Windows, so use a bash regex instead of lookbehind/lookahead.
      if [[ "$content" =~ (function|class)[[:space:]]+([A-Za-z_][A-Za-z0-9_]*) ]]; then
        name="${BASH_REMATCH[2]}"
      elif [[ "$content" =~ const[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*= ]]; then
        name="${BASH_REMATCH[1]}"
      else
        name=""
      fi
      rel_path="${f#$REPO_PATH/}"
      [[ -n "$name" ]] && echo -e "${name}\t${rel_path}\t${lnum}\tfunction"
    done || true
  done >> "$SYMBOLS_FILE" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Step 2: Import graph extraction
# ---------------------------------------------------------------------------
IMPORTS_FILE="${CACHE_DIR}/imports.tsv"
> "$IMPORTS_FILE"

echo "INFO: Building import graph..."

# Python imports
src_files py | while read -r f; do
  rel_path="${f#$REPO_PATH/}"
  grep -n "^import \|^from " "$f" 2>/dev/null | while IFS=: read -r lnum content; do
    # Portable (non-PCRE) extraction — grep -oP is not supported by Git Bash's
    # grep build on Windows, so use a bash regex instead of lookbehind.
    if [[ "$content" =~ ^from[[:space:]]+([^[:space:]]+)[[:space:]]+import[[:space:]]+(.+)$ ]]; then
      module="${BASH_REMATCH[1]}"
      symbol="${BASH_REMATCH[2]}"
    elif [[ "$content" =~ ^import[[:space:]]+([^[:space:]]+) ]]; then
      module="${BASH_REMATCH[1]}"
      symbol=""
    else
      module=""
      symbol=""
    fi
    [[ -n "$module" ]] && echo -e "${rel_path}\t${module}\t${symbol}"
  done || true
done >> "$IMPORTS_FILE" 2>/dev/null || true

# JavaScript/TypeScript imports
src_files js ts tsx jsx | while read -r f; do
  rel_path="${f#$REPO_PATH/}"
  grep -n "^import \|^} from \|require(" "$f" 2>/dev/null | while IFS=: read -r lnum content; do
    # Portable (non-PCRE) extraction — grep -oP is not supported by Git Bash's
    # grep build on Windows, so use a bash regex instead of lookbehind/lookahead.
    if [[ "$content" =~ from[[:space:]]*[\'\"]([^\'\"]+)[\'\"] ]]; then
      module="${BASH_REMATCH[1]}"
    elif [[ "$content" =~ require\([[:space:]]*[\'\"]([^\'\"]+)[\'\"] ]]; then
      module="${BASH_REMATCH[1]}"
    else
      module=""
    fi
    [[ -n "$module" ]] && echo -e "${rel_path}\t${module}\t"
  done || true
done >> "$IMPORTS_FILE" 2>/dev/null || true

# Go imports
src_files go | while read -r f; do
  rel_path="${f#$REPO_PATH/}"
  grep -n '"[^"]*"' "$f" 2>/dev/null | grep -v "//\|fmt.Print\|errors.New" | while IFS=: read -r lnum content; do
    # Portable (non-PCRE) extraction — grep -oP is not supported by Git Bash's
    # grep build on Windows, so use a bash regex instead of lookbehind/lookahead.
    if [[ "$content" =~ \"([^\"]+)\" ]]; then
      module="${BASH_REMATCH[1]}"
    else
      module=""
    fi
    [[ -n "$module" ]] && echo -e "${rel_path}\t${module}\t"
  done || true
done >> "$IMPORTS_FILE" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Step 3: Caller graph (callee → callers mapping)
# ---------------------------------------------------------------------------
CALLERS_FILE="${CACHE_DIR}/callers.tsv"
> "$CALLERS_FILE"

echo "INFO: Building caller graph..."

# One pass (forge#4126): collect every `name(` occurrence across the listed sources with a single grep, then
# join it in awk against the first 500 symbols. The old loop ran one full find|grep tree walk per symbol.
# One row per (symbol, caller file) at the first call line; files defining the symbol are skipped.
if [[ -s "$SYMBOLS_FILE" ]]; then
  CALLEE_FILE="${CACHE_DIR}/.callees"
  head -500 "$SYMBOLS_FILE" > "$CALLEE_FILE"
  (cd "$REPO_PATH" && grep -E '\.(py|js|ts|go|rs|java)$' "$FILE_LIST" | tr '\n' '\0' \
    | xargs -0 grep -n -o -H -E '[A-Za-z_][A-Za-z0-9_]*\(' -- 2>/dev/null) \
  | awk -v syms="$CALLEE_FILE" '
      BEGIN {
        while ((getline l < syms) > 0) {
          split(l, s, "\t")
          # Skip very short or generic names to avoid false positives
          if (length(s[1]) >= 3) { want[s[1]] = 1; def[s[1] SUBSEP s[2]] = 1 }
        }
      }
      {
        # file:line:name(  — split from the right so a ":" in the file name survives.
        n = split($0, a, ":"); id = a[n]; sub(/\($/, "", id); ln = a[n-1]
        f = substr($0, 1, length($0) - length(a[n]) - length(ln) - 2)
        k = id SUBSEP f
        if (!(id in want) || (k in def) || (k in seen)) next
        seen[k] = 1
        print id "\t" f "\t" ln
      }' >> "$CALLERS_FILE" 2>/dev/null || true
  # ^ grep exits 1 when nothing matches; guard so `set -e`/`pipefail` never aborts the build here.
fi

# ---------------------------------------------------------------------------
# Step 4: File-to-domain mapping
# ---------------------------------------------------------------------------
DOMAIN_FILE="${CACHE_DIR}/file_domain.tsv"
> "$DOMAIN_FILE"

echo "INFO: Building file-domain map..."

# Read forge.yaml domain hints if available
FORGE_YAML="${REPO_PATH}/forge.yaml"
# Ordered prefix -> domain table, most specific first; the first matching prefix wins (forge#4235).
# Parallel indexed arrays, not an associative array: bash 3.2 (stock macOS) has no `declare -A`,
# and hash iteration order made services/api vs services/api/auth unspecified.
DOMAIN_PREFIXES=(
  "web/src/app/billing" "web/src/app/auth" "services/api/auth" "services/api/billing" "services/api/db"
  "services/api" "services/worker" "migrations" ".github/workflows" "infra" "web/src" "commands" "scripts"
)
DOMAIN_LABELS=(
  "billing" "auth" "auth" "billing" "database"
  "api" "worker" "database" "ci-cd" "infrastructure" "frontend" "pipeline-commands" "pipeline-scripts"
)

# Read key_paths from forge.yaml if present: prepended so they override the defaults
if [[ -f "$FORGE_YAML" ]]; then
  # Simple key_paths extraction — reads "domain: [patterns]" blocks under review.key_paths
  while IFS=: read -r key val; do
    key=$(echo "$key" | tr -d ' ')
    val=$(echo "$val" | tr -d ' "')
    if [[ -n "$key" && -n "$val" ]]; then
      DOMAIN_PREFIXES=("$val" "${DOMAIN_PREFIXES[@]}")
      DOMAIN_LABELS=("$key" "${DOMAIN_LABELS[@]}")
    fi
  done < <(grep -A2 'key_paths:' "$FORGE_YAML" 2>/dev/null | grep '^\s*\w\+:' | head -20 || true)
fi
DOMAIN_COUNT=${#DOMAIN_PREFIXES[@]}

# Map each file to its domain
while IFS= read -r rel_path; do
  case "$rel_path" in .forge/*|*/node_modules/*|node_modules/*|*/__pycache__/*) continue ;; esac
  domain="unclassified"
  i=0
  while [[ "$i" -lt "$DOMAIN_COUNT" ]]; do
    pattern="${DOMAIN_PREFIXES[$i]}"
    if [[ "$rel_path" == $pattern* ]]; then
      domain="${DOMAIN_LABELS[$i]}"
      break
    fi
    i=$((i + 1))
  done
  echo -e "${rel_path}\t${domain}"
done < "$FILE_LIST" >> "$DOMAIN_FILE" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Step 5: Write index manifest
# ---------------------------------------------------------------------------
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
SYMBOL_COUNT=$(wc -l < "$SYMBOLS_FILE" 2>/dev/null || echo 0)
IMPORT_COUNT=$(wc -l < "$IMPORTS_FILE" 2>/dev/null || echo 0)
CALLER_COUNT=$(wc -l < "$CALLERS_FILE" 2>/dev/null || echo 0)
FILE_COUNT=$(wc -l < "$DOMAIN_FILE" 2>/dev/null || echo 0)

# Sanity check: if source files that should have produced symbols/imports were
# found, but extraction came back empty, a loop was truncated somewhere above
# (or a tool like grep -oP is unavailable/incompatible on this platform) — flag
# it instead of letting "Index built successfully" silently paper over data loss.
SRC_FILE_COUNT=$(src_files py js ts tsx jsx go | wc -l | tr -d ' ')
INDEX_TRUNCATED=0
if [[ "$SRC_FILE_COUNT" -gt 0 && "$SYMBOL_COUNT" -eq 0 ]]; then
  INDEX_TRUNCATED=1
  echo "WARN: 0 symbols extracted despite ${SRC_FILE_COUNT} matching source file(s) found." >&2
  echo "WARN: Extraction may have been truncated by a shell/grep failure, or ctags/grep tooling is unavailable/incompatible on this platform." >&2
fi

cat > "${CACHE_DIR}/index.json" << INDEX_EOF
{
  "schema_version": "1",
  "head_sha": "${HEAD_SHA}",
  "built_at": "${TIMESTAMP}",
  "repo_path": "${REPO_PATH}",
  "cache_dir": "${CACHE_DIR}",
  "stats": {
    "symbols": ${SYMBOL_COUNT},
    "imports": ${IMPORT_COUNT},
    "callers": ${CALLER_COUNT},
    "files": ${FILE_COUNT},
    "truncated": $([[ "$INDEX_TRUNCATED" -eq 1 ]] && echo "true" || echo "false")
  },
  "files": {
    "symbols": "${CACHE_DIR}/symbols.tsv",
    "imports": "${CACHE_DIR}/imports.tsv",
    "callers": "${CACHE_DIR}/callers.tsv",
    "file_domain": "${CACHE_DIR}/file_domain.tsv"
  },
  "query_usage": {
    "symbol_lookup": "scripts/code-index.sh query --symbol <name> --repo-path <path>",
    "caller_lookup": "scripts/code-index.sh query --callers <name> --repo-path <path>",
    "importer_lookup": "scripts/code-index.sh query --importers <file> --repo-path <path>",
    "domain_lookup": "scripts/code-index.sh query --domain <label> --repo-path <path>"
  }
}
INDEX_EOF

if [[ "$INDEX_TRUNCATED" -eq 1 ]]; then
  echo "WARN: Index build completed but looks truncated — see WARN lines above."
else
  echo "INFO: Index built successfully"
fi
echo "INFO:   Symbols:  ${SYMBOL_COUNT}"
echo "INFO:   Imports:  ${IMPORT_COUNT}"
echo "INFO:   Callers:  ${CALLER_COUNT}"
echo "INFO:   Files:    ${FILE_COUNT}"
echo "INFO:   Cache:    ${CACHE_DIR}"
echo ""
cat "${CACHE_DIR}/index.json"
