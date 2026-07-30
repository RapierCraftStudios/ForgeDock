# Phase: Architect

Trace every affected code path and publish an ordered implementation plan. Do
not edit code.

1. Read the issue plus complete investigator/context annotations.
2. Inspect every affected file and relevant caller, importer, public interface,
   schema, test, configuration, and deployment path. Validate that named files
   and symbols exist on the target base branch.
3. Choose the smallest correct design. Record preserved interfaces, migration
   concerns, concurrency/security risks, and consistency updates.
4. For trivial work, post a minimal skip plan rather than omitting the marker.
5. Post one complete architecture annotation:

```markdown
<!-- FORGE:ARCHITECT -->
## Design
...

## Affected Paths
| Path | Symbols | Change | Preserved interface |
|---|---|---|---|

## Ordered Implementation
1. ...

## Verification Plan
- command or observable check

## Risks and Constraints
...
<!-- FORGE:ARCHITECT:COMPLETE -->
```

Use `FORGE:ARCHITECT:PARTIAL` instead of `:COMPLETE` if the plan cannot safely
cover all affected paths. A missing complete marker blocks implementation.
