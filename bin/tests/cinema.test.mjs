/**
 * bin/tests/cinema.test.mjs — Unit tests for bin/cinema.mjs.
 * Run with: node --test bin/tests/cinema.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  colorMode, motionEnabled, sampleGradient, gradientLine, gradientBlock,
  renderMark, HERO_MARK, COMPACT_MARK, CHROME_STOPS, EMBER_STOPS, ember,
} from "../cinema.mjs";

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

describe("colorMode", () => {
  it("returns none when not a TTY", () => {
    assert.equal(colorMode({ COLORTERM: "truecolor" }, PIPE), "none");
  });
  it("returns none when NO_COLOR is set", () => {
    assert.equal(colorMode({ NO_COLOR: "1", COLORTERM: "truecolor" }, TTY), "none");
  });
  it("returns none when TERM is dumb", () => {
    assert.equal(colorMode({ TERM: "dumb" }, TTY), "none");
  });
  it("returns truecolor when COLORTERM advertises it", () => {
    assert.equal(colorMode({ COLORTERM: "truecolor" }, TTY), "truecolor");
    assert.equal(colorMode({ COLORTERM: "24bit" }, TTY), "truecolor");
  });
  it("returns 256 for TERM=xterm-256color without COLORTERM", () => {
    assert.equal(colorMode({ TERM: "xterm-256color" }, TTY), "256");
  });
});

describe("motionEnabled", () => {
  it("false when stdout is not a TTY", () => {
    assert.equal(motionEnabled([], {}, PIPE), false);
  });
  it("false when FORGE_NO_MOTION is set", () => {
    assert.equal(motionEnabled([], { FORGE_NO_MOTION: "1" }, TTY), false);
  });
  it("false when CI is set", () => {
    assert.equal(motionEnabled([], { CI: "true" }, TTY), false);
  });
  it("false when --fast is passed", () => {
    assert.equal(motionEnabled(["--fast"], {}, TTY), false);
  });
  it("true on a plain interactive TTY", () => {
    assert.equal(motionEnabled([], {}, TTY), true);
  });
  it("NO_COLOR alone does NOT disable motion (spec: monochrome, motion intact)", () => {
    assert.equal(motionEnabled([], { NO_COLOR: "1" }, TTY), true);
  });
});

describe("gradients", () => {
  it("sampleGradient endpoints match first and last stops", () => {
    assert.deepEqual(sampleGradient(["#000000", "#ffffff"], 0), [0, 0, 0]);
    assert.deepEqual(sampleGradient(["#000000", "#ffffff"], 1), [255, 255, 255]);
  });
  it("gradientLine in none mode returns the input unchanged", () => {
    assert.equal(gradientLine("FORGE", EMBER_STOPS, "none"), "FORGE");
  });
  it("gradientLine in truecolor mode emits 38;2 codes and resets", () => {
    const out = gradientLine("AB", EMBER_STOPS, "truecolor");
    assert.match(out, /\x1b\[38;2;\d+;\d+;\d+m/);
    assert.ok(out.endsWith("\x1b[0m"));
  });
  it("gradientLine in 256 mode emits 38;5 codes, never 38;2", () => {
    const out = gradientLine("AB", EMBER_STOPS, "256");
    assert.match(out, /\x1b\[38;5;\d+m/);
    assert.doesNotMatch(out, /38;2/);
  });
  it("gradientLine leaves spaces uncolored", () => {
    const out = gradientLine(" ", EMBER_STOPS, "truecolor");
    assert.equal(out, " \x1b[0m");
  });
  it("gradientBlock returns one string per input line", () => {
    assert.equal(gradientBlock(["a", "b", "c"], CHROME_STOPS, "none").length, 3);
  });
});

describe("the mark", () => {
  it("hero mark has 8 lines, compact has 4", () => {
    assert.equal(HERO_MARK.length, 8);
    assert.equal(COMPACT_MARK.length, 4);
  });
  it("renderMark none mode equals the raw art", () => {
    assert.deepEqual(renderMark("hero", "none"), HERO_MARK);
    assert.deepEqual(renderMark("compact", "none"), COMPACT_MARK);
  });
  it("renderMark truecolor lines carry ANSI and settle with reset", () => {
    const lines = renderMark("compact", "truecolor");
    assert.equal(lines.length, 4);
    for (const l of lines) assert.match(l, /\x1b\[38;2/);
  });
  it("ember() wraps text in the ember gradient", () => {
    assert.equal(ember("X", "none"), "X");
    assert.match(ember("X", "truecolor"), /38;2/);
  });
});
