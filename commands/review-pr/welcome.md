---
description: review-pr fragment — Phase 9 new-contributor welcome comment (read by /review-pr when its trigger holds; not a user entrypoint)
user-invocable: false
install: core
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<!-- Fragment of commands/review-pr.md (forge#3405): read on demand, run exactly as if inline. -->

### Phase 9 — New Contributor Welcome (Conditional) <!-- Added: forge#960 -->

Post a welcome comment when all three conditions are true:
1. `IS_FIRST_TIME_CONTRIBUTOR="true"` (set in Phase 1A — no prior merged PRs from this author in this repo)
2. `community.welcome_new_contributors` is not `false` in `forge.yaml` (default: enabled)
3. This is a single-PR review (MODE 3) — not a staging→main or multi-PR review

```bash
# Read config — default enabled when key is absent
WELCOME_ENABLED=$(yq '.community.welcome_new_contributors // true' forge.yaml 2>/dev/null || echo 'true')

if [ "$IS_FIRST_TIME_CONTRIBUTOR" = "true" ] && [ "$WELCOME_ENABLED" != "false" ] && [ "$REVIEW_MODE" = "single-pr" ]; then
    # Read optional custom values from forge.yaml community section
    CONTRIBUTING_URL=$(yq '.community.contributing_url // "CONTRIBUTING.md"' forge.yaml 2>/dev/null || echo 'CONTRIBUTING.md')
    CUSTOM_CONVENTIONS=$(yq '.community.conventions // ""' forge.yaml 2>/dev/null || echo '')
    PROJECT_NAME_WELCOME=$(yq '.project.name // "this project"' forge.yaml 2>/dev/null || echo 'this project')

    # Resolve the conventions text into a plain shell variable BEFORE interpolating it into
    # the --body string below. A nested $(...) command substitution containing an escaped
    # \$VAR here is never expanded — see forge#2214.
    if [ -n "$CUSTOM_CONVENTIONS" ]; then
        CONVENTIONS_TEXT="$CUSTOM_CONVENTIONS"
    else
        CONVENTIONS_TEXT="- **Conventional commits**: prefix your commit messages with \`fix(scope):\`, \`feat(scope):\`, \`refactor(scope):\`, etc.
- **DCO sign-off**: all commits must be signed off with \`git commit -s\` (Developer Certificate of Origin — required for the dual-license model).
  Fix unsigned commits: \`git commit --amend -s --no-edit && git push --force-with-lease\` <!-- allowlist:check-command-side-effects -->
- **Issues, not inline fixes**: when you spot a bug or improvement opportunity, open a GitHub issue rather than fixing it inline — so it flows through the pipeline with full traceability."
    fi

    # Unquoted heredoc (not the corpus's quoted <<'EOF' form) — this body needs live
    # ${VAR} interpolation, which a quoted heredoc would disable. Literal backticks in
    # the static text are still escaped (\`) since they remain live inside an unquoted
    # heredoc, same as inside a double-quoted string. See forge#2223.
    gh pr comment "$PR_NUMBER" -R "$REPO" --body "$(cat <<EOF
## Welcome to ${PROJECT_NAME_WELCOME}! 🎉

Hi @${PR_AUTHOR} — this looks like your first merged contribution here. Thanks for opening a PR!

### What just happened

The automated review pipeline (/review-pr) ran against your PR. It spawned domain-specific agents to review security, integration assumptions, and code quality. Any findings were created as separate GitHub issues — not merge blockers unless they are CONFIRMED at HIGH/CRITICAL severity.

### Key conventions

${CONVENTIONS_TEXT}

### Getting started

- Contributing guide: [\`${CONTRIBUTING_URL}\`](${CONTRIBUTING_URL})
- Run \`npx forgedock\` to install the pipeline commands locally if you want to run /review-pr or /work-on yourself.

Welcome aboard!
EOF
)"
fi
```
