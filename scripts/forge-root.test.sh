#!/usr/bin/env bash
# forge-root.test.sh — guards the canonical FORGE_ROOT bootstrap (forge#3098).
# Plugin installs set neither FORGEDOCK_HOME nor FORGE_HOME; the specs must resolve ForgeDock's OWN
# install root (never the consumer repo) and fail closed when it cannot be found.
# Usage: bash scripts/forge-root.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$HERE/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
PASS=0; FAILN=0; SKIPPED=0
ok()  { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
expect() { [ "$2" = "$3" ] && ok || bad "$1 (got '$3' want '$2')"; }

SITES="commands/work-on.md commands/work-on/build/validate.md commands/quality-gate.md commands/work-on/review.md commands/work-on/investigate.md commands/work-on/decompose.md commands/work-on/build.md commands/work-on/close.md commands/review-pr.md commands/orchestrate/phase-1-resolve.md commands/orchestrate/phase-4-execution.md"

# extract the bootstrap block (comment line .. closing top-level fi), indentation stripped
# Block ends at the first line (after the marker) that starts with `fi` at the marker's own indentation.
# extract <file> <n> prints the n-th (1-based) bootstrap copy in the file.
extract() { awk -v want="$2" '/# FORGE_ROOT bootstrap/{c++; if(c==want){f=1; match($0,/^[ ]*/); ind=RLENGTH}} f{l=$0; sub(/^[ ]+/,"",l); print l} f&&match($0,/^[ ]*fi$/)&&RLENGTH-2==ind{exit}' "$ROOT/$1"; }
count_copies() { grep -c '# FORGE_ROOT bootstrap' "$ROOT/$1"; }
extract commands/work-on.md 1 > "$T/canon"
[ -s "$T/canon" ] && ok || bad "canonical bootstrap not found in work-on.md"
# Expected copies per file are DERIVED from the number of FORGE_ROOT resolution loops
# (`FORGE_ROOT="$_c"` lines) so adding a site never needs a hardcoded count here; count_copies
# (marker comments) must still agree with it, which catches a loop pasted without its marker.
want_copies() { grep -c 'FORGE_ROOT="\$_c"' "$ROOT/$1"; }
for f in $SITES; do
  n=$(count_copies "$f"); expect "exact bootstrap copy count in $f" "$(want_copies "$f")" "$n"
  i=1
  while [ "$i" -le "$n" ]; do   # compare EVERY copy
    extract "$f" "$i" > "$T/s"
    cmp -s "$T/canon" "$T/s" && ok || bad "bootstrap copy $i in $f differs from canonical"
    i=$((i+1))
  done
done
# the canonical block must not contain the stale lexical glob / unfiltered marketplaces glob
grep -v '^[[:space:]]*#' "$T/canon" > "$T/canon.code"   # code only: the comments name the banned constructs
grep -qE 'mapfile|readarray|declare -A|sort[^|]* -[a-zA-Z]*V' "$T/canon.code" && bad "canonical bootstrap uses a bash-4+/non-portable construct" || ok
grep -q 'sort -k1,1nr -k2,2nr -k3,3nr' "$T/canon.code" && ok || bad "canonical bootstrap lacks numeric component version sort"
grep -qF 'marketplaces/*; do' "$T/canon" && bad "canonical bootstrap globs all marketplaces" || ok
grep -qF -- "-iname '*forgedock*'" "$T/canon.code" && bad "canonical bootstrap wildcard-matches marketplaces" || ok
grep -qF '[A-Za-z]:' "$T/canon.code" && ok || bad "canonical bootstrap lacks drive-letter path handling"
# review.md must hard-exit on an unreadable trail
grep -qE 'TRAIL_RC.* -ge 2 .*exit 1' "$ROOT/commands/work-on/review.md" && ok || bad "work-on/review.md lacks hard exit guard for TRAIL_RC>=2"
# behavioral: execute the guard line itself. rc>=2 => BLOCKED on STDOUT + exit 1; rc 0/1 => falls through.
grep -E 'TRAIL_RC.* -ge 2 .*exit 1' "$ROOT/commands/work-on/review.md" | head -1 > "$T/guard"
for rc in 2 127; do
  out=$(TRAIL_RC=$rc bash -c "$(cat "$T/guard")" 2>/dev/null); grc=$?
  expect "review guard exits 1 for TRAIL_RC=$rc" 1 "$grc"
  # The guard prints the full REVIEW_RESULT block (multi-line) to STDOUT.
  expect "review guard prints REVIEW_RESULT block for TRAIL_RC=$rc" "REVIEW_RESULT:|  status: BLOCKED|  blocker: phase trail unreadable (rc=$rc)" "$(printf '%s\n' "$out" | grep -E '^(REVIEW_RESULT:|  status:|  blocker:)' | paste -sd'|' -)"
done
for rc in 0 1; do
  out=$(TRAIL_RC=$rc bash -c "$(cat "$T/guard"); echo passed" 2>&1); expect "review guard falls through for TRAIL_RC=$rc" passed "$out"
done

# no consumer-repo fallback / fail-open remains in the gates
for f in $SITES; do
  grep -nE 'FORGE_HOME:-\$?\{?\{?REPO_PATH\}*/scripts' "$ROOT/$f" >/dev/null && bad "repo-path fallback in $f" || ok
done
for f in commands/review-pr.md commands/work-on/review.md; do
  grep -nE '^[[:space:]]*TRAIL_RC=0[[:space:]]*$' "$ROOT/$f" >/dev/null && bad "fail-open TRAIL_RC=0 in $f" || ok
done

run() { # run <home> [env assignments...] -> prints FORGE_ROOT
  # CLAUDE_PLUGIN_ROOT=<v> is NOT an env var in a real session: Claude Code substitutes the literal
  # text ${CLAUDE_PLUGIN_ROOT} when it loads a plugin spec. Simulate exactly that; every other
  # assignment is passed through as environment.
  local h="$1"; shift; local code; code="$(cat "$T/canon")"; local a; local envs=()
  for a in "$@"; do
    case "$a" in
      CLAUDE_PLUGIN_ROOT=*) code="$(printf '%s' "$code" | awk -v v="${a#CLAUDE_PLUGIN_ROOT=}" '{gsub(/\$\{CLAUDE_PLUGIN_ROOT\}/, v); print}')" ;;
      *) envs+=("$a") ;;
    esac
  done
  ( cd "$T/consumer" && env -i PATH="$PATH" HOME="$h" ${envs[@]+"${envs[@]}"} "$SH" -c "$code; printf %s \"\$FORGE_ROOT\"" )
}
# Run the behavioral cases under every available shell: bash always, zsh when installed (macOS ships it;
# zsh aborts on an unmatched glob, which the bootstrap must not trigger). FORGE_ROOT_TEST_SHELLS overrides.
SHELLS="${FORGE_ROOT_TEST_SHELLS:-bash}"
if [ -z "${FORGE_ROOT_TEST_SHELLS:-}" ] && command -v zsh >/dev/null 2>&1; then SHELLS="bash zsh"; fi
for SH in $SHELLS; do
echo "== bootstrap behavior under: $SH"
mkdir -p "$T/consumer/scripts"; : > "$T/consumer/scripts/verify-phase-trail.sh"   # hostile/lookalike consumer repo
mkscripts() {
  mkdir -p "$1/scripts" "$1/bin/engine"
  : > "$1/scripts/verify-phase-trail.sh"; : > "$1/scripts/lint-dispatch-prompt.sh"; : > "$1/scripts/is-docs-only.sh"
  : > "$1/bin/engine/resolve.mjs"; : > "$1/bin/engine/orchestrate-canary.mjs"; : > "$1/bin/engine/admission.mjs"
}
# plugin install: no env vars at all
mkscripts "$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0"
expect "plugin cache resolves with no env" "$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0" "$(run "$T/h1")"
expect "CLAUDE_PLUGIN_ROOT resolves" "$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0" "$(run "$T/empty" CLAUDE_PLUGIN_ROOT="$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0")"
# nothing installed: empty (never the consumer repo, never a relative path)
expect "unresolvable stays empty" "" "$(run "$T/empty")"
expect "relative FORGE_HOME ignored" "" "$(run "$T/empty" FORGE_HOME=.)"
# explicit FORGEDOCK_HOME is authoritative, even if bogus (caller then fails closed)
expect "FORGEDOCK_HOME authoritative" "$T/nowhere" "$(run "$T/h1" FORGEDOCK_HOME="$T/nowhere")"
# symlink install (install.sh): ~/.claude/commands/work-on.md -> <clone>/commands/work-on.md
mkdir -p "$T/clone/commands" "$T/h2/.claude/commands"; mkscripts "$T/clone"; : > "$T/clone/commands/work-on.md"
# Git Bash (MSYS) makes a COPY for `ln -s` unless native symlinks are requested, which leaves readlink
# nothing to resolve; request them, and run the two symlink cases only when a real symlink exists (a runner
# without symlink privilege cannot exercise install.sh's layout, which is itself a symlink install).
MSYS=winsymlinks:nativestrict ln -sf "$T/clone/commands/work-on.md" "$T/h2/.claude/commands/work-on.md" 2>/dev/null
if [ -L "$T/h2/.claude/commands/work-on.md" ]; then
  expect "install.sh symlink resolves" "$(cd "$T/clone" && pwd -P)" "$(cd "$(run "$T/h2")" && pwd -P)"
  expect "FORGE_HOME without scripts falls through" "$(cd "$T/clone" && pwd -P)" "$(cd "$(run "$T/h2" FORGE_HOME="$T/h2/.claude")" && pwd -P)"
