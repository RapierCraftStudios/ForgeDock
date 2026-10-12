#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# consumer-sweep.sh — deterministic consumer sweep: every reference, outside the change set, to an identifier the
# diff removed, renamed or re-typed. Language-agnostic (fixed-string git grep); no ctags or tree-sitter needed.
#
# Usage:
#   consumer-sweep.sh --range <base>..<head> [--repo P] [--exclude-glob G]... [--cap N] [--consumers FILE]
#                     [--budget-seconds N] [--mode advisory|blocking]
#   consumer-sweep.sh --ident NAME [--ident NAME]... [--repo P] [--exclude-glob G]... [--cap N] [--budget-seconds N]
#   consumer-sweep.sh --eval-history N [--repo P] [--exclude-glob G]... [--cap N] [--budget-seconds N]
#
#   --range A..B   diff mode (validate). A..B is a plain `git diff A B`. When B is the word WORKTREE the diff is
#                  merge-base(A, HEAD) against the working tree, so commits, staged, unstaged and untracked work all
#                  count as the change set (validate runs before the commit).
#   --ident NAME   identifier mode (architect, before any diff exists): sweep the named identifiers, empty change set.
#   --consumers F  gate mode (diff mode only): F is a FORGE:BUILDER body (or any text). A referencing site is
#                  addressed when its file carries a line `- <path>[:<line>] unaffected: <reason>` in F (file-level
#                  granularity; the line number is ignored because lines shift). The path is everything before the
#                  literal ` unaffected: ` token minus one trailing `:<digits>`, so any path characters work
#                  (`app/[id]/page.tsx`, `app/(auth)/login.tsx`, spaces). Files in the change set are never sites. An
#                  `updated` or `unresolved` line is informational: it never justifies a site.
#   --budget-seconds N  wall-clock budget (default 60). When it runs out the sweep stops, reports the partial result
#                  and prints BUDGET_EXCEEDED. A budget stop is advisory: it never produces exit 1.
#   --mode M       gate-mode strictness. `blocking` (default at script level): unaddressed sites exit 1. `advisory`:
#                  sites are printed as `ADVISORY:` lines and the exit is never 1. Callers pass the configured value
#                  (verification.consumer_sweep.mode).
#   --eval-history N  precision measurement: run the diff-mode sweep over the last N first-parent merges of HEAD and
#                  print flagged sites per merge plus the mean and max. Read-only; mutually exclusive with
#                  --range, --ident and --consumers.
#
# Extraction (diff mode) is a per-file survival filter over the diff. A token is swept only when it was REMOVED or
# RENAMED: it appears on a removed line and NOT on any added line of the same file, or it is the name on a
# definition head (function/class/const/def/fn/func/export ... or an assignment head) whose line changed. Tokens
# that survive the edit, prose words, numbers, versions and semver are never swept. Prose files (*.md, *.rst, *.txt,
# *.adoc) contribute only backticked tokens (fenced blocks are examples and spec-internal helpers). UPPER_CASE names count only where defined as constants. Kinds: function, class, const, env, key, flag, literal
# (7+ hex), path. Flags are swept without their leading dashes. Identifiers must match ^[A-Za-z0-9_.:/-]{4,80}$,
# must not start with "-", must contain a letter, must not be a version, are filtered through a stop-list, and are
# written to a pattern file consumed by ONE `git grep -n -w -F -f` as data only: diff text is never evaluated as
# shell or as a regex. Hits in generated/vendored paths are skipped: the same default globs as scripts/diff-size.sh
# (keep in sync) plus --exclude-glob (callers pass build.scope.exclude_globs).
#
# Output (sweep mode): TSV `identifier<TAB>kind<TAB>file:line`, at most --cap rows per identifier (default 25),
# applied before any per-hit work; a further `identifier<TAB>truncated<TAB>+N` row marks the cut (advisory, never a
# gate failure). A removed function/class whose name is still defined outside the change set prints
# `identifier<TAB>ambiguous<TAB>still defined at file:line` instead of sites (informational). An over-budget run adds `*<TAB>BUDGET_EXCEEDED<TAB>detail`. Gate mode prints
# `UNADDRESSED: <identifier> <file:line>` per unaddressed site (`ADVISORY:` in advisory mode), or `OK: ...`.
#
# Exit: 0 swept / all addressed (including no sites, advisory mode, and BUDGET_EXCEEDED); 1 unaddressed sites (gate
# mode, blocking); 2 usage error, unresolvable ref or any git failure — NEVER a pass; callers report DEGRADED.
#
# Offline: no network, no gh. Bash 3.2 portable: no mapfile, no associative arrays in the shell part.

