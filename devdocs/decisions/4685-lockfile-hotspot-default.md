# 4685: lockfiles are excluded from hotspot growth by default

`scripts/hotspots.sh` now always excludes lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `go.sum`, `Gemfile.lock`, `composer.lock`, at any depth) in addition to `maintenance.hotspot.exclude_globs`. One added dependency grows a lockfile by hundreds of lines, which tripped `maintenance.hotspot_growth` on an unrelated change. The excluded flag in the script output is the single source the `hotspotGrowth` precheck reads.
