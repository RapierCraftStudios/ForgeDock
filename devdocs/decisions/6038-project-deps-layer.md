# 6038 — project-deps image layer; depcache exports

`bin/lean/depcache.mjs` now also exports `detect` and `pyHint` (no behaviour change: same lockfile detection, commands and keys).
`bin/pool/project-layer.mjs` reuses them to derive a repo's project deps and build a cached layer FROM the lane image, tagged
`<base>-p<12hex>` (lockfile + manifest + runtime hash). Reusing depcache avoids a second copy of the lockfile logic. The build is
background and single-flight; launches fall back to the base image meanwhile or after a failure. See devdocs/modules/pool.md.
