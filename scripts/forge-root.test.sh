#!/usr/bin/env bash
# forge-root.test.sh — guards the shared forge_resolve stub that resolves FORGE_ROOT in every spec (forge#3098, #3778-#3781).
# Plugin installs set neither FORGEDOCK_HOME nor FORGE_HOME; the specs must resolve ForgeDock's OWN
# install root (never the consumer repo) and fail closed when it cannot be found.
# Usage: bash scripts/forge-root.test.sh
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$HERE/.."
T=$(mktemp -d); T="$(cd "$T" && pwd -P)"   # physical path: the helper reports pwd -P roots (macOS /var, Git Bash /tmp are symlinks)
trap 'rm -rf "$T"' EXIT
PASS=0; FAILN=0; SKIPPED=0
ok()  { PASS=$((PASS+1)); }
bad() { FAILN=$((FAILN+1)); echo "FAIL: $1"; }
expect() { [ "$2" = "$3" ] && ok || bad "$1 (got '$3' want '$2')"; }

STUB_SITES="commands/work-on.md commands/work-on/build/validate.md commands/quality-gate.md commands/work-on/review.md commands/work-on/investigate.md commands/work-on/decompose.md commands/work-on/build.md commands/work-on/close.md commands/orchestrate/phase-1-resolve.md commands/orchestrate/phase-4-execution.md commands/work-on/remediate.md commands/review-pr.md"
# Every site above carries the #3778 forge_resolve stub (no inlined FORGE_ROOT bootstrap copies; #3779, #3780, #3781), so every per-site hygiene check below applies to all of them.
# The pinned locator line is the one in review-pr-staging.md; the "FORGE_ROOT stub" the specs carry is that locator plus FORGE_ROOT="$(forge_root 2>/dev/null || true)".
STG_SPEC="$ROOT/commands/review-pr-staging.md"
sed 's/^[[:space:]]*//' "$STG_SPEC" | grep '^type forge_resolve >/dev/null' | sed 1q > "$T/locator.sh"
[ -s "$T/locator.sh" ] && ok || bad "pinned forge_resolve locator not found in review-pr-staging.md"
FR_LINE='FORGE_ROOT="$(forge_root 2>/dev/null || true)"'
# the unit under test: the real two-line stub the specs carry
{ cat "$T/locator.sh"; printf '%s\n' "$FR_LINE"; } > "$T/canon"

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
for f in $STUB_SITES; do
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
mkscripts() {   # a minimal install root: forge_root accepts the first root that carries scripts/lib/forge-resolve.sh
  mkdir -p "$1/scripts/lib"; cp "$ROOT/scripts/lib/forge-resolve.sh" "$1/scripts/lib/forge-resolve.sh"
}
# plugin install: no env vars at all
mkscripts "$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0"
expect "plugin cache resolves with no env" "$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0" "$(run "$T/h1")"
expect "CLAUDE_PLUGIN_ROOT resolves" "$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0" "$(run "$T/empty" CLAUDE_PLUGIN_ROOT="$T/h1/.claude/plugins/cache/forgedock/forgedock/1.0.0")"
# nothing installed: empty (never the consumer repo, never a relative path)
expect "unresolvable stays empty" "" "$(run "$T/empty")"
expect "relative FORGE_HOME ignored" "" "$(run "$T/empty" FORGE_HOME=.)"
# explicit FORGEDOCK_HOME is authoritative, even if bogus: nothing else is consulted, so the root is empty (caller then fails closed)
expect "FORGEDOCK_HOME authoritative (bogus => empty, no other tier)" "" "$(run "$T/h1" FORGEDOCK_HOME="$T/nowhere")"
mkscripts "$T/hfh/pinned"; expect "FORGEDOCK_HOME pinning a real install resolves it" "$T/hfh/pinned" "$(run "$T/h1" FORGEDOCK_HOME="$T/hfh/pinned")"
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

# forge#3758 (hgate is a fixture of its own: the loop runs once per shell and h14 is reused below with other versions): deploy-gate script resolves on a plugin-only install (cache only, no symlink, no FORGE_* env).
# The gate-script line is taken verbatim from the spec so the test exercises exactly what ships.
mkscripts "$T/hgate/.claude/plugins/cache/forgedock/forgedock/1.0.0"; : > "$T/hgate/.claude/plugins/cache/forgedock/forgedock/1.0.0/scripts/resolve-deploy-gate.sh"
# review-finalize.sh (the review-pr.md Phase 8 gate) resolves the gate script through forge_resolve (#3780): the locator and the call line are taken verbatim from the script.
sed 's/^[[:space:]]*//' "$ROOT/scripts/review-finalize.sh" | grep '^GATE_SCRIPT=\$(forge_resolve resolve-deploy-gate.sh)$' | sort -u > "$T/gs"
expect "gate-script resolver line is identical across sites" 1 "$(wc -l < "$T/gs" | tr -d ' ')"
{ sed 's/^[[:space:]]*//' "$ROOT/commands/review-pr.md" | grep -m1 '^type forge_resolve >/dev/null'; cat "$T/gs"; } > "$T/gs_full"
gate_run() { ( cd "$T/consumer" && env -i PATH="$PATH" HOME="$1" "$SH" -c "$(cat "$T/gs_full"); printf %s \"\$GATE_SCRIPT\"" ); }
expect "plugin-only install resolves resolve-deploy-gate.sh" "$T/hgate/.claude/plugins/cache/forgedock/forgedock/1.0.0/scripts/resolve-deploy-gate.sh" "$(gate_run "$T/hgate")"
expect "unresolved gate script stays empty (strict)" "" "$(gate_run "$T/empty")"
# cwd/consumer repo is never a candidate even when it carries the gate script
: > "$T/consumer/scripts/resolve-deploy-gate.sh"
expect "consumer repo gate script never used" "" "$(gate_run "$T/empty")"
rm -f "$T/consumer/scripts/resolve-deploy-gate.sh"
# no spec iterates CLAUDE_PLUGIN_ROOT as an env var for the gate script
for f in commands/work-on/remediate.md commands/review-pr.md; do
  grep -qF '"${CLAUDE_PLUGIN_ROOT:-}" "${FORGE_ROOT:-}"' "$ROOT/$f" && bad "env-style CLAUDE_PLUGIN_ROOT gate loop in $f" || ok
done

