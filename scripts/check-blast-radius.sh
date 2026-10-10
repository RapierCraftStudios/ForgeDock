#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-blast-radius.sh — Enforce the FORGE:ARCHITECT blast-radius manifest against the final tree.
#
# Usage: check-blast-radius.sh --manifest <file> --base <ref> [--repo <path>]
#
# <file> is either the extracted manifest block or a whole FORGE:ARCHITECT comment body. Only the text between
# <!-- FORGE:BLAST_RADIUS:BEGIN --> and <!-- FORGE:BLAST_RADIUS:END --> is parsed (all such regions, concatenated).
# Grammar, one record per line (blank lines and markdown code-fence lines are the only other lines allowed):
#   SYMBOL: id=<sN> kind=function|field|flag|schema|contract name=<symbol> query="<fixed-string>"
#   HIT: symbol=<sN> file=<path> role=producer|consumer|sibling disposition=change
#   HIT: symbol=<sN> file=<path> role=producer|consumer|sibling disposition=verified-unaffected reason=<one-token>
# Values contain no spaces (use hyphens in reason). query must match ^[A-Za-z0-9_.:/-]{3,80}$ and not start with "-".
#
# For every SYMBOL the query is re-run as a fixed-string search over the final tree (working tree, tracked plus
# untracked files, so it works before and after the commit). A file that matches must be in the change set
# (base...HEAD plus anything staged, modified or untracked) or carry a verified-unaffected row.
# A "change" row whose file is not in the change set is a planned-but-not-done item.
#
# Exit codes:
#   0  covered, or no manifest ("SKIP: no manifest")
#   1  UNLISTED: <symbol> <file>  and/or  NOT_DONE: <symbol> <file>
#   2  malformed manifest, invalid query, unresolvable base/repo, or a git failure — NEVER a pass; callers report DEGRADED
#
# Offline: no network, no gh. Portable to bash 3.2: no mapfile, no associative arrays, no sort -V.

set -uo pipefail

MAX_HITS=200
MANIFEST=""; BASE=""; REPO="."
die2() { echo "check-blast-radius: $*" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) [ "$#" -ge 2 ] || die2 "--manifest needs a value"; MANIFEST="$2"; shift 2 ;;
    --base)     [ "$#" -ge 2 ] || die2 "--base needs a value"; BASE="$2"; shift 2 ;;
    --repo)     [ "$#" -ge 2 ] || die2 "--repo needs a value"; REPO="$2"; shift 2 ;;
    *) die2 "usage: check-blast-radius.sh --manifest <file> --base <ref> [--repo <path>]" ;;
  esac
done
[ -n "$MANIFEST" ] || die2 "usage: check-blast-radius.sh --manifest <file> --base <ref> [--repo <path>]"
[ -f "$MANIFEST" ] || die2 "manifest file not found: $MANIFEST"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/check-blast-radius.XXXXXX") || die2 "mktemp failed"
trap 'rm -rf "$TMP"' EXIT

# ---- extract BEGIN..END regions -------------------------------------------------------------------------
awk -v out="$TMP/region" '
  index($0, "<!-- FORGE:BLAST_RADIUS:BEGIN -->") { if (inb) { bad = 1 } inb = 1; seen = 1; next }
  index($0, "<!-- FORGE:BLAST_RADIUS:END -->")   { if (!inb) { bad = 1 } inb = 0; next }
  inb { print > out }
  END { if (inb || bad) exit 3; if (!seen) exit 4 }
' "$MANIFEST"
case $? in
  0) ;;
  4) echo "SKIP: no manifest"; exit 0 ;;
  *) die2 "unbalanced FORGE:BLAST_RADIUS:BEGIN/END markers" ;;
esac
[ -f "$TMP/region" ] || { echo "SKIP: no manifest"; exit 0; }

# has_symbol <id>: awk over the file (no grep -q in a pipeline: SIGPIPE under pipefail misreports the status)
has_symbol() { awk -F'\t' -v s="$1" '$1==s {ok=1} END{exit ok?0:1}' "$TMP/symbols"; }

