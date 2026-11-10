/**
 * forgedock-splash scene — a pure renderer, no Claude Code API in here.
 *
 * frame(ms, theme) -> { cols, rows, cells }  (cells[row][col] = { ch, rgb } | null)
 * The hooks module (register.tsx) turns cells into runs of <Text>; the tests
 * read frameText(). Everything fits the WIDTH x HEIGHT band.
 *
 * The mark art and the chrome/ember stops are copied from bin/cinema.mjs
 * (this plugin ships on its own, so it cannot import bin/); a test in
 * bin/tests/forgedock-splash.test.mjs keeps the copies identical.
 */

export const WIDTH = 56;
export const HEIGHT = 9;
export const DURATION_MS = 6500;

export const CHROME_STOPS = ["#f7f3ea", "#d9cfba", "#a99a82", "#6e6252"];
export const EMBER_STOPS = ["#ff4d00", "#ff8c1a", "#ffd166"];

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

/** Darker stops for light themes (the dark-theme chrome vanishes on white). */
const LIGHT_CHROME_STOPS = ["#6e6252", "#51463a", "#3a3027", "#241c15"];
const LIGHT_EMBER_STOPS = ["#c23a00", "#b85c00", "#9a6a00"];

const THEMES = {
  dark: { chrome: CHROME_STOPS, ember: EMBER_STOPS, dim: "#6e6252", spark: "#ffd166", clawd: "#e07a4f", bg: "#121212", bar: "#a99a82", shine: "#ffffff" },
  light: { chrome: LIGHT_CHROME_STOPS, ember: LIGHT_EMBER_STOPS, dim: "#8a7d6b", spark: "#b85c00", clawd: "#a8451f", bg: "#fafafa", bar: "#51463a", shine: "#000000" },
};

/** Every glyph a frame may contain (Block Elements, ASCII, Latin-1 »). */
export const GLYPHS = new Set(" ▀▄█▌▐░»·*+.-'/\\|_=^~:oO0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");

const MARK_COL = 2;
const MARK_ROW = 1;
const MARK_WIDTH = 28;
const PANEL_COL = 33;
const WORDMARK = "F O R G E D O C K";
const TAGLINE = "for Claude Code";
const SETTLED = "» supercharged";

// Clawd: 7 x 3, two walking poses and a jumping pose.
const CLAWD_STAND = [" ▄███▄ ", "▐█▀█▀█▌", " ▀▀ ▀▀ "];
const CLAWD_STEP = [" ▄███▄ ", "▐█▀█▀█▌", "  ▀▀▀  "];
const CLAWD_JUMP = [" ▄███▄ ", "▐█▀█▀█▌", " ▀   ▀ "];
const CLAWD_W = 7;
const CLAWD_STAND_X = 47;
const CLAWD_FEET_ROW = 8;

const T = {
  forgeEnd: 1000, cooled: 2400,
  walkStart: 1300, walkEnd: 2500,
  jumpStart: 2600, bonk: 3000, landed: 3350,
  wordmark: 3350, tagline: 3900, taglineClear: 4600, settled: 4750,
  fadeStart: 5700,
};

const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (rgb) => "#" + rgb.map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, "0")).join("");
const mix = (a, b, k) => a.map((c, i) => c + (b[i] - c) * k);

function sample(stops, t) {
  const rgb = stops.map(hexToRgb);
  const x = clamp(t) * (rgb.length - 1);
  const i = Math.min(rgb.length - 2, Math.floor(x));
  return mix(rgb[i], rgb[i + 1], x - i);
}

function blank() {
  return Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
}

function put(grid, row, col, ch, rgb) {
  if (row < 0 || row >= HEIGHT || col < 0 || col >= WIDTH || ch === " ") return;
  grid[row][col] = { ch, rgb };
}

function typed(text, start, perChar, ms) {
  return text.slice(0, Math.max(0, Math.floor((ms - start) / perChar)));
}

function clawdSprite(ms) {
  if (ms >= T.jumpStart && ms < T.landed) return CLAWD_JUMP;
  if (ms >= T.walkStart && ms < T.walkEnd) return Math.floor(ms / 130) % 2 ? CLAWD_STEP : CLAWD_STAND;
  return CLAWD_STAND;
}

function clawdPos(ms) {
  if (ms < T.walkStart) return null;
  if (ms < T.walkEnd) {
    const k = (ms - T.walkStart) / (T.walkEnd - T.walkStart);
    return { x: Math.round(WIDTH + 1 + (CLAWD_STAND_X - WIDTH - 1) * k), lift: 0 };
  }
  if (ms >= T.jumpStart && ms < T.landed) {
    const k = (ms - T.jumpStart) / (T.landed - T.jumpStart);
    return { x: CLAWD_STAND_X, lift: Math.round(5 * Math.sin(Math.PI * k)) };
  }
  return { x: CLAWD_STAND_X, lift: 0 };
}

/**
 * Render one frame.
 * @param {number} ms  time since the splash started
 * @param {'dark'|'light'} theme
 */