# newest cached version wins (1.10.0 must beat 1.9.0)
for v in 1.9.0 1.10.0 1.2.0; do mkscripts "$T/h3/.claude/plugins/cache/forgedock/forgedock/$v"; done
expect "newest cached version wins" "$T/h3/.claude/plugins/cache/forgedock/forgedock/1.10.0" "$(run "$T/h3")"
# HOME containing a space still resolves
mkscripts "$T/sp ace/.claude/plugins/cache/forgedock/forgedock/2.0.0"
expect "space in HOME resolves" "$T/sp ace/.claude/plugins/cache/forgedock/forgedock/2.0.0" "$(run "$T/sp ace")"
# relative FORGEDOCK_HOME / CLAUDE_PLUGIN_ROOT rejected (fail closed => empty)
expect "relative FORGEDOCK_HOME rejected" "" "$(run "$T/h1" FORGEDOCK_HOME=scripts/..)"
expect "relative CLAUDE_PLUGIN_ROOT ignored" "" "$(run "$T/empty" CLAUDE_PLUGIN_ROOT=../consumer)"
# a candidate without the helper is rejected (a bare scripts/ dir is not an install root)
mkdir -p "$T/h4/.claude/plugins/cache/forgedock/forgedock/1.0.0/scripts"; : > "$T/h4/.claude/plugins/cache/forgedock/forgedock/1.0.0/scripts/verify-phase-trail.sh"
expect "partial install (no forge-resolve.sh helper) rejected" "" "$(run "$T/h4")"
# a newest version without the helper is skipped in favor of an older one that has it
rm -rf "$T/h13"; mkscripts "$T/h13/.claude/plugins/cache/forgedock/forgedock/1.0.0"; mkdir -p "$T/h13/.claude/plugins/cache/forgedock/forgedock/2.0.0/scripts"
expect "newest without the helper skipped for older with it" "$T/h13/.claude/plugins/cache/forgedock/forgedock/1.0.0" "$(run "$T/h13")"
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
# the shared helper ranks released x.y.z dirs only: a newer-core pre-release never outranks the newest release
expect "newer-core pre-release does not outrank the newest release" "$T/h7/.claude/plugins/cache/forgedock/forgedock/1.9.0" "$(run "$T/h7")"
# marketplace pinning: a higher-versioned forgedock plugin from a non-official marketplace is never used
mkscripts "$T/h8/.claude/plugins/cache/evil-market/forgedock/99.0.0"; mkscripts "$T/h8/.claude/plugins/cache/forgedock/forgedock/1.1.0"
expect "hostile marketplace at 99.0.0 ignored" "$T/h8/.claude/plugins/cache/forgedock/forgedock/1.1.0" "$(run "$T/h8")"
rm -rf "$T/h8b"; mkscripts "$T/h8b/.claude/plugins/cache/evil-market/forgedock/99.0.0"
expect "only a hostile marketplace => empty" "" "$(run "$T/h8b")"
expect "invalid FORGEDOCK_MARKETPLACE falls back to forgedock" "" "$(run "$T/h8b" FORGEDOCK_MARKETPLACE=..)"
rm -rf "$T/h8c"; mkscripts "$T/h8c/.claude/plugins/marketplaces/evil-forgedock-tools"
expect "wildcard-named marketplace dir ignored" "" "$(run "$T/h8c")"
# non-semver cache dir names (commit SHAs, 1e5x) are skipped, never ranked by numeric coercion
rm -rf "$T/h14"; P14="$T/h14/.claude/plugins/cache/forgedock/forgedock"
mkscripts "$P14/1.10.0"; mkscripts "$P14/1e5abcdef"; mkscripts "$P14/abc1234def"; mkscripts "$P14/6f3a9c0"
expect "SHA-named cache dirs ignored" "$P14/1.10.0" "$(run "$T/h14")"
mkscripts "$P14/1.10.0-rc1"; expect "pre-release dir name still accepted (release wins)" "$P14/1.10.0" "$(run "$T/h14")"
# Windows drive-letter FORGEDOCK_HOME normalization lives in the helper (_forge_posix, pinned in the #3778 section below)
# SEC-1 (#3781): the stub's own first candidate normalizes a drive-letter FORGEDOCK_HOME (cygpath), so the helper loads from that root.
rm -rf "$T/hwin"; mkscripts "$T/hwin/c/forge"; mkdir -p "$T/fakebin"
printf '#!/bin/sh\n[ "$1" = "-u" ] && case "$2" in C:/forge) echo "%s"; exit 0;; esac\nexit 1\n' "$T/hwin/c/forge" > "$T/fakebin/cygpath"; chmod +x "$T/fakebin/cygpath"
expect "C:/ FORGEDOCK_HOME resolves through the stub (cygpath)" "$T/hwin/c/forge" "$(run "$T/empty" PATH="$T/fakebin:$PATH" FORGEDOCK_HOME='C:/forge')"
# Codex: forge-home pointer file written by install-codex.sh
mkscripts "$T/hx/clone"; mkdir -p "$T/hx/.codex"; printf '%s\n' "$T/hx/clone" > "$T/hx/.codex/forge-home"
expect "codex forge-home pointer resolves" "$T/hx/clone" "$(run "$T/hx")"
expect "CODEX_HOME override resolves" "$T/hx/clone" "$(run "$T/empty" CODEX_HOME="$T/hx/.codex")"
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
  expect "survives set $opts with nothing installed (no helper at all, no stderr noise)" "ok:" "$( cd "$T/consumer" && env -i PATH="$PATH" HOME="$T/empty" "$SH" -c "set $opts; $(cat "$T/canon"); printf 'ok:%s' \"\$FORGE_ROOT\"" 2>&1 )"
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
# substituted plugin root alone resolves (the locator loads that root's helper; the stub also hands it to the helper as FORGE_SOURCED_ROOT, so it outranks FORGE_HOME and any newer cache; see forge-resolve.sh)
mkscripts "$T/h11/running-plugin"; mkscripts "$T/h11/stale-clone"
expect "substituted plugin root resolves" "$T/h11/running-plugin" "$(run "$T/h11" CLAUDE_PLUGIN_ROOT="$T/h11/running-plugin")"
# unsubstituted placeholder (non-Claude runtime) is a literal, rejected by the /* check, never expanded
expect "unsubstituted placeholder ignored, FORGE_HOME used" "$T/h11/stale-clone" "$(run "$T/h11" FORGE_HOME="$T/h11/stale-clone")"
expect "unsubstituted placeholder safe under set -u" "" "$( cd "$T/consumer" && env -i PATH="$PATH" HOME="$T/empty" "$SH" -c "set -u; $(cat "$T/canon"); printf %s \"\$FORGE_ROOT\"" 2>&1 )"
# running plugin root (substituted) beats a newer cache version and an exported FORGE_HOME (version skew)
mkscripts "$T/h12/.claude/plugins/cache/forgedock/forgedock/1.16.0"; mkscripts "$T/h12/.claude/plugins/cache/forgedock/forgedock/1.17.0"; mkscripts "$T/h12/stale-clone"
expect "running plugin root beats newer cache" "$T/h12/.claude/plugins/cache/forgedock/forgedock/1.16.0" "$(run "$T/h12" CLAUDE_PLUGIN_ROOT="$T/h12/.claude/plugins/cache/forgedock/forgedock/1.16.0")"
expect "running plugin root beats exported FORGE_HOME" "$T/h11/running-plugin" "$(run "$T/h11" CLAUDE_PLUGIN_ROOT="$T/h11/running-plugin" FORGE_HOME="$T/h11/stale-clone")"
expect "running plugin root beats exported FORGE_ROOT" "$T/h11/running-plugin" "$(run "$T/h11" CLAUDE_PLUGIN_ROOT="$T/h11/running-plugin" FORGE_ROOT="$T/h11/stale-clone")"
expect "FORGEDOCK_HOME still authoritative over running root" "$T/h11/stale-clone" "$(run "$T/h11" CLAUDE_PLUGIN_ROOT="$T/h11/running-plugin" FORGEDOCK_HOME="$T/h11/stale-clone")"
expect "unsubstituted literal ignored, newest cache wins" "$T/h12/.claude/plugins/cache/forgedock/forgedock/1.17.0" "$(run "$T/h12")"
expect "relative running root rejected" "$T/h11/stale-clone" "$(run "$T/h11" CLAUDE_PLUGIN_ROOT="relative/running-plugin" FORGE_HOME="$T/h11/stale-clone")"
# the env var alone (no substitution) must NOT be relied on: Claude Code does not export it to Bash
expect "CLAUDE_PLUGIN_ROOT env var alone is not a candidate" "" "$( cd "$T/consumer" && env -i PATH="$PATH" HOME="$T/empty" CLAUDE_PLUGIN_ROOT="$T/h11/running-plugin" "$SH" -c "$(cat "$T/canon"); printf %s \"\$FORGE_ROOT\"" )"
done
# the pinned locator must use the exact substitutable spelling, single-quoted (no :- form, which Claude Code leaves verbatim)
grep -qF "'\${CLAUDE_PLUGIN_ROOT}'" "$T/locator.sh" && ok || bad "stub locator lacks the substitutable '\${CLAUDE_PLUGIN_ROOT}' candidate"
grep -qF 'CLAUDE_PLUGIN_ROOT:-' "$T/locator.sh" && bad "stub locator uses \${CLAUDE_PLUGIN_ROOT:-}, which Claude Code never substitutes" || ok

