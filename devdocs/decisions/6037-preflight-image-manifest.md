# 6037: plan-time preflight resolves tools against the image manifest

- `bin/pool/image-manifest.mjs` loads `pool/image/manifest.json`; `manifestProvides` matches a tool by entry name or binary.
- `preflightProbes` (bin/lean/preflight.mjs) takes `provided(name)`; a provided command tool is skipped, not probed. lean.mjs passes the manifest.
- In the remote-sandbox miss handling (bin/lean/lean.mjs) a manifest tool never reaches `installLaneTools` or `genericInstallCommands`; a miss emits `REMOTE_TOOL_IMAGE_DEFECT` and falls to the existing host re-place path. Non-manifest tools keep the recipe, generic install, then park flow.
- `RECIPES` and the generic installer are `@deprecated` fallbacks (#6017); `installCommands`/`genericInstallCommands` return `[]` for manifest tools.
- `bin/stats/tool-parks.mjs` adds the zero-park check: `env.tool_missing` parks naming a manifest tool within 7 days fail it.