export function frame(ms, theme = "dark") {
  const pal = THEMES[theme] ?? THEMES.dark;
  const grid = blank();
  if (ms < 0 || ms >= DURATION_MS) return { cols: WIDTH, rows: HEIGHT, cells: grid };

  const ember = (t) => sample(pal.ember, t);
  const bonkAge = ms - T.bonk;

  // Top bar the mascot bonks; it flashes for a moment on impact.
  const barFlash = bonkAge >= 0 && bonkAge < 250;
  for (let c = 0; c < WIDTH; c++) put(grid, 0, c, "▄", barFlash ? ember(c / WIDTH) : hexToRgb(pal.bar));

  // The mark: swept in left to right as molten ember, cooling to chrome.
  const sweep = clamp((ms - 0) / T.forgeEnd) * (MARK_WIDTH + 4);
  const heat = clamp(1 - (ms - T.forgeEnd) / (T.cooled - T.forgeEnd));
  HERO_MARK.forEach((line, r) => {
    [...line].forEach((ch, c) => {
      if (ch === " " || c > sweep) return;
      const near = clamp(1 - (sweep - c) / 8);
      const hot = ms < T.forgeEnd ? Math.max(near, heat) : heat;
      const chrome = sample(pal.chrome, c / MARK_WIDTH + r * 0.06);
      let rgb = mix(chrome, ember(1 - c / MARK_WIDTH), hot);
      if (bonkAge >= 0 && bonkAge < 900) {
        const radius = (bonkAge / 900) * 54;
        const dist = Math.hypot(MARK_COL + c - (CLAWD_STAND_X + 3), (MARK_ROW + r - 1) * 2);
        const k = clamp(1 - Math.abs(dist - radius) / 3) * clamp(1 - bonkAge / 900);
        if (k > 0) rgb = mix(rgb, hexToRgb(pal.shine), k * 0.75);
      }
      put(grid, MARK_ROW + r, MARK_COL + c, ch, rgb);
    });
  });

  // Sparks fly out of the bonk.
  if (bonkAge >= 0 && bonkAge < 700) {
    const age = bonkAge / 700;
    for (let i = 0; i < 8; i++) {
      const dir = (i - 3.5) / 3.5;
      const col = Math.round(CLAWD_STAND_X + 3 + dir * (2 + age * 12));
      const row = Math.round(1 + age * 3 * (1 - Math.abs(dir) * 0.4) + (i % 2));
      put(grid, row, col, i % 3 === 0 ? "*" : i % 3 === 1 ? "+" : "·", hexToRgb(pal.spark));
    }
  }

  // Wordmark and tagline.
  const wordmark = typed(WORDMARK, T.wordmark, 45, ms);
  [...wordmark].forEach((ch, i) => put(grid, 3, PANEL_COL + i, ch, ember(i / WORDMARK.length)));
  const tagline = ms < T.taglineClear ? typed(TAGLINE, T.tagline, 35, ms) : typed(SETTLED, T.settled, 40, ms);
  const tagRgb = ms < T.taglineClear ? hexToRgb(pal.dim) : ember(0.6);
  [...tagline].forEach((ch, i) => put(grid, 4, PANEL_COL + i, ch, tagRgb));

  // Clawd, drawn last so he is in front.
  const pos = clawdPos(ms);
  if (pos) {
    clawdSprite(ms).forEach((line, r) =>
      [...line].forEach((ch, c) => put(grid, CLAWD_FEET_ROW - 2 + r - pos.lift, pos.x + c, ch, hexToRgb(pal.clawd))));
  }

  // Fade towards the background, then clear.
  if (ms >= T.fadeStart) {
    const k = clamp((ms - T.fadeStart) / (DURATION_MS - T.fadeStart));
    const bg = hexToRgb(pal.bg);
    for (const row of grid) row.forEach((cell, c) => { if (cell) row[c] = { ch: cell.ch, rgb: mix(cell.rgb, bg, k) }; });
  }

  for (const row of grid) row.forEach((cell, c) => { if (cell) row[c] = { ch: cell.ch, rgb: toHex(cell.rgb) }; });
  return { cols: WIDTH, rows: HEIGHT, cells: grid };
}

/** Plain text of a frame, one string per row (blanks are spaces). */
export function frameText(f) {
  return f.cells.map((row) => row.map((cell) => (cell ? cell.ch : " ")).join(""));
}

/** One row as runs of same-coloured text: [{ text, rgb }] (rgb null = blank). */
export function runs(row) {
  const out = [];
  for (const cell of row) {
    const rgb = cell ? cell.rgb : null;
    const last = out[out.length - 1];
    if (last && last.rgb === rgb) last.text += cell ? cell.ch : " ";
    else out.push({ text: cell ? cell.ch : " ", rgb });
  }
  return out;
}

/** Can the band hold the scene? Unknown sizes (undefined) are given the benefit of the doubt. */
export function fits(columns, rows) {
  return !(typeof columns === "number" && columns < WIDTH) && !(typeof rows === "number" && rows < HEIGHT);
}

/** Theme name from whatever a host calls it ("light", "light-ansi", "dark-daltonized"...). */
export function themeOf(name) {
  return /light/i.test(String(name ?? "")) ? "light" : "dark";
}