# no hand-built file:// URL from FORGE_ROOT remains; imports go through pathToFileURL (a '#', '?' or space in the path must survive)
for f in $STUB_SITES; do
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
expect "trusted-comments.sh resolver blocks discovered (review + phase-4; review-pr, review-pr-staging and remediate use the forge_resolve stub)" 2 "$TC_BLOCKS"
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

# Guard (#3483): the other executable-helper resolvers (classify-finding.sh, amplification-breaker.sh,
# extract-affected-files.sh) must use the same trusted-install tiers: no "$PWD", no "$REPO_PATH", plugin-cache
# scan present. Blocks are extracted from the real specs (header '# HELPER_SCRIPT resolver' to 'done <<< "$_tc"',
# or the resolve_extract_affected_files function) so a drifting copy cannot pass on a hand-written stand-in.
extract_helper_block() { # file var -> block on stdout
  awk -v var="$2" '/^[ ]*# HELPER_SCRIPT resolver \(/ && index($0, "(" var ";") {inb=1} inb {sub(/^[ ]+/, ""); print} inb && /^done <<< "\$_tc"$/ {exit}' "$1"
}
extract_helper_fn() { # file -> function on stdout
  awk '/^resolve_extract_affected_files\(\) \{/ {inb=1} inb {print} inb && /^\}$/ {exit}' "$1"
}
# review-pr.md resolves its helpers through the forge_resolve stub (#3780); since #3841 the classify, cap, milestone, priority and dedup helpers are resolved inside
# scripts/review-finalize.sh and the code-index helper inside scripts/review-prepare.sh: the pinned locator plus the call line, taken from those scripts.
stub_block() { # file var -> locator + the first `var=$(forge_resolve ...)` line, indentation stripped
  sed 's/^[[:space:]]*//' "$1" | grep -m1 '^type forge_resolve >/dev/null'; sed 's/^[[:space:]]*//' "$1" | grep -m1 "^$2=\$(forge_resolve "
}
HR_CLASSIFY="$ROOT/scripts/review-finalize.sh"
HR_PREPARE="$ROOT/scripts/review-prepare.sh"
HR_AMP="$ROOT/commands/orchestrate/phase-4-execution.md"
HR_EX3="$ROOT/commands/orchestrate/phase-3-dependency.md"
stub_block "$HR_CLASSIFY" CLASSIFY_SCRIPT > "$T/hr_classify.sh"
stub_block "$HR_CLASSIFY" CAP_SCRIPT > "$T/hr_cap.sh"
extract_helper_block "$HR_AMP" AMP_SCRIPT > "$T/hr_amp.sh"
extract_helper_fn "$HR_AMP" > "$T/hr_ex4.sh"
extract_helper_fn "$HR_EX3" > "$T/hr_ex3.sh"
expect "CLASSIFY_SCRIPT resolver stub found" 1 "$(grep -c '^CLASSIFY_SCRIPT=\$(forge_resolve classify-finding.sh)$' "$T/hr_classify.sh")"
expect "CAP_SCRIPT resolver stub found" 1 "$(grep -c '^CAP_SCRIPT=\$(forge_resolve cap-findings.sh)$' "$T/hr_cap.sh")"
expect "review-pr-staging.md no longer carries a CAP_SCRIPT resolver stub (review-finalize.sh owns the cap helper, #3841)" 0 "$(sed 's/^[[:space:]]*//' "$ROOT/commands/review-pr-staging.md" | grep -c '^CAP_SCRIPT=\$(forge_resolve cap-findings.sh)$')"
expect "AMP_SCRIPT resolver block found" 1 "$(grep -c '^AMP_SCRIPT=""' "$T/hr_amp.sh")"
expect "extract-affected-files resolver found in phase-4" 1 "$(grep -c 'resolve_extract_affected_files() {' "$T/hr_ex4.sh")"
expect "extract-affected-files resolver found in phase-3" 1 "$(grep -c 'resolve_extract_affected_files() {' "$T/hr_ex3.sh")"
cmp -s "$T/hr_ex3.sh" "$T/hr_ex4.sh" && ok || bad 'resolve_extract_affected_files copies differ between phase-3 and phase-4'
for hr in classify cap amp ex3 ex4; do
  grep -qF 'plugins/cache/forgedock/forgedock' "$T/hr_$hr.sh" && ok || bad "$hr helper resolver lacks the plugin-cache scan"
  grep -qF 'CLAUDE_CONFIG_DIR' "$T/hr_$hr.sh" && ok || bad "$hr helper resolver lacks CLAUDE_CONFIG_DIR"
  grep -qE '\$PWD|\$REPO_PATH|\$\{PWD|\$\{REPO_PATH' "$T/hr_$hr.sh" && bad "$hr helper resolver lists the working directory or repo path" || ok
done
# no leftover cwd-derived helper tier anywhere under commands/
if grep -rnE 'PWD/scripts/|^\$PWD$|REPO_PATH/scripts/extract' "$ROOT/commands" >/dev/null 2>&1; then bad 'commands/ still lists a working-directory helper tier'; else ok; fi

# Behavior (#3483): a planted scripts/<helper>.sh in the cwd must never be selected; a cache-only install must resolve.
mkdir -p "$T/hrwork/scripts" "$T/hrhome/.claude/plugins/cache/forgedock/forgedock/1.12.0/scripts/lib"
cp "$ROOT/scripts/lib/forge-resolve.sh" "$T/hrhome/.claude/plugins/cache/forgedock/forgedock/1.12.0/scripts/lib/forge-resolve.sh"
for h in classify-finding cap-findings amplification-breaker extract-affected-files; do
  : > "$T/hrwork/scripts/$h.sh"; : > "$T/hrhome/.claude/plugins/cache/forgedock/forgedock/1.12.0/scripts/$h.sh"
