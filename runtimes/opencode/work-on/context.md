# Phase: Context

Produce a bounded historical and repository briefing for the implementation
worker. Do not edit code.

1. Read the latest complete investigator annotation and extract affected files,
   symbols, root cause, and acceptance checks.
2. Read applicable repository instructions and devdocs. Search closed issues,
   merged PRs, git history/blame, and local ForgeDock knowledge indexes for the
   affected files and bug class.
3. Identify prior regressions, compatibility promises, danger zones, concurrent
   file claims, and tests that encode expected behavior. Cite issue/PR/commit
   references instead of pasting large transcripts.
4. If the issue is explicitly marked `COMPLEXITY_BAND: TRIVIAL`, a minimal skip
   annotation is valid. Otherwise post a concise briefing:

```markdown
<!-- FORGE:CONTEXT -->
## Current Scope
...

## Authoritative Instructions
...

## Prior Findings
...

## Known Pitfalls
...

## Verification Targets
...
<!-- FORGE:CONTEXT:COMPLETE -->
```

If a time or access limit prevents a reliable briefing, post the useful partial
content ending in `<!-- FORGE:CONTEXT:PARTIAL -->`. Never claim a complete
briefing when required evidence could not be read.