else
  echo "SKIP: symlink cases (this platform cannot create symlinks)"; SKIPPED=$((SKIPPED+1))
fi

# newest cached version wins (1.10.0 must beat 1.9.0)
for v in 1.9.0 1.10.0 1.2.0; do mkscripts "$T/h3/.claude/plugins/cache/forgedock/forgedock/$v"; done
expect "newest cached version wins" "$T/h3/.claude/plugins/cache/forgedock/forgedock/1.10.0" "$(run "$T/h3")"
# HOME containing a space still resolves
mkscripts "$T/sp ace/.claude/plugins/cache/forgedock/forgedock/2.0.0"
expect "space in HOME resolves" "$T/sp ace/.claude/plugins/cache/forgedock/forgedock/2.0.0" "$(run "$T/sp ace")"
# relative FORGEDOCK_HOME / CLAUDE_PLUGIN_ROOT rejected (fail closed => empty)
expect "relative FORGEDOCK_HOME rejected" "" "$(run "$T/h1" FORGEDOCK_HOME=scripts/..)"
expect "relative CLAUDE_PLUGIN_ROOT ignored" "" "$(run "$T/empty" CLAUDE_PLUGIN_ROOT=../consumer)"
# a candidate with only one of the two needed scripts is rejected
mkdir -p "$T/h4/.claude/plugins/cache/forgedock/forgedock/1.0.0/scripts"; : > "$T/h4/.claude/plugins/cache/forgedock/forgedock/1.0.0/scripts/verify-phase-trail.sh"
expect "partial install (missing lint script) rejected" "" "$(run "$T/h4")"
# stale install: has the two original gate scripts but lacks is-docs-only.sh / engine modules => rejected
for missing in scripts/is-docs-only.sh bin/engine/resolve.mjs bin/engine/orchestrate-canary.mjs bin/engine/admission.mjs; do
  rm -rf "$T/h12"; mkscripts "$T/h12/.claude/plugins/cache/forgedock/forgedock/1.0.0"; rm -f "$T/h12/.claude/plugins/cache/forgedock/forgedock/1.0.0/$missing"
  expect "stale install missing $missing rejected" "" "$(run "$T/h12")"
