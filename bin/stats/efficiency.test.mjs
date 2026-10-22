// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../tests/_tmp.mjs";
import { TRIGGERS } from "../lean/fixround.mjs";
import {
  TRIGGER_CAUSE, RETRY_CAUSES, WEEK_MS, codeCause, issueSlices, sliceRetries, issueQuality, acceptanceOf, efficiencyMetrics,
  batchEfficiency, windowEfficiency, formatEfficiencyLines, parseWindows,
} from "./efficiency.mjs";
import { parseArgs, runStats } from "./index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, "fixtures", "efficiency-20261022");
const AL = "RapierCraftStudios/AlterLab";
const B1 = "b20261022-181111-1103229", B2 = "b20261022-183421-1103229";
const NOW = Date.parse("2026-10-23T00:00:00Z");
const DAY = 86400000;

const start = (ts, repo = "o/r") => ({ event: "RUN_START", ts, repo });
const att = (phase, o = {}) => ({ event: "PHASE_ATTEMPT_USAGE", phase, turns: 10, cost_usd: 1, usage: { cache_read_input_tokens: 1000 }, model: "m1", ...o });
const term = (reason, code, o = {}) => ({ event: "RUN_TERMINAL", reason, code, ...o });
const probe = (result, at, trusted = true) => ({ body: `<!-- FORGE:PROBE -->\n## Acceptance probe\n\`{"fix":"abc","result":"${result}"}\``, created_at: new Date(at).toISOString(),
  author_association: trusted ? "OWNER" : "NONE", user: { type: trusted ? "Bot" : "User", login: "x" } });

describe("#4402 retry causes", () => {
  it("classifies every builder trigger (property: TRIGGERS ⊆ TRIGGER_CAUSE)", () => {
    for (const t of TRIGGERS) assert.ok(Object.hasOwn(TRIGGER_CAUSE, t), `trigger ${t} has no cause`);
    for (const c of Object.values(TRIGGER_CAUSE)) assert.ok(c === null || RETRY_CAUSES.includes(c));
  });
  it("maps lane-rerun codes by family", () => {
    assert.equal(codeCause("env.tool_missing"), "env");
    assert.equal(codeCause("followup.unavailable"), "engine");
    assert.equal(codeCause("engine.error"), "engine");
    assert.equal(codeCause("conformance.unimplemented"), "code");
    assert.equal(codeCause("review.failed"), "review");
    assert.equal(codeCause("weird"), "unknown");
    assert.equal(codeCause(null), "unknown");
  });
  it("counts triggered attempts by cause and legacy attempts beyond plan + build as unknown", () => {
    const s = issueSlices([start("t"), att("implement", { trigger: "plan" }), att("implement", { trigger: "build" }), att("implement", { trigger: "ci_red" }),
      att("implement", { trigger: "context_restart" }), att("implement", { trigger: "ci_unavailable" }), att("review", { trigger: "review" }), att("implement", { trigger: "review" })])[0];
    assert.deepEqual(sliceRetries(s), { env: 1, engine: 1, code: 1, review: 1, unknown: 0 });
    const legacy = issueSlices([start("t"), att("implement"), att("implement"), att("implement"), att("implement"), att("review")])[0];
    assert.deepEqual(sliceRetries(legacy), { env: 0, engine: 0, code: 0, review: 0, unknown: 2 });
  });
});

