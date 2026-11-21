// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// The installer's generated scene copy must draw exactly what the plugin's scene.ts draws.
import { test } from "node:test";
import assert from "node:assert/strict";

const ts = await import("../../plugins/forgedock-splash/hooks/scene.ts");
const js = await import("../splash-scene.mjs");

test("constants match", () => {
  for (const k of ["TICK", "LAST", "MIN_COLUMNS", "MIN_ROWS"]) assert.equal(js[k], ts[k], k);
});

for (const light of [false, true]) {
  test(`every frame matches (${light ? "light" : "dark"} theme) — regenerate with: node scripts/gen-splash-scene.mjs`, () => {
    ts.setTheme(light); js.setTheme(light);
    for (let f = 0; f <= ts.LAST; f++) assert.deepEqual(js.scene(f), ts.scene(f), `frame ${f}`);
  });
}