done
CACHE_SCRIPTS="$T/hrhome/.claude/plugins/cache/forgedock/forgedock/1.12.0/scripts"
hr_run() { # home blockfile expr
  (cd "$T/hrwork" && env -i PATH="$PATH" HOME="$1" REPO_PATH="$T/hrwork" bash -c 'source "$1"; '"$3" _ "$2" 2>/dev/null)
}
expect "CLASSIFY_SCRIPT: cache-only install resolves (cwd copy ignored)" "$CACHE_SCRIPTS/classify-finding.sh" "$(hr_run "$T/hrhome" "$T/hr_classify.sh" 'printf %s "$CLASSIFY_SCRIPT"')"
expect "CLASSIFY_SCRIPT: no install resolves empty (cwd copy ignored)" "" "$(hr_run "$T/nohome" "$T/hr_classify.sh" 'printf %s "$CLASSIFY_SCRIPT"')"
expect "CAP_SCRIPT: cache-only install resolves (cwd copy ignored)" "$CACHE_SCRIPTS/cap-findings.sh" "$(hr_run "$T/hrhome" "$T/hr_cap.sh" 'printf %s "$CAP_SCRIPT"')"
expect "CAP_SCRIPT: no install resolves empty (cwd copy ignored)" "" "$(hr_run "$T/nohome" "$T/hr_cap.sh" 'printf %s "$CAP_SCRIPT"')"
expect "AMP_SCRIPT: cache-only install resolves (cwd copy ignored)" "$CACHE_SCRIPTS/amplification-breaker.sh" "$(hr_run "$T/hrhome" "$T/hr_amp.sh" 'printf %s "$AMP_SCRIPT"')"
expect "AMP_SCRIPT: no install resolves empty (cwd copy ignored)" "" "$(hr_run "$T/nohome" "$T/hr_amp.sh" 'printf %s "$AMP_SCRIPT"')"
expect "extract-affected-files: cache-only install resolves (cwd and REPO_PATH copies ignored)" "$CACHE_SCRIPTS/extract-affected-files.sh" "$(hr_run "$T/hrhome" "$T/hr_ex4.sh" 'resolve_extract_affected_files')"
expect "extract-affected-files: no install resolves nothing (cwd and REPO_PATH copies ignored)" "" "$(hr_run "$T/nohome" "$T/hr_ex4.sh" 'resolve_extract_affected_files')"

# Guard (#3596): review-time helpers (derive-finding-milestone.sh, severity-to-priority.sh, code-index.sh) run while the
# cwd / REPO_PATH is the PR checkout, so each call site must carry a canonical trusted-install resolver block.
HR_STG="$ROOT/commands/review-pr-staging.md"
hr_check_block() { # label file var script
  extract_helper_block "$2" "$3" > "$T/hr_blk.sh"
  expect "$1: $3 resolver block found" 1 "$(grep -c "^$3=\"\"" "$T/hr_blk.sh")"
  grep -qF 'plugins/cache/forgedock/forgedock' "$T/hr_blk.sh" && ok || bad "$1: $3 resolver lacks the plugin-cache scan"
  grep -qF 'CLAUDE_CONFIG_DIR' "$T/hr_blk.sh" && ok || bad "$1: $3 resolver lacks CLAUDE_CONFIG_DIR"
  grep -qE '\$PWD|\$REPO_PATH|\$\{PWD|\$\{REPO_PATH' "$T/hr_blk.sh" && bad "$1: $3 resolver lists the working directory or repo path" || ok
  grep -qF "scripts/$4" "$T/hr_blk.sh" && ok || bad "$1: $3 resolver does not resolve scripts/$4"
}
hr_check_stub() { # label file var script: the spec calls the script through the forge_resolve stub (locator in the same fence)
  stub_block "$2" "$3" > "$T/hr_blk.sh"
  expect "$1: $3 resolver stub found" "$3=\$(forge_resolve $4)" "$(sed -n 2p "$T/hr_blk.sh")"
  grep -qE '\$PWD|\$REPO_PATH|\$\{PWD|\$\{REPO_PATH' "$T/hr_blk.sh" && bad "$1: $3 resolver lists the working directory or repo path" || ok
  local needle="$3=\$(forge_resolve "   # kept out of the awk command substitution: bash 3.2 (macOS) mis-parses the nested quote and paren
  expect "$1: $3 call without a locator in the same fence" 0 "$(awk -v n="$needle" '/^[ ]*```/{loc=0} /^[ ]*type forge_resolve >\/dev\/null/{loc=1} index($0, n)>0 && !loc {b++} END{print b+0}' "$2")"
}
hr_check_stub review-pr "$HR_CLASSIFY" DERIVE_MILESTONE_SCRIPT derive-finding-milestone.sh
hr_check_stub review-pr "$HR_CLASSIFY" PRIORITY_SCRIPT severity-to-priority.sh
hr_check_stub review-prepare "$HR_PREPARE" CODE_INDEX_SCRIPT code-index.sh
hr_check_stub review-pr "$HR_CLASSIFY" DEDUP_SCRIPT issue-dedup.sh
hr_check_stub issue "$ROOT/commands/issue.md" ISSUE_CREATE_SCRIPT issue-create.sh
stub_block "$HR_CLASSIFY" DERIVE_MILESTONE_SCRIPT > "$T/hr_dm.sh"
stub_block "$HR_CLASSIFY" PRIORITY_SCRIPT > "$T/hr_pr.sh"
# no bare cwd-relative helper call in either review spec
if grep -nE 'bash scripts/(derive-finding-milestone|severity-to-priority)\.sh' "$HR_CLASSIFY" "$HR_STG" >/dev/null 2>&1; then bad 'review spec still calls a helper by a bare scripts/ path'; else ok; fi

# Repo-wide guard (#3596): no executed bare `bash scripts/<name>` / `./scripts/` and no REPO_PATH/scripts tier under commands/.
# Allowlist entries are "file-suffix" prefixes; each is a reviewed row with a reason.
#   design-bench.md, design-render-critique-loop.md, pipeline-health/phase-2-metrics.md, phase-3-dependency.md:
#     node scripts/*.mjs run inside the ForgeDock repo itself or printed as user hints (not run under a PR checkout cwd).
#   work-on/investigate.md, work-on/build/architect.md: {REPO_PATH}/scripts/code-index.sh, deferred to #3670.
#   orchestrate/phase-3-dependency.md: scripts/worktree-lifecycle.sh lines sit in a roadmap/proposal fence, not executed.
#   deploy-info.md: read-only grep of decrypt-secrets.sh, never executed.
SCRIPTS_ALLOW='commands/(design-bench|design-render-critique-loop|deploy-info|pipeline-health/phase-2-metrics|pipeline-health/phase-3-dependency|orchestrate/phase-3-dependency|work-on/investigate|work-on/build/architect)\.md'
# Executed forms: a bash/sh/source word, a command substitution `$(scripts/x.sh`, or a line-start/after-;&&| direct `scripts/x.sh` / `./scripts/x.sh`.
GUARD_RE='(^|[^A-Za-z0-9_-])(bash|sh|source) +(\./)?scripts/[A-Za-z0-9_.-]+|REPO_PATH\}?/scripts/|\$\( *(\./)?scripts/[A-Za-z0-9_.-]+\.sh|(^|:[0-9]+:|[;&(] *)[[:space:]]*(\./)?scripts/[A-Za-z0-9_.-]+\.sh'
guard_scan() { # dir -> offending file:line:text rows (comment lines are prose)
  grep -rnE "$GUARD_RE" "$1" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true
}
guard_hits=$(guard_scan "$ROOT/commands" | sed "s#^$ROOT/##" | grep -vE "^($SCRIPTS_ALLOW):" || true)
# Negative fixtures (#3679): a bare direct call must be flagged; backticked prose and comments must not.
mkdir -p "$T/guardfx/bad1" "$T/guardfx/bad2" "$T/guardfx/bad3" "$T/guardfx/good"
printf 'X=$(scripts/foo.sh a b)\n' > "$T/guardfx/bad1/x.md"
printf 'scripts/foo.sh arg\n' > "$T/guardfx/bad2/x.md"
printf 'ok && ./scripts/foo.sh\n' > "$T/guardfx/bad3/x.md"
printf 'See `scripts/foo.sh` for details, forwarded to scripts/foo.sh --exclude.\n# $(scripts/foo.sh) in a comment\n' > "$T/guardfx/good/x.md"
for f in bad1 bad2 bad3; do
  [ -n "$(guard_scan "$T/guardfx/$f")" ] && ok || bad "widened guard missed direct execution fixture $f"