done
# a stale newest version is skipped in favor of a complete older one
rm -rf "$T/h13"; mkscripts "$T/h13/.claude/plugins/cache/forgedock/forgedock/1.0.0"; mkscripts "$T/h13/.claude/plugins/cache/forgedock/forgedock/2.0.0"
rm -f "$T/h13/.claude/plugins/cache/forgedock/forgedock/2.0.0/scripts/is-docs-only.sh"
expect "stale newest skipped for complete older" "$T/h13/.claude/plugins/cache/forgedock/forgedock/1.0.0" "$(run "$T/h13")"
# non-ForgeDock marketplace dirs are ignored; ForgeDock-named ones resolve
mkscripts "$T/h5/.claude/plugins/marketplaces/other-tool"
expect "non-ForgeDock marketplace ignored" "" "$(run "$T/h5")"
mkscripts "$T/h6/.claude/plugins/marketplaces/forgedock"
expect "forgedock marketplace resolves" "$T/h6/.claude/plugins/marketplaces/forgedock" "$(run "$T/h6")"

# release outranks its own pre-release; a newer pre-release core still beats an older release
rm -rf "$T/h7"   # fixture is mutated below; reset per shell
mkscripts "$T/h7/.claude/plugins/cache/forgedock/forgedock/1.9.0-rc1"; mkscripts "$T/h7/.claude/plugins/cache/forgedock/forgedock/1.9.0"
expect "release beats its pre-release" "$T/h7/.claude/plugins/cache/forgedock/forgedock/1.9.0" "$(run "$T/h7")"
mkscripts "$T/h7/.claude/plugins/cache/forgedock/forgedock/2.0.0-rc1"
expect "newer-core pre-release beats older release" "$T/h7/.claude/plugins/cache/forgedock/forgedock/2.0.0-rc1" "$(run "$T/h7")"
# marketplace pinning: a higher-versioned forgedock plugin from a non-official marketplace is never used
mkscripts "$T/h8/.claude/plugins/cache/evil-market/forgedock/99.0.0"; mkscripts "$T/h8/.claude/plugins/cache/forgedock/forgedock/1.1.0"
expect "hostile marketplace at 99.0.0 ignored" "$T/h8/.claude/plugins/cache/forgedock/forgedock/1.1.0" "$(run "$T/h8")"
rm -rf "$T/h8b"; mkscripts "$T/h8b/.claude/plugins/cache/evil-market/forgedock/99.0.0"
expect "only a hostile marketplace => empty" "" "$(run "$T/h8b")"
expect "FORGEDOCK_MARKETPLACE pins another marketplace" "$T/h8b/.claude/plugins/cache/evil-market/forgedock/99.0.0" "$(run "$T/h8b" FORGEDOCK_MARKETPLACE=evil-market)"
expect "invalid FORGEDOCK_MARKETPLACE falls back to forgedock" "" "$(run "$T/h8b" FORGEDOCK_MARKETPLACE=..)"
rm -rf "$T/h8c"; mkscripts "$T/h8c/.claude/plugins/marketplaces/evil-forgedock-tools"
expect "wildcard-named marketplace dir ignored" "" "$(run "$T/h8c")"
# non-semver cache dir names (commit SHAs, 1e5x) are skipped, never ranked by numeric coercion
rm -rf "$T/h14"; P14="$T/h14/.claude/plugins/cache/forgedock/forgedock"
mkscripts "$P14/1.10.0"; mkscripts "$P14/1e5abcdef"; mkscripts "$P14/abc1234def"; mkscripts "$P14/6f3a9c0"
expect "SHA-named cache dirs ignored" "$P14/1.10.0" "$(run "$T/h14")"
rm -rf "$T/h14b"; mkscripts "$T/h14b/.claude/plugins/cache/forgedock/forgedock/abc1234def"
expect "only SHA-named dir => empty" "" "$(run "$T/h14b")"
mkscripts "$P14/1.10.0-rc1"; expect "pre-release dir name still accepted (release wins)" "$P14/1.10.0" "$(run "$T/h14")"
# Windows drive-letter FORGEDOCK_HOME is normalized (/c/...), relative stays rejected
rm -rf "$T/win"; mkscripts "$T/win/c/forge"
expect "C:/ FORGEDOCK_HOME authoritative (no cygpath, bogus path)" "/c/nowhere/forge" "$(run "$T/h1" FORGEDOCK_HOME='C:/nowhere/forge')"
expect "C:\\ FORGEDOCK_HOME normalized" "/d/x/y" "$(run "$T/h1" FORGEDOCK_HOME='D:\x\y')"
# Codex: forge-home pointer file written by install-codex.sh
mkscripts "$T/hx/clone"; mkdir -p "$T/hx/.codex"; printf '%s\n' "$T/hx/clone" > "$T/hx/.codex/forge-home"
expect "codex forge-home pointer resolves" "$T/hx/clone" "$(run "$T/hx")"
expect "CODEX_HOME override resolves" "$T/hx/clone" "$(run "$T/empty" CODEX_HOME="$T/hx/.codex")"
# A relative CODEX_HOME must not resolve the pointer against the consumer cwd
mkdir -p "$T/consumer/.codex"; printf '%s\n' "$T/hx/clone" > "$T/consumer/.codex/forge-home"
expect "relative CODEX_HOME ignored (cwd-local pointer not read)" "" "$(run "$T/empty" CODEX_HOME=.codex)"
rm -rf "$T/consumer/.codex"
printf 'relative/path\n' > "$T/hx/.codex/forge-home"
expect "relative forge-home pointer rejected" "" "$(run "$T/hx")"
# install-codex.sh: FORGE_HOME is shell-escaped in env files, and absent env files are not created (forge#3241)
IC="$T/ic/we ird\$x's"; mkdir -p "$IC/commands" "$T/ic-home"
cp "$ROOT/install-codex.sh" "$IC/install-codex.sh"
: > "$T/ic-home/.zshenv"
( cd "$IC" && env -i PATH="$PATH" HOME="$T/ic-home" CODEX_HOME="$T/ic-home/.codex" bash ./install-codex.sh >/dev/null 2>&1 )
[ ! -e "$T/ic-home/.profile" ] && ok || bad "install-codex.sh created a missing ~/.profile"
# The installer records its own resolved dir (macOS /var -> /private/var, Git Bash /tmp -> /c/Users/...), so compare against that, not $IC.
IC_REAL=$( cd "$IC" && env -i PATH="$PATH" bash -c 'cd "$(dirname ./install-codex.sh)" && pwd' )
got=$(env -i PATH="$PATH" HOME="$T/ic-home" bash -c '. "$HOME/.zshenv"; printf %s "$FORGE_HOME"' 2>&1)
expect "env-file FORGE_HOME round-trips space, \$ and single quote" "$IC_REAL" "$got"
got=$(env -i PATH="$PATH" HOME="$T/ic-home" sh -c '. "$HOME/.zshenv"; printf %s "$FORGE_HOME"' 2>&1)
expect "env-file FORGE_HOME round-trips under POSIX sh" "$IC_REAL" "$got"
grep -qF "\$'" "$T/ic-home/.zshenv" && bad "env file contains bash-only \$'...' quoting" || ok
expect "pointer file still written" "$IC_REAL" "$(cat "$T/ic-home/.codex/forge-home" 2>/dev/null)"
# errexit/pipefail safety: absent readlink target, absent cache dir, no ~/.claude at all
for opts in "-e" "-eo pipefail" "-euo pipefail"; do
  expect "survives set $opts with nothing installed" "ok:" "$( cd "$T/consumer" && env -i PATH="$PATH" HOME="$T/empty" "$SH" -c "set $opts; $(cat "$T/canon"); printf 'ok:%s' \"\$FORGE_ROOT\"" 2>&1 )"
  expect "resolves under set $opts" "ok:$T/h3/.claude/plugins/cache/forgedock/forgedock/1.10.0" "$( cd "$T/consumer" && env -i PATH="$PATH" HOME="$T/h3" "$SH" -c "set $opts; $(cat "$T/canon"); printf 'ok:%s' \"\$FORGE_ROOT\"" 2>&1 )"
