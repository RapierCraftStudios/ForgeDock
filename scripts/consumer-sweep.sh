#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# consumer-sweep.sh — deterministic consumer sweep: every reference, outside the change set, to an identifier the
# diff changed or removed. Language-agnostic (fixed-string git grep); no ctags or tree-sitter needed.
#
# Usage:
#   consumer-sweep.sh --range <base>..<head> [--repo P] [--exclude-glob G]... [--cap N] [--consumers FILE]
#   consumer-sweep.sh --ident NAME [--ident NAME]... [--repo P] [--exclude-glob G]... [--cap N]
#
#   --range A..B   diff mode (validate). A..B is a plain `git diff A B`. When B is the word WORKTREE the diff is
#                  merge-base(A, HEAD) against the working tree, so commits, staged, unstaged and untracked work all
#                  count as the change set (validate runs before the commit).
#   --ident NAME   identifier mode (architect, before any diff exists): sweep the named identifiers, empty change set.
#   --consumers F  gate mode (diff mode only): F is a FORGE:BUILDER body (or any text). A referencing site is
#                  addressed when its file carries a line `- <path>[:<line>] unaffected: <reason>` in F (file-level
#                  granularity; the line number is ignored because lines shift). Files in the change set are never
#                  sites. An `updated` line is informational: an updated file is in the change set and not a site.
#
# Extraction (diff mode) runs over the REMOVED side of the diff, so a renamed or re-typed identifier or a changed
# literal is swept by its OLD value (stale references still carry it). Pure additions have no external references
# and are not swept. Kinds: function, class, const, env, key, flag, literal (7+ hex, semver), path.
# Flags are swept without their leading dashes. Identifiers must match ^[A-Za-z0-9_.:/-]{4,80}$, must not start
# with "-", are filtered through a stop-list, and are passed to `git grep -n -w -F -e ID -- .` as data only: diff
# text is never evaluated as shell or as a regex. Hits in generated/vendored paths are skipped: the same default
# globs as scripts/diff-size.sh (keep in sync) plus --exclude-glob (callers pass build.scope.exclude_globs).
#
# Output (sweep mode): TSV `identifier<TAB>kind<TAB>file:line`, at most --cap rows per identifier (default 25); a
# further `identifier<TAB>truncated<TAB>+N` row marks the cut (advisory, never a gate failure). Gate mode prints
# `UNADDRESSED: <identifier> <file:line>` per unaddressed site, or `OK: ...`.
#
# Exit: 0 swept / all addressed (including no sites); 1 unaddressed sites (gate mode); 2 usage error, unresolvable
# ref or any git failure — NEVER a pass; callers report DEGRADED.
#
# Offline: no network, no gh. Bash 3.2 portable: no mapfile, no associative arrays.

set -uo pipefail

MAX_IDS=150
RANGE=""; REPO="."; CAP=25; CONSUMERS=""; IDENTS=""; EXTRA=""
NL='
'
TAB=$(printf '\t')
die2() { echo "consumer-sweep: $*" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --range)        [ "$#" -ge 2 ] || die2 "--range needs a value"; RANGE="$2"; shift 2 ;;
    --repo)         [ "$#" -ge 2 ] || die2 "--repo needs a value"; REPO="$2"; shift 2 ;;
    --cap)          [ "$#" -ge 2 ] || die2 "--cap needs a value"; CAP="$2"; shift 2 ;;
    --consumers)    [ "$#" -ge 2 ] || die2 "--consumers needs a value"; CONSUMERS="$2"; shift 2 ;;
    --ident)        [ "$#" -ge 2 ] || die2 "--ident needs a value"; IDENTS="${IDENTS}${2}${NL}"; shift 2 ;;
    --exclude-glob) [ "$#" -ge 2 ] || die2 "--exclude-glob needs a value"; [ -z "$2" ] || EXTRA="${EXTRA}${2}${NL}"; shift 2 ;;
    *) die2 "usage: consumer-sweep.sh (--range <base>..<head> [--consumers FILE] | --ident NAME...) [--repo P] [--exclude-glob G]... [--cap N]" ;;
  esac