done
[ -z "$(guard_scan "$T/guardfx/good")" ] && ok || bad 'widened guard flags prose/comment fixture'
if [ -n "$guard_hits" ]; then bad "commands/ has a cwd-relative or REPO_PATH helper call outside the allowlist: $(printf '%s' "$guard_hits" | head -5 | tr '\n' '|')"; else ok; fi

# Behavior (#3596): planted cwd copies of the two review helpers must never be selected.
for h in derive-finding-milestone severity-to-priority code-index; do
  : > "$T/hrwork/scripts/$h.sh"; : > "$CACHE_SCRIPTS/$h.sh"
done
for pair in "dm:DERIVE_MILESTONE_SCRIPT:derive-finding-milestone" "pr:PRIORITY_SCRIPT:severity-to-priority"; do
  IFS=: read -r k var h <<< "$pair"
  expect "$var: cache-only install resolves (cwd copy ignored)" "$CACHE_SCRIPTS/$h.sh" "$(hr_run "$T/hrhome" "$T/hr_$k.sh" "printf %s \"\$$var\"")"
  expect "$var: no install resolves empty (cwd copy ignored)" "" "$(hr_run "$T/nohome" "$T/hr_$k.sh" "printf %s \"\$$var\"")"
done

# Guard (#3636): review-delta.sh takes its trust script ONLY from an explicit absolute --trusted-script. Any
# commands/ block that resolves review-delta.sh (added by the specs that consume it) must use the trusted-install
# tiers: plugin-cache scan and CLAUDE_CONFIG_DIR present, no "$PWD"/"$REPO_PATH" tier. Passes with 0 blocks today.
RD_BLOCKS=0
while IFS= read -r f; do
  # a forge_resolve stub (scripts/lib/forge-resolve.sh owns the tiers) satisfies the guard
  if grep -qE '^[[:space:]]*REVIEW_DELTA_SCRIPT=\$\(forge_resolve review-delta\.sh\)$' "$f"; then RD_BLOCKS=$((RD_BLOCKS + 1)); continue; fi
  awk '/^[ ]*# HELPER_SCRIPT resolver \(/ && index($0, "(REVIEW_DELTA_SCRIPT;") {inb=1} inb {sub(/^[ ]+/, ""); print} inb && /^done <<< "\$_tc"$/ {exit}' "$f" > "$T/rd_block.sh"
  [ -s "$T/rd_block.sh" ] || { bad "review-delta.sh referenced in $f without a canonical REVIEW_DELTA_SCRIPT resolver block"; continue; }
  RD_BLOCKS=$((RD_BLOCKS + 1))
  grep -qF 'plugins/cache/forgedock/forgedock' "$T/rd_block.sh" && ok || bad "review-delta resolver in $f lacks the plugin-cache scan"
  grep -qF 'CLAUDE_CONFIG_DIR' "$T/rd_block.sh" && ok || bad "review-delta resolver in $f lacks CLAUDE_CONFIG_DIR"
  grep -qE '\$PWD|\$REPO_PATH|\$\{PWD|\$\{REPO_PATH' "$T/rd_block.sh" && bad "review-delta resolver in $f lists the working directory or repo path" || ok
done < <(grep -rl 'review-delta\.sh' "$ROOT/commands" 2>/dev/null)

# Behavior (#3636): a planted scripts/trusted-comments.sh in the cwd must never be used. Without --trusted-script the
# resolver fails closed (FULL); a stub that would trust everything cannot change that.
mkdir -p "$T/rdwork/scripts"
printf '#!/usr/bin/env bash\ncat >/dev/null\nprintf "%%s\\n" "\\"<!-- REVIEW-FINDINGS-SYNTHESIZED-START -->\\""\n' > "$T/rdwork/scripts/trusted-comments.sh"
echo '[]' > "$T/rdwork/comments.json"
out=$(cd "$T/rdwork" && bash "$ROOT/scripts/review-delta.sh" --pr 1 --head 0123456789abcdef0123456789abcdef01234567 --base main --comments-file comments.json --labels "" 2>&1 | sed -n 1p)
expect "review-delta.sh without --trusted-script prints FULL (cwd trust script ignored)" "FULL" "$out"
out=$(cd "$T/rdwork" && bash "$ROOT/scripts/review-delta.sh" --pr 1 --head 0123456789abcdef0123456789abcdef01234567 --base main --trusted-script scripts/trusted-comments.sh --comments-file comments.json --labels "" 2>&1 | sed -n 1p)
expect "review-delta.sh with a relative cwd --trusted-script prints FULL" "FULL" "$out"


# Guard (#3778): scripts/lib/forge-resolve.sh owns the install-root tiers; review-pr-staging.md carries only byte-identical
# stubs. The locator line must be identical everywhere, resolve from trusted tiers only (no $PWD, no repo under review),
# and every fence stub must fail closed when the helper is unresolved.
FR="$ROOT/scripts/lib/forge-resolve.sh"; FB="$ROOT/scripts/lib/fence-bootstrap.sh"
[ -f "$FR" ] && [ -f "$FB" ] && ok || bad "scripts/lib/forge-resolve.sh and scripts/lib/fence-bootstrap.sh must exist"
sed 's/^[[:space:]]*//' "$STG_SPEC" | grep '^type forge_resolve >/dev/null' | sort | uniq -c > "$T/loc_uniq"
[ "$(wc -l < "$T/loc_uniq" | tr -d ' ')" = 1 ] && ok || bad "forge_resolve locator line must be byte-identical across every stub in review-pr-staging.md"
[ "$(awk '{print $1}' "$T/loc_uniq")" -ge 12 ] && ok || bad "expected a locator on every bootstrap (10) and resolver (2) stub (the pre/post-dispatch fences moved to forgedock review-staging, #4359)"
grep -qE 'PWD|\$\(pwd\)|REPO_PATH' "$T/locator.sh" && bad "stub locator must not consult the cwd or repo under review" || ok
[ "$(grep -c '# FENCE_BOOTSTRAP$' "$STG_SPEC")" = 10 ] && ok || bad "expected 10 fence bootstrap stubs"
[ "$(grep '# FENCE_BOOTSTRAP$' "$STG_SPEC" | sort -u | wc -l | tr -d ' ')" = 1 ] && ok || bad "fence bootstrap stubs must be byte-identical"
grep '# FENCE_BOOTSTRAP$' "$STG_SPEC" | sed 1q | grep -qF 'exit 1' && ok || bad "fence bootstrap stub must fail closed (exit 1) when the helper is unresolved"
# the spec carries none of the old inlined blocks
grep -qE '^[[:space:]]*(TRUSTED_SCRIPT|[A-Z_]+_SCRIPT)=""$|_tc="\$\(printf' "$STG_SPEC" && bad "review-pr-staging.md still carries an inlined resolver block" || ok
# no $PWD / $(pwd) tier in the helper (comments aside)
grep -nE '\$PWD|\$\(pwd\)|\$\{PWD' "$FR" | grep -vE '^[0-9]+:[[:space:]]*#' | grep -q . && bad "forge-resolve.sh must have no PWD tier" || ok