describe("#4402 issue quality and acceptance", () => {
  it("tags root cause + file:line + fix design", () => {
    assert.equal(issueQuality("## Root Cause\nx at `bin/a.mjs:12`\n## Fix design\ny").tag, "full");
    assert.equal(issueQuality("**Root cause**: z\n### Proposal\nfoo").tag, "partial");
    assert.equal(issueQuality("just words, see a.js:3").tag, "partial");
    assert.equal(issueQuality("plain text").tag, "none");
    assert.equal(issueQuality("<!-- ## Root Cause a.js:1 ## Fix -->\nnothing").tag, "none");
    assert.equal(issueQuality(null).tag, "none");
  });
  it("is pending under 7 days, then pass only when every record within 7 days passes", () => {
    const t0 = NOW - WEEK_MS;
    assert.equal(acceptanceOf([], NOW), "unprobed");
    assert.equal(acceptanceOf([probe("pass", t0 + 1)], NOW), "pending");
    assert.equal(acceptanceOf([probe("pass", t0)], NOW), "pass", "exactly 7 days settles");
    assert.equal(acceptanceOf([probe("pass", t0), probe("fail", t0 + WEEK_MS)], NOW + WEEK_MS), "fail");
    assert.equal(acceptanceOf([probe("pass", t0), probe("fail", t0 + WEEK_MS + 1)], NOW + WEEK_MS), "pass", "a fail after the window does not count");
    assert.equal(acceptanceOf([probe("fail", t0, false)], NOW), "unprobed", "untrusted records are ignored");
  });
});

describe("#4402 efficiencyMetrics", () => {
  const logs = new Map([
    [1, [start("2026-10-01T00:00:00Z"), att("implement", { trigger: "plan" }), att("implement", { trigger: "build" }), term("needs-human", "env.tool_missing"),
      start("2026-10-02T00:00:00Z"), att("implement", { trigger: "build", model: "m2", turns: 30, usage: { cache_read_input_tokens: 9000 } }), att("review", { cost_usd: 0.5 }),
      term("merged", "completed", { turns: { size: "S" } }), start("2026-10-09T00:00:00Z"), att("implement", { cost_usd: 99 })]],
    [2, [start("2026-10-02T00:00:00Z", "x/y"), att("implement", { cost_usd: 50 }), term("merged", "completed"),
      start("2026-10-03T00:00:00Z"), att("implement", { trigger: "build" }), term("merged", "completed")]],
  ]);
  const entries = [
    { row: { issue: 1, outcome: "merged" }, settleAt: "2026-10-05T00:00:00Z" },
    { row: { issue: 2, outcome: "merged" }, settleAt: null },
    { row: { issue: 3, outcome: "needs-human", code: "builder.blocked", detail: "Builder is blocked (promotion): on staging", cost_usd: 0.3 } },
    { row: { issue: 4, outcome: "needs-human", code: "builder.blocked", detail: "Builder is blocked (credentials): x", cost_usd: 0.3 } },
    { row: { issue: 5, outcome: "held", prefilter: { parked: true, kind: "awaiting-promotion" }, cost_usd: 0 } },
  ];
  const issues = new Map([[1, { body: "## Root cause\na.js:1\n## Fix", labels: [], comments: [probe("pass", NOW - 8 * DAY)] }],
    [2, { body: "x", labels: ["size:L"], comments: [] }]]);
  const m = efficiencyMetrics({ entries, logs, issues, repo: "o/r", now: NOW });

  it("sums the cost to merge over earlier slices, bounded by the settle time and the repo", () => {
    assert.equal(m.merged, 2);
    assert.deepEqual(m.per_issue.map((p) => [p.issue, p.slices, p.cost_usd, p.implement_turns, p.size]), [[1, 2, 3.5, 50, "S"], [2, 1, 1, 10, "L"]]);
    assert.equal(m.usd_per_merge, 2.25);
    assert.equal(m.turns_per_merge, 30);
    assert.equal(m.context_per_turn, 200);
    assert.deepEqual(Object.keys(m.by_size), ["S", "L"]);
    assert.deepEqual(m.by_model.m2, { merges: 1, attempts: 1, turns: 30, cost_usd: 1, usd_per_merge: 1, turns_per_merge: 30, context_per_turn: 300 });
  });
  it("counts retries by cause including lane reruns", () => {
    assert.deepEqual(m.retries, { total: 1, per_merge: 0.5, by_cause: { env: 1, engine: 0, code: 0, review: 0, unknown: 0 }, lane_reruns: 1 });
  });
  it("lists no-action lanes: parked and promotion-blocked only", () => {
    assert.equal(m.no_action.lanes, 2);
    assert.deepEqual(Object.keys(m.no_action.by_kind).sort(), ["awaiting-promotion", "blocked-promotion"]);
    assert.equal(m.no_action.cost_usd, 0.3);
  });
  it("compares quality tags and reports the acceptance rate", () => {
    assert.equal(m.quality.full.n, 1);
    assert.equal(m.quality.none.n, 1);
    assert.equal(m.quality.partial.n, 0);
    assert.deepEqual(m.acceptance, { pass: 1, fail: 0, pending: 0, unprobed: 1, probed: 1, pass_rate: 1 });
  });
  it("renders n/a, never NaN, for an empty cohort", () => {
    const lines = formatEfficiencyLines(efficiencyMetrics({}));
    assert.equal(lines.length, 7);
    assert.ok(!lines.some((l) => /NaN|undefined/.test(l)), lines.join("\n"));
    assert.match(lines[0], /^efficiency: merged 0, n\/a\/merge/);
    assert.equal(lines[6], "acceptance (7d after promotion): n/a");
  });
});