done
case "$CAP" in ""|0|*[!0-9]*) die2 "--cap must be a positive integer" ;; esac
if [ -n "$RANGE" ] && [ -n "$IDENTS" ]; then die2 "--range and --ident are mutually exclusive"; fi
if [ -z "$RANGE" ] && [ -z "$IDENTS" ]; then die2 "one of --range or --ident is required"; fi
if [ -n "$CONSUMERS" ]; then
  [ -n "$RANGE" ] || die2 "--consumers requires --range"
  [ -f "$CONSUMERS" ] || die2 "consumers file not found: $CONSUMERS"
fi
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die2 "not a git work tree: $REPO"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/consumer-sweep.XXXXXX") || die2 "mktemp failed"
trap 'rm -rf "$TMP"' EXIT

# ---- exclude globs (mirror of scripts/diff-size.sh: keep in sync) ---------------------------------------
DEFAULTS="package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock poetry.lock uv.lock go.sum Gemfile.lock composer.lock *.min.* *.snap __generated__/ __snapshots__/"
ROOT_DIRS="dist/ build/ generated/ fixtures/ vendor/"
GLOBS="${DEFAULTS}${NL}${EXTRA}"
excluded() { # path -> 0 when excluded (globs are data: matched by case, never evaluated)
  local p="$1" b="${1##*/}" g
  for g in $ROOT_DIRS; do case "$p" in "$g"*) return 0 ;; esac; done
  set -f
  for g in $GLOBS; do
    case "$g" in
      */) case "/$p" in *"/$g"*) set +f; return 0 ;; esac ;;
      *) case "$b" in $g) set +f; return 0 ;; esac; case "$p" in $g) set +f; return 0 ;; esac ;;
    esac
  done
  set +f
  return 1
}

: > "$TMP/changed"
: > "$TMP/excl"
: > "$TMP/raw"

