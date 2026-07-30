# Phase: Remediate

Re-drive one blocked PR exactly once, preserving a durable paper trail.

1. Resolve the PR associated with the issue/branch and read its latest review,
   failed checks, comments, and diff. If a complete remediation annotation
   already exists, stop without another attempt.
2. Classify the block as fixable or a policy/human judgment. For an unfixable
   policy decision, leave `needs-human` and finalize with `UNFIXABLE`.
3. For a fixable block, remove `needs-human`, add `workflow:in-review`, make the
   smallest correction in the existing worktree, run relevant checks, commit,
   and push normally. Never force-push or amend.
4. Re-review the full updated diff and required checks. Merge only if approved,
   mergeable, and all required checks pass. Otherwise use `RE-ESCALATED` for a
   fresh defect/policy block or `HELD-AWAITING-MERGE` for a clean change that
   still requires a human merge.
5. Post the same final annotation to both PR and issue:

```markdown
<!-- FORGE:REMEDIATION -->
**PR**: #<number>
**Issue**: #<number>
**Classification**: FIXABLE | UNFIXABLE
**Re-gate outcome**: AUTO-LANDED | HELD-AWAITING-MERGE | RE-ESCALATED | UNFIXABLE
**Findings addressed**: ...
**Verification**: ...
<!-- FORGE:REMEDIATION:COMPLETE -->
```

6. Reconcile labels:
   - `AUTO-LANDED`: add `workflow:merged`, remove active/blocked labels, close
     the issue, and post a concise `FORGE:TRAJECTORY` if absent.
   - `HELD-AWAITING-MERGE`: add `workflow:awaiting-merge`; remove
     `workflow:in-review` and `needs-human`.
   - `RE-ESCALATED`/`UNFIXABLE`: add `needs-human`; remove
     `workflow:in-review`.

This phase is terminal. Do not start another remediation attempt.
