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
# Works on Windows (Git Bash / WSL) and Linux. No bash-only hot-path tooling.
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
# Step 1: Symbol extraction
# ---------------------------------------------------------------------------
SYMBOLS_FILE="${CACHE_DIR}/symbols.tsv"
> "$SYMBOLS_FILE"

echo "INFO: Extracting symbols..."

if command -v ctags >/dev/null 2>&1; then
  # Use ctags for precise symbol extraction
  # --fields=+ne adds line number and end-of-scope — portable across universal-ctags
  ctags -R --output-format=json \
    --fields='nkz' \
    --languages=Python,JavaScript,TypeScript,Go,Rust,Java,C,C++ \
    -f - "$REPO_PATH" 2>/dev/null \
  | grep -v '^!' \
  | while IFS= read -r line; do
      # Parse JSON output from universal-ctags
      name=$(echo "$line" | grep -oP '"name"\s*:\s*"\K[^"]+' 2>/dev/null || true)
      path=$(echo "$line" | grep -oP '"path"\s*:\s*"\K[^"]+' 2>/dev/null || true)
      line_num=$(echo "$line" | grep -oP '"line"\s*:\s*\K\d+' 2>/dev/null || echo "0")
      kind=$(echo "$line" | grep -oP '"kind"\s*:\s*"\K[^"]+' 2>/dev/null || echo "unknown")
      if [[ -n "$name" && -n "$path" ]]; then
        echo -e "${name}\t${path}\t${line_num}\t${kind}"
      fi
    done >> "$SYMBOLS_FILE" 2>/dev/null || true
fi

# Fallback: grep-based extraction for Python functions/classes
if [[ ! -s "$SYMBOLS_FILE" ]] || ! command -v ctags >/dev/null 2>&1; then
  echo "INFO: Falling back to grep-based symbol extraction"

  # Python: functions and classes
  find "$REPO_PATH" -name "*.py" -not -path "*/.git/*" -not -path "*/node_modules/*" \
    -not -path "*/__pycache__/*" 2>/dev/null | while read -r f; do
    grep -n "^def \|^    def \|^class " "$f" 2>/dev/null | while IFS=: read -r lnum content; do
      name=$(echo "$content" | grep -oP '(?<=def |class )\w+' | head -1)
      kind=$(echo "$content" | grep -q "^def \|    def " && echo "function" || echo "class")
      rel_path="${f#$REPO_PATH/}"
      [[ -n "$name" ]] && echo -e "${name}\t${rel_path}\t${lnum}\t${kind}"
    done
  done >> "$SYMBOLS_FILE" 2>/dev/null || true

  # JavaScript/TypeScript: functions and classes
  find "$REPO_PATH" -name "*.js" -o -name "*.ts" -o -name "*.tsx" -o -name "*.jsx" \
    -not -path "*/.git/*" -not -path "*/node_modules/*" 2>/dev/null | while read -r f; do
    grep -n "^export function \|^function \|^export class \|^class \|^const .* = \(function\|async function\|() =>\)" \
      "$f" 2>/dev/null | while IFS=: read -r lnum content; do
      name=$(echo "$content" | grep -oP '(?<=function |class )\w+|(?<=const )\w+(?=\s*=)' | head -1)
      rel_path="${f#$REPO_PATH/}"
      [[ -n "$name" ]] && echo -e "${name}\t${rel_path}\t${lnum}\tfunction"
    done
  done >> "$SYMBOLS_FILE" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Step 2: Import graph extraction
# ---------------------------------------------------------------------------
IMPORTS_FILE="${CACHE_DIR}/imports.tsv"
> "$IMPORTS_FILE"

echo "INFO: Building import graph..."

# Python imports
find "$REPO_PATH" -name "*.py" -not -path "*/.git/*" -not -path "*/__pycache__/*" \
  2>/dev/null | while read -r f; do
  rel_path="${f#$REPO_PATH/}"
  grep -n "^import \|^from " "$f" 2>/dev/null | while IFS=: read -r lnum content; do
    module=$(echo "$content" | grep -oP '(?<=^from )\S+|(?<=^import )\S+' | head -1)
    symbol=$(echo "$content" | grep -oP '(?<=import )[\w, ]+$' | head -1 || echo "")
    [[ -n "$module" ]] && echo -e "${rel_path}\t${module}\t${symbol}"
  done
done >> "$IMPORTS_FILE" 2>/dev/null || true

# JavaScript/TypeScript imports
find "$REPO_PATH" \( -name "*.js" -o -name "*.ts" -o -name "*.tsx" -o -name "*.jsx" \) \
  -not -path "*/.git/*" -not -path "*/node_modules/*" 2>/dev/null | while read -r f; do
  rel_path="${f#$REPO_PATH/}"
  grep -n "^import \|^} from \|require(" "$f" 2>/dev/null | while IFS=: read -r lnum content; do
    module=$(echo "$content" | grep -oP "(?<=from ['\"])[^'\"]+|(?<=require\(['\"])[^'\"]+")
    [[ -n "$module" ]] && echo -e "${rel_path}\t${module}\t"
  done
done >> "$IMPORTS_FILE" 2>/dev/null || true

