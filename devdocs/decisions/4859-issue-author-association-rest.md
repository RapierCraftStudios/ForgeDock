# 4859: issue author association comes from REST

`gh issue view|list --json` has no `authorAssociation` field (gh 2.97), so asking for it failed every read.
`bin/lean/gh-assoc.mjs` reads `author_association` through `gh api` (one call per issue, or one paginated list for issue watch)
and merges it into the record. A failed read leaves it unset, which is untrusted (fail closed).
`ISSUE_JSON_FIELDS` is the allowlist a test checks every `gh issue view|list --json` list against.
