#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Fixtures for scripts/refresh-bot-token.sh (#4507): hosts.yml is replaced by rename, never rewritten in place.
# Run: bash scripts/refresh-bot-token.test.sh (bash 3.2 compatible). Stubs `node` and `gh`; no network.

set -u
DIR=$(cd "$(dirname "$0")" && pwd)
S="$DIR/refresh-bot-token.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/refresh-bot-token-test.XXXXXX")
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { pass=$((pass+1)); }
no() { fail=$((fail+1)); echo "FAIL: $1"; }

mkdir -p "$T/bin" "$T/cfg"
echo key > "$T/key.pem"
cat > "$T/bin/node" <<'STUB'
#!/usr/bin/env bash
printf 'tok-new'
STUB
cat > "$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$GH_CONFIG_DIR $*" >> "$GH_LOG"
case "$1 $2" in
  "auth login") [ -n "${GH_FAIL:-}" ] && exit 1; cat > /dev/null; printf 'github.com:\n    oauth_token: tok-new\n' > "$GH_CONFIG_DIR/hosts.yml" ;;
  "auth status") echo "Logged in to github.com account rapiercraft-forgedock[bot]" ;;
esac
exit 0
STUB
chmod +x "$T/bin/node" "$T/bin/gh"
inode() { ls -i "$1" | awk '{print $1}'; }

# (a) success: gh writes in a staging dir; hosts.yml is renamed into place
printf 'github.com:\n    oauth_token: tok-old\n' > "$T/cfg/hosts.yml"
before=$(inode "$T/cfg/hosts.yml")
OUT=$(PATH="$T/bin:$PATH" GH_CONFIG_DIR="$T/cfg" GH_LOG="$T/log" bash "$S" --pem "$T/key.pem" 2>&1); RC=$?
[ "$RC" = 0 ] && ok || no "(a) exit $RC: $OUT"
grep -q 'tok-new' "$T/cfg/hosts.yml" && ok || no "(a) hosts.yml not updated"
[ "$(inode "$T/cfg/hosts.yml")" != "$before" ] && ok || no "(a) hosts.yml rewritten in place (same inode)"
if awk '{print $1}' "$T/log" | grep -qx "$T/cfg"; then no "(a) gh ran against the live config dir"; else ok; fi
grep -q "auth login" "$T/log" && ok || no "(a) gh auth login not run"
ls -a "$T/cfg" | grep -q '^\.hosts-stage\.' && no "(a) staging dir left behind" || ok
case "$OUT" in *"token refreshed"*) ok ;; *) no "(a) success message missing: $OUT" ;; esac

# (b) failed login: the live hosts.yml stays byte-identical, exit != 0
printf 'github.com:\n    oauth_token: tok-keep\n' > "$T/cfg/hosts.yml"
cp "$T/cfg/hosts.yml" "$T/expect"
PATH="$T/bin:$PATH" GH_CONFIG_DIR="$T/cfg" GH_LOG="$T/log" GH_FAIL=1 bash "$S" --pem "$T/key.pem" >/dev/null 2>&1; RC=$?
[ "$RC" != 0 ] && ok || no "(b) failed login exited 0"
cmp -s "$T/expect" "$T/cfg/hosts.yml" && ok || no "(b) hosts.yml changed after a failed login"
ls -a "$T/cfg" | grep -q '^\.hosts-stage\.' && no "(b) staging dir left behind" || ok

echo "refresh-bot-token: $pass passed, $fail failed"
[ "$fail" = 0 ]
