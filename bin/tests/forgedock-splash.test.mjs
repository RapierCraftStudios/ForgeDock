/**
 * bin/tests/forgedock-splash.test.mjs — Tests for plugins/forgedock-splash.
 * Run with: node --test bin/tests/forgedock-splash.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { CHROME_STOPS, EMBER_STOPS, HERO_MARK } from "../cinema.mjs";
import * as scene from "../../plugins/forgedock-splash/hooks/scene.mjs";

const root = new URL("../../", import.meta.url);
const json = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));

describe("mark parity with bin/cinema.mjs", () => {
  it("uses the same art and brand stops", () => {
    assert.deepEqual(scene.SPLASH_MARK, HERO_MARK);
    assert.deepEqual(scene.SPLASH_CHROME_STOPS, CHROME_STOPS);
    assert.deepEqual(scene.SPLASH_EMBER_STOPS, EMBER_STOPS);
  });
});

describe("scene", () => {
  for (const theme of ["dark", "light"]) {
    it(`every ${theme} frame fits the band and uses only allowed glyphs`, () => {
      for (let ms = 0; ms <= scene.DURATION_MS + 100; ms += 50) {
        const f = scene.frame(ms, theme);
        assert.equal(f.cells.length, scene.HEIGHT);
        for (const row of f.cells) assert.equal(row.length, scene.WIDTH);
        for (const line of scene.frameText(f)) {
          for (const ch of line) assert.ok(scene.GLYPHS.has(ch), `glyph ${JSON.stringify(ch)} at ${ms}ms`);
        }
      }
    });
    it(`the settled ${theme} frame has the mark, Clawd and the wordmark`, () => {
      const text = scene.frameText(scene.frame(5500, theme)).join("\n");
      for (const line of HERO_MARK) assert.ok(text.includes(line.trim()), line);
      assert.ok(text.includes("▐█▀█▀█▌"));
      assert.ok(text.includes("F O R G E D O C K"));
      assert.ok(text.includes("» supercharged"));
    });
  }
  it("clears at the end", () => {
    assert.equal(scene.frameText(scene.frame(scene.DURATION_MS)).join("").trim(), "");
  });
  it("types the wordmark in progressively", () => {
    assert.ok(!scene.frameText(scene.frame(3000)).join("\n").includes("F O R G E"));
    assert.ok(scene.frameText(scene.frame(3800)).join("\n").includes("F O R G E"));
  });
  it("the light theme uses darker colours than the dark one on the mark", () => {
    const lum = (hex) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    const cell = (theme) => scene.frame(2450, theme).cells[3].find((c) => c && c.ch === "█");
    assert.ok(lum(cell("light").rgb) < lum(cell("dark").rgb));
  });
  it("fits() skips bands under 56x9 and trusts unknown sizes", () => {
    assert.equal(scene.fits(55, 12), false);
    assert.equal(scene.fits(80, 8), false);
    assert.equal(scene.fits(56, 9), true);
    assert.equal(scene.fits(undefined, undefined), true);
  });
  it("themeOf maps light themes to light", () => {
    assert.equal(scene.themeOf("light-ansi"), "light");
    assert.equal(scene.themeOf("dark"), "dark");
    assert.equal(scene.themeOf(undefined), "dark");
  });
});

describe("marketplace wiring", () => {
  it("lists the main plugin and the splash plugin, whose source exists", () => {
    const names = json(".claude-plugin/marketplace.json").plugins.map((p) => p.name);
    assert.deepEqual(names, ["forgedock", "forgedock-splash"]);
    const splash = json(".claude-plugin/marketplace.json").plugins[1];
    assert.ok(existsSync(new URL(`${splash.source}/.claude-plugin/plugin.json`, root)));
    assert.equal(json("plugins/forgedock-splash/.claude-plugin/plugin.json").name, "forgedock-splash");
  });
  it("the main plugin does not reference the splash or its API", () => {
    assert.ok(!readFileSync(new URL(".claude-plugin/plugin.json", root), "utf8").includes("splash"));
  });
});
