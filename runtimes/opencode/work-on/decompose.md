# Phase: Decompose

Turn a confirmed decomposition plan into a finite ordered set of executable
sub-issues, then stop work on the parent.

1. Read the latest complete `FORGE:INVESTIGATOR` annotation. If it has no
   explicit decomposition plan, add `needs-human` with that blocker and stop.
2. If a complete `FORGE:DECOMPOSED` annotation already exists, verify the linked
   children and stop without creating duplicates.
3. Search existing open and closed issues for each planned child title and for
   a `Parent: #<parent>` reference. Reuse exact existing children.
4. Create only missing children. Each body must contain context, scoped affected
   files, verifiable acceptance criteria, dependencies, and `Parent: #<parent>`.
   Copy the parent milestone and relevant non-workflow labels. Never create a
   child whose scope is merely "investigate further" without a concrete output.
5. Update the parent body with an unchecked child tracker while preserving all
   existing content.
6. Post one annotation ending in the completion marker:

```markdown
<!-- FORGE:DECOMPOSED -->
**Parent**: #<parent>
**Children**: #<n>, #<n>
**Order**: dependency order or "independent"

| Child | Scope | Depends on |
|---|---|---|
| #<n> | concise scope | none or #<n> |

<!-- FORGE:DECOMPOSED:COMPLETE -->
```

7. Add `workflow:decomposed`; remove `workflow:investigating`,
   `workflow:ready-to-build`, and `workflow:building`. Do not implement a child
   and do not continue the parent pipeline.
