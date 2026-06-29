#!/usr/bin/env bash
#
# bootstrap.sh — stand up a live ForgeDock demo repo from this scaffold.
#
# This is the ONE step that needs a human: it creates a real GitHub repo (which
# requires your credentials), pushes this code, sets up the workflow labels, and
# files the five demo issues. Everything else in the scaffold is ready to go.
#
# Usage:
#   ./bootstrap.sh                       # creates <your-user>/forgedock-demo (public)
#   ./bootstrap.sh my-org/forgedock-demo # custom owner/repo
#   ./bootstrap.sh my-org/forgedock-demo --private
#
# Requirements: an authenticated `gh` CLI (`gh auth status`) and `git`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- args -------------------------------------------------------------------
REPO_SLUG="${1:-}"
VISIBILITY="--public"
for arg in "$@"; do
  case "$arg" in
    --private) VISIBILITY="--private" ;;
    --public)  VISIBILITY="--public" ;;
  esac
done

if [ -z "$REPO_SLUG" ] || [[ "$REPO_SLUG" == --* ]]; then
  GH_USER="$(gh api user --jq '.login')"
  REPO_SLUG="${GH_USER}/forgedock-demo"
fi

echo "==> Target repo: $REPO_SLUG ($VISIBILITY)"

command -v gh >/dev/null || { echo "ERROR: gh CLI not found"; exit 1; }
gh auth status >/dev/null || { echo "ERROR: run 'gh auth login' first"; exit 1; }

# ---- 1. create the repo -----------------------------------------------------
if gh repo view "$REPO_SLUG" >/dev/null 2>&1; then
  echo "==> Repo already exists, skipping creation."
else
  echo "==> Creating repo..."
  gh repo create "$REPO_SLUG" $VISIBILITY \
    --description "Try ForgeDock risk-free — a tiny Notes API with pre-written issues." \
    --disable-wiki
fi

# ---- 2. push the scaffold ---------------------------------------------------
TMP_DIR="$(mktemp -d)"
echo "==> Staging scaffold in $TMP_DIR"
# Copy everything except bootstrap.sh and the issues/ specs (issues become GH issues).
cp -r src scripts package.json forge.yaml labels.json README.md .gitignore "$TMP_DIR/" 2>/dev/null || true
# Ship the issue specs too, for reference inside the repo.
cp -r issues "$TMP_DIR/issues"

(
  cd "$TMP_DIR"
  git init -q
  git checkout -q -b main
  git add .
  git -c user.name="forgedock-demo" -c user.email="demo@forgedock.dev" \
      commit -q -m "chore: initial demo scaffold"
  git remote add origin "https://github.com/${REPO_SLUG}.git"
  git push -q -u origin main --force
)
echo "==> Pushed scaffold to $REPO_SLUG"

# ---- 3. labels --------------------------------------------------------------
echo "==> Creating labels..."
# Prefer the ForgeDock CLI if available; otherwise create from labels.json.
if command -v npx >/dev/null && npx --no-install forgedock --help >/dev/null 2>&1; then
  npx forgedock labels setup --repo "$REPO_SLUG" || true
else
  node -e '
    const fs = require("fs");
    const labels = JSON.parse(fs.readFileSync("labels.json", "utf8"));
    for (const l of labels) console.log([l.name, l.color, l.description].join("\t"));
  ' labels.json | while IFS=$'\t' read -r name color desc; do
    gh label create "$name" --color "$color" --description "$desc" --force -R "$REPO_SLUG" >/dev/null 2>&1 || true
  done
fi

# ---- 4. issues --------------------------------------------------------------
echo "==> Creating issues..."
for f in issues/*.md; do
  title="$(grep -m1 '^title:' "$f" | sed -E 's/^title:[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/')"
  labels="$(grep -m1 '^labels:' "$f" | sed -E 's/^labels:[[:space:]]*\[(.*)\][[:space:]]*$/\1/' | tr -d '"' | tr -d ' ')"
  # Body = everything after the closing front-matter '---'.
  body="$(awk 'f{print} /^---[[:space:]]*$/{c++; if(c==2) f=1}' "$f")"
  label_args=()
  if [ -n "$labels" ]; then
    IFS=',' read -ra parts <<< "$labels"
    for l in "${parts[@]}"; do label_args+=(--label "$l"); done
  fi
  echo "    - $title"
  gh issue create -R "$REPO_SLUG" --title "$title" --body "$body" "${label_args[@]}" >/dev/null \
    || gh issue create -R "$REPO_SLUG" --title "$title" --body "$body" >/dev/null
done

rm -rf "$TMP_DIR"

echo ""
echo "Done. Your demo repo is ready:"
echo "  https://github.com/${REPO_SLUG}"
echo ""
echo "Next:"
echo "  git clone https://github.com/${REPO_SLUG}.git && cd forgedock-demo"
echo "  npx forgedock           # install the commands"
echo "  # open Claude Code here, then run:  /work-on 1"
