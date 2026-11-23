#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Regenerate bin/splash-scene.mjs from the plugin's scene.ts (types stripped). The installer plays this copy:
// Node refuses to strip types under node_modules, and engines allows Node 18. Needs Node >= 22.13 to run.
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const src = readFileSync(root("plugins/forgedock-splash/hooks/scene.ts"), "utf8");
const body = stripTypeScriptTypes(src, { mode: "strip" })
  .replace(/^\/\/ SPDX[^\n]*\n\/\/ SPDX[^\n]*\n/, "")
  .split("\n").map((l) => l.trimEnd()).join("\n")
  .replace(/\n{3,}/g, "\n\n");
writeFileSync(root("bin/splash-scene.mjs"), [
  "// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios",
  "// SPDX-License-Identifier: AGPL-3.0-or-later",
  "// GENERATED from plugins/forgedock-splash/hooks/scene.ts (types stripped) so `npx forgedock` can play the",
  "// startup-splash scene on any supported Node, including from node_modules where Node refuses to strip types.",
  "// Do not edit by hand: change scene.ts, then run: node scripts/gen-splash-scene.mjs",
  "// bin/tests/splash-scene-parity.test.mjs fails if the two drift.",
  body,
].join("\n"));