done
# a non-forgedock plugin in the cache is ignored even with a higher version
mkscripts "$T/h9/.claude/plugins/cache/forgedock/otherplugin/9.9.9"; mkscripts "$T/h9/.claude/plugins/cache/forgedock/forgedock/1.0.0"
expect "non-forgedock cache plugin ignored" "$T/h9/.claude/plugins/cache/forgedock/forgedock/1.0.0" "$(run "$T/h9")"
# unmatched globs: empty cache dir, absent marketplaces dir, absent ~/.claude entirely (must not abort under zsh)
mkdir -p "$T/h10/.claude/plugins/cache"
expect "empty cache, no match, no abort" "" "$(run "$T/h10")"
expect "no ~/.claude at all, no abort" "" "$(run "$T/empty")"
expect "unmatched glob does not break later candidates" "$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0" "$(run "$T/h10" CLAUDE_PLUGIN_ROOT="$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0")"
# plugin root (textually substituted) outranks an exported FORGE_HOME that also has the scripts:
# the running plugin's own files win over a stale clone named by a global env var (forge#3147 field test)
mkscripts "$T/h11/stale-clone"; mkscripts "$T/h11/running-plugin"
expect "substituted plugin root beats FORGE_HOME" "$T/h11/running-plugin" "$(run "$T/h11" FORGE_HOME="$T/h11/stale-clone" CLAUDE_PLUGIN_ROOT="$T/h11/running-plugin")"
# unsubstituted placeholder (non-Claude runtime) is a literal, rejected by the /* check, never expanded
expect "unsubstituted placeholder ignored, FORGE_HOME used" "$T/h11/stale-clone" "$(run "$T/h11" FORGE_HOME="$T/h11/stale-clone")"
expect "unsubstituted placeholder safe under set -u" "" "$( cd "$T/consumer" && env -i PATH="$PATH" HOME="$T/empty" "$SH" -c "set -u; $(cat "$T/canon"); printf %s \"\$FORGE_ROOT\"" 2>&1 )"
# the env var alone (no substitution) must NOT be relied on: Claude Code does not export it to Bash
expect "CLAUDE_PLUGIN_ROOT env var alone is not a candidate" "" "$( cd "$T/consumer" && env -i PATH="$PATH" HOME="$T/empty" CLAUDE_PLUGIN_ROOT="$T/h11/running-plugin" "$SH" -c "$(cat "$T/canon"); printf %s \"\$FORGE_ROOT\"" )"
done
# the canonical block must use the exact substitutable spelling, single-quoted (no :- form, which Claude Code leaves verbatim)
grep -qF "'\${CLAUDE_PLUGIN_ROOT}'" "$T/canon.code" && ok || bad "canonical bootstrap lacks the substitutable '\${CLAUDE_PLUGIN_ROOT}' candidate"
grep -qF 'CLAUDE_PLUGIN_ROOT:-' "$T/canon.code" && bad "canonical bootstrap uses \${CLAUDE_PLUGIN_ROOT:-}, which Claude Code never substitutes" || ok

