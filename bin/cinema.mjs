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
