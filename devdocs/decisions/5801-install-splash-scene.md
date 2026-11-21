---
status: fresh
anchor: scripts/gen-splash-scene.mjs
created: 2026-11-21
---

# ADR: the installer plays a generated JS copy of the splash scene

## Context

`npx forgedock` now opens with the forgedock-splash scene (#5801). The scene lives in `plugins/forgedock-splash/hooks/scene.ts`, which the Claude Code mod runtime loads as TypeScript. The CLI can't import it directly: `engines` allows Node 18, which has no type stripping, and newer Node refuses to strip types for files under `node_modules`, which is where `npx` runs the package from.

## Choice

- `scripts/gen-splash-scene.mjs` strips the types from `scene.ts` with `node:module` `stripTypeScriptTypes` and writes `bin/splash-scene.mjs`, a plain-JS copy with a "generated, do not edit" header. It needs Node 22.13 or later, but only at development time; the generated file runs on Node 18.
- `scene.ts` stays the single source. Change it, then run `node scripts/gen-splash-scene.mjs`.
- `bin/tests/splash-scene-parity.test.mjs` imports both and fails if any frame differs on either theme, so the two can't drift.
- `bin/journey.mjs` `introScene()` plays the copy only on interactive truecolor terminals big enough for the scene, and when neither `--fast`, `--no-splash` nor `FORGEDOCK_NO_SPLASH=1` is set. Otherwise the existing shimmer runs.

## Rejected

- **Porting the scene to `.mjs` and importing it from the plugin.** The plugin is staged to `~/.forge/splash-marketplace` on its own, without `bin/`, so it can't import across.
- **Importing `scene.ts` at runtime when type stripping is available.** That fails under `node_modules` and on Node 18 and 20. The installer would silently lose the scene for most users.
