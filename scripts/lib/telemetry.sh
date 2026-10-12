#!/usr/bin/env bash
# telemetry.sh — fail-safe structured telemetry emitter (sourced helper, or exec'd as a CLI).
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
#   . scripts/lib/telemetry.sh;  forge_emit <event> key=value...      # sourced
#   bash scripts/lib/telemetry.sh <event> key=value...                 # exec'd (spec call sites)
#
# One compact JSON line per call: v, ts, forge_version, repo, issue, pr, run, phase, event + payload. GitHub is the
# canonical store: the line is appended to the trusted `<!-- FORGE:TELEMETRY v1 -->` comment on the issue (or PR for
# review-side events), edited in place (JSONL inside a fenced block), rolling over to `... v1 part=N` near 60000 chars.
# A failed write is appended to a local buffer and flushed by the next emit for the same target; the buffer is only
# a cache, everything flushed is recoverable from GitHub alone. The emitter NEVER fails or changes the caller:
# always returns 0, all output is discarded, `FORGE_TELEMETRY=off` disables it. It records ids, counts and codes only,
# never comment bodies, file contents or secrets (values are charset-restricted and truncated).
#
# Context env: FORGE_REPO (default: parsed from `git remote get-url origin`), FORGE_ISSUE, FORGE_PR, FORGE_RUN,
# FORGE_PHASE; null when unset. With no repo or no numeric target the record is dropped (nothing to write to).
# Test hooks: FORGE_TELEMETRY_GH (gh replacement), FORGE_TELEMETRY_BUFFER_DIR, FORGE_TELEMETRY_MAX_CHARS.
# Comment trust is decided by scripts/trusted-comments.sh (the one trust predicate), resolved next to this file.
# bash 3.2 portable.

_FORGE_TEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

_forge_tel_clean() { # sanitize a payload value: restricted charset, max 200 chars
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -c 'A-Za-z0-9 _.:/#@+=,-' '_' | cut -c1-200
}

_forge_tel_record() { # event k=v... -> one JSON line on stdout
  local ev="$1"; shift
  local ver="" repo="${FORGE_REPO:-}" args=() kv k v
  if [ -z "$repo" ]; then
    repo=$(git remote get-url origin 2>/dev/null | sed -E 's#^.*[:/]([^/:]+/[^/]+)$#\1#; s#\.git$##')
  fi
  ver=$(jq -r '.version // empty' "$_FORGE_TEL_DIR/../../package.json" 2>/dev/null)
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    case "$kv" in *=*) ;; *) continue ;; esac
    case "$k" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    case "$k" in v|ts|forge_version|repo|issue|pr|run|phase|event|eid) continue ;; esac
    args+=("$k" "$(_forge_tel_clean "$v")")
  done
  jq -nc --arg ev "$ev" --arg ver "$ver" --arg repo "$repo" --arg issue "${FORGE_ISSUE:-}" --arg pr "${FORGE_PR:-}" \
    --arg run "${FORGE_RUN:-}" --arg phase "${FORGE_PHASE:-}" --arg eid "$(date +%s)-$$-${RANDOM}${RANDOM}${RANDOM}" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    def num: if test("^[0-9]+$") then tonumber else null end;
    def str: if . == "" then null else . end;
    ($ARGS.positional | [range(0; length; 2) as $i | {key: .[$i], value: .[$i+1]}]
      | map(.value |= (if test("^-?[0-9]+$") then tonumber elif . == "true" then true elif . == "false" then false else . end))
      | from_entries) as $p
    | {v: 1, ts: $ts, forge_version: ($ver | str), repo: ($repo | str), issue: ($issue | num), pr: ($pr | num),
       run: ($run | str), phase: ($phase | str), event: $ev, eid: $eid} + $p' --args "${args[@]}"
}