# ---- parse ----------------------------------------------------------------------------------------------
: > "$TMP/symbols"   # id<TAB>name<TAB>query
: > "$TMP/hits"      # symbol<TAB>file<TAB>disposition
QRE='^[A-Za-z0-9_.:/-]{3,80}$'
FRE='^[A-Za-z0-9_./@+=:,-]+$'
LN=0
while IFS= read -r line || [ -n "$line" ]; do
  LN=$((LN+1))
  line="${line%$'\r'}"
  trimmed="${line#"${line%%[![:space:]]*}"}"
  case "$trimmed" in
    ""|'```'*) continue ;;
    "SYMBOL: "*) kind_rec=SYMBOL; rest="${trimmed#SYMBOL: }" ;;
    "HIT: "*)    kind_rec=HIT;    rest="${trimmed#HIT: }" ;;
    *) die2 "line $LN: unrecognised record: $trimmed" ;;
  esac
  id=""; kind=""; name=""; query=""; symbol=""; file=""; role=""; disp=""; reason=""
  set -f
  for tok in $rest; do
    case "$tok" in
      *=*) k="${tok%%=*}"; v="${tok#*=}" ;;
      *) set +f; die2 "line $LN: token without key=value: $tok" ;;
    esac
    case "$k" in
      id) id="$v" ;; kind) kind="$v" ;; name) name="$v" ;;
      query) v="${v#\"}"; v="${v%\"}"; query="$v" ;;
      symbol) symbol="$v" ;; file) file="$v" ;; role) role="$v" ;;
      disposition) disp="$v" ;; reason) reason="$v" ;;
      *) set +f; die2 "line $LN: unknown key: $k" ;;
    esac
  done
  set +f
  if [ "$kind_rec" = SYMBOL ]; then
    case "$id" in s[0-9]*) ;; *) die2 "line $LN: SYMBOL id must look like s1: '$id'" ;; esac
    case "$id" in *[!A-Za-z0-9]*) die2 "line $LN: invalid SYMBOL id: '$id'" ;; esac
    case "$kind" in function|field|flag|schema|contract) ;; *) die2 "line $LN: invalid kind: '$kind'" ;; esac
    [ -n "$name" ] || die2 "line $LN: SYMBOL without name"
    [ -n "$query" ] || die2 "line $LN: empty query"
    case "$query" in -*) die2 "line $LN: query must not start with '-'" ;; esac
    [[ "$query" =~ $QRE ]] || die2 "line $LN: invalid query (want $QRE): $query"
    has_symbol "$id" && die2 "line $LN: duplicate SYMBOL id: $id"
    printf '%s\t%s\t%s\n' "$id" "$name" "$query" >> "$TMP/symbols"
  else
    [ -n "$symbol" ] || die2 "line $LN: HIT without symbol"
    has_symbol "$symbol" || die2 "line $LN: HIT references unknown symbol: $symbol"
    [ -n "$file" ] || die2 "line $LN: HIT without file"
    case "$file" in -*) die2 "line $LN: file must not start with '-'" ;; esac
    [[ "$file" =~ $FRE ]] || die2 "line $LN: invalid file path: $file"
    case "$role" in producer|consumer|sibling) ;; *) die2 "line $LN: invalid role: '$role'" ;; esac
    case "$disp" in
      change) ;;
      verified-unaffected) [ -n "$reason" ] || die2 "line $LN: verified-unaffected requires reason=<token>" ;;
      *) die2 "line $LN: invalid disposition: '$disp'" ;;
    esac
    printf '%s\t%s\t%s\n' "$symbol" "$file" "$disp" >> "$TMP/hits"
  fi
done < "$TMP/region"

if [ ! -s "$TMP/symbols" ]; then
  if [ -s "$TMP/hits" ]; then die2 "HIT records without any SYMBOL"; fi
  echo "SKIP: no manifest"; exit 0
fi

# ---- repo, base, change set -----------------------------------------------------------------------------
case "$BASE" in ""|-*) die2 "invalid --base: '$BASE'" ;; esac
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die2 "not a git work tree: $REPO"
git -C "$REPO" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1 || die2 "cannot resolve base ref '$BASE'"

: > "$TMP/changed"
git -C "$REPO" diff -z --name-only "${BASE}...HEAD" -- > "$TMP/c1" 2>/dev/null || die2 "git diff ${BASE}...HEAD failed"
git -C "$REPO" diff -z --name-only HEAD -- > "$TMP/c2" 2>/dev/null || die2 "git diff HEAD failed"
git -C "$REPO" ls-files -z --others --exclude-standard > "$TMP/c3" 2>/dev/null || die2 "git ls-files failed"
cat "$TMP/c1" "$TMP/c2" "$TMP/c3" | tr '\0' '\n' | sed '/^$/d' | sort -u > "$TMP/changed"

# ---- check ----------------------------------------------------------------------------------------------
RC=0
while IFS="$(printf '\t')" read -r sid sname squery; do
  git -C "$REPO" grep -z --untracked -l -F -e "$squery" -- > "$TMP/g" 2>"$TMP/gerr"
  grc=$?
  if [ "$grc" -gt 1 ]; then die2 "git grep failed for symbol $sid (rc=$grc): $(head -n 1 "$TMP/gerr")"; fi
  tr '\0' '\n' < "$TMP/g" | sed '/^$/d' | sort -u > "$TMP/found"
  n=$(wc -l < "$TMP/found" | tr -d ' ')
  [ "$n" -le "$MAX_HITS" ] || die2 "query too broad for symbol $sid ($n files > $MAX_HITS): use a more distinctive query"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if grep -Fxq -- "$f" "$TMP/changed"; then continue; fi
    if awk -F'\t' -v s="$sid" -v f="$f" '$1==s && $2==f && $3=="verified-unaffected" {ok=1} END{exit ok?0:1}' "$TMP/hits"; then continue; fi
    echo "UNLISTED: $sid $f"; RC=1
  done < "$TMP/found"
  # planned-but-not-done: change rows for this symbol whose file is not in the change set
  while IFS="$(printf '\t')" read -r hs hf hd; do
    [ "$hs" = "$sid" ] && [ "$hd" = change ] || continue
    grep -Fxq -- "$hf" "$TMP/changed" || { echo "NOT_DONE: $sid $hf"; RC=1; }
  done < "$TMP/hits"
done < "$TMP/symbols"

# HIT rows whose symbol exists were validated at parse time; a manifest that covers every hit passes.
[ "$RC" -eq 0 ] && echo "OK: blast-radius manifest covered ($(wc -l < "$TMP/symbols" | tr -d ' ') symbol(s))"
exit "$RC"
