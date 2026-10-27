### Approach
Replaced the column-1 character whitelist with a blacklist: `R<n>:` prefix still rejected, control chars rejected, whitespace values must contain `/` or end in an extension (so prose is still rejected).
### Changes
- scripts/file-deferred-followups.sh: new column-1 validation, header comment.
- scripts/file-deferred-followups.test.sh: regression test for the five issue paths.
### Acceptance Criteria Status
- R1 ✅ scripts/file-deferred-followups.sh:78-79, test at the #4739 case
- R2 ✅ existing 68 checks unchanged and passing
- R3 ✅ rejection cases in section 21 still pass
### Verification
- V1 `bash scripts/file-deferred-followups.test.sh`: passed=69 failed=0; the new test fails without the fix (68/1).
### Notes
No env vars or other behaviour changes.

## Docs
Added a devdocs/modules/lean.md entry (#4739) describing the column-1 validation change, to satisfy check-devdocs-freshness.
