/**
 * bin/tests/splash-parity.test.mjs — keeps the forgedock-splash plugin's copy of
 * the F mark and brand stops in sync with bin/cinema.mjs.
 * Run with: node --test bin/tests/splash-parity.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HERO_MARK, CHROME_STOPS, EMBER_STOPS } from "../cinema.mjs";

const SCENE = readFileSync(
  fileURLToPath(new URL("../../plugins/forgedock-splash/hooks/scene.ts", import.meta.url)),
  "utf8",
);

const quoted = (text) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

describe("forgedock-splash scene parity with bin/cinema.mjs", () => {
  it("MARK rows equal HERO_MARK", () => {
    const body = SCENE.match(/const MARK = \[([\s\S]*?)\n\]/)[1];
    assert.deepEqual(quoted(body), HERO_MARK);
  });
  it("dark palette chrome stops equal CHROME_STOPS", () => {
    const m = SCENE.match(/const DARK = \{ chrome: \[([^\]]*)\]/);
    assert.deepEqual(quoted(m[1]), CHROME_STOPS);
  });
  it("dark palette ember stops equal EMBER_STOPS", () => {
    const m = SCENE.match(/const DARK = \{[^\n]*ember: \[([^\]]*)\]/);
    assert.deepEqual(quoted(m[1]), EMBER_STOPS);
  });
});