# ---- diff mode: change set and removed-side extraction --------------------------------------------------
if [ -n "$RANGE" ]; then
  case "$RANGE" in *..*) ;; *) die2 "--range must look like <base>..<head>" ;; esac
  A="${RANGE%%..*}"; B="${RANGE#*..}"; B="${B#.}"
  case "$A" in ""|-*) die2 "invalid base in --range: '$A'" ;; esac
  case "$B" in ""|-*) die2 "invalid head in --range: '$B'" ;; esac
  git -C "$REPO" rev-parse --verify --quiet "${A}^{commit}" >/dev/null 2>&1 || die2 "cannot resolve base ref '$A'"
  if [ "$B" = WORKTREE ]; then
    MB=$(git -C "$REPO" merge-base "$A" HEAD 2>/dev/null) && [ -n "$MB" ] || die2 "cannot compute merge base of '$A' and HEAD"
    DIFFARGS="$MB"
    git -C "$REPO" diff -z --name-only --no-renames "$MB" -- > "$TMP/c1" 2>/dev/null || die2 "git diff --name-only failed"
    git -C "$REPO" ls-files -z --others --exclude-standard > "$TMP/c2" 2>/dev/null || die2 "git ls-files failed"
  else
    git -C "$REPO" rev-parse --verify --quiet "${B}^{commit}" >/dev/null 2>&1 || die2 "cannot resolve head ref '$B'"
    DIFFARGS="$A $B"
    # shellcheck disable=SC2086
    git -C "$REPO" diff -z --name-only --no-renames $DIFFARGS -- > "$TMP/c1" 2>/dev/null || die2 "git diff --name-only failed"
    : > "$TMP/c2"
  fi
  cat "$TMP/c1" "$TMP/c2" | tr '\0' '\n' | sed '/^$/d' | sort -u > "$TMP/changed"
  # files whose removed lines are not extracted (generated/vendored)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if excluded "$f"; then printf '%s\n' "$f" >> "$TMP/excl"; fi
  done < "$TMP/changed"
  # shellcheck disable=SC2086
  git -C "$REPO" -c core.quotepath=off diff -U0 --no-color --no-ext-diff --no-renames $DIFFARGS -- > "$TMP/diff" 2>/dev/null \
    || die2 "git diff failed"
  # removed lines only, minus excluded files; the old path comes from the "--- a/<path>" header
  awk -v excl="$TMP/excl" '
    BEGIN { while ((getline l < excl) > 0) skip[l] = 1 }
    /^--- / { p = substr($0, 5); sub(/^a\//, "", p); cur = p; next }
    /^\+\+\+ / { next }
    /^-/ { if (!(cur in skip) && cur != "/dev/null") print substr($0, 2) }
  ' "$TMP/diff" > "$TMP/removed"

  # declarations: keyword [receiver] NAME  ->  kind by keyword
  grep -oE '(^|[^A-Za-z0-9_])(def|function|func|fn|fun|sub|proc|class|struct|interface|enum|trait|type|const|val)[[:space:]]+(\([^)]*\)[[:space:]]*)?[A-Za-z_][A-Za-z0-9_]*' "$TMP/removed" 2>/dev/null \
    | sed -E 's/^[^A-Za-z]//' \
    | awk '{ kw=$1; n=$NF; sub(/^.*\)/, "", n);
             k="const";
             if (kw=="def"||kw=="function"||kw=="func"||kw=="fn"||kw=="fun"||kw=="sub"||kw=="proc") k="function";
             else if (kw=="class"||kw=="struct"||kw=="interface"||kw=="enum"||kw=="trait"||kw=="type") k="class";
             print n "\t" k }' >> "$TMP/raw"
  # shell-style  name() {
  grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*\(\)[[:space:]]*\{' "$TMP/removed" 2>/dev/null \
    | sed -E 's/^[[:space:]]*//; s/\(\).*$//' | awk '{ print $0 "\tfunction" }' >> "$TMP/raw"
  # env vars: UPPER_CASE tokens on lines that read the environment
  grep -E 'getenv|environ|process\.env|os\.Getenv|ENV\[|\$\{?[A-Z]|env:|\.env' "$TMP/removed" 2>/dev/null \
    | grep -oE '(^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]{3,}([^A-Za-z0-9_]|$)' \
    | sed -E 's/^[^A-Z]//; s/[^A-Z0-9_]$//' | awk '{ print $0 "\tenv" }' >> "$TMP/raw"
  # UPPER_CASE constants
  grep -oE '(^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]{3,}([^A-Za-z0-9_]|$)' "$TMP/removed" 2>/dev/null \
    | sed -E 's/^[^A-Z]//; s/[^A-Z0-9_]$//' | awk '{ print $0 "\tconst" }' >> "$TMP/raw"
  # CLI flags (swept without the leading dashes)
  grep -oE '(^|[^A-Za-z0-9_-])--[A-Za-z][A-Za-z0-9-]{3,}' "$TMP/removed" 2>/dev/null \
    | sed -E 's/^[^-]?--//' | awk '{ print $0 "\tflag" }' >> "$TMP/raw"
  # literals: 7+ hex (must mix digits and a-f), semver
  grep -oE '(^|[^A-Za-z0-9_])[0-9a-f]{7,64}([^A-Za-z0-9_]|$)' "$TMP/removed" 2>/dev/null \
    | sed -E 's/^[^0-9a-f]//; s/[^0-9a-f]$//' | grep '[0-9]' | grep '[a-f]' | awk '{ print $0 "\tliteral" }' >> "$TMP/raw"
  grep -oE '(^|[^A-Za-z0-9_.])[0-9]+\.[0-9]+\.[0-9]+([^A-Za-z0-9_.]|$)' "$TMP/removed" 2>/dev/null \
    | sed -E 's/^[^0-9]//; s/[^0-9]$//' | awk '{ print $0 "\tliteral" }' >> "$TMP/raw"
  # paths: dir/name.ext
  grep -oE '(^|[^A-Za-z0-9_./-])(\./)?[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,6}([^A-Za-z0-9_]|$)' "$TMP/removed" 2>/dev/null \
    | sed -E 's/^[^A-Za-z0-9.]//; s/^\.\///; s/[^A-Za-z0-9]$//' | awk '{ print $0 "\tpath" }' >> "$TMP/raw"
  # quoted config/context keys and yaml-style keys
  grep -oE "[\"'][A-Za-z_][A-Za-z0-9_.-]{3,}[\"']" "$TMP/removed" 2>/dev/null \
    | sed -E "s/^[\"']//; s/[\"']\$//" | awk '{ print $0 "\tkey" }' >> "$TMP/raw"
  grep -oE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_.-]{3,}:' "$TMP/removed" 2>/dev/null \
    | sed -E 's/^[[:space:]]*//; s/:$//' | awk '{ print $0 "\tkey" }' >> "$TMP/raw"
else
  # ---- identifier mode ------------------------------------------------------------------------------------
  printf '%s' "$IDENTS" | sed '/^$/d' | awk '{ print $0 "\tident" }' > "$TMP/raw"
fi

# ---- filter: first-seen per identifier, charset, length, stop-list -------------------------------------
STOP="true false null none self this main init test tests data name type types value values list dict item items result results error errors string default config options args kwargs size path file files text node nodes index count state status user users TODO FIXME NOTE HACK NULL TRUE FALSE NONE UTF8 JSON YAML HTML HTTP HTTPS GET POST PUT PATCH DELETE ERROR WARN INFO DEBUG EOF LINE MAIN"
awk -F'\t' -v stop="$STOP" '
  BEGIN { n = split(stop, s, " "); for (i = 1; i <= n; i++) st[tolower(s[i])] = 1 }
  $1 ~ /^[A-Za-z0-9_.:\/-]+$/ && length($1) >= 4 && length($1) <= 80 && substr($1, 1, 1) != "-" \
    && !(tolower($1) in st) && !seen[$1]++ { print $1 "\t" $2 }
' "$TMP/raw" > "$TMP/ids"
if [ -z "$RANGE" ]; then
  # an explicit --ident that fails validation is a usage error, never silently skipped
  want=$(printf '%s' "$IDENTS" | sed '/^$/d' | wc -l | tr -d ' ')
  have=$(wc -l < "$TMP/ids" | tr -d ' ')
  [ "$want" = "$have" ] || die2 "invalid --ident (want ^[A-Za-z0-9_.:/-]{4,80}\$, not a stop-list word, no duplicates)"
fi

# ---- sweep -----------------------------------------------------------------------------------------------
: > "$TMP/sites"   # identifier<TAB>kind<TAB>file:line
NIDS=0
while IFS="$TAB" read -r id kind; do
  [ -n "$id" ] || continue
  NIDS=$((NIDS+1))
  if [ "$NIDS" -gt "$MAX_IDS" ]; then printf '*\ttruncated\tidentifiers beyond %s not swept\n' "$MAX_IDS" >> "$TMP/sites"; break; fi
  git -C "$REPO" grep -n -z -w -F -e "$id" -- . > "$TMP/g" 2> "$TMP/gerr"
  grc=$?
  if [ "$grc" -gt 1 ]; then die2 "git grep failed for '$id' (rc=$grc): $(head -n 1 "$TMP/gerr")"; fi
  [ "$grc" -eq 0 ] || continue
  # one row per file:line, files outside the change set and not excluded, stable order
  awk 'BEGIN { RS = "\n"; FS = "\0" } NF >= 2 { print $1 "\t" $2 }' "$TMP/g" | sort -u > "$TMP/h"
  cnt=0; extra=0
  while IFS="$TAB" read -r hf hl; do
    [ -n "$hf" ] || continue
    if grep -Fxq -- "$hf" "$TMP/changed"; then continue; fi
    if excluded "$hf"; then continue; fi
    cnt=$((cnt+1))
    if [ "$cnt" -le "$CAP" ]; then printf '%s\t%s\t%s:%s\n' "$id" "$kind" "$hf" "$hl" >> "$TMP/sites"; else extra=$((extra+1)); fi
  done < "$TMP/h"
  [ "$extra" -eq 0 ] || printf '%s\ttruncated\t+%s\n' "$id" "$extra" >> "$TMP/sites"
done < "$TMP/ids"

if [ -z "$CONSUMERS" ]; then
  cat "$TMP/sites"
  exit 0
fi

# ---- gate mode -------------------------------------------------------------------------------------------
# Justified files: lines like  "- path[:line] unaffected: reason"  (leading bullet and backticks tolerated).
sed -E 's/\r$//; s/`//g; s/^[[:space:]]*([-*][[:space:]]+)?//' "$CONSUMERS" \
  | awk '{ p = $1; if (p ~ /^[A-Za-z0-9_.\/@+=,-]+(:[0-9]+)?$/ && $2 == "unaffected:" && $3 != "") { sub(/:[0-9]+$/, "", p); print p } }' \
  | sort -u > "$TMP/justified"
RC=0; NSITES=0
while IFS="$TAB" read -r id kind loc; do
  [ -n "$id" ] || continue
  [ "$kind" != truncated ] || continue
  NSITES=$((NSITES+1))
  f="${loc%:*}"
  grep -Fxq -- "$f" "$TMP/justified" && continue
  echo "UNADDRESSED: $id $loc"; RC=1
done < "$TMP/sites"
[ "$RC" -ne 0 ] || echo "OK: consumer sweep addressed ($NSITES site(s))"
exit "$RC"