# Guard (#3779): remediate.md carries the same byte-identical locator stub (9 fences: M4 ancestry, merged-first transition-label (the merge-branch one reuses the CI-gate fence locator), 5 gate sites, trusted-comments, CI gate) and none of the old inlined resolvers.
REM_SPEC="$ROOT/commands/work-on/remediate.md"
sed 's/^[[:space:]]*//' "$REM_SPEC" | grep '^type forge_resolve >/dev/null' | sort | uniq -c > "$T/rem_uniq"
[ "$(wc -l < "$T/rem_uniq" | tr -d ' ')" = 1 ] && ok || bad "remediate.md locator lines must be byte-identical"
expect "remediate.md locator count (one per fence that resolves a script)" 9 "$(awk '{print $1}' "$T/rem_uniq")"
[ "$(sed 's/^[[:space:]]*//' "$REM_SPEC" | grep '^type forge_resolve >/dev/null' | sed 1q)" = "$(cat "$T/locator.sh")" ] && ok || bad "remediate.md locator differs from the pinned review-pr-staging.md locator"
expect "remediate.md inlined FORGE_ROOT bootstrap copies" 0 "$(grep -c '# FORGE_ROOT bootstrap' "$REM_SPEC" || true)"
grep -qE '^[[:space:]]*(TRUSTED_SCRIPT|[A-Z_]+_SCRIPT)=""|_tc="\$\(printf|^[[:space:]]*GATE_SCRIPT=""' "$REM_SPEC" && bad "remediate.md still carries an inlined resolver block" || ok
# every forge_resolve call in remediate.md must sit in a fence that already defined it via the locator
expect "remediate.md: forge_resolve calls without a preceding locator in the same fence" 0 "$(awk '/^[ ]*```/{loc=0} /^[ ]*type forge_resolve >\/dev\/null/{loc=1} /(GATE|TRUSTED|CI_GATE)_SCRIPT=\$\(forge_resolve /&&!loc{bad++} END{print bad+0}' "$REM_SPEC")"

# Guard (#3780): review-pr.md carries the same byte-identical locator stub (one per fence that resolves a script) and none of the
# old inlined blocks: no FORGE_ROOT bootstrap, no `_tc` resolver, no `*_SCRIPT=""` accumulator. Review-delta mode lives in
# scripts/lib/review-delta-mode.sh (pinned by review-pr-delta-wiring.test.sh).
RP_SPEC="$ROOT/commands/review-pr.md"
sed 's/^[[:space:]]*//' "$RP_SPEC" | grep '^type forge_resolve >/dev/null' | sort | uniq -c > "$T/rp_uniq"
[ "$(wc -l < "$T/rp_uniq" | tr -d ' ')" = 1 ] && ok || bad "review-pr.md locator lines must be byte-identical"
[ "$(awk '{print $1}' "$T/rp_uniq")" -ge 10 ] && ok || bad "expected a locator in every review-pr.md fence that resolves a script (>=10; the classify/file/prepare helpers resolve inside the review scripts since #3841)"
[ "$(sed 's/^[[:space:]]*//' "$RP_SPEC" | grep '^type forge_resolve >/dev/null' | sed 1q)" = "$(cat "$T/locator.sh")" ] && ok || bad "review-pr.md locator differs from the pinned review-pr-staging.md locator"
expect "review-pr.md inlined FORGE_ROOT bootstrap copies" 0 "$(grep -c 'FORGE_ROOT bootstrap' "$RP_SPEC" || true)"
# (SCOPE_SCRIPT="" is a sibling path derived from the resolved trusted script's own directory, not a resolver accumulator)
grep -vE '^[[:space:]]*SCOPE_SCRIPT=""$' "$RP_SPEC" | grep -qE '^[[:space:]]*(TRUSTED_SCRIPT|[A-Z_]+_SCRIPT)=""|_tc="\$\(printf|TRUSTED_SCRIPT resolver \(canonical' && bad "review-pr.md still carries an inlined resolver block" || ok
expect "review-pr.md: forge_resolve calls without a preceding locator in the same fence" 0 "$(awk '/^[ ]*```/{loc=0} /^[ ]*type forge_resolve >\/dev\/null/{loc=1} /=\$\(forge_resolve /&&!loc{bad++} END{print bad+0}' "$RP_SPEC")"
grep -nE '\$FORGE_ROOT|\$\{FORGE_ROOT:\+' "$RP_SPEC" | grep -q . && bad "review-pr.md consumes \$FORGE_ROOT (resolve through forge_resolve instead)" || ok