# finding_disposition payload is generic key=value (incl. scope=introduced|pre-existing|unknown); no per-field allowlist applies.
# Prints "<number> <repo>" of the comment target (issue or PR) for this event, or nothing when none is usable.
_forge_tel_target() {
  local ev="$1" repo="$2" n
  case "$ev" in
    review_panel|finding_disposition|ci_gate) n="${FORGE_PR:-}"; case "$n" in ''|*[!0-9]*) n="${FORGE_ISSUE:-}" ;; esac ;;
    *) n="${FORGE_ISSUE:-}"; case "$n" in ''|*[!0-9]*) n="${FORGE_PR:-}" ;; esac ;;
  esac
  case "$n" in ''|*[!0-9]*) return 0 ;; esac
  case "$repo" in */*) ;; *) return 0 ;; esac
  printf '%s %s\n' "$n" "$repo"
}

# Appends the JSONL lines on stdin to the trusted telemetry comment of <repo>#<n>; returns non-zero on any failure.
_forge_tel_upsert() {
  local repo="$1" n="$2" gh="${FORGE_TELEMETRY_GH:-gh}" max="${FORGE_TELEMETRY_MAX_CHARS:-60000}"
  local nl fence new comments cand id body part best_id="" best_part=0 best_body="" all_bodies="" lines hdr out tc
  new=$(cat); [ -n "$new" ] || return 0
  tc="$_FORGE_TEL_DIR/../trusted-comments.sh"; [ -f "$tc" ] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  local to=""; command -v timeout >/dev/null 2>&1 && to="timeout 30"
  comments=$($to "$gh" api --paginate "repos/$repo/issues/$n/comments" 2>/dev/null) || return 1
  [ -n "$comments" ] || comments='[]'
  # Candidates carry the marker; each is then checked individually against the trust predicate.
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    id=$(printf '%s' "$cand" | jq -r '.id')
    [ "$(printf '[%s]' "$cand" | bash "$tc" count '^<!-- FORGE:TELEMETRY v1( part=[0-9]+)? -->' 2>/dev/null)" = "1" ] || continue
    body=$(printf '%s' "$cand" | jq -r '.body')
    all_bodies="${all_bodies}${body}"$'\n'
    part=$(printf '%s' "$body" | sed -n '1s/^<!-- FORGE:TELEMETRY v1 part=\([0-9]*\) -->.*/\1/p'); part="${part:-1}"
    if [ "$part" -ge "$best_part" ]; then best_part="$part"; best_id="$id"; best_body="$body"; fi
  done < <(printf '%s' "$comments" | jq -c -s '.[][] | select((.body // "") | test("^<!-- FORGE:TELEMETRY v1( part=[0-9]+)? -->")) | {id, body, user, author_association}' 2>/dev/null)
  # Drop lines any part already holds (a PATCH whose reply was lost, or a re-flushed buffer). Every record carries a
  # unique eid, so two distinct same-second events are never byte-identical and are never dropped by this check.
  lines=""
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    case "$all_bodies" in *"$l"*) continue ;; esac
    lines="${lines}${l}"$'\n'
  done <<< "$new"
  [ -n "$lines" ] || return 0
  # bash 3.2: $'..' inside a double-quoted ${..%..} is NOT expanded (and backticks there start a command
  # substitution), so the newline and fence live in variables and the pattern quotes them.
  nl=$'\n'; fence='```'
  lines="${lines%"$nl"}"
  if [ -n "$best_id" ]; then
    local cur="${best_body%"$nl$fence"*}"            # body up to the closing fence
    out="${cur}"$'\n'"${lines}"$'\n```'
    if [ "${#out}" -le "$max" ]; then
      $to "$gh" api -X PATCH "repos/$repo/issues/comments/$best_id" -f body="$out" >/dev/null 2>&1; return $?
    fi
    hdr="<!-- FORGE:TELEMETRY v1 part=$((best_part + 1)) -->"
  else
    hdr="<!-- FORGE:TELEMETRY v1 -->"
  fi
  out="${hdr}"$'\n```jsonl\n'"${lines}"$'\n```'
  $to "$gh" api -X POST "repos/$repo/issues/$n/comments" -f body="$out" >/dev/null 2>&1
}