# Go imports
find "$REPO_PATH" -name "*.go" -not -path "*/.git/*" 2>/dev/null | while read -r f; do
  rel_path="${f#$REPO_PATH/}"
  grep -n '"[^"]*"' "$f" 2>/dev/null | grep -v "//\|fmt.Print\|errors.New" | while IFS=: read -r lnum content; do
    module=$(echo "$content" | grep -oP '"\K[^"]+(?=")')
    [[ -n "$module" ]] && echo -e "${rel_path}\t${module}\t"
  done
done >> "$IMPORTS_FILE" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Step 3: Caller graph (callee → callers mapping)
# ---------------------------------------------------------------------------
CALLERS_FILE="${CACHE_DIR}/callers.tsv"
> "$CALLERS_FILE"

echo "INFO: Building caller graph..."

# For each symbol, find files that call it (grep for usage)
if [[ -s "$SYMBOLS_FILE" ]]; then
  # Process a sample of top symbols (cap at 500 to avoid timeout)
  head -500 "$SYMBOLS_FILE" | while IFS=$'\t' read -r sym_name sym_file sym_line sym_kind; do
    # Skip very short or generic names to avoid false positives
    if [[ ${#sym_name} -lt 3 ]]; then continue; fi
    # Search for callers (function calls, not definitions)
    find "$REPO_PATH" -type f \( -name "*.py" -o -name "*.js" -o -name "*.ts" \
      -o -name "*.go" -o -name "*.rs" -o -name "*.java" \) \
      -not -path "*/.git/*" -not -path "*/node_modules/*" 2>/dev/null | \
      xargs grep -l "\b${sym_name}(" 2>/dev/null | while read -r caller_file; do
        rel_caller="${caller_file#$REPO_PATH/}"
        # Skip the file where the symbol is defined
        if [[ "$rel_caller" == "$sym_file" ]]; then continue; fi
        caller_line=$(grep -n "\b${sym_name}(" "$caller_file" 2>/dev/null | head -1 | cut -d: -f1 || echo "0")
        echo -e "${sym_name}\t${rel_caller}\t${caller_line}"
      done
  done >> "$CALLERS_FILE" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Step 4: File-to-domain mapping
# ---------------------------------------------------------------------------
DOMAIN_FILE="${CACHE_DIR}/file_domain.tsv"
> "$DOMAIN_FILE"

echo "INFO: Building file-domain map..."

# Read forge.yaml domain hints if available
FORGE_YAML="${REPO_PATH}/forge.yaml"
declare -A DOMAIN_PATTERNS
DOMAIN_PATTERNS=(
  ["commands"]="pipeline-commands"
  ["scripts"]="pipeline-scripts"
  ["services/api"]="api"
  ["services/worker"]="worker"
  ["web/src/app/billing"]="billing"
  ["web/src/app/auth"]="auth"
  ["services/api/auth"]="auth"
  ["services/api/billing"]="billing"
  ["services/api/db"]="database"
  ["migrations"]="database"
  [".github/workflows"]="ci-cd"
  ["infra"]="infrastructure"
  ["web/src"]="frontend"
)

# Read key_paths from forge.yaml if present (override defaults)
if [[ -f "$FORGE_YAML" ]]; then
  # Simple key_paths extraction — reads "domain: [patterns]" blocks under review.key_paths
  while IFS=: read -r key val; do
    key=$(echo "$key" | tr -d ' ')
    val=$(echo "$val" | tr -d ' "')
    if [[ -n "$key" && -n "$val" ]]; then
      DOMAIN_PATTERNS["$val"]="$key"
    fi
  done < <(grep -A2 'key_paths:' "$FORGE_YAML" 2>/dev/null | grep '^\s*\w\+:' | head -20 || true)
fi

# Map each file to its domain
find "$REPO_PATH" -type f -not -path "*/.git/*" -not -path "*/node_modules/*" \
  -not -path "*/__pycache__/*" -not -path "*/.forge/*" 2>/dev/null | while read -r f; do
  rel_path="${f#$REPO_PATH/}"
  domain="unclassified"
  for pattern in "${!DOMAIN_PATTERNS[@]}"; do
    if [[ "$rel_path" == $pattern* ]]; then
      domain="${DOMAIN_PATTERNS[$pattern]}"
      break
    fi
  done
  echo -e "${rel_path}\t${domain}"
done >> "$DOMAIN_FILE" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Step 5: Write index manifest
# ---------------------------------------------------------------------------
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
SYMBOL_COUNT=$(wc -l < "$SYMBOLS_FILE" 2>/dev/null || echo 0)
IMPORT_COUNT=$(wc -l < "$IMPORTS_FILE" 2>/dev/null || echo 0)
CALLER_COUNT=$(wc -l < "$CALLERS_FILE" 2>/dev/null || echo 0)
FILE_COUNT=$(wc -l < "$DOMAIN_FILE" 2>/dev/null || echo 0)

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
    "files": ${FILE_COUNT}
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

echo "INFO: Index built successfully"
echo "INFO:   Symbols:  ${SYMBOL_COUNT}"
echo "INFO:   Imports:  ${IMPORT_COUNT}"
echo "INFO:   Callers:  ${CALLER_COUNT}"
echo "INFO:   Files:    ${FILE_COUNT}"
echo "INFO:   Cache:    ${CACHE_DIR}"
echo ""
cat "${CACHE_DIR}/index.json"