# no hand-built file:// URL from FORGE_ROOT remains; imports go through pathToFileURL (a '#', '?' or space in the path must survive)
for f in $SITES commands/work-on/close.md; do
  grep -nE 'file://\$\{?(FORGE_ROOT|\(pwd\))' "$ROOT/$f" >/dev/null && bad "concatenated file:// URL in $f" || ok
done
if command -v node >/dev/null 2>&1; then
  for d in "we#ird" "sp ace" "q?x"; do
    # '?' is not a legal Windows filename character: MSYS remaps it, so node sees a different path.
    case "$d:$(uname -s)" in *'?'*:MINGW*|*'?'*:MSYS*|*'?'*:CYGWIN*) echo "SKIP: path '$d' (illegal on Windows)"; SKIPPED=$((SKIPPED+1)); continue ;; esac
    mkdir -p "$T/url/$d/bin/engine"; echo 'export const v = 42;' > "$T/url/$d/bin/engine/resolve.mjs"
    out=$(node -e 'import(require("node:url").pathToFileURL(process.argv[1]).href).then(m => process.stdout.write(String(m.v)))' "$T/url/$d/bin/engine/resolve.mjs" 2>&1)
    expect "pathToFileURL import survives path '$d'" 42 "$out"
  done
fi

# Guard (#3400, #3454): every gate-helper (trusted-comments.sh) resolver block under commands/ must be
# byte-identical, must scan the plugin cache (the plugin-root placeholder is not always substituted in
# forked runs, so without the scan a cache-only install never resolves the script), and must never list the
# working directory (the repo under review is author-controlled). Blocks are discovered, not hard-coded, so a
# new copy cannot drift unnoticed. A block runs from its '# TRUSTED_SCRIPT resolver' header to 'done <<< "$_tc"'.
: > "$T/tc_all"; TC_BLOCKS=0; TC_STRAY=0
while IFS= read -r f; do
  awk -v out="$T/tc_all" '
    /^[ ]*# TRUSTED_SCRIPT resolver/ {inb=1; line=""}
    inb { sub(/^[ ]+/, ""); line = line $0 "\\n" }
    inb && /^done <<< "\$_tc"$/ { print line >> out; inb=0; n++ }
    END { print n+0 }' "$f" > "$T/tc_n"
  TC_BLOCKS=$((TC_BLOCKS + $(cat "$T/tc_n")))
  # every trusted-comments.sh resolution case-arm must belong to a block (no stray short copies)
  arms=$(grep -c 'trusted-comments.sh" \]' "$f" || true)
  [ "$arms" = "$(cat "$T/tc_n")" ] || { TC_STRAY=$((TC_STRAY + 1)); echo "  stray resolver in $f: $arms arms vs $(cat "$T/tc_n") blocks"; }
