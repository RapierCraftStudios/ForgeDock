**Verdict**: CONFIRMED
**Confidence**: high
**Severity**: high (`orchestrate --add/--resume` can never add an issue; the batch body reader drops every trusted dependency edge, placement need and relay prefetch; issue watch sees no issue)
**Task Type**: bug

### What Was Claimed
`gh issue view|list --json` has no `authorAssociation` field (gh 2.97: `Unknown JSON field`). Four engine calls request it, so each fails on a real host. Unit tests mock `gh`, so CI never saw it.

### What We Found
- bin/engine-cli.mjs:1257 `addToBatch` asks `state,body,author,authorAssociation`. The throw is swallowed (`st = null`), so every issue is skipped as `unreadable` (:1266).
- bin/engine-cli.mjs:1864 and :1865 (batch `readBody`) ask `...author,authorAssociation`. The throw is caught fail-open at bin/lean/orchestrate.mjs:369 (`readDeps`), so deps, needs and prefetch are lost, and `trustedOf` stays unset.
- bin/lean/issuewatch.mjs:244 (`tick`) and :273 (`releaseStep`) ask `...author,authorAssociation,createdAt` through `gh issue list`. `classifyIssue` (:145) reads `issue.authorAssociation` against `TRUSTED`.
- `bodyTrusted` (bin/engine-cli.mjs:2230) reads `v.authorAssociation` and `v.author`, and feeds `isTrustedActor` (bin/engine/phases.mjs:63).
- Working REST precedent: bin/engine-cli.mjs:1922 (`gh api repos/${repo}/issues/${n}/events --jq`). GraphQL precedent: bin/engine/projector.mjs:15.
- Tests mock the `authorAssociation` key on issue records (bin/tests/orchestrate-add-edges.test.mjs:11, bin/lean/issuewatch.test.mjs:12), which is why nothing failed.
- Other `authorAssociation` hits (prefilter.mjs:196, pre-tool-use.mjs:271) read it from `--json comments`, which gh supports. They are not affected.

### Root Cause
`authorAssociation` was assumed to be a top-level `gh issue` JSON field. It exists only on comments, in REST (`author_association`) and in GraphQL. No test checks gh's field names.

### Affected Files
- bin/lean/gh-assoc.mjs (new): `ISSUE_JSON_FIELDS` allowlist, `issueAssociation(gh, repo, n)` (REST, `--jq .author_association`), `listAssociations(gh, repo)` (one paginated REST list that returns number to association). A failed read gives `undefined`, which is untrusted (fail closed).
- bin/engine-cli.mjs (wiring only; the file is a hotspot): the :1257 and :1864/:1865 calls drop the field and merge `authorAssociation` from the helper.
- bin/lean/issuewatch.mjs: :244 and :273 drop the field and merge the association map into each listed issue.
- bin/lean/gh-assoc.test.mjs (new): allowlist scan over `bin/**/*.mjs` (non-test), plus helper tests.
- Existing tests whose gh mocks need an `api` branch or a stub that rejects unknown fields: bin/tests/orchestrate-add-edges.test.mjs, bin/lean/issuewatch.test.mjs, bin/lean/issuewatch-release.test.mjs, bin/tests/engine-cli.test.mjs.
- Enumerating tests (literal sibling lists): bin/lean/lean.test.mjs:66, bin/lean/execution.test.mjs:43, bin/lean/conformance.test.mjs:404, bin/lean/context.test.mjs:138, bin/lean/batch.test.mjs:29, bin/engine/telemetry-seam.test.mjs:24, bin/lean/checks.test.mjs:156, bin/lean/drift.test.mjs:14, bin/lean/fixround.test.mjs:10, bin/lean/conformance.e2e.test.mjs:74 and bin/lean/execution.e2e.test.mjs:28. A new bin/lean file may have to join some of these lists, so run them and amend if red.
- devdocs/modules entry for bin/lean if index.yaml maps it (freshness check).

### Sibling Sweep
- The four call sites above are the only `gh issue view|list --json authorAssociation` uses in bin/ (grep of non-test code). The allowlist test guards any other `--json` field list passed to `gh issue view|list`.
- `--json comments` use of `authorAssociation` is valid, so leave it.

### History
- #4773 (81378f3de) introduced the :1257 and body-reader uses, and #4785 extended the reader. issuewatch was introduced in #4765 (PR #4811).
- No prior fix.

### Recommendation
Add one small helper module and call it from the four sites. In `readBody` and `addToBatch`, fetch the view without `authorAssociation` and call `issueAssociation` in parallel. Merge the result so `bodyTrusted` and `addedEdges` are unchanged. For issue watch, fetch `listAssociations` once per tick and merge it by number. REST `gh api repos/{repo}/issues?state=open&per_page=100 --paginate --jq '.[]|"\(.number)\t\(.author_association)"'` is one call, not one per issue. Handle a missing `-R` repo with the `{owner}/{repo}` placeholder. A stub `gh` in the tests rejects unknown `--json` fields the way gh does.

### Related Issues
#4773, #4785, #4765, #4835 and #4838 (observed impact).
