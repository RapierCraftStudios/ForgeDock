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