set -uo pipefail

MAX_IDS=150
RANGE=""; REPO="."; CAP=25; CONSUMERS=""; IDENTS=""; EXTRA=""; BUDGET=60; MODE=blocking; EVAL=""
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
    --budget-seconds) [ "$#" -ge 2 ] || die2 "--budget-seconds needs a value"; BUDGET="$2"; shift 2 ;;
    --mode)         [ "$#" -ge 2 ] || die2 "--mode needs a value"; MODE="$2"; shift 2 ;;
    --eval-history) [ "$#" -ge 2 ] || die2 "--eval-history needs a value"; EVAL="$2"; shift 2 ;;
    *) die2 "usage: consumer-sweep.sh (--range <base>..<head> [--consumers FILE] | --ident NAME... | --eval-history N) [--repo P] [--exclude-glob G]... [--cap N] [--budget-seconds N] [--mode advisory|blocking]" ;;
  esac
done
case "$CAP" in ""|0|*[!0-9]*) die2 "--cap must be a positive integer" ;; esac
case "$BUDGET" in ""|*[!0-9]*) die2 "--budget-seconds must be a non-negative integer" ;; esac
case "$MODE" in advisory|blocking) ;; *) die2 "--mode must be advisory or blocking" ;; esac
if [ -n "$EVAL" ]; then
  case "$EVAL" in 0|*[!0-9]*) die2 "--eval-history must be a positive integer" ;; esac
  if [ -n "$RANGE$IDENTS$CONSUMERS" ]; then die2 "--eval-history is mutually exclusive with --range, --ident and --consumers"; fi
else
  if [ -n "$RANGE" ] && [ -n "$IDENTS" ]; then die2 "--range and --ident are mutually exclusive"; fi
  if [ -z "$RANGE" ] && [ -z "$IDENTS" ]; then die2 "one of --range, --ident or --eval-history is required"; fi
fi
if [ -n "$CONSUMERS" ]; then
  [ -n "$RANGE" ] || die2 "--consumers requires --range"
  [ -f "$CONSUMERS" ] || die2 "consumers file not found: $CONSUMERS"
fi
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die2 "not a git work tree: $REPO"
SECONDS=0

# ---- precision evaluation over merge history ------------------------------------------------------------
if [ -n "$EVAL" ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  MERGES=$(git -C "$REPO" log --merges --first-parent -n "$EVAL" --format=%H HEAD 2>/dev/null) || die2 "git log failed"
  [ -n "$MERGES" ] || die2 "no merge commits found for --eval-history"
  SUMMARY=""
  for m in $MERGES; do
    set -- --repo "$REPO" --range "${m}^1..${m}" --budget-seconds "$BUDGET" --cap "$CAP"
    while IFS= read -r g; do [ -z "$g" ] || set -- "$@" --exclude-glob "$g"; done <<EOF
$EXTRA
EOF
    out=$(bash "$SELF" "$@" 2>/dev/null); rcx=$?
    subj=$(git -C "$REPO" log -n 1 --format=%s "$m" 2>/dev/null | cut -c1-70)
    if [ "$rcx" -ne 0 ]; then
      printf 'eval\t%s\terror(rc=%s)\t%s\n' "$(printf '%s' "$m" | cut -c1-10)" "$rcx" "$subj"
      continue
    fi
    stat=$(printf '%s\n' "$out" | awk -F'\t' '
      $2 == "BUDGET_EXCEEDED" { b = 1; next }
      $2 == "ambiguous" { next }
      $2 == "truncated" { v = $3; sub(/^\+/, "", v); sites += v + 0; next }
      NF >= 3 { sites++; ids[$1] = 1 }
      END { n = 0; for (k in ids) n++; print sites + 0 "\t" n "\t" (b ? "budget" : "") }')
    sites=${stat%%"$TAB"*}
    printf 'eval\t%s\tsites=%s\t%s\t%s\n' "$(printf '%s' "$m" | cut -c1-10)" "$sites" "$(printf '%s' "$stat" | cut -f3)" "$subj"
    SUMMARY="${SUMMARY}${sites}${NL}"
  done
  printf '%s' "$SUMMARY" | awk '
    NF { n++; t += $1; if ($1 + 0 > mx) mx = $1 + 0 }
    END {
      if (n == 0) { print "mean=0.00 max=0 prs=0 guard=UNKNOWN"; exit }
      mean = t / n
      printf "mean=%.2f max=%d prs=%d guard=%s\n", mean, mx, n, (mean <= 2 && mx <= 10) ? "PASS" : "FAIL"
    }'
  exit 0
fi

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
# the same rules, one per line, for the awk-side filter: R:<root prefix> D:<dir glob> G:<name/path glob>
: > "$TMP/globs"
for g in $ROOT_DIRS; do printf 'R:%s\n' "$g" >> "$TMP/globs"; done
set -f
for g in $GLOBS; do
  case "$g" in */) printf 'D:%s\n' "$g" >> "$TMP/globs" ;; *) printf 'G:%s\n' "$g" >> "$TMP/globs" ;; esac
