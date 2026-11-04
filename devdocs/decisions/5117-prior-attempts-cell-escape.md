# 5117 — prior-attempts table cells escape backslashes before pipes

**Context**: CodeQL alert `js/incomplete-sanitization` on release PR #5103. `scripts/prior-attempts.mjs` `cell()` (added in #5085 / PR #5111) escaped `|` in the `## Prior Attempts` markdown table but not `\`. A title ending in a backslash therefore turned the cell's `\|` back into a column break and shifted the table.

**Decision**: `cell()` escapes `\` first, then `|`, then collapses whitespace. Regression test: `scripts/prior-attempts.test.mjs`, "a title with a backslash or pipe stays inside its table cell".

**Alternative**: strip backslashes from titles. Rejected because it loses information that the title really contains.