# Guard (#3781): every spec that needs FORGE_ROOT resolves it through the pinned locator + `FORGE_ROOT="$(forge_root ...)"` and carries none of
# the old inlined bootstrap (no marker comment, no `FORGE_ROOT="$_c"` candidate loop, no sentinel-file probes). Per site:
for f in $STUB_SITES; do
  sed 's/^[[:space:]]*//' "$ROOT/$f" | grep '^type forge_resolve >/dev/null' | sort -u > "$T/site_loc"
  [ "$(wc -l < "$T/site_loc" | tr -d ' ')" = 1 ] && [ "$(cat "$T/site_loc")" = "$(cat "$T/locator.sh")" ] && ok || bad "$f: locator lines are not byte-identical to the pinned locator"
  expect "$f: inlined FORGE_ROOT bootstrap markers" 0 "$(grep -c '# FORGE_ROOT bootstrap' "$ROOT/$f" || true)"
  expect "$f: inlined FORGE_ROOT candidate loops" 0 "$(grep -c 'FORGE_ROOT="\$_c"' "$ROOT/$f" || true)"
  grep -qE 'verify-phase-trail\.sh" \] && \[ -f' "$ROOT/$f" && bad "$f: still probes the sentinel files of the old bootstrap" || ok
  # every FORGE_ROOT resolution is the stub line (shell state does not persist between Bash calls, so each fence repeats it) and follows a locator in its fence
  expect "$f: FORGE_ROOT resolutions that are not the stub line" 0 "$(grep -E '^[[:space:]]*FORGE_ROOT="\$\(forge_root' "$ROOT/$f" | grep -cvF "$FR_LINE" || true)"
  expect "$f: forge_root calls without a preceding locator in the same fence" 0 "$(awk '/^[ ]*```/{loc=0} /^[ ]*type forge_resolve >\/dev\/null/{loc=1} /FORGE_ROOT="\$\(forge_root /&&!loc{bad++} END{print bad+0}' "$ROOT/$f")"
done
# the spec-count of stub resolutions pins the conversion (a copy dropped or re-inlined changes it)
for pair in work-on.md:3 work-on/review.md:2 work-on/build/validate.md:5 work-on/investigate.md:1 work-on/decompose.md:1 work-on/close.md:1 work-on/build.md:1 quality-gate.md:4 orchestrate/phase-1-resolve.md:2 orchestrate/phase-4-execution.md:8; do
  f="commands/${pair%%:*}"; n="${pair##*:}"
  expect "$f: FORGE_ROOT stub resolutions" "$n" "$(grep -cF "$FR_LINE" "$ROOT/$f" || true)"
done

# Behaviour: run the REAL stub locator + forge_resolve in a clean env over each install layout.
# Paths are compared canonically: macOS resolves /var -> /private/var and Git Bash maps /tmp -> /c/Users/..., so the literal
# spelling of a temp path differs from what readlink/pwd -P report (and 8.3 short names like RUNNER~1 differ from long ones). cygpath -ml (Git Bash) or dirname+pwd -P (POSIX) agree.
canon() { # path -> canonical spelling, empty stays empty
  [ -n "$1" ] || return 0
  if command -v cygpath >/dev/null 2>&1; then cygpath -ml "$1" 2>/dev/null || printf '%s' "$1"
  else ( cd "$(dirname "$1")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename "$1")" ) || printf '%s' "$1"; fi
}
expect_path() { expect "$1" "$(canon "$2")" "$(canon "$3")"; }
mkdir -p "$T/fr/cwdplant/scripts/lib" "$T/fr/ws"
cp "$FR" "$T/fr/cwdplant/scripts/lib/forge-resolve.sh"; printf 'PLANT\n' > "$T/fr/cwdplant/scripts/trusted-comments.sh"
mk_install() { # dir: a minimal install root that carries the helpers and trusted-comments.sh
  mkdir -p "$1/scripts/lib" "$1/commands"; cp "$FR" "$1/scripts/lib/"; cp "$FB" "$1/scripts/lib/"; : > "$1/scripts/trusted-comments.sh"; : > "$1/commands/work-on.md"
}
fr_run_sh() { # shell home cmd [extra env assignments...] -> stdout; cwd is a planted repo that must never be trusted
  local sh="$1" h="$2" c="$3"; shift 3
  ( cd "$T/fr/cwdplant" && env -i PATH="$PATH" HOME="$h" "$@" "$sh" -c "$(cat "$T/locator.sh"); $c" 2>/dev/null )
}
fr_run() { fr_run_sh bash "$@"; }
mk_install "$T/fr/npm"
expect_path "engine layout: FORGEDOCK_HOME resolves (cwd plant ignored)" "$T/fr/npm/scripts/trusted-comments.sh" "$(fr_run "$T/fr/h0" 'forge_resolve trusted-comments.sh' FORGEDOCK_HOME="$T/fr/npm")"
expect_path "forge_root under FORGEDOCK_HOME" "$T/fr/npm" "$(fr_run "$T/fr/h0" 'forge_root' FORGEDOCK_HOME="$T/fr/npm")"
mk_install "$T/fr/other"
expect "FORGEDOCK_HOME is authoritative: a valid FORGE_HOME is not consulted when it points at a bare dir" "" "$(fr_run "$T/fr/h0" 'forge_resolve trusted-comments.sh' FORGEDOCK_HOME="$T/fr/ws" FORGE_HOME="$T/fr/other")"
CFG="$T/fr/plugonly/.claude/plugins/cache/forgedock/forgedock"
mk_install "$CFG/1.9.0"; mk_install "$CFG/1.12.0"; : > "$CFG/1.12.0/scripts/review-delta.sh"
expect_path "plugin-only layout: newest pinned cache wins (1.12.0 over 1.9.0)" "$CFG/1.12.0" "$(fr_run "$T/fr/plugonly" 'forge_root')"
expect_path "plugin-only layout: script resolves from the cache" "$CFG/1.12.0/scripts/review-delta.sh" "$(fr_run "$T/fr/plugonly" 'forge_resolve review-delta.sh')"
# INFRA-3: a lexical glob picks 1.16.0 before 2.0.0 and a pair where 1.9.0/1.12.0 happen to agree masks it; the stub must still end on 2.0.0
CFG2="$T/fr/lexical/.claude/plugins/cache/forgedock/forgedock"
mk_install "$CFG2/1.16.0"; mk_install "$CFG2/2.0.0"; : > "$CFG2/2.0.0/scripts/review-delta.sh"
expect_path "lexical-vs-numeric: 2.0.0 outranks 1.16.0 (stub-loaded helper re-resolves numerically)" "$CFG2/2.0.0" "$(fr_run "$T/fr/lexical" 'forge_root')"
expect_path "lexical-vs-numeric: a script only in 2.0.0 resolves" "$CFG2/2.0.0/scripts/review-delta.sh" "$(fr_run "$T/fr/lexical" 'forge_resolve review-delta.sh')"
mk_install "$T/fr/subst"
expect_path "plugin-only layout: substituted plugin root is a locator tier" "$T/fr/subst/scripts/trusted-comments.sh" "$(sed "s|'\${CLAUDE_PLUGIN_ROOT}'|'$T/fr/subst'|g" "$T/locator.sh" > "$T/locator_subst.sh"; cd "$T/fr/cwdplant" && env -i PATH="$PATH" HOME="$T/fr/h0" bash -c "$(cat "$T/locator_subst.sh"); forge_resolve trusted-comments.sh" 2>/dev/null)"
mk_install "$T/fr/repo"; mkdir -p "$T/fr/instl/.claude/commands"
if ln -s "$T/fr/repo/commands/work-on.md" "$T/fr/instl/.claude/commands/work-on.md" 2>/dev/null && [ -L "$T/fr/instl/.claude/commands/work-on.md" ]; then
  expect_path "install.sh layout: commands symlink resolves to the repo root" "$T/fr/repo" "$(fr_run "$T/fr/instl" 'forge_root')"
else echo "SKIP: symlinks unavailable here"; SKIPPED=$((SKIPPED+1)); fi
mk_install "$T/fr/relocated/cfg/plugins/cache/forgedock/forgedock/1.12.0"
expect_path "CLAUDE_CONFIG_DIR-relocated layout resolves" "$T/fr/relocated/cfg/plugins/cache/forgedock/forgedock/1.12.0/scripts/trusted-comments.sh" "$(fr_run "$T/fr/h0" 'forge_resolve trusted-comments.sh' CLAUDE_CONFIG_DIR="$T/fr/relocated/cfg")"
# INFRA-2: CLAUDE_CONFIG_DIR is set (and empty) while the plugin cache lives under ~/.claude
mkdir -p "$T/fr/emptycfg"
expect_path "CLAUDE_CONFIG_DIR set but empty, cache under ~/.claude resolves" "$CFG/1.12.0/scripts/trusted-comments.sh" "$(fr_run "$T/fr/plugonly" 'forge_resolve trusted-comments.sh' CLAUDE_CONFIG_DIR="$T/fr/emptycfg")"
# INFRA-1: Codex / legacy variable layouts with no ~/.claude at all
expect_path "FORGE_HOME-only layout resolves" "$T/fr/repo/scripts/trusted-comments.sh" "$(fr_run "$T/fr/h0" 'forge_resolve trusted-comments.sh' FORGE_HOME="$T/fr/repo")"
expect_path "FORGE_ROOT-only layout resolves" "$T/fr/repo/scripts/trusted-comments.sh" "$(fr_run "$T/fr/h0" 'forge_resolve trusted-comments.sh' FORGE_ROOT="$T/fr/repo")"
mkdir -p "$T/fr/codexhome"; printf '%s\n' "$T/fr/repo" > "$T/fr/codexhome/forge-home"
expect_path "Codex forge-home file layout resolves" "$T/fr/repo/scripts/trusted-comments.sh" "$(fr_run "$T/fr/h0" 'forge_resolve trusted-comments.sh' CODEX_HOME="$T/fr/codexhome")"
expect "relative FORGE_HOME is rejected" "" "$(fr_run "$T/fr/h0" 'forge_resolve trusted-comments.sh' FORGE_HOME=fr/cwdplant)"
expect "unresolved layout prints nothing (cwd plant ignored)" "" "$(fr_run "$T/fr/h0" 'forge_resolve trusted-comments.sh')"
expect "unresolved layout: the bootstrap stub fails closed" "BLOCKED" "$(fr_run "$T/fr/h0" "$(grep '# FENCE_BOOTSTRAP$' "$STG_SPEC" | sed 1q); echo reached" | sed -n 's/^\(BLOCKED\).*/\1/p')"
expect "unresolved layout: the bootstrap stub does not reach the fence body" "" "$(fr_run "$T/fr/h0" "$(grep '# FENCE_BOOTSTRAP$' "$STG_SPEC" | sed 1q); echo reached" | sed -n 's/^\(reached\)$/\1/p')"
expect "relative FORGEDOCK_HOME is rejected" "" "$(fr_run "$T/fr/h0" 'forge_resolve trusted-comments.sh' FORGEDOCK_HOME=fr/cwdplant)"
expect "path traversal in the script name is rejected" "" "$(fr_run "$T/fr/h0" 'forge_resolve ../scripts/trusted-comments.sh' FORGEDOCK_HOME="$T/fr/npm")"
# #3779: the REAL remediate locator + gate resolution on a plugin-only layout and on an empty HOME (empty output => the spec's strict branch fires)
sed 's/^[[:space:]]*//' "$REM_SPEC" | grep '^type forge_resolve >/dev/null' | sed 1q > "$T/rem_locator.sh"
mk_install "$T/fr/remgate/.claude/plugins/cache/forgedock/forgedock/1.0.0"; : > "$T/fr/remgate/.claude/plugins/cache/forgedock/forgedock/1.0.0/scripts/resolve-deploy-gate.sh"
rem_run() { ( cd "$T/fr/cwdplant" && env -i PATH="$PATH" HOME="$1" bash -c "$(cat "$T/rem_locator.sh"); GATE_SCRIPT=\$(forge_resolve resolve-deploy-gate.sh); printf %s \"\$GATE_SCRIPT\"" 2>/dev/null ); }
expect_path "remediate stub: plugin-only install resolves resolve-deploy-gate.sh" "$T/fr/remgate/.claude/plugins/cache/forgedock/forgedock/1.0.0/scripts/resolve-deploy-gate.sh" "$(rem_run "$T/fr/remgate")"
: > "$T/fr/cwdplant/scripts/resolve-deploy-gate.sh"
expect "remediate stub: empty HOME leaves the gate script empty (strict), cwd plant ignored" "" "$(rem_run "$T/fr/h0")"
rm -f "$T/fr/cwdplant/scripts/resolve-deploy-gate.sh"
# INFRA-8: the stub itself must survive errexit in bash (setopt is zsh-only and must not abort a set -e shell)
expect "errexit: the locator stub itself survives set -e with no helper" "survived" "$(cd "$T/fr/cwdplant" && env -i PATH="$PATH" HOME="$T/fr/h0" bash -c "set -e; $(cat "$T/locator.sh"); X=\$(forge_resolve trusted-comments.sh); [ -z \"\$X\" ] && echo survived" 2>/dev/null)"
# INFRA-5: errexit callers must survive a resolver miss (helper sourced, and helper never found) and reach their own empty-output branch
expect "errexit: a resolver miss with the helper sourced survives" "survived" "$(fr_run "$T/fr/h0" 'set -e; X=$(forge_resolve nothere.sh); [ -z "$X" ] && echo survived' FORGEDOCK_HOME="$T/fr/npm")"
expect "errexit: a resolver miss with no helper at all survives" "survived" "$(fr_run "$T/fr/h0" 'set -e; X=$(forge_resolve trusted-comments.sh); [ -z "$X" ] && echo survived')"
# #3781: the real two-line stub (locator + FORGE_ROOT line) leaves FORGE_ROOT empty, silently, and survives errexit when nothing resolves (callers keep their own empty-root fail-closed branch)
for opts in "-e" "-eo pipefail" "-euo pipefail"; do
  expect "stub: unresolved layout leaves FORGE_ROOT empty under set $opts" "ok:" "$(cd "$T/fr/cwdplant" && env -i PATH="$PATH" HOME="$T/fr/h0" "$SH" -c "set $opts; $(cat "$T/canon"); printf 'ok:%s' \"\$FORGE_ROOT\"" 2>&1)"
  expect "stub: resolves under set $opts" "ok:$T/fr/npm" "$(cd "$T/fr/cwdplant" && env -i PATH="$PATH" HOME="$T/fr/h0" FORGEDOCK_HOME="$T/fr/npm" "$SH" -c "set $opts; $(cat "$T/canon"); printf 'ok:%s' \"\$FORGE_ROOT\"" 2>&1)"
