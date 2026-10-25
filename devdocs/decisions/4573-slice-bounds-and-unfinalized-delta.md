---
issue: 4573
status: fresh
anchor: scripts/review-prepare.sh
created: 2026-10-25
---

# ADR: bounded whole-file diff slices; `--delta-from` accepts a complete unfinalized panel

## Context

On a large bundle the reviewer briefs reached 640-940 KB. `slice()` cut the diff at 100K bytes mid-file, fell back to the full diff when a domain matched nothing (the same slice repeated), and put `.github/` first in the security slice. `bin/review-staging.mjs` inlined the slice into templates that repeat `[DOMAIN_DIFF_SLICE]` many times. Separately, #4471 required a finalized summary as proof, so a fix landing before finalize dead-ended `--delta`.

## Choice

- `slice()` emits whole `diff --git` blocks only. A block over `REVIEW_SLICE_FILE_CAP` (20000 chars) or past `REVIEW_SLICE_CAP` (102400) is listed as `# OMITTED` at the top. The security slice lists `.github/` blocks last. An unmatched domain gets a note and no paths, with no full-diff fallback.
- The brief inlines a slice only up to 16000 chars; larger is a pointer to `slices.<domain>.diff_file`.
- `--delta-from` also accepts the earlier head when no summary exists but every domain in the PR-keyed launched-agent file has a trusted agent body with findings and `Reviewed-SHA: <from>`, and no degraded marker follows. An empty or missing list, or any missing domain, stays `no-proof`.

## Rejected

- Raising the cap: it multiplies through the repeated token.
- Accepting any single agent body at `<from>` as completeness: one agent is not a panel.