done
set +f

: > "$TMP/changed"
: > "$TMP/excl"
: > "$TMP/raw"
OVER=0; OVERWHY=""

# ---- diff mode: change set and per-file survival extraction ---------------------------------------------
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
  # files whose lines are not extracted (generated/vendored)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if excluded "$f"; then printf '%s\n' "$f" >> "$TMP/excl"; fi
  done < "$TMP/changed"
  # shellcheck disable=SC2086
  git -C "$REPO" -c core.quotepath=off diff -U0 --no-color --no-ext-diff --no-renames $DIFFARGS -- > "$TMP/diff" 2>/dev/null \
    || die2 "git diff failed"

  # One awk pass: removed and added lines are collected per file (a "--- a/<path>" / "+++ b/<path>" header is read
  # only before the first @@ of a file, so removed "-- " lines are never mistaken for headers), then every
  # candidate token of a removed line is kept only when it did not survive in that file's added lines.
  cat > "$TMP/extract.awk" <<'AWK'
function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); gsub(/[ \t]+/, " ", s); return s }
function isprose(f) { f = tolower(f); return f ~ /\.(md|markdown|mdx|rst|txt|adoc|org)$/ }
function addl(F, s,   n, i, parts) {
  anl[F]++; al[F, anl[F]] = s
  gl[trim(s)] = 1
  n = split(s, parts, /[^A-Za-z0-9_]+/)
  for (i = 1; i <= n; i++) if (parts[i] != "") aw[F, parts[i]] = 1
}
function spans(s,   out) {
  out = ""   # spans are joined with a separator so two spans never read as one "keyword NAME" declaration
  while (match(s, /`[^`]+`/)) { out = out " \001 " substr(s, RSTART + 1, RLENGTH - 2); s = substr(s, RSTART + RLENGTH) }
  return out
}
# every maximal word-bounded run of identifier characters in one file's added lines, built once per file on first use
# (O(added chars x 80)), so a survival test is one hash lookup instead of a scan of every added line per candidate
function build(F,   k, line, n, i, j, c, pc, nc2) {
  built[F] = 1
  for (k = 1; k <= anl[F]; k++) {
    line = al[F, k]; n = length(line)
    for (i = 1; i <= n; i++) {
      c = substr(line, i, 1)
      if (c !~ /[A-Za-z0-9_.:\/-]/) continue
      pc = (i > 1) ? substr(line, i - 1, 1) : ""
      if (pc ~ /[A-Za-z0-9_]/) continue
      for (j = i; j <= n && j < i + 80; j++) {
        if (substr(line, j, 1) !~ /[A-Za-z0-9_.:\/-]/) break
        nc2 = (j < n) ? substr(line, j + 1, 1) : ""
        if (nc2 !~ /[A-Za-z0-9_]/) sx[F, substr(line, i, j - i + 1)] = 1
      }
    }
  }
}
function survives(F, id) {
  if (id ~ /^[A-Za-z0-9_]+$/) return ((F SUBSEP id) in aw)
  if (!(F in built)) build(F)
  return ((F SUBSEP id) in sx)
}
# a candidate must be code-like: charset, 4..80 chars, a letter, not a version/number, not a stop word
function cand(F, id, kind, head, norm) {
  if (id !~ /^[A-Za-z0-9_.:\/-]+$/) return
  if (length(id) < 4 || length(id) > 80 || substr(id, 1, 1) == "-") return
  if (id !~ /[A-Za-z]/) return
  if (id ~ /^[vV]?[0-9][0-9.]*([-+][A-Za-z0-9.+-]*)?$/) return
  if (id ~ /^[vV]?[0-9]+\.[0-9]+\.[0-9]+/) return
  if (tolower(id) in st) return
  nc++; cF[nc] = F; cid[nc] = id; ckind[nc] = kind; chead[nc] = head; cnorm[nc] = norm
}
function scan(F, t, norm, prose, pmode,   s, m, kw, nm, k, tok, ok, ext, comment, n, sp) {
  comment = (!prose && t ~ /^[ \t]*(#|\/\/|\*|\/\*|--[ \t]|;)/)
  # declarations: keyword [receiver] NAME  -> kind by keyword (a definition head: the whole line is compared)
  if (!comment) {
    s = t
    while (match(s, /(^|[^A-Za-z0-9_])(def|function|func|fn|fun|sub|proc|class|struct|interface|enum|trait|type|const|val)[ \t]+(\([^)]*\)[ \t]*)?[A-Za-z_][A-Za-z0-9_]*/)) {
      m = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
      kw = m; sub(/^[^A-Za-z]/, "", kw); sub(/[ \t].*$/, "", kw)
      nm = m; sub(/^.*[ \t)]/, "", nm)
      if (substr(s, 1, 1) !~ /[({<:=\[]/ && s !~ /^[ \t]*([({<:=\[]|$)/) continue
      k = "const"
      if (kw == "def" || kw == "function" || kw == "func" || kw == "fn" || kw == "fun" || kw == "sub" || kw == "proc") k = "function"
      else if (kw == "class" || kw == "struct" || kw == "interface" || kw == "enum" || kw == "trait" || kw == "type") k = "class"
      # a const/val is an API symbol only at top level or with an access modifier; an indented one is a local variable
      if (kw == "const" || kw == "val") {
        if (t !~ /^(const|val)[ \t]/ && t !~ /^[ \t]*((export|pub|public|private|protected|static|final|readonly|default|declare)[ \t]+)+(const|val)[ \t]/) continue
      }
      # only a function/class head is a signature: a changed const/val value does not invalidate its consumers
      cand(F, nm, k, (k == "const") ? 0 : 1, norm)
    }
  }
  # shell-style  name() {
  if (match(t, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*\(\)[ \t]*\{/)) {
    nm = substr(t, RSTART, RLENGTH); sub(/^[ \t]*/, "", nm); sub(/\(\).*$/, "", nm)
    cand(F, nm, "function", 1, norm)
  }
  # env vars: a quoted UPPER_CASE name, or process.env.NAME, on a line that reads the environment
  if (t ~ /getenv|environ|process\.env|os\.Getenv|ENV\[|env:|\.env/) {
    s = t
    while (match(s, /["'][A-Z][A-Z0-9_]*["']|process\.env\.[A-Z][A-Z0-9_]*/)) {
      tok = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
      sub(/^process\.env\./, "", tok); gsub(/["']/, "", tok)
      cand(F, tok, "env", 0, norm)
    }
  }
  # UPPER_CASE constants: only where the token is DEFINED as a constant. A modifier head (export/const/static/final/
  # readonly/#define ...), a column-0 assignment in a non-shell file, or an assignment in a key/value config file. A
  # shell variable (shell file or fenced shell in prose) is a local, never a constant. A backticked UPPER_SNAKE
  # mention in prose is a documented constant.
  s = t
  while (match(s, /(^|[^A-Za-z0-9_])[A-Z][A-Z0-9_]*([^A-Za-z0-9_]|$)/)) {
    tok = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    sub(/^[^A-Z]/, "", tok); sub(/[^A-Z0-9_]$/, "", tok)
    if (length(tok) < 4) continue
    ok = 0
    if (t ~ ("^[ \t]*((export|const|static|final|readonly|public|private|protected|declare|pub|let|var)[ \t]+)+" tok "([^A-Za-z0-9_]|$)") || t ~ ("^[ \t]*#[ \t]*define[ \t]+" tok "([^A-Za-z0-9_]|$)")) ok = 1
    else if (pmode == 1) ok = (index(tok, "_") > 0)
    else if (pmode == 0 && t !~ ("^[ \t]*" tok "[ \t]*==") && t ~ ("^" tok "[ \t]*[:=]") && F !~ /\.(sh|bash|zsh|ksh)$/) ok = 1
    else if (pmode == 0 && t ~ ("^[ \t]*" tok "[ \t]*[:=]") && F ~ /\.(ya?ml|toml|ini|env|properties|cfg|conf)$/) ok = 1
    if (ok) cand(F, tok, "const", 0, norm)
  }
  # CLI flags (swept without the leading dashes)
  s = t
  while (match(s, /(^|[^A-Za-z0-9_-])--[A-Za-z][A-Za-z0-9_-]*/)) {
    nm = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    sub(/^[^-]?--/, "", nm); sub(/-+$/, "", nm)
    # a flag is swept where the changed file DEFINES it (parser registration, case arm, or a documented option), never
    # where it merely passes the flag to another tool
    if (length(nm) >= 4 && (t ~ /add_argument|add_option|\.option\(|\.flag\(|Flag\(|flag\.[A-Z][A-Za-z]*\(|getopt|argparse|click\.option|\.Var\(/ \
        || t ~ ("^[ \t]*(-[A-Za-z][ \t]*\\|[ \t]*)?--" nm "(=[^ \t|)]*)?[ \t]*(\\||\\))") \
        || (prose && t ~ ("^[ \t]*--" nm "([^A-Za-z0-9_-]|$)")))) cand(F, nm, "flag", 0, norm)
  }
  # literals: 7+ hex that mixes digits and a-f (a pinned hash); semver and plain numbers are never swept
  s = t
  while (match(s, /(^|[^A-Za-z0-9_])[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]+([^A-Za-z0-9_]|$)/)) {
    tok = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    sub(/^[^0-9a-f]/, "", tok); sub(/[^0-9a-f]$/, "", tok)
    if (length(tok) <= 64 && tok ~ /[0-9]/ && tok ~ /[a-f]/) cand(F, tok, "literal", 0, norm)
  }
  # quoted config/context keys
  s = t
  while (match(s, /["'][A-Za-z_][A-Za-z0-9_.-]*["']/)) {
    tok = substr(s, RSTART + 1, RLENGTH - 2); s = substr(s, RSTART + RLENGTH)
    # a quoted string is a key only in key position (followed by a colon); other strings are messages, values or uses
    if (substr(s, 1, 1) == ":" || s ~ /^[ \t]*:/) cand(F, tok, "key", 0, norm)
  }
  # prose: the specific identifier a list item or table row DOCUMENTS (a leading backticked span such as
  # "- `legacy_option` ..." or "| `legacy_option` |"); a mid-sentence mention is a use, not a definition
  if (pmode == 1 && match(norm, /^([-*+]|\|)[ \t]*`[A-Za-z_][A-Za-z0-9_.-]*`/)) {
    tok = substr(norm, RSTART, RLENGTH); sub(/^[^`]*`/, "", tok); sub(/`$/, "", tok)
    if (tok ~ /[_.-]/ || tok ~ /.[A-Z]/) cand(F, tok, "ident", 0, norm)
  }
  # yaml-style keys (never from prose files)
  if (!prose && match(t, /^[ \t]*(-[ \t]+)?[A-Za-z_][A-Za-z0-9_.-]*:([ \t]|$)/)) {
    tok = substr(t, RSTART, RLENGTH); sub(/^[ \t]*(-[ \t]+)?/, "", tok); sub(/:[ \t]?$/, "", tok)
    cand(F, tok, "key", 0, norm)
  }
}
BEGIN {
  while ((getline l < excl) > 0) skip[l] = 1
  n = split(xstop, sw, " ")
  for (i = 1; i <= n; i++) st[tolower(sw[i])] = 1
}
/^diff --git / { inhunk = 0; next }
/^@@ / { inhunk = 1; hunk++; next }
!inhunk && /^--- / { p = substr($0, 5); sub(/\t.*$/, "", p); sub(/^a\//, "", p); cur = p; next }
!inhunk && /^\+\+\+ / {
  p = substr($0, 5); sub(/\t.*$/, "", p); sub(/^b\//, "", p); curb = p
  # a deleted or moved-away file: its own path is an identifier whose references go stale
  if (p == "/dev/null" && cur != "/dev/null" && !(cur in skip)) cand(cur, cur, "path", 0, "")
  next
}
inhunk && /^-/ { if (!(cur in skip) && cur != "/dev/null") { nr++; rf[nr] = cur; rt[nr] = substr($0, 2); rh[nr] = hunk } next }
inhunk && /^\+/ { if (curb != "/dev/null" && !(curb in skip)) addl(curb, substr($0, 2)); next }
END {
  lasth = -1
  for (i = 1; i <= nr; i++) {
    F = rf[i]; line = rt[i]
    if (rh[i] != lasth) { fence = 0; lasth = rh[i] }
    prose = isprose(F); text = line
    if (prose) {
      if (line ~ /^[ \t]*(```|~~~)/) { fence = !fence; continue }
      # fenced blocks in prose are examples and spec-internal helpers (shell locals, sample JSON): not definitions
      if (fence) continue
      text = spans(line)
      if (text == "") continue
    }
    scan(F, text, trim(line), prose, prose ? 1 : 0)
  }
  for (c = 1; c <= nc; c++) {
    # a definition head whose exact line still exists in the added side (same file or moved) did not change
    if (chead[c] && (cnorm[c] in gl)) continue
    # a token that survives in the file's added lines was edited around, not removed; only a changed head counts
    if (survives(cF[c], cid[c]) && !chead[c]) continue
    print cid[c] "\t" ckind[c]
  }
}
AWK
  XSTOP="that this with from have will your into than then them they were been being their there these those which while where when what would could should about after before because between both each other such only also more most some many much very just like make made used uses using need needs needed must may might shall can cannot does done doing not nor yet but and for are the any all one two use via per set get put add see run runs also else elif try catch finally case switch default return returns import export from yield await async static public private protected final override begin end then fi done esac function class struct enum type none null true false undefined void version versions note notes todo fixme hack example examples see below above following here step steps stage phase section sections item items line lines word words text name names title label labels body bodies content contents message messages description summary details detail info information option options param params parameter parameters arg args argument arguments key keys value values field fields row rows column columns table tables list lists array arrays map maps string strings number numbers boolean object objects element elements node nodes child children parent parents root base head tail first last next prev previous current latest main master release releases branch branches commit commits change changes changed file files path paths dir dirs directory folder folders link links url urls href src dest target targets source sources input inputs output outputs result results error errors warn warning warnings debug trace level levels mode modes state states status user users admin id ids uid uuid time date datetime timestamp when once always never true false enabled disabled enable disable active inactive required optional allow deny allowed denied yes no on off"
  # the extraction runs inside the same --budget-seconds deadline as the grep: over budget is advisory, never a failure
  REM=$((BUDGET - SECONDS)); TO=""
  if command -v timeout >/dev/null 2>&1; then TO="timeout"; elif command -v gtimeout >/dev/null 2>&1; then TO="gtimeout"; fi
  if [ "$REM" -le 0 ]; then
    OVER=1; OVERWHY="budget ${BUDGET}s spent before the extraction started"
  else
    ${TO:+"$TO" "$REM"} awk -v excl="$TMP/excl" -v xstop="$XSTOP" -f "$TMP/extract.awk" "$TMP/diff" 2>/dev/null > "$TMP/raw"
    xrc=$?
    if [ "$xrc" -eq 124 ]; then
      : > "$TMP/raw"; OVER=1; OVERWHY="budget ${BUDGET}s elapsed during the extraction; results are partial"
    elif [ "$xrc" -ne 0 ]; then die2 "extraction failed"; fi
  fi
else
  # ---- identifier mode ------------------------------------------------------------------------------------
  printf '%s' "$IDENTS" | sed '/^$/d' | awk '{ print $0 "\tident" }' > "$TMP/raw"
fi

# ---- filter: first-seen per identifier, charset, length, stop-list -------------------------------------
STOP="true false null none self this main init test tests data name type types value values list dict item items result results error errors string default config options args kwargs size path file files text node nodes index count state status user users TODO FIXME NOTE HACK NULL TRUE FALSE NONE UTF8 JSON YAML HTML HTTP HTTPS GET POST PUT PATCH DELETE ERROR WARN INFO DEBUG EOF LINE MAIN version VERSION"
awk -F'\t' -v stop="$STOP" '
  BEGIN { n = split(stop, s, " "); for (i = 1; i <= n; i++) st[tolower(s[i])] = 1 }
  $1 ~ /^[A-Za-z0-9_.:\/-]+$/ && length($1) >= 4 && length($1) <= 80 && substr($1, 1, 1) != "-" && $1 ~ /[A-Za-z]/ \
    && $1 !~ /^[vV]?[0-9][0-9.]*([-+][A-Za-z0-9.+-]*)?$/ \
    && !(tolower($1) in st) && !seen[$1]++ { print $1 "\t" $2 }
' "$TMP/raw" > "$TMP/ids"
if [ -z "$RANGE" ]; then
  # an explicit --ident that fails validation is a usage error, never silently skipped
  want=$(printf '%s' "$IDENTS" | sed '/^$/d' | wc -l | tr -d ' ')
  have=$(wc -l < "$TMP/ids" | tr -d ' ')
  [ "$want" = "$have" ] || die2 "invalid --ident (want ^[A-Za-z0-9_.:/-]{4,80}\$, not a stop-list word, no duplicates)"
fi

# ---- sweep: ONE bounded git grep -----------------------------------------------------------------------
: > "$TMP/sites"   # identifier<TAB>kind<TAB>file:line
NIDS=$(wc -l < "$TMP/ids" | tr -d ' ')
if [ "$NIDS" -gt "$MAX_IDS" ]; then
  head -n "$MAX_IDS" "$TMP/ids" > "$TMP/ids.cut"; mv "$TMP/ids.cut" "$TMP/ids"
fi
if [ -s "$TMP/ids" ]; then
  cut -f1 "$TMP/ids" > "$TMP/idents"
  REM=$((BUDGET - SECONDS))
  if [ "$REM" -le 0 ]; then
    OVER=1; OVERWHY="budget ${BUDGET}s spent before the grep started"
  else
    TO=""
    if command -v timeout >/dev/null 2>&1; then TO="timeout"; elif command -v gtimeout >/dev/null 2>&1; then TO="gtimeout"; fi
    if [ -n "$TO" ]; then
      "$TO" "$REM" git -C "$REPO" grep -n -z -I -w -F -f "$TMP/idents" -- . > "$TMP/g" 2> "$TMP/gerr"
    else
      git -C "$REPO" grep -n -z -I -w -F -f "$TMP/idents" -- . > "$TMP/g" 2> "$TMP/gerr"
    fi
    grc=$?
    if [ "$grc" -eq 124 ]; then
      OVER=1; OVERWHY="budget ${BUDGET}s elapsed during the grep; results are partial"
    elif [ "$grc" -gt 1 ]; then
      die2 "git grep failed (rc=$grc): $(head -n 1 "$TMP/gerr")"
    fi
    if [ -s "$TMP/g" ]; then
      # group, drop the change set and excluded paths, cap per identifier before any per-hit work: one awk, no forks
      tr '\0' '\001' < "$TMP/g" | awk -v cap="$CAP" -v plainprose="$([ -n "$RANGE" ] && echo 1 || echo 0)" -v ids="$TMP/ids" -v changed="$TMP/changed" -v globs="$TMP/globs" '
        function globre(g,   i, c, r) {
          r = "^"
          for (i = 1; i <= length(g); i++) {
            c = substr(g, i, 1)
            if (c == "*") r = r ".*"
            else if (c == "?") r = r "."
            else if (c ~ /[.+(){}|^$\\\[\]]/) r = r "\\" c
            else r = r c
          }
          return r "$"
        }
        function isexcl(p,   i, b) {
          for (i = 1; i <= nroot; i++) if (index(p, roots[i]) == 1) return 1
          for (i = 1; i <= ndir; i++) if (index("/" p, "/" dirs[i]) > 0) return 1
          b = p; sub(/^.*\//, "", b)
          for (i = 1; i <= ng; i++) if (b ~ gre[i] || p ~ gre[i]) return 1
          return 0
        }
        function hasword(text, id,   start, p, abs, prev, nx) {
          start = 1
          while ((p = index(substr(text, start), id)) > 0) {
            abs = start + p - 1
            prev = (abs > 1) ? substr(text, abs - 1, 1) : ""
            nx = substr(text, abs + length(id), 1)
            if (prev !~ /[A-Za-z0-9_]/ && nx !~ /[A-Za-z0-9_]/) return 1
            start = abs + 1
          }
          return 0
        }
        # the name a hit line DEFINES (keyword NAME, or shell name() {), or ""
        function defname(text,   m, nm, r) {
          if (match(text, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*\(\)[ \t]*\{/)) {
            nm = substr(text, RSTART, RLENGTH); sub(/^[ \t]*/, "", nm); sub(/\(\).*$/, "", nm); return nm
          }
          if (match(text, /(^|[^A-Za-z0-9_])(def|function|func|fn|fun|sub|proc|class|struct|interface|enum|trait|type)[ \t]+(\([^)]*\)[ \t]*)?[A-Za-z_][A-Za-z0-9_]*/)) {
            nm = substr(text, RSTART, RLENGTH); sub(/^.*[ \t)]/, "", nm); return nm
          }
          return ""
        }
        BEGIN {
          FS = "\001"
          while ((getline l < ids) > 0) {
            split(l, a, "\t"); N++; iid[N] = a[1]; ikind[N] = a[2]
            if (a[1] ~ /^[A-Za-z0-9_]+$/) wid[a[1]] = N; else sid[++ns] = N
            # a plain lowercase word is generic English in prose: it is swept in code files only (diff mode)
            if (plainprose && a[1] ~ /^[a-z]+$/) plain[N] = 1
          }
          while ((getline l < changed) > 0) chg[l] = 1
          while ((getline l < globs) > 0) {
            v = substr(l, 3)
            if (substr(l, 1, 2) == "R:") roots[++nroot] = v
            else if (substr(l, 1, 2) == "D:") dirs[++ndir] = v
            else gre[++ng] = globre(v)
          }
        }
        NF >= 3 {
          f = $1; ln = $2
          if (f in chg) next
          if (!(f in exc)) exc[f] = isexcl(f)
          if (exc[f]) next
          if (!(f in pro)) pro[f] = (tolower(f) ~ /\.(md|markdown|mdx|rst|txt|adoc|org)$/)
          text = $3
          for (j = 4; j <= NF; j++) text = text "\001" $j
          hit++
          dn = defname(text)
          if (dn != "" && (dn in wid)) { dk = wid[dn]; if ((ikind[dk] == "function" || ikind[dk] == "class") && !(dk in defat)) defat[dk] = f ":" ln }
          nw = split(text, w, /[^A-Za-z0-9_]+/)
          for (j = 1; j <= nw; j++) if (w[j] in wid) { k = wid[w[j]]; if (seen[k] != hit) { seen[k] = hit; take(k, f, ln) } }
          for (j = 1; j <= ns; j++) { k = sid[j]; if (seen[k] != hit && index(text, iid[k]) > 0 && hasword(text, iid[k])) { seen[k] = hit; take(k, f, ln) } }
        }
        function take(k, f, ln) {
          if (plain[k] && pro[f]) return
          cnt[k]++
          if (cnt[k] <= cap) rows[k] = rows[k] iid[k] "\t" ikind[k] "\t" f ":" ln "\n"
          else extra[k]++
        }
        END {
          for (k = 1; k <= N; k++) {
            # a removed function/class whose name is still DEFINED outside the change set is not a unique symbol:
            # its references resolve to the other definition, so they cannot be attributed to the removed one
            if (k in defat) { printf "%s\tambiguous\tstill defined at %s\n", iid[k], defat[k]; continue }
            if (k in rows) printf "%s", rows[k]
            if (extra[k] > 0) printf "%s\ttruncated\t+%d\n", iid[k], extra[k]
          }
        }
      ' > "$TMP/sites" || die2 "sweep grouping failed"
    fi
  fi
fi
if [ "$NIDS" -gt "$MAX_IDS" ]; then printf '*\ttruncated\tidentifiers beyond %s not swept\n' "$MAX_IDS" >> "$TMP/sites"; fi
if [ "$OVER" -eq 1 ]; then printf '*\tBUDGET_EXCEEDED\t%s\n' "$OVERWHY" >> "$TMP/sites"; fi

if [ -z "$CONSUMERS" ]; then
  cat "$TMP/sites"
  exit 0
fi

# ---- gate mode -------------------------------------------------------------------------------------------
# Justified files: lines like  "- path[:line] unaffected: reason"  (leading bullet and backticks tolerated). The
# path is everything before the literal " unaffected: " token minus one trailing :<digits>, so any path characters
# work; a line with an empty reason never justifies.
sed -E 's/\r$//; s/`//g; s/^[[:space:]]*([-*][[:space:]]+)?//' "$CONSUMERS" \
  | awk '{
      sub(/[ \t]+$/, "")
      i = index($0, " unaffected: ")
      if (i > 1) {
        p = substr($0, 1, i - 1); r = substr($0, i + 13)
        gsub(/^[ \t]+|[ \t]+$/, "", p); gsub(/^[ \t]+|[ \t]+$/, "", r)
        sub(/:[0-9]+$/, "", p)
        if (p != "" && r != "") print p
      }
    }' \
  | sort -u > "$TMP/justified"
RC=0; NSITES=0; NUNADDR=0
LABEL="UNADDRESSED"; [ "$MODE" != advisory ] || LABEL="ADVISORY"
while IFS="$TAB" read -r id kind loc; do
  [ -n "$id" ] || continue
  [ "$kind" != truncated ] || continue
  [ "$kind" != BUDGET_EXCEEDED ] || continue
  [ "$kind" != ambiguous ] || continue
  NSITES=$((NSITES+1))
  f="${loc%:*}"
  grep -Fxq -- "$f" "$TMP/justified" && continue
  echo "$LABEL: $id $loc"; NUNADDR=$((NUNADDR+1)); RC=1
done < "$TMP/sites"
if [ "$OVER" -eq 1 ]; then
  echo "BUDGET_EXCEEDED: $OVERWHY (advisory: the sweep is incomplete and never fails the gate)"
  exit 0
fi
if [ "$MODE" = advisory ]; then
  echo "OK: consumer sweep advisory ($NSITES site(s), $NUNADDR unaddressed; mode=advisory never fails)"
  exit 0
fi
[ "$RC" -ne 0 ] || echo "OK: consumer sweep addressed ($NSITES site(s))"
exit "$RC"
