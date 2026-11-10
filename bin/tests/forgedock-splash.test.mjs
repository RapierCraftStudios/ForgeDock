/**
 * bin/tests/forgedock-splash.test.mjs — forgedock-splash plugin checks under plain node:
 * parity with bin/cinema.mjs, frame bounds, glyph allowlist, settled frame,
 * undersized-band guard and marketplace listing.
 * Run with: node --test bin/tests/forgedock-splash.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HERO_MARK, CHROME_STOPS, EMBER_STOPS } from "../cinema.mjs";

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const SCENE = readFileSync(root("plugins/forgedock-splash/hooks/scene.ts"), "utf8");
const REGISTER = readFileSync(root("plugins/forgedock-splash/hooks/register.tsx"), "utf8");
const { LAST, MIN_COLUMNS, MIN_ROWS, scene, setTheme } = await import(
  "../../plugins/forgedock-splash/hooks/scene.ts"
);

const quoted = (text) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
const plain = (rows) => rows.map((r) => r.map((x) => x.text).join("")).join("\n");

describe("forgedock-splash parity with bin/cinema.mjs", () => {
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

describe("forgedock-splash scene", () => {
  it("every frame fits 56x9 and uses only common glyphs, on both themes", () => {
    const allowed = /^[\x20-\x7e▀▄█▌▐▛▜▙▟▖▗▘▝░▒▓·•*✦✧»←→↑↓╱╲─│]*$/u;
    for (const light of [false, true]) {
      setTheme(light);
      for (let f = 0; f <= LAST; f++) {
        const rows = scene(f);
        assert.ok(rows.length <= MIN_ROWS);
        for (const runs of rows) {
          const text = runs.map((r) => r.text).join("");
          assert.ok([...text].length <= MIN_COLUMNS, `frame ${f} is ${[...text].length} wide`);
          assert.match(text, allowed, `frame ${f} has an uncommon glyph: ${text}`);
        }
      }
    }
    setTheme(false);
  });
  it("settled frame has the mark, Clawd and the wordmark", () => {
    const text = plain(scene(LAST - 12));
    for (const s of ["▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄", "▐▛███▜▌", "F O R G E D O C K", "» supercharged"]) {
      assert.ok(text.includes(s), s);
    }
  });
  it("undersized bands render nothing", () => {
    assert.equal(MIN_COLUMNS, 56);
    assert.equal(MIN_ROWS, 9);
    assert.match(REGISTER, /bodyColumns < MIN_COLUMNS \|\| e\.props\.maxRows < MIN_ROWS/);
  });
});

describe("forgedock-splash marketplace listing", () => {
  it("lists both plugins and the splash source dir exists", () => {
    const mk = JSON.parse(readFileSync(root(".claude-plugin/marketplace.json"), "utf8"));
    const names = mk.plugins.map((p) => p.name);
    assert.ok(names.includes("forgedock") && names.includes("forgedock-splash"));
    const splash = mk.plugins.find((p) => p.name === "forgedock-splash");
    assert.equal(splash.source, "./plugins/forgedock-splash");
    assert.ok(existsSync(root("plugins/forgedock-splash/.claude-plugin/plugin.json")));
  });
});
