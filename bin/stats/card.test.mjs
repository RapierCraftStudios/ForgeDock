// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { tmpDir } from "../tests/_tmp.mjs";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCard, renderCardMarkdown, renderCardPng, renderCardSvg } from "./card.mjs";
import { parseArgs, runStats } from "./index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TITLE = "SECRET-TITLE-do-not-leak", REPO = "secret-org/private-repo";
const group = (over = {}) => ({
  version: "1.0.0", repo: REPO, n: 4, flow: { n: 4, mergedPct: 0.5 }, cost: { usdTotal: 10 },
  issueFlow: { closed: { merged: 2, invalid: 1, duplicate: 2, other: 3 } },
  gates: { acceptance: { blocked: 1 }, diffSize: { blocked: 2 }, ci: { blocked: 3 }, liveness: { blocked: 0 } }, ...over,
});
// A report whose input carries canary strings: groups never hold titles, but extra fields must not reach the card.
const report = { groups: [group(), group({ version: "1.1.0", flow: { n: 2, mergedPct: 1 }, cost: { usdTotal: 2 }, title: TITLE })] };

let td;
afterEach(() => { if (td) rmSync(td, { recursive: true, force: true }); td = null; });

describe("stats card (forge#5291)", () => {
  it("sums the groups into aggregate numbers", () => {
    const c = buildCard(report);
    assert.equal(c.prsMerged, 4);
    assert.equal(c.issuesCompleted, 4);
    assert.equal(c.closedBeforeCode, 6);
    assert.equal(c.gateCatches, 12);
    assert.equal(c.costPerMerge, 3);
    assert.match(renderCardMarkdown(c), /Time saved \(estimate\)/);
  });
  it("defaults expose no issue titles or repo names, in either format", () => {
    const c = buildCard(report);
    for (const text of [renderCardMarkdown(c), renderCardSvg(c), JSON.stringify(c)]) {
      assert.ok(!text.includes(TITLE), "no title");
      assert.ok(!text.includes(REPO) && !text.includes("private-repo"), "no repo name");
    }
  });
  it("--include-repo-names opts the repo name in", () => {
    assert.match(renderCardMarkdown(buildCard({ groups: [group()] }, { includeRepoNames: true })), /secret-org\/private-repo/);
  });
  it("footer follows show_attribution and SVG text is escaped", () => {
    assert.match(renderCardMarkdown(buildCard(report)), /ForgeDock\]\(/);
    assert.ok(!renderCardMarkdown(buildCard(report, { attribution: false })).includes("Made with"));
    assert.ok(!renderCardSvg(buildCard(report, { attribution: false })).includes("Made with"));
    assert.ok(!renderCardSvg(buildCard({ groups: [group({ repo: "a<b>&c" })] }, { includeRepoNames: true })).includes("a<b>"));
  });
  it("--public-repo links the run history; default never does", () => {
    const one = { groups: [group()] };
    assert.ok(!renderCardMarkdown(buildCard(one, { repo: REPO })).includes("github.com/secret-org"));
    const c = buildCard(one, { repo: REPO, publicRepo: true });
    assert.match(renderCardMarkdown(c), /\[Run history\]\(https:\/\/github.com\/secret-org\/private-repo\/pulls/);
    assert.match(renderCardSvg(c), /Run history: https:\/\/github.com\/secret-org/);
    assert.throws(() => parseArgs(["--public-repo"]), /need --card/);
  });
  it("renders a valid PNG with deterministic size and an inflatable pixel stream", async () => {
    const { inflateSync } = await import("node:zlib");
    const png = renderCardPng(buildCard({ groups: [] }));
    const h = png.readUInt32BE(20), idatLen = png.readUInt32BE(33);
    assert.equal(inflateSync(png.subarray(41, 41 + idatLen)).length, (900 * 3 + 1) * h);
    assert.deepEqual([...png.subarray(png.length - 8, png.length - 4)], [73, 69, 78, 68]);
  });
  it("validates flags", () => {
    assert.equal(parseArgs(["--card", "--week", "--include-repo-names", "--out", "x"]).card, true);
    assert.throws(() => parseArgs(["--week"]), /need --card/);
    assert.throws(() => parseArgs(["--card", "--week", "--month"]), /mutually exclusive/);
    assert.throws(() => parseArgs(["--card", "--depth"]), /cannot be combined/);
  });
  it("runStats --card renders from the crawl only, writes files, and leaks nothing by default", async () => {
    td = tmpDir("card-");
    const issues = JSON.parse(readFileSync(join(here, "fixtures", "issues.json"), "utf8")).map((i) => ({ ...i, title: TITLE }));
    const calls = [];
    const gh = (args) => { calls.push(args.join(" ")); return JSON.stringify(args.some((a) => /issues\?|issues$/.test(String(a))) && !args.some((a) => /comments/.test(String(a))) ? issues : []); };
    const realOut = process.stdout.write;
    let stdout = "";
    process.stdout.write = (c) => { stdout += c; return true; };
    try { assert.equal(await runStats(["--card", "--month", "--repo", REPO, "--no-cache", "--no-local", "--out", td], { gh, env: {}, releaseTimes: [], onProgress: () => {} }), 0); } finally { process.stdout.write = realOut; }
    assert.ok(calls.length > 0 && calls.every((c) => c.startsWith("api ") || c.includes("repos/")), "only crawl calls");
    for (const text of [stdout, readFileSync(join(td, "stats-card.svg"), "utf8"), readFileSync(join(td, "stats-card.md"), "utf8")]) {
      assert.ok(!text.includes(TITLE) && !text.includes("private-repo"));
    }
    assert.ok(existsSync(join(td, "stats-card.svg")));
    const png = readFileSync(join(td, "stats-card.png"));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 900);
    assert.ok(!png.includes(Buffer.from(TITLE)));
    assert.match(stdout, /last 30 days/);
  });
});
