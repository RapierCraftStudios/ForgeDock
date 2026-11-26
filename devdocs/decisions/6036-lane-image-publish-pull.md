# 6036: publish the lane image on release, pull before building, report image_version

- `.github/workflows/publish.yml` builds `pool/image` after the npm publish steps (skipped when `SKIP_PUBLISH=true`, `continue-on-error`) and pushes `ghcr.io/<owner>/forgedock-lane:<version>` and `:latest`. `LANE_IMAGE_REPO` overrides the repo.
- `bin/pool/agent.mjs` `ensureLaneImage`: local tag present, else `docker pull` of the published ref (`FORGEDOCK_LANE_REPO` overrides) retagged to `forgedock-lane:<version>`, else the local build. A pull failure never blocks; an explicit `cfg.image` skips the pull.
- `image_version` and `image_source` (present|pulled|built) are reported in capacity and the launch view; the router passes `image_version` through.
- `bin/lean/sandbox-remote.mjs` records `image_version` per launch and returns `imageVersion` from `result()`; `bin/lean/lane-audit.mjs` stamps `image_version` (null when unknown).
