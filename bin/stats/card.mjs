// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock stats --card` (forge#5291): a shareable summary card (SVG + Markdown) built from the aggregate report.
 * Aggregate numbers only: no issue titles, and no repo name unless `includeRepoNames`.
 */

/** Documented estimate: human-hours of work saved per merged PR. Always shown as an estimate. */
export const HOURS_SAVED_PER_MERGE = 1.5;
export const CARD_URL = "https://github.com/RapierCraftStudios/forgedock";

import { deflateSync } from "node:zlib";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const n0 = (x) => (isNum(x) ? x : 0);

/** Sum the report groups (all versions; one repo or all repos) into aggregate card numbers. */
export function buildCard(report, { includeRepoNames = false, publicRepo = false, attribution = true, windowLabel = "all time", repo = null } = {}) {
  const groups = report?.groups ?? [];
  let merged = 0, completed = 0, closedBeforeCode = 0, gateCatches = 0, usd = 0;
  const repos = new Set();
  for (const g of groups) {
    repos.add(g.repo);
    merged += Math.round(n0(g.flow?.mergedPct) * n0(g.flow?.n));
    completed += n0(g.issueFlow?.closed?.merged);
    closedBeforeCode += n0(g.issueFlow?.closed?.invalid) + n0(g.issueFlow?.closed?.duplicate);
    const q = g.gates ?? {};
    gateCatches += n0(q.acceptance?.blocked) + n0(q.diffSize?.blocked) + n0(q.ci?.blocked) + n0(q.liveness?.blocked);
    usd += n0(g.cost?.usdTotal);
  }
  // `publicRepo` is the user's assertion that the repo is public: it names the repo and links its merged-PR run history.
  const named = (includeRepoNames || publicRepo) && repos.size === 1;
  const runHistory = publicRepo && repo && repos.size === 1 && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/pulls?q=is%3Apr+is%3Amerged` : null;
  return {
    window: windowLabel, runHistory,
    scope: named ? [...repos][0] : repos.size === 1 ? "1 repo" : `${repos.size} repos`,
    prsMerged: merged, issuesCompleted: completed, costPerMerge: merged ? usd / merged : null,
    closedBeforeCode, gateCatches, hoursSavedEstimate: merged * HOURS_SAVED_PER_MERGE,
    footer: attribution ? CARD_URL : null,
  };
}

const usd = (x) => (isNum(x) ? `$${x.toFixed(2)}` : "n/a");
const rows = (c) => [
  ["PRs merged", String(c.prsMerged)], ["Issues completed", String(c.issuesCompleted)], ["Cost per merge", usd(c.costPerMerge)],
  ["Issues closed before code (invalid/duplicate)", String(c.closedBeforeCode)], ["Release-gate catches", String(c.gateCatches)],
  ["Time saved (estimate)", `~${Math.round(c.hoursSavedEstimate * 10) / 10}h`],
];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function renderCardMarkdown(c) {
  const out = [`# ForgeDock stats card: ${c.scope}, ${c.window}`, "", "| metric | value |", "|---|---|", ...rows(c).map(([a, b]) => `| ${a} | ${b} |`), "",
    `Time saved is an estimate (${HOURS_SAVED_PER_MERGE}h per merged PR), not a measurement.`];
  if (c.runHistory) out.push("", `[Run history](${c.runHistory})`);
  if (c.footer) out.push("", `Made with [ForgeDock](${c.footer})`);
  return out.join("\n");
}

export function renderCardSvg(c) {
  const r = rows(c), h = 120 + r.length * 36 + (c.footer ? 30 : 0) + (c.runHistory ? 20 : 0);
  const lines = r.map(([a, b], i) => `<text x="24" y="${96 + i * 36}" font-size="16">${esc(a)}</text><text x="576" y="${96 + i * 36}" font-size="18" font-weight="bold" text-anchor="end">${esc(b)}</text>`);
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${h}" viewBox="0 0 600 ${h}" font-family="sans-serif">`,
    `<rect width="600" height="${h}" rx="12" fill="#0d1117"/><g fill="#e6edf3">`,
    `<text x="24" y="40" font-size="22" font-weight="bold">ForgeDock stats</text><text x="24" y="64" font-size="14" fill="#8b949e">${esc(c.scope)}, ${esc(c.window)}</text>`,
    ...lines, `<text x="24" y="${h - (c.footer ? 36 : 12)}" font-size="11" fill="#8b949e">Time saved is an estimate (${HOURS_SAVED_PER_MERGE}h per merged PR).</text>`,
    ...(c.runHistory ? [`<text x="24" y="${h - (c.footer ? 52 : 28)}" font-size="11" fill="#58a6ff">Run history: ${esc(c.runHistory)}</text>`] : []),
    ...(c.footer ? [`<text x="24" y="${h - 12}" font-size="12" fill="#58a6ff">Made with ForgeDock: ${esc(c.footer)}</text>`] : []), "</g></svg>"].join("\n");
}