done
expect "stub: cwd plant is never FORGE_ROOT (hostile consumer repo)" "" "$(cd "$T/fr/cwdplant" && env -i PATH="$PATH" HOME="$T/fr/h0" bash -c "$(cat "$T/canon"); printf %s \"\$FORGE_ROOT\"" 2>/dev/null)"
# INFRA-4: under zsh an unmatched glob in the locator must not abort, and there is no cwd-derived self root
if command -v zsh >/dev/null 2>&1; then
  expect_path "zsh: locator survives no cache at all and a FORGE_HOME layout resolves" "$T/fr/repo/scripts/trusted-comments.sh" "$(fr_run_sh zsh "$T/fr/h0" 'forge_resolve trusted-comments.sh' FORGE_HOME="$T/fr/repo")"
  expect "zsh: unresolved layout prints nothing and never trusts the cwd plant" "" "$(fr_run_sh zsh "$T/fr/h0" 'forge_resolve trusted-comments.sh')"
  expect_path "zsh: numeric-newest cache wins" "$CFG2/2.0.0" "$(fr_run_sh zsh "$T/fr/lexical" 'forge_root')"
else echo "SKIP: zsh not installed"; SKIPPED=$((SKIPPED+1)); fi
# INFRA-6: a Windows drive-letter FORGEDOCK_HOME is normalized by the helper (cygpath where present, else the /c/x spelling)
expect "drive-letter FORGEDOCK_HOME normalizes to /c/x" "/c/forge/x" "$(env -i PATH="$PATH" HOME="$T/fr/h0" bash -c ". '$FR'; _forge_posix 'C:\\forge\\x'" 2>/dev/null | sed 's|^/cygdrive||')"

echo "forge-root tests: pass=$PASS fail=$FAILN skipped=$SKIPPED"
[ "$FAILN" -eq 0 ]
