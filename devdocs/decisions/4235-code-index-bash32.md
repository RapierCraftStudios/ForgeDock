---
issue: 4235
status: fresh
anchor: scripts/code-index.sh
created: 2026-10-20
---

# ADR: code-index.sh is bash 3.2 portable; review-prepare surfaces index build failures

## Context

On the macOS leg of `shell-compat.yml`, `scripts/review-prepare.test.sh` failed "real index fills the auth slice" on every run. It was mistaken for an intermittent failure because some "green" runs had no macOS job. That leg resolves `bash` to `/bin/bash` 3.2. `scripts/code-index.sh` declared its domain table with `declare -A`, which bash 3.2 does not have, so the build aborted before writing `index.json`. `review-prepare.sh` discarded the build's stderr, and every review on a stock macOS host fell back to grep slices without saying why.

## Decision

- The file-to-domain table is two parallel indexed arrays (prefix, label), ordered most specific first. The first prefix match wins, so `services/api/auth/*` maps to `auth`. Before, it mapped to `api` or `auth` depending on hash order. forge.yaml `review.key_paths` entries are prepended so they still override the defaults.
- When the index build fails, `review-prepare.sh` keeps the build's stderr in a temp file under the out dir. It prints the exit code and up to the last 20 stderr lines (prefixed `review-prepare: code-index: `), then removes the file. The timeout (exit 124) path and the stdout JSON contract are unchanged.
- `code-index.test.sh` guards against bash-4-only constructs and runs under `/bin/bash` 3.2 on macOS.

## Alternatives

- Install Homebrew bash or coreutils on the macOS runner: CI would pass, but users' stock macOS hosts would stay broken.
- Re-exec under a newer bash when one is found: this adds a runtime dependency and still fails where none is installed.