_forge_tel_impl() {
  local ev="${1:-}"; shift
  [ "${FORGE_TELEMETRY:-on}" = "off" ] && return 0
  case "$ev" in ''|*[!A-Za-z0-9_.-]*) return 0 ;; esac
  command -v jq >/dev/null 2>&1 || return 0
  local rec repo tgt n buf bdir pending
  rec=$(_forge_tel_record "$ev" "$@") && [ -n "$rec" ] || return 0
  repo=$(printf '%s' "$rec" | jq -r '.repo // ""')
  tgt=$(_forge_tel_target "$ev" "$repo"); [ -n "$tgt" ] || return 0
  n="${tgt%% *}"
  bdir="${FORGE_TELEMETRY_BUFFER_DIR:-$HOME/.forge/telemetry-buffer}"
  buf="$bdir/$(printf '%s' "$repo" | tr '/' '_')__${n}.jsonl"
  # Serialize emitters on this host per target: the GitHub read-modify-write has no version check, so two overlapping
  # emitters would each PATCH a stale snapshot (lost record) or both POST a first/rollover part (duplicate comments).
  # Bounded wait (every loop pass counts, 50 x 0.1s); a lock over 5 min old (longer than any bounded hold: two 30s gh
  # calls plus trust checks) is stale and reclaimed by an atomic rename so only one waiter wins; the holder writes an
  # owner token and releases only its own lock. A non-writable buffer dir skips locking. On timeout the record is
  # buffered, never dropped.
  local lock="$bdir/.lock-$(printf '%s' "$repo" | tr '/' '_')__${n}" tries=0 got="" token="$$.${RANDOM}${RANDOM}"
  if ! { mkdir -p "$bdir" 2>/dev/null && [ -w "$bdir" ]; }; then tries=50; got=nolock; fi
  while [ "$tries" -lt 50 ]; do
    if mkdir "$lock" 2>/dev/null; then printf '%s' "$token" > "$lock/owner" 2>/dev/null; got=1; break; fi
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then
      mv "$lock" "$lock.stale.$token" 2>/dev/null && rm -rf "$lock.stale.$token" 2>/dev/null
    else
      sleep 0.1 2>/dev/null || sleep 1
    fi
    tries=$((tries + 1))
  done
  if [ -z "$got" ]; then printf '%s\n' "$rec" >> "$buf" 2>/dev/null; return 0; fi
  _forge_tel_unlock() { [ "$got" = 1 ] && [ "$(cat "$lock/owner" 2>/dev/null)" = "$token" ] && rm -rf "$lock" 2>/dev/null; got=""; }
  trap '_forge_tel_unlock' EXIT; trap '_forge_tel_unlock; exit 1' HUP INT TERM
  # Claim the buffer by renaming it first: a record appended by another emitter after this point lands in a fresh
  # buffer file and survives. Holding the lock, any other "$buf.flush.*" is an orphan of a killed emitter: fold it in.
  local claimed="$buf.flush.$token" f
  pending="$rec"
  if [ -s "$buf" ]; then mv "$buf" "$claimed" 2>/dev/null; fi
  for f in "$buf".flush.*; do
    [ -f "$f" ] && [ "$f" != "$claimed" ] && cat "$f" >> "$claimed" 2>/dev/null && rm -f "$f" 2>/dev/null
  done
  if [ -s "$claimed" ]; then pending="$(cat "$claimed")"$'\n'"$rec"; fi
  if printf '%s\n' "$pending" | _forge_tel_upsert "$repo" "$n"; then
    rm -f "$claimed" 2>/dev/null
  else
    if [ -f "$claimed" ]; then cat "$claimed" >> "$buf" 2>/dev/null; rm -f "$claimed" 2>/dev/null; fi
    printf '%s\n' "$rec" >> "$buf" 2>/dev/null
  fi
  _forge_tel_unlock
  return 0
}

# Subshell + discarded output: no option, variable, trap or stream of the caller can be changed or polluted.
forge_emit() { ( set +eu +o pipefail 2>/dev/null; _forge_tel_impl "$@" ) >/dev/null 2>&1 </dev/null || true; return 0; }

# Exec'd as a CLI (spec call sites); sourcing only defines functions.
if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" = "$0" ]; then forge_emit "$@"; exit 0; fi