describe("#4402 reproduces the 2026-10-22 AlterLab batches (#4389-#4394)", () => {
  const window = async (gh = null) => (await windowEfficiency({ batchRoot: join(FX, "batches"), runsDir: join(FX, "runs"), repo: AL, gh, now: NOW, windows: [7 * DAY] }))["7d"];
  it("implement $85.98 against review $3.13 over the 10 merged lanes, per-issue turns, cache-read and cost", async () => {
    const m = await window();
    assert.equal(m.batches, 2);
    assert.equal(m.merged, 10);
    assert.equal(m.implement_usd.toFixed(2), "85.98");
    assert.equal(m.review_usd.toFixed(2), "3.13");
    assert.equal(Math.round((m.implement_usd / (m.implement_usd + m.review_usd)) * 100), 96);
    assert.equal(m.implement_turns, 802);
    assert.equal(m.implement_cache_read, 92215514);
    assert.equal(m.context_per_turn, 114982);
    assert.equal(m.turns_per_merge, 80.2);
    const p = Object.fromEntries(m.per_issue.map((x) => [x.issue, x]));
    const mm = (x) => `${(x / 1e6).toFixed(1)}M`;
    assert.deepEqual([p[36629].implement_turns, mm(p[36629].implement_cache_read), p[36629].implement_usd.toFixed(2)], [124, "22.6M", "19.80"]);
    assert.deepEqual([p[36143].implement_turns, mm(p[36143].implement_cache_read), p[36143].implement_usd.toFixed(2), p[36143].slices], [165, "14.2M", "15.03", 2]);
    assert.equal(p[36143].retries.code, 1);
    assert.deepEqual([p[36627].implement_turns, mm(p[36627].implement_cache_read), p[36627].implement_usd.toFixed(2)], [102, "15.8M", "9.20"]);
    assert.deepEqual([p[36620].implement_turns, mm(p[36620].implement_cache_read)], [91, "12.2M"]);
    assert.deepEqual([p[36612].implement_turns, p[36612].implement_usd.toFixed(2)], [19, "1.23"]);
    assert.deepEqual([p[36619].slices, p[36619].retries.env, p[36619].retries.engine], [4, 1, 2]);
  });
  it("batch 183421: 32 promotion-blocked no-action lanes for $10.13 and the #4389 outcome table", async () => {
    const b = await batchEfficiency({ batchDir: join(FX, "batches", B2), runsDir: join(FX, "runs"), now: NOW });
    assert.equal(b.batch, B2);
    assert.deepEqual([b.no_action.lanes, b.no_action.cost_usd.toFixed(2), Object.keys(b.no_action.by_kind)], [32, "10.13", ["blocked-promotion"]]);
    const { readFileSync } = await import("node:fs");
    const rows = JSON.parse(readFileSync(join(FX, "batches", B2, "report.json"), "utf8")).rows;
    const by = (o) => { const xs = rows.filter((r) => r.outcome === o); return [xs.length, xs.reduce((a, r) => a + r.cost_usd, 0).toFixed(2)]; };
    assert.deepEqual([by("merged"), by("dependency-blocked"), by("invalid")], [[7, "52.97"], [3, "1.27"], [2, "0.82"]]);
    const b1 = await batchEfficiency({ batchDir: join(FX, "batches", B1), runsDir: join(FX, "runs"), now: NOW });
    assert.equal(b1.merged + b.merged, 10);
  });
  it("a gh failure leaves quality and acceptance n/a with a note, never throws", async () => {
    const m = await window(async () => { throw new Error("HTTP 502"); });
    assert.equal(m.quality, null);
    assert.equal(m.acceptance, null);
    assert.match(formatEfficiencyLines(m).join("\n"), /issue quality: n\/a \(gh failed \(HTTP 502\)\)/);
  });
  it("windows exclude batches outside the window and other repos", async () => {
    const out = await windowEfficiency({ batchRoot: join(FX, "batches"), runsDir: join(FX, "runs"), repo: AL, now: NOW + 30 * DAY, windows: [7 * DAY, 60 * DAY] });
    assert.deepEqual([out["7d"].batches, out["7d"].merged, out["60d"].batches, out["60d"].merged], [0, 0, 2, 10]);
    const other = await windowEfficiency({ batchRoot: join(FX, "batches"), runsDir: join(FX, "runs"), repo: "o/r", now: NOW, windows: [7 * DAY] });
    assert.equal(other["7d"].batches, 0);
  });
  it("an issue in two batches counts once, with its latest row", async () => {
    const root = tmpDir("eff-root-");
    for (const [id, created, outcome] of [["b1", "2026-10-20T00:00:00Z", "deferred"], ["b2", "2026-10-21T00:00:00Z", "merged"]]) {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, "plan.json"), JSON.stringify({ v: 1, id, repo: "o/r", created }));
      writeFileSync(join(root, id, "report.json"), JSON.stringify({ rows: [{ issue: 7, outcome, cost_usd: 1 }] }));
    }
    const m = (await windowEfficiency({ batchRoot: root, runsDir: tmpDir("eff-runs-"), repo: "o/r", now: NOW, windows: [7 * DAY] }))["7d"];
    assert.deepEqual([m.batches, m.merged], [2, 1]);
  });
});

