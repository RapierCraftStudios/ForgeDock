### Approach
`authorAssociation` is not a `gh issue view|list --json` field. A new module reads `author_association` from REST and merges it into the issue record, failing closed (unset means untrusted).

### Changes
- bin/lean/gh-assoc.mjs (new): `ISSUE_JSON_FIELDS`, `issueAssociation`, `listAssociations`, `viewIssue`.
- bin/engine-cli.mjs: `addToBatch` and both batch body readers use `viewIssue`; the field is dropped from the `--json` lists.
- bin/lean/issuewatch.mjs: the two `gh issue list` calls drop the field and merge `listAssociations` by number.
- bin/lean/gh-assoc.test.mjs (new): allowlist scan, helper tests, strict-gh `--add` regression, issue-watch tick trust.
- Mock updates (REST call): orchestrate-add-edges, issuewatch, issuewatch-release, batch, lean tests.
- devdocs/decisions/4859-issue-author-association-rest.md: devdocs freshness (amendment add-deliverable).

### Acceptance Criteria Status
- R1 ✅ bin/engine-cli.mjs:1258,1865,1866; bin/lean/issuewatch.mjs:245,277
- R2 ✅ bin/lean/gh-assoc.test.mjs:36
- R3 ✅ bin/lean/gh-assoc.test.mjs:60
- R4 ✅ bin/lean/gh-assoc.test.mjs:75
- R5 ✅ same as R1/R2
- R6 ✅ bodyTrusted unchanged (bin/engine-cli.mjs:2231); helper fails closed (gh-assoc.test.mjs:49)

### Verification
- V1 (gh-assoc, orchestrate-add-edges, issuewatch, issuewatch-release): 42 pass, 0 fail. The new gh-assoc tests fail (3 of 4) with engine-cli.mjs and issuewatch.mjs reverted.
- V2 (enumerating and sibling tests): 832 pass, 0 fail.
- V3 node --check: ok.
- Also ran recovery, schedd, plan-validate-live: pass. devdocs freshness: passes after the decision doc. `forgedock check`: PASS.
- checks.mjs widened to the full suite (fan-out cap); not run, per host rules.

### Notes
No formatter is configured in package.json. No env vars. One extra REST call per issue read, and one paginated list per issue-watch tick.

## Sibling-list follow-up
The ten tests flagged for enumerating gh-assoc siblings hold unrelated lists (telemetry events, outcomes, check kinds, git args), not module names. Recorded each as a not_member in result.json; no test edits.
