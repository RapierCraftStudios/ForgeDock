/**
 * bin/tests/splash-scene.test.mjs — runs the same checks as
 * plugins/forgedock-splash/tests/scene.test.ts under plain node, so CI covers
 * them without the `claude plugin test` runner.
 * Run with: node --test bin/tests/splash-scene.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { LAST, MIN_COLUMNS, MIN_ROWS, scene, setTheme } = await import(
  "../../plugins/forgedock-splash/hooks/scene.ts"
);

describe("forgedock-splash scene", () => {
  it("every frame fits the smallest band, on both themes", () => {
    for (const light of [false, true]) {
      setTheme(light);
      for (let f = 0; f <= LAST; f++) {
        const rows = scene(f);
        assert.ok(rows.length <= MIN_ROWS);
        for (const runs of rows) {
          const width = runs.reduce((n, run) => n + [...run.text].length, 0);
          assert.ok(width <= MIN_COLUMNS, `frame ${f} is ${width} wide`);
        }
      }
    }
    setTheme(false);
  });
  it("settled frame has the mark, Clawd and the wordmark", () => {
    const text = scene(LAST - 12).map((r) => r.map((x) => x.text).join("")).join("\n");
    for (const s of ["▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄", "▐▛███▜▌", "F O R G E D O C K", "» supercharged"]) {
      assert.ok(text.includes(s), s);
    }
  });
});
