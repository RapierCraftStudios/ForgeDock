// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock stats --card` (forge#5291): a shareable summary card (SVG + Markdown) built from the aggregate report.
 * Aggregate numbers only: no issue titles, and no repo name unless `includeRepoNames`.
 */

/** Documented estimate: human-hours of work saved per merged PR. Always shown as an estimate. */
export const HOURS_SAVED_PER_MERGE = 1.5;
export const CARD_URL = "https://github.com/RapierCraftStudios/forgedock";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const n0 = (x) => (isNum(x) ? x : 0);

/** Sum the report groups (all versions; one repo or all repos) into aggregate card numbers. */
export function buildCard(report, { includeRepoNames = false, attribution = true, windowLabel = "all time", repo = null } = {}) {
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
  return {
    window: windowLabel,
    scope: includeRepoNames && repos.size === 1 ? [...repos][0] : repos.size === 1 ? "1 repo" : `${repos.size} repos`,
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
  if (c.footer) out.push("", `Made with [ForgeDock](${c.footer})`);
  return out.join("\n");
}

export function renderCardSvg(c) {
  const r = rows(c), h = 120 + r.length * 36 + (c.footer ? 30 : 0);
  const lines = r.map(([a, b], i) => `<text x="24" y="${96 + i * 36}" font-size="16">${esc(a)}</text><text x="576" y="${96 + i * 36}" font-size="18" font-weight="bold" text-anchor="end">${esc(b)}</text>`);
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${h}" viewBox="0 0 600 ${h}" font-family="sans-serif">`,
    `<rect width="600" height="${h}" rx="12" fill="#0d1117"/><g fill="#e6edf3">`,
    `<text x="24" y="40" font-size="22" font-weight="bold">ForgeDock stats</text><text x="24" y="64" font-size="14" fill="#8b949e">${esc(c.scope)}, ${esc(c.window)}</text>`,
    ...lines, `<text x="24" y="${h - (c.footer ? 36 : 12)}" font-size="11" fill="#8b949e">Time saved is an estimate (${HOURS_SAVED_PER_MERGE}h per merged PR).</text>`,
    ...(c.footer ? [`<text x="24" y="${h - 12}" font-size="12" fill="#58a6ff">Made with ForgeDock: ${esc(c.footer)}</text>`] : []), "</g></svg>"].join("\n");
}