describe("#4402 forgedock stats --efficiency", () => {
  it("parses the flags and rejects --batch/--window without --efficiency", () => {
    const o = parseArgs(["--efficiency", "--batch", B2, "--window", "7d,30d"]);
    assert.deepEqual([o.efficiency, o.batch, o.windows], [true, B2, [7 * DAY, 30 * DAY]]);
    assert.throws(() => parseArgs(["--batch", B2]), /need --efficiency/);
    assert.throws(() => parseArgs(["--efficiency", "--batch", "../x"]), /invalid --batch/);
    assert.throws(() => parseWindows("7w"), /--window/);
  });
  it("prints the batch and each window", async () => {
    const out = [], w = process.stdout.write;
    process.stdout.write = (t) => { out.push(String(t)); return true; };
    let code;
    try {
      code = await runStats(["--efficiency", "--batch", B2, "--window", "7d", "--repo", AL],
        { batchRoot: join(FX, "batches"), runsDir: join(FX, "runs"), now: () => NOW, gh: async () => { throw new Error("offline"); } });
    } finally { process.stdout.write = w; }
    assert.equal(code, 0);
    const text = out.join("");
    assert.match(text, new RegExp(`^efficiency \\(batch ${B2}\\): merged 7,`, "m"));
    assert.match(text, /^efficiency \(7d, 2 batches\): merged 10, \$8\.91\/merge \(implement \$85\.98, review \$3\.13\), turns\/merge 80\.2, context\/turn 114982$/m);
    assert.match(text, /^no action: 32 lanes, \$10\.13 \(blocked-promotion 32\)$/m);
  });
});