done < <(grep -rl 'trusted-comments.sh" \]' "$ROOT/commands")
expect "trusted-comments.sh resolver blocks discovered (review-pr 7 + review + remediate + phase-4)" 10 "$TC_BLOCKS"
expect "trusted-comments.sh resolvers without a canonical block" 0 "$TC_STRAY"
expect "trusted-comments.sh resolvers byte-identical" 1 "$(sort -u "$T/tc_all" | wc -l | tr -d ' ')"
grep -qF 'plugins/cache/forgedock/forgedock' "$T/tc_all" && ok || bad 'trusted-comments.sh resolver lacks the plugin-cache scan'
grep -qF 'CLAUDE_CONFIG_DIR' "$T/tc_all" && ok || bad 'trusted-comments.sh resolver lacks CLAUDE_CONFIG_DIR'
grep -qF '"$PWD"' "$T/tc_all" && bad 'trusted-comments.sh resolver lists "$PWD"' || ok

# Behavior (#3454): a cache-only install with an unsubstituted plugin-root placeholder must resolve the script.
# Run the real block from review.md against a fake HOME that has only plugins/cache/forgedock/forgedock/<semver>.
awk '/^[ ]*# TRUSTED_SCRIPT resolver/ {inb=1} inb {sub(/^[ ]+/, ""); print} inb && /^done <<< "\$_tc"$/ {exit}' "$ROOT/commands/work-on/review.md" > "$T/tc_block.sh"
mkdir -p "$T/tchome/.claude/plugins/cache/forgedock/forgedock/1.9.0/scripts" "$T/tchome/.claude/plugins/cache/forgedock/forgedock/1.12.0/scripts" "$T/tcwork"
: > "$T/tchome/.claude/plugins/cache/forgedock/forgedock/1.9.0/scripts/trusted-comments.sh"
: > "$T/tchome/.claude/plugins/cache/forgedock/forgedock/1.12.0/scripts/trusted-comments.sh"
mkdir -p "$T/tcwork/scripts"; : > "$T/tcwork/scripts/trusted-comments.sh"   # author-controlled cwd copy must NOT win
out=$(cd "$T/tcwork" && env -i PATH="$PATH" HOME="$T/tchome" bash -c 'source "$1"; printf %s "$TRUSTED_SCRIPT"' _ "$T/tc_block.sh" 2>&1)
expect "cache-only install resolves newest cached trusted-comments.sh" "$T/tchome/.claude/plugins/cache/forgedock/forgedock/1.12.0/scripts/trusted-comments.sh" "$out"
out=$(cd "$T/tcwork" && env -i PATH="$PATH" HOME="$T/nohome" bash -c 'source "$1"; printf %s "$TRUSTED_SCRIPT"' _ "$T/tc_block.sh" 2>&1)
expect "no install resolves empty (cwd copy never used)" "" "$out"

echo "forge-root tests: pass=$PASS fail=$FAILN skipped=$SKIPPED"
[ "$FAILN" -eq 0 ]
