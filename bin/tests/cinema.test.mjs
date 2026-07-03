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

// Task 2 tests
import { shimmer, revealRows, moltenBar, fixCard } from "../cinema.mjs";

/** Minimal writable stub capturing everything written. */
function fakeWriter() {
  const chunks = [];
  return {
    chunks,
    write(s) { chunks.push(s); return true; },
    get text() { return chunks.join(""); },
  };
}

describe("shimmer", () => {
  it("without motion writes the settled block once, no cursor movement", async () => {
    const w = fakeWriter();
    await shimmer(["ABC", "DEF"], CHROME_STOPS, { mode: "none", motion: false, writer: w });
    assert.equal(w.text, "ABC\nDEF\n");
    assert.doesNotMatch(w.text, /\x1b\[\d+A/);
  });
  it("with motion ends settled and uses cursor-up (no alt screen)", async () => {
    const w = fakeWriter();
    await shimmer(["AB"], EMBER_STOPS, { mode: "truecolor", motion: true, writer: w, frames: 2, interval: 1 });
    assert.match(w.text, /\x1b\[1A/);          // in-place redraw
    assert.doesNotMatch(w.text, /\x1b\[\?1049/); // never alt-screen
  });
});

describe("revealRows", () => {
  it("without motion prints one final line per row and returns results", async () => {
    const w = fakeWriter();
    const results = await revealRows(
      [
        { label: "git", run: async () => ({ ok: true, detail: "2.45" }) },
        { label: "gh", run: async () => ({ ok: false, detail: "not found", fix: ["winget install GitHub.cli"] }) },
      ],
      { mode: "none", motion: false, writer: w },
    );
    assert.equal(results.length, 2);
    assert.match(w.text, /✔ git\s+2\.45/);
    assert.match(w.text, /✖ gh\s+not found/);
    assert.match(w.text, /winget install GitHub\.cli/); // fix card rendered
  });
  it("renders confidence badges when provided", async () => {
    const w = fakeWriter();
    await revealRows(
      [{ label: "owner/repo", run: async () => ({ ok: true, detail: "Rapier/ForgeDock", badge: "high" }) }],
      { mode: "none", motion: false, writer: w },
    );
    assert.match(w.text, /\[high\]/);
  });
});

describe("moltenBar", () => {
  it("none mode renders bracketed plain bar", () => {
    const bar = moltenBar(3, 6, { width: 6, mode: "none" });
    assert.equal(bar, "[█▓▒░░░]");
  });
  it("full bar has no empty cells", () => {
    const bar = moltenBar(6, 6, { width: 6, mode: "none" });
    assert.doesNotMatch(bar, /░/);
  });
  it("truecolor mode emits gradient codes", () => {
    assert.match(moltenBar(3, 6, { width: 6, mode: "truecolor" }), /38;2/);
  });
});

describe("fixCard", () => {
  it("boxes the fix lines", () => {
    const card = fixCard(["run: gh auth login"], "none");
    assert.match(card, /╭[─ ]*.*╮/s);
    assert.match(card, /run: gh auth login/);
  });
});
