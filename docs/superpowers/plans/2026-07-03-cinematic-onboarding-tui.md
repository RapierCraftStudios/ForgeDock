# Cinematic Onboarding TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `npx forgedock` into one continuous cinematic onboarding journey (preflight → install → detect → review → celebrate), wire the dormant SessionStart hook / registry / annotated-review modules into the CLI, and make every doc claim true.

**Architecture:** Two new zero-dependency modules — `bin/cinema.mjs` (gradients, block-art mark, motion primitives) and `bin/journey.mjs` (five act functions orchestrating the existing `init-detect.mjs`, `init-enrich-api.mjs`, `annotatedReviewScreen`, `registry.mjs`) — plus a new `bin/settings-hook.mjs` for idempotent `~/.claude/settings.json` hook merging. `bin/forgedock.mjs` shrinks to a router.

**Tech Stack:** Node.js ≥18 built-ins only (no npm dependencies). Tests: `node --test` (existing suite in `bin/tests/`).

**Spec:** `docs/superpowers/specs/2026-07-03-cinematic-onboarding-tui-design.md` — read it before starting.

## Global Constraints

- **Zero npm dependencies.** Node built-ins only, ESM (`.mjs`).
- **Node ≥18** (`engines` in package.json).
- **No alternate screen buffer.** Animations redraw in place with cursor-up (`\x1b[NA`) while active, then settle to static lines. Scrollback must hold a plain receipt.
- **Color vs motion are independent gates.** `NO_COLOR`/non-TTY/`TERM=dumb` → no ANSI color. Non-TTY/`FORGE_NO_MOTION=1`/`CI`/`--fast` → no animation frames. `NO_COLOR` alone keeps motion (per spec degradation ladder).
- **Palette:** chrome stops `#f7f3ea #d9cfba #a99a82 #6e6252`; ember stops `#ff4d00 #ff8c1a #ffd166`.
- **Windows is first-class.** Never assume `HOME` alone: use `process.env.HOME || process.env.USERPROFILE || os.homedir()`. Never split paths on `/` — use `path.basename`.
- **Never a dead stop:** preflight failures print a fix card and continue; degraded steps are stated inline and echoed in the final receipt.
- **Filesystem safety:** existing forge.yaml is backed up before overwrite; `settings.json` merge is read-modify-write with a malformed-JSON guard (skip + warn, never clobber); non-TTY overwrite of an existing forge.yaml aborts.
- **Commits:** every commit uses `git commit -s` (DCO sign-off required). Never add AI attribution lines.
- **Run the full suite** (`npm test`) before every commit; all existing tests must stay green.
- **Ship version: 1.1.0** in both `package.json` and `.claude-plugin/plugin.json`.

## File Structure

| File | Responsibility |
| --- | --- |
| `bin/cinema.mjs` (create) | Color-mode/motion detection, gradient rendering, the block-art F mark, shimmer/reveal/progress primitives. Pure presentation; no business logic. |
| `bin/settings-hook.mjs` (create) | Idempotent install/remove of the SessionStart hook entry in `~/.claude/settings.json`. |
| `bin/journey.mjs` (create) | The five acts (`preflight`, `forge`, `read`, `review`, `celebrate`), `runJourney`, ConfigDraft→forge.yaml writer, description detection (moved from forgedock.mjs). |
| `bin/forgedock.mjs` (modify) | Thin router: flag parsing, HOME fallback, command dispatch, `enable`/`disable`/`status`, uninstall hook removal. The inline `init()` template and `install()` body move to journey.mjs. |
| `bin/tui.mjs` (modify) | `annotatedReviewScreen` gains `opts.extraFields` (surfacing the detected description) and the prompt copy becomes "Press Enter to forge…". Nothing else changes. |
| `bin/tests/cinema.test.mjs`, `bin/tests/settings-hook.test.mjs`, `bin/tests/journey.test.mjs`, `bin/tests/router.test.mjs` (create) | Unit tests per module. |
| `README.md`, `docs/site/getting-started.md`, `docs/CONFIG.md`, `package.json`, `.claude-plugin/plugin.json` (modify) | Docs truth-pass + version 1.1.0. |

Existing modules consumed as-is (do NOT modify): `bin/init-detect.mjs` (`detectConfig(cwd) → ConfigDraft`), `bin/init-enrich-api.mjs` (`enrich(draft)`), `bin/registry.mjs` (`resolveState(dir)`, `setOptOut(dir, bool)`), `bin/hooks/session-start.mjs`, `bin/forge-utils.mjs`.

**Test convention** (copy from `bin/tests/registry.test.mjs`): `node:test` + `assert/strict`; modules that read env at load time are imported freshly via `pathToFileURL(...)` with a cache-busting `?_t=` param. `cinema.mjs` and `journey.mjs` must therefore take `env`/`stdout`/`argv` as *parameters* (with `process.*` defaults) so tests never need cache-busting.

---

### Task 1: cinema.mjs — modes, gradients, the mark

**Files:**
- Create: `bin/cinema.mjs`
- Test: `bin/tests/cinema.test.mjs`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 2, 5–9):
  - `colorMode(env?, stdout?) → 'truecolor' | '256' | 'none'`
  - `motionEnabled(argv?, env?, stdout?) → boolean`
  - `CHROME_STOPS: string[]`, `EMBER_STOPS: string[]`
  - `sampleGradient(stops, t) → [r,g,b]`
  - `gradientLine(text, stops, mode, phase?) → string` (ANSI-colored, `\x1b[0m`-terminated; plain text when mode `'none'`)
  - `gradientBlock(lines, stops, mode) → string[]` (diagonal: phase shifts per row)
  - `HERO_MARK: string[]` (8 lines), `COMPACT_MARK: string[]` (4 lines)
  - `renderMark(size, mode) → string[]` (`size` = `'hero' | 'compact'`, chrome gradient)
  - `ember(text, mode) → string` (ember gradient shorthand)
  - `sleep(ms) → Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `bin/tests/cinema.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/cinema.test.mjs`
Expected: FAIL — `Cannot find module '.../bin/cinema.mjs'`

- [ ] **Step 3: Write the implementation**

Create `bin/cinema.mjs`:

```js
/**
 * bin/cinema.mjs — Cinematic rendering primitives for ForgeDock's TUI.
 *
 * Zero-dependency. Pure presentation: gradients, the block-art F mark, and
 * (in Task 2) shimmer / reveal / progress animation primitives.
 *
 * Two independent gates (spec: degradation ladder):
 *   colorMode()     — 'truecolor' | '256' | 'none'  (NO_COLOR, TTY, TERM)
 *   motionEnabled() — animation frames on/off        (TTY, FORGE_NO_MOTION, CI, --fast)
 *
 * All functions take env/stdout/argv as parameters (with process defaults)
 * so tests never need module-cache busting.
 */

// ---------------------------------------------------------------------------
// Palette (spec: Chrome & Ember)
// ---------------------------------------------------------------------------

export const CHROME_STOPS = ["#f7f3ea", "#d9cfba", "#a99a82", "#6e6252"];
export const EMBER_STOPS = ["#ff4d00", "#ff8c1a", "#ffd166"];

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/**
 * Decide the color capability of the terminal.
 * @returns {'truecolor'|'256'|'none'}
 */
export function colorMode(env = process.env, stdout = process.stdout) {
  if (stdout.isTTY !== true) return "none";
  if (env.NO_COLOR) return "none";
  if (env.TERM === "dumb") return "none";
  const ct = (env.COLORTERM || "").toLowerCase();
  if (ct.includes("truecolor") || ct.includes("24bit")) return "truecolor";
  if ((env.TERM || "").includes("256")) return "256";
  // Windows Terminal / modern conhost support truecolor but don't set COLORTERM.
  if (process.platform === "win32") return "truecolor";
  return "256";
}

/**
 * Decide whether animation frames run. Independent of color:
 * NO_COLOR keeps motion (monochrome choreography); non-TTY/CI/--fast kill it.
 * @returns {boolean}
 */
export function motionEnabled(
  argv = process.argv,
  env = process.env,
  stdout = process.stdout,
) {
  if (stdout.isTTY !== true) return false;
  if (env.FORGE_NO_MOTION) return false;
  if (env.CI) return false;
  if (argv.includes("--fast")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Gradient math
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Sample a multi-stop gradient at position t ∈ [0,1].
 * @returns {[number, number, number]} RGB triple.
 */
export function sampleGradient(stops, t) {
  const rgb = stops.map(hexToRgb);
  const clamped = Math.min(Math.max(t, 0), 1);
  const seg = Math.min(Math.floor(clamped * (rgb.length - 1)), rgb.length - 2);
  const localT = clamped * (rgb.length - 1) - seg;
  const [a, b] = [rgb[seg], rgb[seg + 1]];
  const mix = (x, y) => Math.round(x + (y - x) * localT);
  return [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])];
}

/** Quantize an RGB triple to the xterm-256 6×6×6 color cube. */
function to256([r, g, b]) {
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Foreground escape for an RGB triple in the given mode ('' for none). */
function fg(rgb, mode) {
  if (mode === "none") return "";
  if (mode === "256") return `\x1b[38;5;${to256(rgb)}m`;
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

/**
 * Render one line of text with a per-character horizontal gradient.
 * Spaces stay uncolored. `phase` shifts the gradient start (for diagonals).
 * In 'none' mode returns the input text verbatim (no reset appended).
 */
export function gradientLine(text, stops, mode, phase = 0) {
  if (mode === "none") return text;
  const chars = [...text];
  const n = Math.max(chars.length - 1, 1);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === " ") {
      out += " ";
      continue;
    }
    const t = Math.min(i / n + phase, 1);
    out += fg(sampleGradient(stops, t), mode) + chars[i];
  }
  return out + "\x1b[0m";
}

/**
 * Render a block of lines with a diagonal gradient (each row's phase shifts
 * slightly, approximating the logo's 135° gradient).
 * @returns {string[]}
 */
export function gradientBlock(lines, stops, mode) {
  return lines.map((line, row) => gradientLine(line, stops, mode, row * 0.06));
}

// ---------------------------------------------------------------------------
// The mark — block-art interpretation of the ForgeDock "F" (design approved
// from the 2026-07-03 brainstorm mockups; geometry may be pixel-tuned).
// ---------------------------------------------------------------------------