// PNG (forge#5291): dependency-free raster of the same rows (node:zlib + a built-in 5x7 bitmap font, upper-case only).
const GLYPHS = {
  A: "0E 11 11 1F 11 11 11", B: "1E 11 11 1E 11 11 1E", C: "0E 11 10 10 10 11 0E", D: "1E 11 11 11 11 11 1E", E: "1F 10 10 1E 10 10 1F",
  F: "1F 10 10 1E 10 10 10", G: "0E 11 10 17 11 11 0F", H: "11 11 11 1F 11 11 11", I: "0E 04 04 04 04 04 0E", J: "07 02 02 02 02 12 0C",
  K: "11 12 14 18 14 12 11", L: "10 10 10 10 10 10 1F", M: "11 1B 15 15 11 11 11", N: "11 11 19 15 13 11 11", O: "0E 11 11 11 11 11 0E",
  P: "1E 11 11 1E 10 10 10", Q: "0E 11 11 11 15 12 0D", R: "1E 11 11 1E 14 12 11", S: "0F 10 10 0E 01 01 1E", T: "1F 04 04 04 04 04 04",
  U: "11 11 11 11 11 11 0E", V: "11 11 11 11 11 0A 04", W: "11 11 11 15 15 15 0A", X: "11 11 0A 04 0A 11 11", Y: "11 11 0A 04 04 04 04",
  Z: "1F 01 02 04 08 10 1F", 0: "0E 11 13 15 19 11 0E", 1: "04 0C 04 04 04 04 0E", 2: "0E 11 01 02 04 08 1F", 3: "1F 02 04 02 01 11 0E",
  4: "02 06 0A 12 1F 02 02", 5: "1F 10 1E 01 01 11 0E", 6: "06 08 10 1E 11 11 0E", 7: "1F 01 02 04 08 08 08", 8: "0E 11 11 0E 11 11 0E",
  9: "0E 11 11 0F 01 02 0C", ".": "00 00 00 00 00 0C 0C", ",": "00 00 00 00 0C 04 08", ":": "00 0C 0C 00 0C 0C 00", "-": "00 00 00 1F 00 00 00",
  _: "00 00 00 00 00 00 1F", "/": "01 01 02 04 08 10 10", "~": "00 00 08 15 02 00 00", "(": "02 04 08 08 08 04 02", ")": "08 04 02 02 02 04 08",
  $: "04 0F 14 0E 05 1E 04", "?": "0E 11 01 02 04 00 04", "+": "00 04 04 1F 04 04 00", "=": "00 00 1F 00 1F 00 00", "%": "18 19 02 04 08 13 03",
};
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function renderCardPng(c) {
  const S = 2, ADV = 6 * S, W = 900, r = rows(c), H = 120 + r.length * 36 + 70;
  const px = Buffer.alloc(W * H * 3);
  const rect = (x, y, w, h, col) => { for (let j = y; j < y + h && j < H; j++) for (let i = x; i < x + w && i < W; i++) px.set(col, (j * W + i) * 3); };
  const text = (s, x, y, col, right = false) => {
    const t = String(s).toUpperCase();
    let cx = right ? x - t.length * ADV : x;
    for (const ch of t) {
      const g = ch === " " ? null : (GLYPHS[ch] ?? GLYPHS["?"]).split(" ").map((h) => parseInt(h, 16));
      g?.forEach((bits, ry) => { for (let rx = 0; rx < 5; rx++) if (bits & (16 >> rx)) rect(cx + rx * S, y + ry * S, S, S, col); });
      cx += ADV;
    }
  };
  const fg = hex("#e6edf3"), dim = hex("#8b949e"), link = hex("#58a6ff");
  rect(0, 0, W, H, hex("#0d1117"));
  text("FORGEDOCK STATS", 24, 24, fg); text(`${c.scope}, ${c.window}`, 24, 48, dim);
  r.forEach(([a, b], i) => { text(a, 24, 84 + i * 36, fg); text(b, W - 24, 84 + i * 36, fg, true); });
  let y = 84 + r.length * 36 + 8;
  text(`TIME SAVED IS AN ESTIMATE (${HOURS_SAVED_PER_MERGE}H PER MERGED PR).`, 24, y, dim);
  if (c.runHistory) text(`RUN HISTORY: ${c.runHistory}`, 24, (y += 20), link);
  if (c.footer) text(`MADE WITH FORGEDOCK: ${c.footer}`, 24, (y += 20), link);
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let j = 0; j < H; j++) px.copy(raw, j * (W * 3 + 1) + 1, j * W * 3, (j + 1) * W * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
