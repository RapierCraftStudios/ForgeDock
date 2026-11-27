# failureOutsideDiff scans test-file names linearly

The #6094 regex that found test-file names in check output nested quantifiers over overlapping character classes and
backtracked exponentially on long path-like output. The lane (and `npm test`) spun in `failureOutsideDiff` forever; the
1.68.0 publish hung three times on it. `bin/lean/envgap.mjs` now splits the output on non-path characters and tests each
token's basename with anchored patterns, scanning at most the last 512 KiB and skipping tokens over 400 characters.