export const HERO_MARK = [
  "            ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
  "        ▄▄██████████████████",
  "     ▄█████████████▀▀▀▀▀▀▀▀▀",
  "   ▄██████████▀▀",
  "    ▀▀▀▀▀  ▄▄███████▀",
  "        ▄████████▀",
  "      ▄██████▀",
  "       ▀▀▀▀",
];

export const COMPACT_MARK = [
  "   ▄▄████████",
  " ▄█████▀▀▀▀▀",
  " ▀▀ ▄████▀",
  "   ▀▀▀",
];

/**
 * Render the chrome-gradient mark.
 * @param {'hero'|'compact'} size
 * @param {'truecolor'|'256'|'none'} mode
 * @returns {string[]}
 */
export function renderMark(size, mode) {
  const art = size === "hero" ? HERO_MARK : COMPACT_MARK;
  if (mode === "none") return [...art];
  return gradientBlock(art, CHROME_STOPS, mode);
}

/** Ember-gradient text shorthand (wordmarks, act headers). */
export function ember(text, mode) {
  return gradientLine(text, EMBER_STOPS, mode);
}

/** Promise-based sleep for animation pacing. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/cinema.test.mjs`
Expected: PASS (all describe blocks). Also run `npm test` — existing suite stays green.

- [ ] **Step 5: Commit**

```bash
git add bin/cinema.mjs bin/tests/cinema.test.mjs
git commit -s -m "feat(cinema): color/motion gates, gradient renderer, block-art mark"
```

---

### Task 2: cinema.mjs — shimmer, reveal rows, molten progress

**Files:**
- Modify: `bin/cinema.mjs` (append)
- Test: `bin/tests/cinema.test.mjs` (append)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces (used by Tasks 5–9):
  - `shimmer(lines, stops, { mode, motion, writer?, frames?, interval? }) → Promise<void>` — animated highlight sweep, settles to `gradientBlock` output; with `motion: false` writes the settled block immediately.
  - `revealRows(rows, { mode, motion, writer?, minDisplayMs? }) → Promise<results[]>` — `rows: [{ label, run: async () => ({ ok, detail?, fix?, badge? }) }]`. Renders `✔ label  detail` / `✖ label  detail` (+ fix-card box lines when `fix` present, + `[high]/[med]/[low]` badge when `badge` present). Returns the array of results.
  - `moltenBar(current, total, { width?, mode }) → string` — one static frame: ember-gradient `█…▓▒` fill + dim `░` rest.
  - `fixCard(lines, mode) → string` — ember-bordered box (wraps `tui.box`).

- [ ] **Step 1: Write the failing tests**

Append to `bin/tests/cinema.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/cinema.test.mjs`
Expected: FAIL — `shimmer` etc. not exported.

- [ ] **Step 3: Write the implementation**

Append to `bin/cinema.mjs`:

```js
// ---------------------------------------------------------------------------
// Animation primitives (Task 2)
// ---------------------------------------------------------------------------

import { box, stripAnsi } from "./tui.mjs";

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Ember-tinted status glyph for a result row. */
function statusGlyph(ok, mode) {
  if (mode === "none") return ok ? "✔" : "✖";
  const rgb = ok ? [255, 179, 71] : [224, 112, 80]; // amber / ember-red
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${ok ? "✔" : "✖"}\x1b[0m`;
}

/** Dim wrapper honoring the mode gate. */
function dimText(s, mode) {
  return mode === "none" ? s : `\x1b[2m${s}\x1b[22m`;
}

/** Badge like [high] / [med] / [low], colorized per confidence. */
function badgeText(badge, mode) {
  const label = badge === "medium" ? "med" : badge;
  if (mode === "none") return `[${label}]`;
  const rgb = badge === "high" ? [125, 219, 132] : badge === "medium" ? [232, 192, 96] : [224, 112, 80];
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m[${label}]\x1b[0m`;
}

/** Ember-bordered fix card (wraps tui.box; border color applied when able). */
export function fixCard(lines, mode) {
  const boxed = box(lines.map((l) => ` ${l} `), { title: "fix" });
  if (mode === "none") return boxed;
  return boxed
    .split("\n")
    .map((l) => l.replace(/^([╭╰│]|\s*[╭╰│])/u, (m) => `\x1b[38;2;255;107;53m${m}\x1b[0m`))
    .join("\n");
}

function formatRow(label, res, mode) {
  const parts = [`  ${statusGlyph(res.ok, mode)} ${label.padEnd(16)}`];
  if (res.detail) parts.push(dimText(String(res.detail), mode));
  if (res.badge) parts.push(badgeText(res.badge, mode));
  return parts.join("  ");
}

/**
 * Reveal rows one at a time: spinner while `run()` is in flight, settling to
 * a ✔/✖ line (+ optional fix card). Without motion: run, print final line.
 * Every row's `run` executes regardless of motion — this is display-only.
 */
export async function revealRows(
  rows,
  { mode, motion, writer = process.stdout, interval = 80, minDisplayMs = 120 } = {},
) {
  const results = [];
  for (const row of rows) {
    let res;
    if (!motion) {
      res = await row.run();
    } else {
      let frame = 0;
      writer.write(`  \x1b[38;2;255;107;53m${BRAILLE[0]}\x1b[0m ${row.label}\n`);
      const timer = setInterval(() => {
        frame = (frame + 1) % BRAILLE.length;
        writer.write(`\x1b[1A\x1b[2K  \x1b[38;2;255;107;53m${BRAILLE[frame]}\x1b[0m ${row.label}\n`);
      }, interval);
      const started = Date.now();
      try {
        res = await row.run();
        const elapsed = Date.now() - started;
        if (elapsed < minDisplayMs) await sleep(minDisplayMs - elapsed);
      } finally {
        clearInterval(timer);
      }
      writer.write("\x1b[1A\x1b[2K");
    }
    writer.write(formatRow(row.label, res, mode) + "\n");
    if (!res.ok && res.fix && res.fix.length > 0) {
      writer.write(fixCard(res.fix, mode) + "\n");
    }
    results.push(res);
  }
  return results;
}

/**
 * One-pass highlight sweep over gradient block art, settling to the static
 * gradientBlock render. In-place redraw via cursor-up; never alt-screen.
 */
export async function shimmer(
  lines,
  stops,
  { mode, motion, writer = process.stdout, frames = 14, interval = 55 } = {},
) {
  const settled = gradientBlock(lines, stops, mode);
  if (!motion || mode === "none") {
    writer.write(settled.join("\n") + "\n");
    return;
  }
  const width = Math.max(...lines.map((l) => l.length));
  for (let f = 0; f <= frames; f++) {
    const band = (f / frames) * (width + 16) - 8;
    const frameLines = lines.map((line, row) => {
      const chars = [...line];
      let out = "";
      for (let i = 0; i < chars.length; i++) {
        if (chars[i] === " ") {
          out += " ";
          continue;
        }
        const t = Math.min(i / Math.max(chars.length - 1, 1) + row * 0.06, 1);
        let rgb = sampleGradient(stops, t);
        const dist = Math.abs(i - band + row * 1.5);
        if (dist < 6) {
          const boost = 1 - dist / 6;
          rgb = rgb.map((v) => Math.round(v + (255 - v) * boost));
        }
        out += `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${chars[i]}`;
      }
      return out + "\x1b[0m";
    });
    if (f > 0) writer.write(`\x1b[${lines.length}A`);
    writer.write(frameLines.join("\n") + "\n");
    await sleep(interval);
  }
  writer.write(`\x1b[${lines.length}A`);
  writer.write(settled.join("\n") + "\n");
}

/**
 * One static frame of the molten progress bar: solid fill with a ▓▒ leading
 * edge and dim ░ remainder. Caller redraws with cursor-up for animation.
 */
export function moltenBar(current, total, { width = 24, mode } = {}) {
  const ratio = total === 0 ? 1 : Math.min(current / total, 1);
  const filled = Math.round(ratio * width);
  const solidLen = Math.max(filled - 2, 0);
  const edge = "▓▒".slice(0, filled - solidLen);
  const body = "█".repeat(solidLen) + edge;
  const rest = "░".repeat(Math.max(width - filled, 0));
  if (mode === "none") return `[${body}${rest}]`;
  return gradientLine(body, EMBER_STOPS, mode) + dimText(rest, mode);
}
```

Note: `stripAnsi` is imported for future width math in journey; if the linter flags it unused here, drop it from the import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/cinema.test.mjs` → PASS. Then `npm test` → all green.

- [ ] **Step 5: Visual smoke check (eyeball only, no assert)**

Run: `node -e "import('./bin/cinema.mjs').then(async c => { await c.shimmer(c.HERO_MARK, c.CHROME_STOPS, { mode: 'truecolor', motion: true }); console.log(c.ember('F O R G E D O C K', 'truecolor')); console.log(c.moltenBar(18, 24, { mode: 'truecolor' })); })"`
Expected: chrome mark sweeps once and settles; ember wordmark; molten bar. (Run in Windows Terminal, not a piped shell.)

- [ ] **Step 6: Commit**

```bash
git add bin/cinema.mjs bin/tests/cinema.test.mjs
git commit -s -m "feat(cinema): shimmer, reveal rows, molten progress, fix cards"
```

---

### Task 3: settings-hook.mjs — idempotent SessionStart hook merge

**Files:**
- Create: `bin/settings-hook.mjs`
- Test: `bin/tests/settings-hook.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 6, 8):
  - `installSessionStartHook(settingsPath, hookScriptPath) → { status: 'installed' | 'already' | 'skipped-malformed' }`
  - `removeSessionStartHook(settingsPath) → { status: 'removed' | 'absent' | 'skipped-malformed' }`
  - Our entry is identified by its command containing `bin/hooks/session-start.mjs` (marker substring `HOOK_MARKER`).

- [ ] **Step 1: Write the failing tests**

Create `bin/tests/settings-hook.test.mjs`:

```js
/**
 * bin/tests/settings-hook.test.mjs — Unit tests for bin/settings-hook.mjs.
 * Run with: node --test bin/tests/settings-hook.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { installSessionStartHook, removeSessionStartHook } from "../settings-hook.mjs";

const HOOK_SCRIPT = "C:/fake/forgedock/bin/hooks/session-start.mjs";

let dir, settingsPath;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "fd-hook-"));
  settingsPath = join(dir, "settings.json");
});

describe("installSessionStartHook", () => {
  it("creates settings.json with the hook when absent", () => {
    const res = installSessionStartHook(settingsPath, HOOK_SCRIPT);
    assert.equal(res.status, "installed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const cmds = JSON.stringify(parsed.hooks.SessionStart);
    assert.match(cmds, /session-start\.mjs/);
  });

  it("is idempotent — second run reports already, no duplicate entry", () => {
    installSessionStartHook(settingsPath, HOOK_SCRIPT);
    const res = installSessionStartHook(settingsPath, HOOK_SCRIPT);
    assert.equal(res.status, "already");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const matches = JSON.stringify(parsed).match(/session-start\.mjs/g);
    assert.equal(matches.length, 1);
  });

  it("preserves unrelated hooks and settings keys", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "opus",
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }], Stop: [] },
      }),
      "utf-8",
    );
    installSessionStartHook(settingsPath, HOOK_SCRIPT);
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(parsed.model, "opus");
    assert.ok(Array.isArray(parsed.hooks.Stop));
    assert.equal(parsed.hooks.SessionStart.length, 2); // existing + ours
    assert.match(JSON.stringify(parsed.hooks.SessionStart[0]), /echo hi/);
  });

  it("skips (never clobbers) malformed JSON", () => {
    writeFileSync(settingsPath, "{ not json !!", "utf-8");
    const res = installSessionStartHook(settingsPath, HOOK_SCRIPT);
    assert.equal(res.status, "skipped-malformed");
    assert.equal(readFileSync(settingsPath, "utf-8"), "{ not json !!");
  });
});

describe("removeSessionStartHook", () => {
  it("removes only our entry", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
      "utf-8",
    );
    installSessionStartHook(settingsPath, HOOK_SCRIPT);
    const res = removeSessionStartHook(settingsPath);
    assert.equal(res.status, "removed");
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    assert.equal(parsed.hooks.SessionStart.length, 1);
    assert.match(JSON.stringify(parsed.hooks.SessionStart[0]), /echo hi/);
  });

  it("reports absent when file or entry missing", () => {
    assert.equal(removeSessionStartHook(settingsPath).status, "absent");
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }), "utf-8");
    assert.equal(removeSessionStartHook(settingsPath).status, "absent");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/settings-hook.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `bin/settings-hook.mjs`:

```js
/**
 * bin/settings-hook.mjs — Idempotent SessionStart hook registration in
 * ~/.claude/settings.json.
 *
 * Contract (spec: "Hook wiring"):
 *   - Read-modify-write; unrelated keys and hooks preserved verbatim
 *   - Our entry identified by HOOK_MARKER in its command string
 *   - Malformed JSON → skip and report, NEVER overwrite the file
 *   - Absolute hook script path baked in at install time
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";

/** Substring identifying ForgeDock's own hook entry. */
export const HOOK_MARKER = "session-start.mjs";

function isOurs(entry) {
  return JSON.stringify(entry).includes(HOOK_MARKER);
}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return { settings: {}, fresh: true };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { settings: parsed, fresh: false };
  } catch {
    return null; // malformed — caller must not write
  }
}

function writeSettings(settingsPath, settings) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = settingsPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  renameSync(tmp, settingsPath);
}

