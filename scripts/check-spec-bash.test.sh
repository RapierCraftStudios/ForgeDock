#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/check-spec-bash.sh. Run: bash scripts/check-spec-bash.test.sh (bash 3.2 compatible)

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/check-spec-bash.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/check-spec-bash-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
FENCE='```'

check() { # check <want_rc> <want_substring> <desc> -- args...
  want_rc="$1"; want="$2"; desc="$3"; shift 4
  out=$(cd "$T" && bash "$S" "$@" 2>&1); rc=$?
  case "$out" in *"$want"*) ok=1 ;; *) ok=0 ;; esac
  if [ "$rc" = "$want_rc" ] && [ "$ok" = 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $desc (rc=$rc)"; printf '%s\n' "$out" | sed 's/^/    /'; fi
}

cat > "$T/good.md" <<EOF
# Good
${FENCE}bash
if [ -z "{GH_REPO}" ]; then echo none; fi
gh issue view {NUMBER} -R {GH_REPO} --json labels
${FENCE}
Prose with it's apostrophe and an unbalanced ( paren.
EOF

cat > "$T/bad.md" <<EOF
# Bad
${FENCE}bash
if [ -n "\$X" ]; then
  echo "unterminated
fi
${FENCE}
EOF

cat > "$T/pseudo.md" <<EOF
${FENCE}bash
OUT=\$(Skill(skill="x", args="y"))
${FENCE}
EOF

cat > "$T/allow.md" <<EOF
<!-- allowlist:check-spec-bash -->
${FENCE}bash
if true; then
${FENCE}
EOF

cat > "$T/prose-mention.md" <<EOF
Use \`<!-- allowlist:check-spec-bash -->\` before an intentional fragment.
${FENCE}bash
if true; then
${FENCE}
EOF

cat > "$T/notbash.md" <<EOF
${FENCE}yaml
key: [unclosed
${FENCE}
EOF

check 0 "OK good.md:2"                  "valid block with placeholders passes" -- good.md
check 1 "FAIL bad.md:2 bash -n"         "unterminated quote fails"             -- bad.md
check 0 "SKIP pseudo.md:1 pseudo tool"  "pseudo tool call skipped"             -- pseudo.md
check 0 "SKIP allow.md:2 allowlisted"   "allowlisted fragment skipped"         -- allow.md
check 0 "checked=0 failed=0"            "non-bash fence ignored"               -- notbash.md
check 1 "FAIL prose-mention.md:2"      "prose mention of the marker does not allowlist" -- prose-mention.md
check 1 "checked=2 failed=1 skipped=1"  "multi-file summary"                   -- good.md bad.md pseudo.md
check 2 ""                              "no files is a usage error"            --
check 2 ""                              "unknown flag"                         -- --bogus good.md

# --base: only blocks touching changed lines are checked, so pre-existing breakage never fails a change.
( cd "$T" && git init -q . && git -c user.email=t@t -c user.name=t add bad.md good.md && git -c user.email=t@t -c user.name=t commit -q -m base )
check 0 "checked=0 failed=0"            "--base with no change checks nothing" -- --base HEAD bad.md good.md
printf '\nnew prose line\n' >> "$T/bad.md"
check 0 "checked=0 failed=0"            "--base: prose change outside a broken block passes" -- --base HEAD bad.md
cat >> "$T/good.md" <<EOF
${FENCE}bash
for x in a b; do
  echo "\$x"
${FENCE}
EOF
check 1 "FAIL good.md:"                 "--base: newly added broken block fails" -- --base HEAD good.md

echo "check-spec-bash.test.sh: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
