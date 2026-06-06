---
authority: recommended
scope: templates
applies_to: [work-on, review-pr]
---

# Pull Request Template

Use this template for PR bodies. The ForgeDock pipeline creates PRs automatically during the `/work-on` build phase — this template defines the expected structure.

---

## Template

```markdown
## Summary

{1-3 sentences describing what changed and why. Focus on the "why" not just the "what".}

## Changes

- `{file_or_component}`: {what changed and why}
- `{file_or_component}`: {what changed and why}
- `{file_or_component}`: {what changed and why}

## Testing

- [ ] {test scenario 1 — describe the action and expected result}
- [ ] {test scenario 2}
- [ ] No regressions in {related feature}

---
Closes #{issue_number}
**Implementation branch**: `{branch_name}`
**Base**: `{pr_base_branch}`
```

---

## PR Title Format

```
{Prefix}: {concise description}
```

| Prefix | Use for |
|--------|---------|
| `Fix:` | Bug fixes |
| `Feat:` | New features |
| `Refactor:` | Code restructuring |
| `Docs:` | Documentation changes |
| `Chore:` | Maintenance |

**Rules**:
- Capitalize the prefix
- Max 70 characters
- Match the linked issue's prefix
- Be specific about what changed

**Examples**:
- `Fix: prevent division by zero when user credits reach 0`
- `Feat: add dark mode toggle to dashboard settings`
- `Refactor: extract pagination logic into shared utility`

---

## PR Target Branch Rules

| Situation | Base Branch |
|-----------|------------|
| Fast-lane (no milestone) | `staging` |
| Feature-lane (has milestone) | `milestone/{slug}` |
| **Never** | `main` |

`main` only receives changes through the staging review process.

---

## Review-Finding Behavior

Review agents may create GitHub issues labeled `review-finding`. These are **not merge blockers** — the PR merges, and findings become separate issues to address in subsequent PRs.

The only exception is code that does not compile or causes runtime panics — those block merge.

---

## Auto-Close Note

`Closes #{N}` in a PR body does NOT auto-close the linked issue for non-default-branch PRs (i.e., PRs targeting `staging` or `milestone/*`). The ForgeDock pipeline explicitly closes the issue after merge in Phase 6. The `Closes` reference is for documentation purposes.

---

## Mergeability Check

Before posting a review verdict, always verify:

```bash
gh pr view {pr_number} -R {owner}/{repo} \
  --json mergeable,mergeStateStatus \
  --jq '{mergeable, mergeStateStatus}'
```

If `mergeable: CONFLICTING`, the PR has merge conflicts. Do NOT merge — post a comment and add `needs-human`.

---

## Checklist Before Submitting

- [ ] PR title follows `{Prefix}: {description}` convention
- [ ] `## Summary` explains the "why", not just the "what"
- [ ] `## Changes` lists every meaningful file change
- [ ] `## Testing` has at least two testable scenarios
- [ ] `Closes #{N}` references the correct issue
- [ ] Base branch is correct (`staging` or `milestone/*`, never `main`)
- [ ] No unintended files in the diff (build artifacts, `.env` files, etc.)
