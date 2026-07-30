# Phase: Review

Independently review the committed branch, create or adopt its PR, run required
checks, and merge only when the evidence supports approval.

1. Read the complete builder annotation and verify the named branch exists,
   contains at least one commit ahead of the supplied base, and matches the
   controller-supplied worktree.
2. Push the branch without force. Adopt an existing PR with the same head, or
   create one targeting the supplied base. The body must summarize behavior,
   verification, risk, and reference the issue.
3. Add `workflow:in-review`; remove `workflow:building` on the issue.
4. Review the full base-to-head diff as a fresh reviewer. Trace callers and test
   behavior. Check correctness, regressions, security, concurrency, data loss,
   error handling, compatibility, and acceptance criteria. Run focused checks.
5. Post a `FORGE:REVIEWER` comment on the PR with `**Verdict**: APPROVED` or
   `CHANGES_REQUESTED`, findings with file/line evidence, and checks run.
6. For actionable findings, label both PR and issue `needs-human`, leave the PR
   open, and stop. The separate remediation phase owns fixes.
7. For approval, wait for required GitHub checks. If checks are pending, enable
   normal auto-merge when repository policy permits; otherwise merge with the
   repository's normal merge method. Never bypass checks or branch protection.
8. Re-read the PR. Only after it is actually merged, post on the issue:

```markdown
<!-- FORGE:REVIEWER:MERGED -->
**PR**: #<number>
**Base**: `<base>`
**Head**: `<branch>`
**Verdict**: APPROVED
```

Do not close the issue here. The close phase owns final labels, trajectory, and
cleanup.