/**
 * Merge ForgeDock's SessionStart hook into settings.json.
 * @param {string} settingsPath - Absolute path to ~/.claude/settings.json
 * @param {string} hookScriptPath - Absolute path to bin/hooks/session-start.mjs
 * @returns {{ status: 'installed'|'already'|'skipped-malformed' }}
 */
export function installSessionStartHook(settingsPath, hookScriptPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings } = read;

  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const list = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  if (list.some(isOurs)) return { status: "already" };

  list.push({
    hooks: [
      {
        type: "command",
        command: `node "${hookScriptPath}"`,
      },
    ],
  });
  settings.hooks.SessionStart = list;
  writeSettings(settingsPath, settings);
  return { status: "installed" };
}

/**
 * Remove ForgeDock's SessionStart hook entry; leaves everything else alone.
 * @returns {{ status: 'removed'|'absent'|'skipped-malformed' }}
 */
export function removeSessionStartHook(settingsPath) {
  const read = readSettings(settingsPath);
  if (read === null) return { status: "skipped-malformed" };
  const { settings, fresh } = read;
  if (fresh) return { status: "absent" };

  const list = settings.hooks && Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart
    : [];
  const kept = list.filter((e) => !isOurs(e));
  if (kept.length === list.length) return { status: "absent" };

  settings.hooks.SessionStart = kept;
  writeSettings(settingsPath, settings);
  return { status: "removed" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/settings-hook.test.mjs` → PASS. `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add bin/settings-hook.mjs bin/tests/settings-hook.test.mjs
git commit -s -m "feat(hook): idempotent SessionStart merge into settings.json"
```

---

### Task 4: journey.mjs — forge.yaml writer + backup (single source of truth)

**Files:**
- Create: `bin/journey.mjs`
- Test: `bin/tests/journey.test.mjs`

**Interfaces:**
- Consumes: nothing yet (pure functions).
- Produces (used by Tasks 7–9):
  - `writeForgeYaml(values, lowConfidenceKeys, outputPath) → { todoCount }` — `values` is exactly the object `annotatedReviewScreen` resolves with (`owner, repo, name, description, root, worktreeBase, defaultBranch, stagingBranch`); low-confidence fields get a trailing `# TODO(forgedock:<key>) — verify this value` comment.
  - `backupExisting(outputPath) → { backupName } | null` — renames an existing file to `forge.yaml.bak` (or timestamped variant); returns null when nothing existed. Uses `path.basename` (fixes the current `split("/")` Windows bug in forgedock.mjs:485).
  - `detectDescription(cwd) → { value: string, source: 'README.md'|'CLAUDE.md'|'' }` — first-paragraph extraction moved verbatim from forgedock.mjs:363-455 (README then CLAUDE.md fallback; strips links/bold/inline code; 200 chars).

- [ ] **Step 1: Write the failing tests**

Create `bin/tests/journey.test.mjs`:

```js
/**
 * bin/tests/journey.test.mjs — Unit tests for bin/journey.mjs.
 * Run with: node --test bin/tests/journey.test.mjs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { writeForgeYaml, backupExisting, detectDescription } from "../journey.mjs";

const VALUES = {
  owner: "RapierCraftStudios",
  repo: "ForgeDock",
  name: "Forge Dock",
  description: 'Turn a "GitHub issue" into a merged PR',
  root: "C:\\proj\\ForgeDock",
  worktreeBase: "C:\\proj\\ForgeDock\\.claude\\worktrees",
  defaultBranch: "main",
  stagingBranch: "staging",
};

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "fd-journey-"));
});

describe("writeForgeYaml", () => {
  it("writes required sections with the given values", () => {
    const out = join(dir, "forge.yaml");
    const res = writeForgeYaml(VALUES, [], out);
    const yaml = readFileSync(out, "utf-8");
    assert.match(yaml, /owner: "RapierCraftStudios"/);
    assert.match(yaml, /repo: "ForgeDock"/);
    assert.match(yaml, /default: "main"/);
    assert.match(yaml, /staging: "staging"/);
    assert.equal(res.todoCount, 0);
  });
  it("escapes quotes and backslashes", () => {
    const out = join(dir, "forge.yaml");
    writeForgeYaml(VALUES, [], out);
    const yaml = readFileSync(out, "utf-8");
    assert.match(yaml, /Turn a \\"GitHub issue\\"/);
    assert.match(yaml, /C:\\\\proj\\\\ForgeDock/);
  });
  it("flags low-confidence keys with TODO comments and counts them", () => {
    const out = join(dir, "forge.yaml");
    const res = writeForgeYaml(VALUES, ["owner", "stagingBranch"], out);
    const yaml = readFileSync(out, "utf-8");
    assert.match(yaml, /owner: "RapierCraftStudios"\s+# TODO\(forgedock:owner\)/);
    assert.match(yaml, /staging: "staging"\s+# TODO\(forgedock:stagingBranch\)/);
    assert.equal(res.todoCount, 2);
  });
});

describe("backupExisting", () => {
  it("returns null when the file does not exist", () => {
    assert.equal(backupExisting(join(dir, "forge.yaml")), null);
  });
  it("renames to forge.yaml.bak and returns basename (no slash-split bug)", () => {
    const out = join(dir, "forge.yaml");
    writeFileSync(out, "x", "utf-8");
    const res = backupExisting(out);
    assert.equal(res.backupName, "forge.yaml.bak");
    assert.ok(existsSync(join(dir, "forge.yaml.bak")));
    assert.ok(!existsSync(out));
  });
  it("timestamps the backup when forge.yaml.bak already exists", () => {
    writeFileSync(join(dir, "forge.yaml"), "x", "utf-8");
    writeFileSync(join(dir, "forge.yaml.bak"), "old", "utf-8");
    const res = backupExisting(join(dir, "forge.yaml"));
    assert.match(res.backupName, /^forge\.yaml\.bak\..+/);
  });
});

describe("detectDescription", () => {
  it("extracts the first README paragraph, stripping markdown", () => {
    writeFileSync(
      join(dir, "README.md"),
      "# Title\n\n**Turn** a [GitHub issue](https://x) into a `merged PR`.\n\nMore.\n",
      "utf-8",
    );
    const res = detectDescription(dir);
    assert.equal(res.value, "Turn a GitHub issue into a merged PR.");
    assert.equal(res.source, "README.md");
  });
  it("falls back to CLAUDE.md, then empty", () => {
    assert.deepEqual(detectDescription(dir), { value: "", source: "" });
    writeFileSync(join(dir, "CLAUDE.md"), "# T\n\nProject brain.\n", "utf-8");
    assert.deepEqual(detectDescription(dir), { value: "Project brain.", source: "CLAUDE.md" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/journey.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `bin/journey.mjs`:

```js
/**
 * bin/journey.mjs — The five-act onboarding journey for ForgeDock.
 *
 * Acts (added across Tasks 4–8):
 *   preflight() → forge() → read() → review() → celebrate()
 *
 * This file owns forge.yaml generation (single source of truth, driven from
 * detection values) and orchestrates the existing modules:
 *   init-detect.mjs, init-enrich-api.mjs, tui.annotatedReviewScreen, registry.mjs
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join, basename } from "path";

// ---------------------------------------------------------------------------
// forge.yaml generation (Task 4)
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Append the TODO flag for a low-confidence field. */
function todo(key, low) {
  return low.includes(key) ? `  # TODO(forgedock:${key}) — verify this value` : "";
}

/**
 * Write forge.yaml from reviewed values.
 * @param {{owner:string,repo:string,name:string,description:string,root:string,
 *          worktreeBase:string,defaultBranch:string,stagingBranch:string}} v
 *   Exactly the object annotatedReviewScreen resolves with.
 * @param {string[]} lowConfidenceKeys - keys to flag with # TODO comments.
 * @param {string} outputPath
 * @returns {{ todoCount: number }}
 */
export function writeForgeYaml(v, lowConfidenceKeys, outputPath) {
  const low = lowConfidenceKeys;
  const content = `# forge.yaml — ForgeDock Configuration
#
# Auto-generated by: npx forgedock
# Fields flagged # TODO(forgedock:<field>) were guessed — verify them.
#
# Required sections: project, paths, branches
# Optional sections: repos, project_board, services, review, verification
#
# See docs/CONFIG.md for full reference.

# =============================================================================
# PROJECT (REQUIRED)
# =============================================================================

project:
  name: "${esc(v.name)}"${todo("name", low)}
  owner: "${esc(v.owner)}"${todo("owner", low)}
  repo: "${esc(v.repo)}"${todo("repo", low)}
  description: "${esc(v.description)}"${todo("description", low)}

# =============================================================================
# PATHS (REQUIRED)
# =============================================================================

paths:
  root: "${esc(v.root)}"${todo("root", low)}
  worktree_base: "${esc(v.worktreeBase)}"${todo("worktreeBase", low)}

# =============================================================================
# BRANCHES (REQUIRED)
# =============================================================================

branches:
  default: "${esc(v.defaultBranch)}"${todo("defaultBranch", low)}
  staging: "${esc(v.stagingBranch)}"${todo("stagingBranch", low)}
  feature_pattern: "milestone/{slug}"

# =============================================================================
# REPOS (OPTIONAL) — multi-repo configuration. Remove the # to enable.
# =============================================================================

# repos:
#   default:
#     repo: "${esc(v.owner)}/${esc(v.repo)}"
#     staging_branch: "${esc(v.stagingBranch)}"
#   satellites:
#     - prefix: "mcp"
#       repo: "${esc(v.owner)}/your-satellite-repo"
#       staging_branch: "main"

# =============================================================================
# PROJECT BOARD (OPTIONAL) — GitHub Projects v2 integration.
# To find IDs: gh project list --owner ${esc(v.owner)}
# =============================================================================

# project_board:
#   owner: "${esc(v.owner)}"
#   project_number: 1
#   project_id: "PVT_kwHOxxxxxxxxxxxxxxxx"
#   field_ids:
#     status: "PVTSSF_xxxxxxxxxxxxxxxxxxxxxxxx"

# =============================================================================
# REVIEW (OPTIONAL) — context injected into review agent prompts.
# =============================================================================

# review:
#   tech_stack: "Node.js, TypeScript, PostgreSQL"
#   context: |
#     Describe your repo structure and any unusual conventions here.

# =============================================================================
# VERIFICATION (OPTIONAL) — health checks for quality gate / validate.
# =============================================================================

# verification:
#   health_endpoint: "https://api.example.com/health"
#   health_patterns:
#     - '"status": "ok"'
`;
  writeFileSync(outputPath, content, "utf-8");
  const todoCount = (content.match(/# TODO\(forgedock:/g) || []).length;
  return { todoCount };
}

/**
 * Back up an existing file to <name>.bak (timestamped if .bak exists).
 * @returns {{ backupName: string } | null} null when the file didn't exist.
 */
export function backupExisting(outputPath) {
  if (!existsSync(outputPath)) return null;
  const baseBak = outputPath + ".bak";
  const backupPath = existsSync(baseBak)
    ? `${baseBak}.${new Date().toISOString().replace(/[:.]/g, "-")}`
    : baseBak;
  renameSync(outputPath, backupPath);
  return { backupName: basename(backupPath) };
}

// ---------------------------------------------------------------------------
// Description detection (moved from forgedock.mjs init(), Task 4)
// ---------------------------------------------------------------------------

function firstParagraph(content) {
  const lines = content.split("\n");
  let started = false;
  const out = [];
  for (const line of lines) {
    if (!started && line.match(/^#/)) continue;
    if (!started && line.trim() === "") continue;
    if (!started && line.match(/^[!<\[`|]/)) continue;
    if (!started && line.match(/^---/)) continue;
    if (!started) started = true;
    if (line.trim() === "") break;
    out.push(line.trim());
  }
  if (out.length === 0) return "";
  return out
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .slice(0, 200)
    .trim();
}

/**
 * Detect a project description from README.md, falling back to CLAUDE.md.
 * @returns {{ value: string, source: 'README.md'|'CLAUDE.md'|'' }}
 */
export function detectDescription(cwd) {
  for (const file of ["README.md", "CLAUDE.md"]) {
    try {
      const p = join(cwd, file);
      if (!existsSync(p)) continue;
      const value = firstParagraph(readFileSync(p, "utf-8").slice(0, 2048));
      if (value) return { value, source: file };
    } catch {
      // best-effort only
    }
  }
  return { value: "", source: "" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/journey.test.mjs` → PASS. `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add bin/journey.mjs bin/tests/journey.test.mjs
git commit -s -m "feat(journey): ConfigDraft-driven forge.yaml writer, backup, description detection"
```

---

### Task 5: journey.mjs — Act I `preflight()`

**Files:**
- Modify: `bin/journey.mjs` (append)
- Test: `bin/tests/journey.test.mjs` (append)

**Interfaces:**
- Consumes: `revealRows`, `renderMark`, `ember`, `shimmer` from `bin/cinema.mjs`.
- Produces (used by Task 8/9):
  - `makeCtx(overrides?) → ctx` — journey context: `{ cwd, home, forgeHome, argv, env, stdout, mode, motion, exec, startedAt }`. `exec(cmd, args) → string` wraps `execFileSync` (throws on failure); injectable for tests. `startedAt` set by the caller (router) via `Date.now()`.
  - `preflight(ctx) → Promise<{ checks: Array<{ name, ok, detail, fix? }>, ghReady: boolean }>` — renders Act I (hero mark + wordmark + reveal rows) and returns verdicts. Never throws; never exits.

- [ ] **Step 1: Write the failing tests**

Append to `bin/tests/journey.test.mjs`:

```js
import { makeCtx, preflight } from "../journey.mjs";

/** Writer stub + exec stub factory for act tests. */
function fakeWriter() {
  const chunks = [];
  return { chunks, write(s) { chunks.push(s); return true; }, get text() { return chunks.join(""); }, isTTY: false };
}

function stubCtx({ execMap = {}, home = os.tmpdir(), cwd = os.tmpdir() } = {}) {
  const w = fakeWriter();
  return {
    ctx: makeCtx({
      cwd,
      home,
      forgeHome: "C:/fake/forgedock",
      argv: [],
      env: {},
      stdout: w,
      mode: "none",
      motion: false,
      startedAt: 0,
      exec: (cmd, args) => {
        const key = [cmd, ...(args || [])].join(" ");
        if (key in execMap) {
          const v = execMap[key];
          if (v instanceof Error) throw v;
          return v;
        }
        throw new Error(`ENOENT: ${key}`);
      },
    }),
    w,
  };
}

describe("preflight", () => {
  it("all green when everything is present", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { ctx, w } = stubCtx({
      home,
      execMap: {
        "git --version": "git version 2.45.0",
        "gh --version": "gh version 2.52.0",
        "gh auth status": "Logged in to github.com",
      },
    });
    const res = await preflight(ctx);
    assert.equal(res.checks.every((c) => c.ok), true);
    assert.equal(res.ghReady, true);
    assert.match(w.text, /F O R G E D O C K/);
  });

  it("missing gh yields a fix card and ghReady=false, but does not throw", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home2-"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const { ctx, w } = stubCtx({
      home,
      execMap: { "git --version": "git version 2.45.0" },
    });
    const res = await preflight(ctx);
    const gh = res.checks.find((c) => c.name === "GitHub CLI");
    assert.equal(gh.ok, false);
    assert.equal(res.ghReady, false);
    assert.match(w.text, /cli\.github\.com/); // fix card content
  });

  it("missing ~/.claude flags Claude Code check", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-home3-"));
    const { ctx } = stubCtx({ home, execMap: { "git --version": "git version 2.45.0" } });
    const res = await preflight(ctx);
    const cc = res.checks.find((c) => c.name === "Claude Code");
    assert.equal(cc.ok, false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/journey.test.mjs`
Expected: FAIL — `makeCtx`/`preflight` not exported.

- [ ] **Step 3: Write the implementation**

Append to `bin/journey.mjs`:

```js
// ---------------------------------------------------------------------------
// Journey context (Task 5)
// ---------------------------------------------------------------------------

import { execFileSync } from "child_process";
import os from "os";
import {
  renderMark, ember, shimmer, revealRows, moltenBar, fixCard,
  colorMode, motionEnabled, CHROME_STOPS, HERO_MARK, COMPACT_MARK, sleep,
} from "./cinema.mjs";

/**
 * Build the shared journey context. Every act takes this as its first arg.
 * All process-touching values are injectable for tests.
 */
export function makeCtx(overrides = {}) {
  const env = overrides.env ?? process.env;
  const stdout = overrides.stdout ?? process.stdout;
  const argv = overrides.argv ?? process.argv.slice(2);
  return {
    cwd: process.cwd(),
    home: env.HOME || env.USERPROFILE || os.homedir(),
    forgeHome: "",
    argv,
    env,
    stdout,
    mode: colorMode(env, stdout),
    motion: motionEnabled(argv, env, stdout),
    exec: (cmd, args) =>
      execFileSync(cmd, args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      }).trim(),
    startedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Act I — Ignition: hero mark + preflight checks (Task 5)
// ---------------------------------------------------------------------------

const dimLine = (ctx, s) => (ctx.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);

/**
 * Render the hero banner and run preflight checks. Failures render fix cards
 * and the journey continues — advisory, never fatal.
 * @returns {Promise<{ checks: Array<{name, ok, detail, fix?}>, ghReady: boolean }>}
 */
export async function preflight(ctx) {
  const { stdout: w } = ctx;
  w.write("\n");
  await shimmer(HERO_MARK, CHROME_STOPS, { mode: ctx.mode, motion: ctx.motion, writer: w });
  w.write("\n  " + ember("F O R G E D O C K", ctx.mode) + "\n");
  w.write("  " + dimLine(ctx, "──── lighting the forge ────────────────────") + "\n\n");

  const rows = [
    {
      label: "Node",
      run: async () => {
        const major = Number(process.versions.node.split(".")[0]);
        return major >= 18
          ? { ok: true, detail: `v${process.versions.node}` }
          : { ok: false, detail: `v${process.versions.node} — need ≥18`, fix: ["Upgrade Node: https://nodejs.org/"] };
      },
    },
    {
      label: "git",
      run: async () => {
        try {
          const v = ctx.exec("git", ["--version"]);
          return { ok: true, detail: v.replace(/^git version\s*/, "") };
        } catch {
          return { ok: false, detail: "not found", fix: ["Install git: https://git-scm.com/downloads"] };
        }
      },
    },
    {
      label: "Claude Code",
      run: async () => {
        const claudeDir = join(ctx.home, ".claude");
        return existsSync(claudeDir)
          ? { ok: true, detail: "~/.claude found" }
          : { ok: false, detail: "~/.claude not found", fix: ["Install Claude Code: https://claude.com/claude-code"] };
      },
    },
    {
      label: "GitHub CLI",
      run: async () => {
        try {
          ctx.exec("gh", ["--version"]);
        } catch {
          return {
            ok: false,
            detail: "not found",
            fix: ["Install gh: https://cli.github.com/", "Windows: winget install GitHub.cli"],
          };
        }
        try {
          ctx.exec("gh", ["auth", "status"]);
          return { ok: true, detail: "authenticated" };
        } catch {
          return { ok: false, detail: "not authenticated", fix: ["Run: gh auth login"] };
        }
      },
    },
  ];

  // Map check names for the return contract (label ≠ name only for clarity).
  const results = await revealRows(rows, { mode: ctx.mode, motion: ctx.motion, writer: w });
  const checks = rows.map((r, i) => ({ name: r.label === "git" ? "git" : r.label, ...results[i] }));
  const named = [
    { ...checks[0], name: "Node" },
    { ...checks[1], name: "git" },
    { ...checks[2], name: "Claude Code" },
    { ...checks[3], name: "GitHub CLI" },
  ];
  return { checks: named, ghReady: named[3].ok };
}
```

Note: `join` and `existsSync` are already imported at the top of journey.mjs (Task 4).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/journey.test.mjs` → PASS. `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add bin/journey.mjs bin/tests/journey.test.mjs
git commit -s -m "feat(journey): Act I preflight with fix cards and hero banner"
```

---

### Task 6: journey.mjs — Act II `forge()` (install + hook + registry)

**Files:**
- Modify: `bin/journey.mjs` (append)
- Test: `bin/tests/journey.test.mjs` (append)

**Interfaces:**
- Consumes: `installSessionStartHook` (Task 3), `moltenBar`/`ember` (Task 2). The symlink loop and `findMarkdownFiles` move here **verbatim in behavior** from `bin/forgedock.mjs:63-135` (regular files skipped with warning, changed links updated via `.tmp` rename, per-file errors other than ENOENT rethrown).
- Produces (used by Tasks 8–9):
  - `findMarkdownFiles(dir) → Promise<string[]>` (sorted, recursive)
  - `forge(ctx) → Promise<{ installed, updated, skipped, total, hookStatus }>` — installs command symlinks from `join(ctx.forgeHome, "commands")` into `join(ctx.home, ".claude", "commands")`, redrawing a molten progress line per file when motion is on (plain per-file lines when off), then merges the SessionStart hook (`join(ctx.forgeHome, "bin", "hooks", "session-start.mjs")` into `join(ctx.home, ".claude", "settings.json")`).

- [ ] **Step 1: Write the failing tests**

Append to `bin/tests/journey.test.mjs`:

```js
import { forge } from "../journey.mjs";
import { lstatSync, readlinkSync, mkdirSync as mkdirSyncFs } from "node:fs";

describe("forge (Act II)", () => {
  it("symlinks commands, registers hook, reports counts", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src-"));
    mkdirSyncFs(join(forgeHome, "commands", "sub"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "commands", "sub", "b.md"), "B", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const { ctx, w } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    const res = await forge(ctx);

    assert.equal(res.installed, 2);
    assert.equal(res.total, 2);
    assert.equal(res.hookStatus, "installed");
    const link = join(home, ".claude", "commands", "a.md");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), join(forgeHome, "commands", "a.md"));
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    assert.match(JSON.stringify(settings.hooks.SessionStart), /session-start\.mjs/);
    assert.match(w.text, /2.*commands|commands.*2/i);
  });

  it("second run is idempotent: skips links, hook already", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-forge-home2-"));
    const forgeHome = mkdtempSync(join(os.tmpdir(), "fd-forge-src2-"));
    mkdirSyncFs(join(forgeHome, "commands"), { recursive: true });
    mkdirSyncFs(join(forgeHome, "bin", "hooks"), { recursive: true });
    writeFileSync(join(forgeHome, "commands", "a.md"), "A", "utf-8");
    writeFileSync(join(forgeHome, "bin", "hooks", "session-start.mjs"), "// hook", "utf-8");

    const { ctx } = stubCtx({ home });
    ctx.forgeHome = forgeHome;
    await forge(ctx);
    const res2 = await forge(makeCtx({ ...ctx }));
    assert.equal(res2.installed, 0);
    assert.equal(res2.skipped, 1);
    assert.equal(res2.hookStatus, "already");
  });
});
```

(Windows note: creating file symlinks requires Developer Mode or admin. If the symlink call fails with `EPERM` in CI, the test environment must enable Developer Mode — same requirement the existing `install()` already has. Do not code around it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/journey.test.mjs`
Expected: FAIL — `forge` not exported.

- [ ] **Step 3: Write the implementation**

Append to `bin/journey.mjs`:

```js
// ---------------------------------------------------------------------------
// Act II — Forging: command symlinks + SessionStart hook (Task 6)
// ---------------------------------------------------------------------------

import { mkdir, symlink, readlink, lstat, readdir, rename, unlink } from "fs/promises";
import { relative, dirname as pathDirname } from "path";
import { installSessionStartHook } from "./settings-hook.mjs";

/** Recursively find .md files, sorted (moved from forgedock.mjs). */
export async function findMarkdownFiles(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findMarkdownFiles(full)));
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results.sort();
}

/**
 * Act II: link commands into ~/.claude/commands with a molten progress line,
 * then register the SessionStart hook.
 * Symlink semantics preserved verbatim from the original install():
 * regular files are skipped with a warning; changed links updated atomically.
 */
export async function forge(ctx) {
  const { stdout: w } = ctx;
  const commandsDir = join(ctx.forgeHome, "commands");
  const targetDir = join(ctx.home, ".claude", "commands");

  w.write("\n  " + ember("Forging commands", ctx.mode) + " " + dimLine(ctx, `into ${targetDir}`) + "\n\n");
  await mkdir(targetDir, { recursive: true });

  const files = await findMarkdownFiles(commandsDir);
  let installed = 0, updated = 0, skipped = 0;
  const barWidth = 24;
  let barShown = false;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = relative(commandsDir, file);
    const target = join(targetDir, rel);
    await mkdir(pathDirname(target), { recursive: true });

    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) {
        const current = await readlink(target);
        if (current === file) {
          skipped++;
        } else {
          await symlink(file, target + ".tmp");
          await rename(target + ".tmp", target);
          updated++;
        }
      } else {
        if (barShown) { w.write("\x1b[1A\x1b[2K"); barShown = false; }
        w.write(`  WARNING: ${rel} is a regular file — skipping (remove it manually to let ForgeDock manage it)\n`);
        skipped++;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      await symlink(file, target);
      installed++;
    }

    if (ctx.motion) {
      if (barShown) w.write("\x1b[1A\x1b[2K");
      w.write(`  ${moltenBar(i + 1, files.length, { width: barWidth, mode: ctx.mode })}  ${i + 1}/${files.length}  ${dimLine(ctx, "/" + rel.replace(/\.md$/, ""))}\n`);
      barShown = true;
    }
  }
  if (barShown) w.write("\x1b[1A\x1b[2K");

  const hookScript = join(ctx.forgeHome, "bin", "hooks", "session-start.mjs");
  const settingsPath = join(ctx.home, ".claude", "settings.json");
  const { status: hookStatus } = installSessionStartHook(settingsPath, hookScript);

  const glyph = (ok) => (ctx.mode === "none" ? (ok ? "✔" : "!") : `\x1b[38;2;255;179;71m${ok ? "✔" : "!"}\x1b[0m`);
  w.write(`  ${glyph(true)} ${files.length} slash commands linked ${dimLine(ctx, `(new ${installed}, updated ${updated}, unchanged ${skipped})`)}\n`);
  if (hookStatus === "skipped-malformed") {
    w.write(`  ${glyph(false)} SessionStart hook NOT registered — ${settingsPath} is not valid JSON\n`);
    w.write(fixCard([`Fix the JSON in ${settingsPath}, then re-run: npx forgedock install`], ctx.mode) + "\n");
  } else {
    w.write(`  ${glyph(true)} SessionStart hook ${hookStatus === "already" ? "active" : "registered"} ${dimLine(ctx, settingsPath)}\n`);
  }

  return { installed, updated, skipped, total: files.length, hookStatus };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/journey.test.mjs` → PASS. `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add bin/journey.mjs bin/tests/journey.test.mjs
git commit -s -m "feat(journey): Act II forge — symlinks with molten progress, hook registration"
```

---

### Task 7: annotatedReviewScreen `extraFields` + prompt copy

**Files:**
- Modify: `bin/tui.mjs` (annotatedReviewScreen, around lines 835-870 and the prompt near line 987)
- Test: `bin/tests/tui.test.mjs` (append)

**Interfaces:**
- Consumes: existing `annotatedReviewScreen(draft, opts)`.
- Produces: `opts.extraFields` — `{ description?: { value, confidence, source, why } }`. When `REVIEW_FIELDS` entry has `draftPath: null` and `extraFields[key]` exists, that field object seeds the row (instead of the empty low-confidence placeholder). Prompt copy becomes: `Press Enter to forge, or a number to edit a field`.

- [ ] **Step 1: Write the failing test**

Append to `bin/tests/tui.test.mjs` (follow that file's existing import style):

```js
import { annotatedReviewScreen } from "../tui.mjs";

describe("annotatedReviewScreen extraFields", () => {
  it("non-TTY: description from extraFields is returned; medium conf not flagged low", async () => {
    // process.stdin.isTTY is false under node --test, so this exercises the non-TTY path.
    const draft = {
      project: {
        owner: { value: "o", confidence: "high", source: "s", why: "w" },
        repo: { value: "r", confidence: "high", source: "s", why: "w" },
        name: { value: "n", confidence: "medium", source: "s", why: "w" },
      },
      paths: {
        root: { value: "/p", confidence: "high", source: "s", why: "w" },
        worktreeBase: { value: "/p/w", confidence: "high", source: "s", why: "w" },
      },
      branches: {
        default: { value: "main", confidence: "high", source: "s", why: "w" },
        staging: { value: "main", confidence: "medium", source: "s", why: "w" },
      },
      meta: { remoteDetected: true },
    };
    const res = await annotatedReviewScreen(draft, {
      extraFields: {
        description: { value: "From README", confidence: "medium", source: "README.md", why: "First paragraph" },
      },
    });
    assert.equal(res.description, "From README");
    assert.ok(!res.lowConfidenceKeys.includes("description"));
  });

  it("non-TTY without extraFields: description stays empty and low", async () => {
    const draft = {
      project: { owner: { value: "o", confidence: "high", source: "s", why: "w" },
                 repo: { value: "r", confidence: "high", source: "s", why: "w" },
                 name: { value: "n", confidence: "medium", source: "s", why: "w" } },
      paths: { root: { value: "/p", confidence: "high", source: "s", why: "w" },
               worktreeBase: { value: "/p/w", confidence: "high", source: "s", why: "w" } },
      branches: { default: { value: "main", confidence: "high", source: "s", why: "w" },
                  staging: { value: "main", confidence: "medium", source: "s", why: "w" } },
      meta: { remoteDetected: true },
    };
    const res = await annotatedReviewScreen(draft, {});
    assert.equal(res.description, "");
    assert.ok(res.lowConfidenceKeys.includes("description"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test bin/tests/tui.test.mjs`
Expected: FAIL — `res.description` is `""` in the first test (extraFields ignored).

- [ ] **Step 3: Implement**

In `bin/tui.mjs`, change the `annotatedReviewScreen` signature (line ~835):

```js
export async function annotatedReviewScreen(
  draft,
  { hasExistingConfig = false, existingContent = "", showSources = false, extraFields = {} } = {},
) {
```

And change `getField` + the seeding loop so `extraFields` wins for null-draftPath fields. Replace the loop body (lines ~861-867):

```js
  for (const fd of REVIEW_FIELDS) {
    const field =
      fd.draftPath === null && extraFields[fd.key]
        ? extraFields[fd.key]
        : getField(fd.draftPath);
    values[fd.key] = field.value;
    confidences[fd.key] = field.confidence;
    sources[fd.key] = field.source;
    whys[fd.key] = field.why;
  }
```

Then update the accept prompt (search for the string `Press Enter to accept all values` around line 987) to:

```js
`Press Enter to forge, or a number to edit a field`
```

(keep the exact surrounding styling calls unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/tui.test.mjs` → PASS. `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add bin/tui.mjs bin/tests/tui.test.mjs
git commit -s -m "feat(tui): annotatedReviewScreen extraFields + forge prompt copy"
```

---

### Task 8: journey.mjs — Acts III–V (`read`, `review`, `celebrate`) + `runJourney`

**Files:**
- Modify: `bin/journey.mjs` (append)
- Test: `bin/tests/journey.test.mjs` (append)

**Interfaces:**
- Consumes: `detectConfig` (init-detect.mjs), `enrich` (init-enrich-api.mjs), `annotatedReviewScreen` + `extraFields` (Task 7), `writeForgeYaml`/`backupExisting`/`detectDescription` (Task 4), `revealRows`/`renderMark`/`ember`/`box` (cinema/tui).
- Produces (used by Task 9):
  - `read(ctx) → Promise<{ draft, description: {value, source} }>` — Act III: runs `detectConfig(ctx.cwd)` + `detectDescription(ctx.cwd)`, renders per-field reveal rows with confidence badges, runs `enrich(draft)` when `ctx.env.ANTHROPIC_API_KEY` is set (guarded try/catch; failure prints one dim line and continues).
  - `review(ctx, draft, description) → Promise<{ written: boolean, todoCount: number, backupName: string|null, aborted: boolean }>` — Act IV: existing forge.yaml + non-TTY → abort (protect config, `written:false, aborted:true`); otherwise `annotatedReviewScreen` → `backupExisting` → `writeForgeYaml`.
  - `celebrate(ctx, summary) → void` — Act V: compact mark, `Forged.` + elapsed seconds, receipt lines, next-steps box.
  - `runJourney(ctx) → Promise<number>` — Acts I→V in order; returns process exit code (0 unless review aborted → 1). SIGINT handler: restores cursor, prints partial-state line, exits 130.

- [ ] **Step 1: Write the failing tests**

Append to `bin/tests/journey.test.mjs`:

```js
import { read, review, celebrate } from "../journey.mjs";

describe("read (Act III)", () => {
  it("returns a draft + description without a git repo (placeholders, low confidence)", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-read-"));
    writeFileSync(join(cwd, "README.md"), "# X\n\nA test project.\n", "utf-8");
    const { ctx, w } = stubCtx({ cwd });
    const res = await read(ctx);
    assert.equal(res.draft.project.owner.value, "your-github-org");
    assert.equal(res.description.value, "A test project.");
    assert.match(w.text, /\[low\]/); // badge rendered for placeholder
  });
});

describe("review (Act IV)", () => {
  it("non-TTY + no existing config: writes forge.yaml with TODO flags for low fields", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-review-"));
    const { ctx } = stubCtx({ cwd });
    const res0 = await read(ctx);
    const res = await review(ctx, res0.draft, res0.description);
    assert.equal(res.written, true);
    assert.equal(res.aborted, false);
    const yaml = readFileSync(join(cwd, "forge.yaml"), "utf-8");
    assert.match(yaml, /# TODO\(forgedock:owner\)/);
    assert.ok(res.todoCount >= 1);
  });

  it("non-TTY + existing config: aborts and leaves the file untouched", async () => {
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-review2-"));
    writeFileSync(join(cwd, "forge.yaml"), "precious: true\n", "utf-8");
    const { ctx } = stubCtx({ cwd });
    const res0 = await read(ctx);
    const res = await review(ctx, res0.draft, res0.description);
    assert.equal(res.aborted, true);
    assert.equal(res.written, false);
    assert.equal(readFileSync(join(cwd, "forge.yaml"), "utf-8"), "precious: true\n");
  });
});

describe("celebrate (Act V)", () => {
  it("prints elapsed time, receipt, and next steps", () => {
    const { ctx, w } = stubCtx({});
    ctx.startedAt = Date.now() - 34000;
    celebrate(ctx, { written: true, todoCount: 2, total: 24, hookStatus: "installed" });
    assert.match(w.text, /Forged\./);
    assert.match(w.text, /34s|3[0-9]s/);
    assert.match(w.text, /work-on next/);
    assert.match(w.text, /2/); // TODO count surfaces in the receipt
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/journey.test.mjs`
Expected: FAIL — `read`/`review`/`celebrate` not exported.

- [ ] **Step 3: Write the implementation**

Append to `bin/journey.mjs`:

```js
// ---------------------------------------------------------------------------
// Act III — Reading your repository (Task 8)
// ---------------------------------------------------------------------------

import { detectConfig } from "./init-detect.mjs";
import { enrich } from "./init-enrich-api.mjs";
import { annotatedReviewScreen, box } from "./tui.mjs";

const badgeOf = (field) => field.confidence;

/**
 * Act III: detect the repo, show each field as a reveal row with its
 * confidence badge, optionally AI-enrich. Detection runs first (it is fast);
 * rows are display pacing, not fake latency.
 */
export async function read(ctx) {
  const { stdout: w } = ctx;
  w.write("\n  " + ember("Reading your repository", ctx.mode) + "\n\n");

  const draft = await detectConfig(ctx.cwd);
  const description = detectDescription(ctx.cwd);

  const rows = [
    { label: "owner/repo", run: async () => ({ ok: true, detail: `${draft.project.owner.value}/${draft.project.repo.value}`, badge: badgeOf(draft.project.owner) }) },
    { label: "default branch", run: async () => ({ ok: true, detail: draft.branches.default.value, badge: badgeOf(draft.branches.default) }) },
    { label: "staging branch", run: async () => ({ ok: true, detail: draft.branches.staging.value, badge: badgeOf(draft.branches.staging) }) },
    { label: "project name", run: async () => ({ ok: true, detail: draft.project.name.value, badge: badgeOf(draft.project.name) }) },
    {
      label: "description",
      run: async () => description.value
        ? { ok: true, detail: `"${description.value.slice(0, 40)}${description.value.length > 40 ? "…" : ""}"`, badge: "medium" }
        : { ok: true, detail: "none found", badge: "low" },
    },
  ];
  await revealRows(rows, { mode: ctx.mode, motion: ctx.motion, writer: w });

  if (ctx.env.ANTHROPIC_API_KEY) {
    try {
      w.write("  " + dimLine(ctx, "✦ enriching with AI…") + "\n");
      await enrich(draft);
    } catch {
      w.write("  " + dimLine(ctx, "✦ AI enrichment unavailable — continuing with detection only") + "\n");
    }
  } else {
    w.write("  " + dimLine(ctx, "✦ no ANTHROPIC_API_KEY — skipping AI enrichment") + "\n");
  }

  return { draft, description };
}

// ---------------------------------------------------------------------------
// Act IV — The Review (Task 8)
// ---------------------------------------------------------------------------

/**
 * Act IV: the single interaction. Non-TTY + existing config aborts to protect
 * the file; non-TTY + fresh config writes detection values with TODO flags
 * (annotatedReviewScreen's non-TTY path returns them directly).
 */
export async function review(ctx, draft, description) {
  const { stdout: w } = ctx;
  const outputPath = join(ctx.cwd, "forge.yaml");
  const hasExisting = existsSync(outputPath);

  if (hasExisting && process.stdin.isTTY !== true) {
    w.write("\n  forge.yaml already exists — non-interactive run, aborting to protect it.\n");
    w.write("  " + dimLine(ctx, "Run interactively (or delete forge.yaml) to regenerate.") + "\n");
    return { written: false, todoCount: 0, backupName: null, aborted: true };
  }

  const extraFields = description.value
    ? { description: { value: description.value, confidence: "medium", source: description.source, why: `First paragraph of ${description.source}` } }
    : {};

  const accepted = await annotatedReviewScreen(draft, {
    hasExistingConfig: hasExisting,
    showSources: ctx.argv.includes("--verbose"),
    extraFields,
  });

  const backup = backupExisting(outputPath);
  if (backup) w.write(`  Backed up: forge.yaml → ${backup.backupName}\n`);

  const { todoCount } = writeForgeYaml(accepted, accepted.lowConfidenceKeys, outputPath);
  return { written: true, todoCount, backupName: backup ? backup.backupName : null, aborted: false };
}

// ---------------------------------------------------------------------------
// Act V — Forged (Task 8)
// ---------------------------------------------------------------------------

/**
 * Act V: quench flash on the compact mark, receipt with real elapsed time,
 * next-steps box.
 */
export function celebrate(ctx, summary) {
  const { stdout: w } = ctx;
  const elapsed = Math.round((Date.now() - ctx.startedAt) / 1000);
  const mark = renderMark("compact", ctx.mode);

  w.write("\n");
  w.write(mark[0] + "\n");
  w.write(mark[1] + "   " + ember("Forged.", ctx.mode) + " " + dimLine(ctx, `install → config in ${elapsed}s`) + "\n");
  w.write(mark[2] + "\n");
  w.write(mark[3] + "\n\n");

  const glyph = ctx.mode === "none" ? "✔" : "\x1b[38;2;255;179;71m✔\x1b[0m";
  if (summary.written) {
    const todoNote = summary.todoCount > 0 ? `${summary.todoCount} field${summary.todoCount === 1 ? "" : "s"} flagged # TODO` : "all fields detected";
    w.write(`  ${glyph} forge.yaml written          ${dimLine(ctx, todoNote)}\n`);
  }
  if (summary.total !== undefined) {
    const hookNote = summary.hookStatus === "skipped-malformed" ? "hook NOT active — see fix above" : "Claude Code knows this repo";
    w.write(`  ${glyph} ${summary.total} commands · hook ${summary.hookStatus === "skipped-malformed" ? "skipped" : "active"}   ${dimLine(ctx, hookNote)}\n`);
  }
  w.write("\n");
  w.write(
    box(
      [
        `  1. open claude in this repo`,
        `  2. run /work-on next — watch an issue become a merged PR`,
      ],
      { title: "what's next" },
    ),
  );
  w.write("  " + dimLine(ctx, "docs: github.com/RapierCraftStudios/ForgeDock · ⭐ a star is the whole marketing budget") + "\n\n");
}

// ---------------------------------------------------------------------------
// The full journey (Task 8)
// ---------------------------------------------------------------------------

/**
 * Acts I→V. Returns the process exit code.
 * SIGINT: restore cursor, summarize partial state, exit 130.
 */
export async function runJourney(ctx) {
  const onSigint = () => {
    ctx.stdout.write("\x1b[0m\x1b[?25h\n  Interrupted. Partial state: commands may be installed; config not written.\n  Finish anytime with: npx forgedock init\n");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  try {
    await preflight(ctx);
    const forged = await forge(ctx);
    const { draft, description } = await read(ctx);
    const reviewed = await review(ctx, draft, description);
    celebrate(ctx, { ...reviewed, total: forged.total, hookStatus: forged.hookStatus });
    return reviewed.aborted ? 1 : 0;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/journey.test.mjs` → PASS. `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add bin/journey.mjs bin/tests/journey.test.mjs
git commit -s -m "feat(journey): Acts III-V — read, review, celebrate, runJourney"
```

---

### Task 9: forgedock.mjs — router refactor (+ enable/disable/status, HOME fix)

**Files:**
- Modify: `bin/forgedock.mjs` (major: replace `install()`/`init()` bodies with journey calls; keep `uninstall()`/`update()`; add commands)
- Test: `bin/tests/router.test.mjs` (create)

**Interfaces:**
- Consumes: `makeCtx`, `runJourney`, `read`, `review`, `celebrate`, `findMarkdownFiles` (journey.mjs); `removeSessionStartHook` (settings-hook.mjs); `resolveState`, `setOptOut` (registry.mjs); `renderMark`, `ember`, `colorMode` (cinema.mjs).
- Produces: the CLI surface —
  - bare / `install` → configured repo? status screen : `runJourney(ctx)`
  - `init` → Acts III–V (`read` → `review` → `celebrate`); `--manual` → plain `input()` prompts per field instead of the review screen
  - `enable` → `setOptOut(cwd, false)` + create `.forgedock` marker if no forge.yaml
  - `disable` → `setOptOut(cwd, true)`
  - `status` → compact lockup + `resolveState(cwd)` + hook/commands state
  - `uninstall` → existing removal + `removeSessionStartHook`
  - `update`, `help` → kept; help text lists ONLY real commands
  - Flags stripped from args before command resolution: `--fast`, `--manual`, `--verbose`
  - `HOME` resolution: `process.env.HOME || process.env.USERPROFILE || os.homedir()` — the hard `process.exit(1)` at forgedock.mjs:21-26 is deleted.

- [ ] **Step 1: Write the failing tests**

Create `bin/tests/router.test.mjs` (spawn the real CLI — non-TTY, so plain-log mode; `HOME`/`USERPROFILE` pointed at a temp dir):

```js
/**
 * bin/tests/router.test.mjs — CLI-level tests for bin/forgedock.mjs routing.
 * Run with: node --test bin/tests/router.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "forgedock.mjs");

function runCli(args, { cwd, home } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? mkdtempSync(join(os.tmpdir(), "fd-cli-cwd-")),
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
    encoding: "utf-8",
    timeout: 30000,
  });
}

describe("router", () => {
  it("help lists only real commands — no demo, no integrate", () => {
    const res = runCli(["help"], { home: mkdtempSync(join(os.tmpdir(), "fd-h-")) });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /install/);
    assert.match(res.stdout, /enable/);
    assert.match(res.stdout, /disable/);
    assert.match(res.stdout, /status/);
    assert.doesNotMatch(res.stdout, /demo/);
    assert.doesNotMatch(res.stdout, /integrate/);
  });

  it("unknown command exits 1", () => {
    const res = runCli(["frobnicate"], { home: mkdtempSync(join(os.tmpdir(), "fd-u-")) });
    assert.equal(res.status, 1);
    assert.match(res.stdout + res.stderr, /Unknown command/);
  });

  it("status reports unmanaged in a fresh directory", () => {
    const res = runCli(["status"], { home: mkdtempSync(join(os.tmpdir(), "fd-s-")) });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /unmanaged|not active/i);
  });

  it("disable then status reports opted out", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-d-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-d-cwd-"));
    writeFileSync(join(cwd, "forge.yaml"), "project:\n", "utf-8");
    assert.equal(runCli(["disable"], { home, cwd }).status, 0);
    const res = runCli(["status"], { home, cwd });
    assert.match(res.stdout, /opted.?out|disabled/i);
  });

  it("enable in a bare directory creates the .forgedock marker", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-e-"));
    const cwd = mkdtempSync(join(os.tmpdir(), "fd-e-cwd-"));
    assert.equal(runCli(["enable"], { home, cwd }).status, 0);
    assert.ok(existsSync(join(cwd, ".forgedock")));
  });

  it("works without HOME when USERPROFILE is set (no hard exit)", () => {
    const home = mkdtempSync(join(os.tmpdir(), "fd-w-"));
    const res = spawnSync(process.execPath, [CLI, "help"], {
      env: { ...process.env, HOME: "", USERPROFILE: home, NO_COLOR: "1" },
      encoding: "utf-8",
      timeout: 30000,
    });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stdout + res.stderr, /HOME environment variable/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test bin/tests/router.test.mjs`
Expected: FAIL — `enable`/`disable`/`status` hit `Unknown command`; the HOME test hits the hard exit; help currently lacks the new commands.

- [ ] **Step 3: Implement the router**

Rewrite `bin/forgedock.mjs` top and dispatch. Keep `uninstall()` and `update()` bodies (update `uninstall` to also remove the hook; both now use journey's `findMarkdownFiles`). Delete the old `install()`, `init()`, `confirmOverwrite()`, `findMarkdownFiles()` — they moved to journey.mjs. The new file skeleton:

```js
#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";
import { lstat, readlink, unlink } from "fs/promises";
import { existsSync } from "fs";
import { execSync } from "child_process";
import os from "os";
import { makeCtx, runJourney, read, review, celebrate, forge, preflight, findMarkdownFiles } from "./journey.mjs";
import { removeSessionStartHook } from "./settings-hook.mjs";
import { resolveState, setOptOut } from "./registry.mjs";
import { renderMark, ember } from "./cinema.mjs";
import { input } from "./tui.mjs";
import { writeForgeYaml, backupExisting } from "./journey.mjs";

const __filename = fileURLToPath(import.meta.url);
const FORGE_HOME = dirname(dirname(__filename));

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const TARGET_DIR = join(HOME, ".claude", "commands");

const rawArgs = process.argv.slice(2);
const FLAGS = new Set(["--fast", "--manual", "--verbose"]);
const flags = rawArgs.filter((a) => FLAGS.has(a));
const positional = rawArgs.filter((a) => !FLAGS.has(a));
const command = positional[0] || "install";

function ctx() {
  const c = makeCtx({ argv: flags });
  c.forgeHome = FORGE_HOME;
  c.home = HOME;
  return c;
}

/** Compact status screen for configured/managed directories. */
function statusScreen(c) {
  const state = resolveState(c.cwd);
  const mark = renderMark("compact", c.mode);
  const dim = (s) => (c.mode === "none" ? s : `\x1b[2m${s}\x1b[22m`);
  c.stdout.write("\n" + mark[0] + "\n");
  c.stdout.write(mark[1] + "  " + ember("FORGEDOCK", c.mode) + " " + dim("status") + "\n");
  c.stdout.write(mark[2] + "\n" + mark[3] + "\n\n");
  const configured = existsSync(join(c.cwd, "forge.yaml"));
  c.stdout.write(`  directory   ${state}\n`);
  c.stdout.write(`  forge.yaml  ${configured ? "present" : "missing"}\n`);
  c.stdout.write(`  commands    ${existsSync(TARGET_DIR) ? "installed at " + TARGET_DIR : "not installed"}\n`);
  if (state === "managed-optedout") {
    c.stdout.write(`\n  ForgeDock is disabled (opted out) here. Re-enable: npx forgedock enable\n`);
  } else if (state === "unmanaged") {
    c.stdout.write(`\n  ForgeDock is not active in this directory. Activate: npx forgedock enable\n`);
  } else if (!configured) {
    c.stdout.write(`\n  Generate config: npx forgedock init\n`);
  } else {
    c.stdout.write(`\n  Reconfigure: npx forgedock init · Full journey: npx forgedock install\n`);
  }
  c.stdout.write("\n");
}

async function initFlow(c) {
  if (flags.includes("--manual")) {
    // Manual escape hatch: plain prompts, detection values as defaults.
    const { draft, description } = await read(c);
    const v = {
      owner: await input("GitHub owner", draft.project.owner.value),
      repo: await input("Repository", draft.project.repo.value),
      name: await input("Project name", draft.project.name.value),
      description: await input("Description", description.value),
      root: await input("Repo root", draft.paths.root.value),
      worktreeBase: await input("Worktree base", draft.paths.worktreeBase.value),
      defaultBranch: await input("Default branch", draft.branches.default.value),
      stagingBranch: await input("Staging branch", draft.branches.staging.value),
    };
    const outputPath = join(c.cwd, "forge.yaml");
    const backup = backupExisting(outputPath);
    if (backup) c.stdout.write(`  Backed up: forge.yaml → ${backup.backupName}\n`);
    const { todoCount } = writeForgeYaml(v, [], outputPath);
    celebrate(c, { written: true, todoCount });
    return 0;
  }
  const { draft, description } = await read(c);
  const reviewed = await review(c, draft, description);
  celebrate(c, reviewed);
  return reviewed.aborted ? 1 : 0;
}
```

Dispatch (replacing the old switch; `help()` updated to list `install init enable disable status update uninstall help` + the three flags — copy the existing help() formatting style with cyan command names):

```js
let exitCode = 0;
switch (command) {
  case "install": {
    const c = ctx();
    if (existsSync(join(c.cwd, "forge.yaml")) && resolveState(c.cwd) === "managed-active") {
      statusScreen(c);
    } else {
      exitCode = await runJourney(c);
    }
    break;
  }
  case "init":
    exitCode = await initFlow(ctx());
    break;
  case "enable": {
    const c = ctx();
    await setOptOut(c.cwd, false);
    if (!existsSync(join(c.cwd, "forge.yaml")) && !existsSync(join(c.cwd, ".forgedock"))) {
      const { writeFileSync } = await import("fs");
      writeFileSync(join(c.cwd, ".forgedock"), "", "utf-8");
    }
    c.stdout.write("\n  ForgeDock enabled in this directory.\n\n");
    break;
  }
  case "disable": {
    const c = ctx();
    await setOptOut(c.cwd, true);
    c.stdout.write("\n  ForgeDock disabled in this directory. Re-enable: npx forgedock enable\n\n");
    break;
  }
  case "status":
    statusScreen(ctx());
    break;
  case "uninstall":
    await uninstall(); // existing body, now also calls removeSessionStartHook (below)
    break;
  case "update":
    await update(); // unchanged
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.log(`Unknown command: ${command}`);
    help();
    exitCode = 1;
}
process.exit(exitCode);
```

Inside the kept `uninstall()`, after the removal loop add:

```js
  const { status } = removeSessionStartHook(join(HOME, ".claude", "settings.json"));
  if (status === "removed") console.log("  Removed: SessionStart hook");
```

and change its `COMMANDS_DIR` reference to `join(FORGE_HOME, "commands")`. Delete the `if (!process.env.HOME) { … process.exit(1) }` block entirely.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test bin/tests/router.test.mjs` → PASS. Then the full suite: `npm test` → green (fix any old tests that asserted the removed help text).

- [ ] **Step 5: Full-journey smoke test in a scratch repo (eyeball)**

```bash
cd "$(mktemp -d)" && git init -q && git remote add origin https://github.com/RapierCraftStudios/ForgeDock.git
node <ABSOLUTE_PATH_TO_REPO>/bin/forgedock.mjs
```
Expected: hero shimmer → preflight rows → molten install bar → detection rows with badges → review screen (press Enter) → quench + receipt + next-steps box. Re-run: status screen, not the movie. Then `node .../forgedock.mjs uninstall` and confirm the hook entry is gone from `~/.claude/settings.json`.

- [ ] **Step 6: Commit**

```bash
git add bin/forgedock.mjs bin/tests/router.test.mjs
git commit -s -m "feat(cli): router over the journey — enable/disable/status, hook uninstall, HOME fallback"
```

---

### Task 10: Docs truth-pass + version 1.1.0

**Files:**
- Modify: `README.md`, `docs/site/getting-started.md`, `docs/CONFIG.md`, `package.json`, `.claude-plugin/plugin.json`

**Interfaces:** none (docs). Verification is grep-based.

- [ ] **Step 1: README.md**

1. Delete the "30-second try" `npx forgedock demo` block (README lines ~52-58) and replace with:

```markdown
### Try it in 60 seconds

npx forgedock

One command: it checks your environment, installs the slash commands, reads
your repo, and writes a reviewed `forge.yaml` — you press Enter once.
```

2. In the install section (~lines 174-208): requirements list becomes `Claude Code · GitHub CLI (authenticated) · Node.js ≥ 18`; collapse the two-step quickstart to the single `npx forgedock` (mention `npx forgedock init` as "re-generate config only"); DELETE the sentence claiming init "injects a short usage block into your project's CLAUDE.md" and replace with:

```markdown
Installing also registers a SessionStart hook, so every Claude Code session
in a forge-managed directory starts already knowing ForgeDock runs it.
Per-directory control: `npx forgedock enable` / `disable` / `status`.
```

3. In the maintenance commands list (~lines 199-204): remove `integrate`, add `enable`, `disable`, `status`.

- [ ] **Step 2: docs/site/getting-started.md**

Rewrite Step 2 (lines ~43-58): the config is created by `npx forgedock` itself (or `npx forgedock init` to redo it); `/forgedock-init` is the optional *enrichment* step run afterwards inside Claude Code to fill optional sections (boards, satellites, review context). Remove any instruction to run `/forgedock-init` before a forge.yaml exists.

- [ ] **Step 3: docs/CONFIG.md**

Update the CLI flags section (~lines 15-26) to document exactly what now exists: `--manual` (plain prompts, detection as defaults), `--verbose` (show all detection sources on the review screen), `--fast` (skip animation frames), `FORGE_NO_MOTION=1`. Remove any flag text that doesn't match Task 9's implementation.

- [ ] **Step 4: Versions**

`package.json`: `"version": "1.1.0"`. `.claude-plugin/plugin.json`: `"version": "1.1.0"`.

- [ ] **Step 5: Verify**

```bash
grep -rn "forgedock demo" README.md docs/ ; grep -rn "forgedock integrate" README.md docs/
grep -n "CLAUDE.md" README.md   # remaining mentions must not claim injection
grep -n '"version"' package.json .claude-plugin/plugin.json
npm test
```
Expected: no `demo`/`integrate` hits; both versions `1.1.0`; suite green.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/site/getting-started.md docs/CONFIG.md package.json .claude-plugin/plugin.json
git commit -s -m "docs: truth-pass — journey install story, real flags, v1.1.0"
```

---

### Task 11: Final verification + demo re-record (manual)

**Files:** none (verification); optionally `docs/demo.tape` + `docs/demo.gif`.

- [ ] **Step 1: Full suite + fresh-machine simulation**

```bash
npm test
# Fresh HOME simulation (bash):
export TESTHOME=$(mktemp -d) && HOME=$TESTHOME USERPROFILE=$TESTHOME node bin/forgedock.mjs --fast < /dev/null; echo "exit: $?"
```
Expected: suite green; non-TTY run prints the plain-log receipt, writes forge.yaml with TODO flags (fresh dir), exits 0.

- [ ] **Step 2: Degradation ladder spot checks (eyeball)**

Run `node bin/forgedock.mjs status` under: normal Windows Terminal (truecolor + motion), `NO_COLOR=1` (monochrome, motion), `--fast` (instant), piped (`| cat` — plain log). Each must be readable and truthful.

- [ ] **Step 3: Re-record the demo**

Update `docs/demo.tape` to drive the new journey (`npx forgedock` in a scratch repo) and regenerate `docs/demo.gif` with vhs (`vhs docs/demo.tape`). If vhs isn't installed, file a follow-up issue instead of blocking the merge — but do NOT ship a README that embeds a gif of the old flow without a note.

- [ ] **Step 4: Commit (if tape re-recorded)**

```bash
git add docs/demo.tape docs/demo.gif
git commit -s -m "docs: re-record demo for the cinematic journey"
```

---

## Plan Self-Review (completed)

- **Spec coverage:** five acts (Tasks 5, 6, 8), hook wiring + uninstall (Tasks 3, 6, 9), enable/disable/status (Task 9), review-screen wiring + extraFields + prompt copy (Tasks 7, 8), ConfigDraft-driven writer with TODO flags (Task 4), degradation ladder gates (Task 1) + non-TTY behavior (Tasks 8, 9, 11), HOME/Windows fixes (Tasks 4, 9), docs truth-pass + 1.1.0 (Task 10), demo.tape (Task 11). Out of scope per spec: `demo` command, self-healing validate, skill-backend enrichment.
- **Known simplifications (intentional):** Act III reveal rows pace the display of already-computed detection (detection is <1s; spec allows pacing, forbids fake *work*). `enrich()` mutates/returns the draft but its optional sections are not yet written into forge.yaml by `writeForgeYaml` — matching current spec scope where enrichment feeds the review context; extend the writer when the enrichment sections are promoted into the template (follow-up).
- **Type consistency:** `annotatedReviewScreen` return keys (`owner…stagingBranch, lowConfidenceKeys`) == `writeForgeYaml` input keys; `ConfigDraft` paths used in Tasks 7–8 match `init-detect.mjs` exactly (`project.owner.value` etc.); `hookStatus` literals (`installed|already|skipped-malformed`) consistent across Tasks 3, 6, 8.
