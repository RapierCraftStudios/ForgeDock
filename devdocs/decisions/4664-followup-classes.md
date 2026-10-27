# 4664: deferred follow-ups per class, with milestone

`scripts/file-deferred-followups.sh` files one follow-up per class (`engineering|post-deploy|external|ops`) per parent instead of one mixed issue.

- Routing: label `followup:<class>`; `external` also `external-prerequisite` and names the parent it is a prerequisite of (`FORGE_EXTERNAL_PREREQ` adds a link). `post-deploy` items keep the `[check:<id>]` token, so `postDeployOnly` still parks them.
- Markers: `FORGE:DEFERRED_FROM` is unchanged (review-finalize.sh and prefilter.mjs match it); `FORGE:DEFERRED_CLASS` is new and absent means engineering, so older follow-ups and claim markers are still reused. The claim marker gains an optional `class=` suffix.
- Milestone: the parent's (`FORGE_FOLLOWUP_MILESTONE`, else read from the parent). A closed milestone resolves to the next open one by `due_on` (as the train order of 4659), else forge.yaml `followups.default_milestone`, else none.
- TSV: column 1 is a path or `-`; requirement text goes to the label column 5, which is the item's identity. Requirement text or an `R<n>:` prefix in column 1 is a script error (exit 2, nothing filed), not a malformed issue.
- Lookups for every class run before anything is filed; a failed lookup files nothing.
