#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Deterministic regression test for install-pi.sh profile serialization.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER_SOURCE="$SCRIPT_DIR/../install-pi.sh"
TEMP_ROOT=$(mktemp -d)
MOCK_BIN="$TEMP_ROOT/bin"
HOME_DIR="$TEMP_ROOT/home"
INSTALL_DIR=""
PI_ARGS="$TEMP_ROOT/pi-args"

cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$MOCK_BIN" "$HOME_DIR"
: > "$HOME_DIR/.bashrc"
: > "$HOME_DIR/.zshrc"

# Keep every shell metacharacter literal while creating the adversarial path.
ADVERSARIAL_NAME="forge \$(touch forge-profile-command-substitution-pwned) \`touch forge-profile-backtick-pwned\` \"double\" 'single' \\backslash !"
INSTALL_DIR="$TEMP_ROOT/$ADVERSARIAL_NAME"
mkdir -p "$INSTALL_DIR"
cp "$INSTALLER_SOURCE" "$INSTALL_DIR/install-pi.sh"
chmod +x "$INSTALL_DIR/install-pi.sh"
# `pwd` normalizes separators on platforms such as Windows; compare with the
# same canonical path the installer computes rather than the construction input.
EXPECTED_FORGE_HOME="$(cd "$INSTALL_DIR" && pwd)"

cat > "$MOCK_BIN/pi" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${PI_MOCK_ARGS:?}"
EOF
chmod +x "$MOCK_BIN/pi"

run_installer() {
  (
    cd "$TEMP_ROOT"
    HOME="$HOME_DIR" PATH="$MOCK_BIN:$PATH" PI_MOCK_ARGS="$PI_ARGS" \
      "$INSTALL_DIR/install-pi.sh" >/dev/null
  )
}

run_installer

mapfile -t PI_ARGUMENTS < "$PI_ARGS"
[[ "${#PI_ARGUMENTS[@]}" -eq 2 ]] || {
  printf 'FAIL: mocked pi received %s arguments, expected 2\n' "${#PI_ARGUMENTS[@]}" >&2
  exit 1
}
[[ "${PI_ARGUMENTS[0]}" == install && "${PI_ARGUMENTS[1]}" == "$EXPECTED_FORGE_HOME" ]] || {
  printf 'FAIL: pi install argument was not the exact raw path\n' >&2
  printf '  expected: %s\n' "$EXPECTED_FORGE_HOME" >&2
  printf '  actual:   %s %s\n' "${PI_ARGUMENTS[0]}" "${PI_ARGUMENTS[1]}" >&2
  exit 1
}

source_profile() {
  local shell_name="$1"
  local profile="$2"
  # WIRE:PROVEN — the fixture invokes this branch for both generated profiles.
  if [[ "$shell_name" == bash ]]; then
    (
      cd "$TEMP_ROOT"
      env -i HOME="$HOME_DIR" PATH="$PATH" bash --noprofile --norc -c \
        '. "$1"; printf "%s" "$FORGE_HOME"' _ "$profile"
    )
  else
    (
      cd "$TEMP_ROOT"
      env -i HOME="$HOME_DIR" PATH="$PATH" zsh -f -c \
        '. "$1"; printf "%s" "$FORGE_HOME"' _ "$profile"
    )
  fi
}

for profile in "$HOME_DIR/.bashrc" "$HOME_DIR/.zshrc"; do
  actual=$(source_profile bash "$profile")
  [[ "$actual" == "$EXPECTED_FORGE_HOME" ]] || {
    printf 'FAIL: sourcing %s did not preserve FORGE_HOME\n' "$profile" >&2
    printf '  expected: %s\n  actual:   %s\n' "$EXPECTED_FORGE_HOME" "$actual" >&2
    exit 1
  }
done

for marker in \
  "$TEMP_ROOT/forge-profile-command-substitution-pwned" \
  "$TEMP_ROOT/forge-profile-backtick-pwned"; do
  [[ ! -e "$marker" ]] || {
    printf 'FAIL: sourcing a generated profile executed %s\n' "$marker" >&2
    exit 1
  }
done

# WIRE:PROVEN — the optional branch runs when zsh is installed and remains non-blocking otherwise.
if command -v zsh >/dev/null 2>&1; then
  for profile in "$HOME_DIR/.bashrc" "$HOME_DIR/.zshrc"; do
    actual=$(source_profile zsh "$profile")
    [[ "$actual" == "$EXPECTED_FORGE_HOME" ]] || {
      printf 'FAIL: zsh sourcing %s did not preserve FORGE_HOME\n' "$profile" >&2
      printf '  expected: %s\n  actual:   %s\n' "$EXPECTED_FORGE_HOME" "$actual" >&2
      exit 1
    }
  done
fi

run_installer
for profile in "$HOME_DIR/.bashrc" "$HOME_DIR/.zshrc"; do
  [[ "$(grep -c '^export FORGE_HOME=' "$profile")" -eq 1 ]] || {
    printf 'FAIL: repeated installation appended a duplicate export to %s\n' "$profile" >&2
    exit 1
  }
done

printf 'PASS: Pi installer serializes metacharacter paths safely for Bash and zsh profiles\n'
