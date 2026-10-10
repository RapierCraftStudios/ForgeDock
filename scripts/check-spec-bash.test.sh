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
check 0 "SPEC-POSITIONAL: files="       "no args defaults to --positional over commands/" --
check 0 "SPEC-POSITIONAL: files="       "--positional with no files uses the default set" -- --positional
check 2 ""                              "--shellcheck alone is a usage error"  -- --shellcheck
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

# --positional: $0-$9 inside fences are flagged; ${N}, $(N), $NF, prose and allowlisted lines are not.
cat > "$T/pos-bad.md" <<EOF
${FENCE}bash
X=\$(echo a b | awk '{print \$2}')
local a="\$1"
${FENCE}
EOF
cat > "$T/pos-good.md" <<EOF
Prose mentions \$1 and \$2 freely.
${FENCE}bash
X=\$(echo a b | awk '{print \$(2) \$NF}')
local a="\${1}" b="\$@" n="\$#"
echo \$10
y=\$1 # allowlist:positional-arg
${FENCE}
EOF
check 1 "FAIL pos-bad.md:2"             "--positional flags awk \$2"            -- --positional pos-bad.md
check 1 "FAIL pos-bad.md:3"             "--positional flags shell \$1"          -- --positional pos-bad.md
check 1 "violations=2"                  "--positional counts violations"       -- --positional pos-bad.md
check 0 "violations=0"                  "--positional passes safe forms, prose, allowlist" -- --positional pos-good.md

# --fence-state: a listed var read in a fence without a prior assignment in that same fence is flagged.
cat > "$T/fs-bad.md" <<EOF
${FENCE}bash
gh pr view "\$PR_NUMBER" -R "\$REPO" --json state
${FENCE}
${FENCE}bash
X=\$(gh pr diff \${PR_NUMBER} --name-only)
${FENCE}
${FENCE}bash
echo "\${REPO:-none}"
${FENCE}
${FENCE}bash
gh pr view "\$PR_NUMBER"
PR_NUMBER="{PR_NUMBER}"
${FENCE}
EOF
cat > "$T/fs-good.md" <<EOF
Prose mentions \$PR_NUMBER and \$REPO freely.
${FENCE}bash
# comment reads \$PR_NUMBER and \$REPO
PR_NUMBER="{PR_NUMBER}"; REPO="{GH_REPO}"
gh pr view "\$PR_NUMBER" -R "\$REPO"
${FENCE}
${FENCE}bash
export REPO="{GH_REPO}"
for PR_NUMBER in 1 2; do echo "\${PR_NUMBER}"; done
echo "\$REPO"
${FENCE}
${FENCE}bash
REPO="\${REPO:-\$(gh repo view)}"
${FENCE}
${FENCE}bash
gh pr view \${REPO_FLAG} "\$OTHER"
${FENCE}
${FENCE}bash
echo "\$PR_NUMBER" # allowlist:fence-state
${FENCE}
${FENCE}text
echo \$PR_NUMBER \$REPO
${FENCE}
${FENCE}bash
PR_NUMBER="{PR_NUMBER}"
OUT=\$(Skill(skill="x", args="\$PR_NUMBER"))
${FENCE}
EOF
check 1 "FAIL fs-bad.md:2 fence-state: \$PR_NUMBER" "--fence-state flags \$VAR read"        -- --fence-state PR_NUMBER REPO -- fs-bad.md
check 1 "FAIL fs-bad.md:2 fence-state: \$REPO"      "--fence-state flags each listed var"   -- --fence-state PR_NUMBER REPO -- fs-bad.md
check 1 "FAIL fs-bad.md:5 fence-state: \$PR_NUMBER" "--fence-state flags \${VAR} form"       -- --fence-state PR_NUMBER REPO -- fs-bad.md
check 1 "FAIL fs-bad.md:8 fence-state: \$REPO"      "--fence-state flags \${VAR:-default}" -- --fence-state PR_NUMBER REPO -- fs-bad.md
check 1 "FAIL fs-bad.md:11 fence-state: \$PR_NUMBER" "--fence-state flags read before assignment" -- --fence-state PR_NUMBER REPO -- fs-bad.md
check 1 "violations=5"                   "--fence-state counts violations"        -- --fence-state PR_NUMBER REPO -- fs-bad.md
check 0 "violations=0"                   "--fence-state ignores unlisted vars"    -- --fence-state UNLISTED -- fs-bad.md
check 0 "violations=0"                   "--fence-state passes declared, loop, export, REPO_FLAG, allowlist, comments, prose, non-bash fences" -- --fence-state PR_NUMBER REPO -- fs-good.md
check 2 "Usage"                          "--fence-state without -- is a usage error"  -- --fence-state PR_NUMBER fs-good.md
check 2 "Usage"                          "--fence-state without vars is a usage error" -- --fence-state -- fs-good.md

echo "check-spec-bash.test.sh: passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
