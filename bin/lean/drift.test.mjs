// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldSummary, emptySummary, parseSummary, renderSummary, crossingIssues, fileCrossings, flaggedPackages, heldBy, makeDrift } from "./drift.mjs";
import { orchestrate } from "./orchestrate.mjs";
import { readDrift } from "../engine-cli.mjs";
import { affectedFiles } from "../orchestrate-preflight.mjs";

const S1 = { deps_added: [{ from: "@s/web", to: "@s/core", kind: "dependencies", manifest: "apps/web/package.json" }], deps_removed: [],
  new_edges: [{ from: "@s/web", to: "@s/db", file: "apps/web/a.ts", files: 2 }], removed_edges: [], top_growth: [{ file: "packages/db/big.ts", lines: 40 }], decisions: [] };
const S2 = { deps_added: [], deps_removed: [], new_edges: [{ from: "@s/web", to: "@s/db", file: "apps/web/c.ts", files: 1 }],
  removed_edges: [{ from: "@s/web", to: "@s/old", files: 1 }], top_growth: [{ file: "packages/db/big.ts", lines: 10 }], decisions: [] };
const REPORT = {
  milestone: "m1", fork_point: "0123456789abcdef",
  pairs: [{ from: "@s/web", to: "@s/db", growth: 6, files_added: 6, files_removed: 0, files: ["apps/web/a.ts", "apps/web/c.ts"], prs: [21, 22] }],
  files: [{ path: "packages/db/big.ts", added: 12000, removed: 0, growth: 12000, package: "@s/db" }],
  packages: [{ name: "@s/db", path: "packages/db", added: 12000, removed: 0, growth: 12000 }],
  crossings: [
    { kind: "pair_growth", key: "@s/web->@s/db", value: 6, threshold: 5, package_path: "apps/web" },
    { kind: "package_lines", key: "@s/db", value: 12000, threshold: 10000, package_path: "packages/db" },
  ],
};

/** gh fake: one milestone, open issues, and a log of every call. */
function fakeGh({ description = "Ship the MCP server.", open = [] } = {}) {
  const st = { description, open: [...open], calls: [], created: [] };
  st.gh = async (a) => {
    st.calls.push(a);
    if (a[0] === "api" && /milestones\?state=all/.test(a[1])) return JSON.stringify([{ number: 7, title: "Other", description: "" }, { number: 3, title: "M One", description: st.description }]);
    if (a[0] === "api" && a[1] === "-X" && a[2] === "PATCH") { st.description = a[a.indexOf("-f") + 1].slice("description=".length); return "{}"; }
    if (a[0] === "issue" && a[1] === "list") return JSON.stringify(st.open);
    if (a[0] === "issue" && a[1] === "create") {
      const n = 900 + st.created.length;
      st.created.push({ n, title: a[a.indexOf("--title") + 1], body: a[a.indexOf("--body") + 1], milestone: a[a.indexOf("--milestone") + 1] });
      st.open.push({ number: n, body: a[a.indexOf("--body") + 1] });
      return `https://github.com/o/r/issues/${n}\n`;
    }
    throw new Error(`unexpected gh ${a.join(" ")}`);
  };
  return st;
}
const fakeGit = () => { const calls = []; return { calls, git: async (a) => { calls.push(a); return ""; } }; };
const merged = (pr, structure = S1, lane = "milestone/m1") => ({ terminalReason: "merged", pr, structure, milestone: "M One", lane });

describe("drift summary fold (forge#4161)", () => {
  it("folds structure records keyed by PR; a re-fold is a no-op", () => {
    const a = foldSummary(emptySummary("M One"), { issue: 1, pr: 21, milestone: "M One", structure: S1 });
    const b = foldSummary(a, { issue: 2, pr: 22, milestone: "M One", structure: S2 });
    assert.deepEqual(b.merged, [{ issue: 1, pr: 21 }, { issue: 2, pr: 22 }]);
    assert.deepEqual(b.pairs, { "@s/web:@s/db": { files_added: 3, files_removed: 0, prs: [21, 22] }, "@s/web:@s/old": { files_added: 0, files_removed: 1, prs: [] } });
    assert.deepEqual(b.deps_added, [{ from: "@s/web", to: "@s/core", kind: "dependencies", pr: 21 }]);
    assert.deepEqual(b.growth, { "packages/db/big.ts": 50 });
    assert.equal(foldSummary(b, { issue: 2, pr: 22, structure: S2 }), b, "same PR: unchanged");
  });

  it("the description block round-trips and keeps the text around it byte for byte", () => {
    const desc = "Line one.\r\n<!-- FORGE:MILESTONE_INDEX: https://gist.github.com/x -->\ntrailing  ";
    const s1 = foldSummary(emptySummary("M One"), { issue: 1, pr: 21, structure: { ...S1, top_growth: [{ file: "a-->b.ts", lines: 3 }] } });
    const d1 = renderSummary(desc, s1);
    assert.ok(d1.startsWith(`${desc}\n\n<!-- FORGE:DRIFT {`));
    assert.equal((d1.match(/-->/g) ?? []).length, 2, "a `-->` in a path never ends the comment");
    assert.deepEqual(parseSummary(d1), s1);
    const s2 = foldSummary(s1, { issue: 2, pr: 22, structure: S2 });
    const d2 = renderSummary(d1, s2);
    assert.equal(d2.slice(0, desc.length + 2), `${desc}\n\n`);
    assert.deepEqual(parseSummary(d2), s2);
    assert.equal((d2.match(/FORGE:DRIFT \{/g) ?? []).length, 1, "replaced, not appended");
    assert.equal(parseSummary("no block"), null);
    assert.equal(parseSummary("<!-- FORGE:DRIFT {bad} -->"), null);
    assert.equal(renderSummary("", s1).startsWith("<!-- FORGE:DRIFT "), true);
  });
});

describe("drift crossings (forge#4161)", () => {
  it("one templated issue per crossing with numbers, files and a marker; flagged packages and holds", () => {
    const issues = crossingIssues(REPORT, { slug: "m1", milestone: "M One" });
    assert.deepEqual(issues.map((i) => i.marker), ["FORGE:DRIFT:m1:pair_growth:@s/web->@s/db", "FORGE:DRIFT:m1:package_lines:@s/db"]);
    assert.equal(issues[0].title, "drift(milestone/m1): pair_growth @s/web->@s/db 6 > 5");
    assert.match(issues[0].body, /`@s\/web->@s\/db` has 6 value-import files \(threshold 5\)/);
    assert.match(issues[0].body, /- `apps\/web\/a\.ts`\n- `apps\/web\/c\.ts`\n- PRs: #21, #22/);
    assert.match(issues[1].body, /- `packages\/db\/big\.ts` \+12000 -0/);
    assert.ok(issues[1].body.endsWith("<!-- FORGE:DRIFT:m1:package_lines:@s/db -->"));
    assert.deepEqual(flaggedPackages(REPORT), ["apps/web", "packages/db"]);
    assert.equal(heldBy(["packages/db/src/x.ts"], ["packages/db"]), "packages/db");
    assert.equal(heldBy(["packages/dbx/a.ts", "apps/webapp/a.ts"], ["packages/db", "apps/web"]), null, "a dir prefix only");
    assert.deepEqual(crossingIssues({ ...REPORT, crossings: [] }, { slug: "m1", milestone: "M One" }), []);
  });

  it("files exactly one issue per new crossing; open drift issues and earlier filings are deduplicated", async () => {
    const st = fakeGh({ open: [{ number: 5, body: "old\n<!-- FORGE:DRIFT:m1:package_lines:@s/db -->" }] });
    const issues = crossingIssues(REPORT, { slug: "m1", milestone: "M One" });
    const seen = new Set();
    const r = await fileCrossings({ gh: st.gh, repo: "o/r", milestone: "M One", issues, seen });
    assert.deepEqual(r, { filed: [{ marker: "FORGE:DRIFT:m1:pair_growth:@s/web->@s/db", number: 900 }], skipped: ["FORGE:DRIFT:m1:package_lines:@s/db"] });
    assert.equal(st.created[0].milestone, "M One");
    const again = await fileCrossings({ gh: st.gh, repo: "o/r", milestone: "M One", issues, seen });
    assert.deepEqual(again.filed, []);
    assert.equal(st.created.length, 1);
    const none = await fileCrossings({ gh: st.gh, repo: "o/r", milestone: "M One", issues: [] });
    assert.deepEqual(none, { filed: [], skipped: [] });
    assert.equal(st.calls.filter((a) => a[0] === "issue" && a[1] === "list").length, 2, "no read without a crossing");
  });
});

describe("makeDrift (forge#4161)", () => {
  it("no config: the summary only (milestone GET + PATCH), no script, no fetch, no issue, no holds", async () => {
    const st = fakeGh(), g = fakeGit(); let ran = 0;
    const d = makeDrift({ repo: "o/r", cwd: "/x", io: { gh: st.gh, git: g.git }, config: null, runScript: async () => { ran++; return "{}"; } });
    assert.equal(d.holds, undefined);
    const r = await d.onMerged(1, { issue: 1, outcome: "merged", pr: 21 }, merged(21));
    assert.deepEqual(parseSummary(st.description).merged, [{ issue: 1, pr: 21 }]);
    assert.ok(st.description.startsWith("Ship the MCP server.\n\n"));
    assert.equal(r.summary.pairs["@s/web:@s/db"].files_added, 2);
    assert.deepEqual(st.calls.map((a) => `${a[0]} ${a[1]}`), ["api repos/o/r/milestones?state=all&per_page=100", "api -X"]);
    assert.deepEqual([ran, g.calls.length], [0, 0]);
    // same PR again: read only, no PATCH
    await d.onMerged(1, { issue: 1, outcome: "merged", pr: 21 }, merged(21));
    assert.equal(st.calls.filter((a) => a[2] === "PATCH").length, 1);
    // staging lanes, results without structure or milestone: nothing
    for (const res of [merged(23, S1, "staging"), { ...merged(24), structure: undefined }, { ...merged(25), milestone: undefined }]) assert.equal(await d.onMerged(3, {}, res), null);
    assert.equal(st.calls.length, 3);
  });

  it("thresholds: runs the script with the summary and thresholds, files one issue per crossing once, flags packages", async () => {
    const st = fakeGh(), g = fakeGit(); const runs = [];
    const runScript = async (args) => {
      const sum = JSON.parse((await import("node:fs")).readFileSync(args[args.indexOf("--summary") + 1], "utf8"));
      runs.push({ args, merged: sum.merged.length });
      return JSON.stringify(runs.length === 1 ? { ...REPORT, crossings: [] } : REPORT);
    };
    const d = makeDrift({ repo: "o/r", cwd: "/x", io: { gh: st.gh, git: g.git }, config: { pairGrowth: 5, packageLines: 10000, fileLines: null, blockDispatch: true }, stagingBranch: "staging", affectedFiles, runScript });
    const below = await d.onMerged(1, {}, merged(21));
    assert.deepEqual([below.filed, st.created.length], [[], 0], "below the thresholds nothing is filed");
    assert.equal(st.calls.filter((a) => a[0] === "issue").length, 0, "and no issue read");
    assert.deepEqual(runs[0].args.filter((x) => !x.includes("/")), ["m1", "--summary", "--pair-growth", "5", "--package-lines", "10000"]);
    assert.deepEqual(g.calls, [["fetch", "origin", "milestone/m1"], ["fetch", "origin", "staging"]]);
    const body = (files) => `## Affected Files\n${files.map((f) => `- \`${f}\``).join("\n")}\n`;
    assert.equal(d.holds(9, { body: body(["packages/db/x.ts"]), lane: "milestone/m1" }), null, "no flag yet");
    const r = await d.onMerged(2, {}, merged(22, S2));
    assert.equal(runs[1].merged, 2, "the script sees the folded summary");
    assert.deepEqual(r.filed.map((f) => f.number), [900, 901]);
    assert.deepEqual(st.created.map((c) => c.title), ["drift(milestone/m1): pair_growth @s/web->@s/db 6 > 5", "drift(milestone/m1): package_lines @s/db 12000 > 10000"]);
    await d.onMerged(3, {}, merged(23, S2));
    assert.equal(st.created.length, 2, "a later merge with the same crossings files nothing");
    assert.equal(d.holds(9, { body: body(["packages/db/x.ts"]), lane: "milestone/m1" }), "packages/db");
    assert.equal(d.holds(9, { body: body(["packages/core/x.ts"]), lane: "milestone/m1" }), null, "another package");
    assert.equal(d.holds(9, { body: body(["packages/db/x.ts"]), lane: "milestone/m2" }), null, "another milestone");
  });

  it("calls are serialised: parallel merges never lose a fold", async () => {
    const st = fakeGh(); const slow = st.gh;
    st.gh = async (a) => { await new Promise((r) => setTimeout(r, 5)); return slow(a); };
    const d = makeDrift({ repo: "o/r", cwd: "/x", io: { gh: st.gh, git: async () => "" } });
    await Promise.all([d.onMerged(1, {}, merged(21)), d.onMerged(2, {}, merged(22, S2)), d.onMerged(3, {}, merged(23))]);
    assert.deepEqual(parseSummary(st.description).merged.map((m) => m.pr), [21, 22, 23]);
  });
});

describe("orchestrate drift seam (forge#4161)", () => {
  const lanesOf = (m) => async (n) => ({ ok: true, lane: m[n] ?? "staging" });

  it("a merged milestone lane awaits onMerged before the batch ends; staging lanes and other outcomes do not", async () => {
    const calls = [];
    const drift = { onMerged: async (n, row, r) => { await new Promise((res) => setTimeout(res, 10)); calls.push([n, row.lane, r.pr]); } };
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 3, readBody: async () => "", resolveLane: lanesOf({ 1: "milestone/m1", 3: "milestone/m1" }), drift,
      runOne: async (n) => (n === 3 ? { terminalReason: "needs-human" } : merged(20 + n, S1, n === 1 ? "milestone/m1" : "staging")) });
    assert.deepEqual(calls, [[1, "milestone/m1", 21]]);
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged", "needs-human"]);
  });

  it("a drift failure never changes the outcome or stops the batch", async () => {
    const seen = [];
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, readBody: async () => "", resolveLane: lanesOf({ 1: "milestone/m1", 2: "milestone/m1" }), onUpdate: (r) => seen.push(r),
      drift: { onMerged: async () => { throw new Error("gh down"); } }, runOne: async (n) => merged(20 + n) });
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[1, "merged"], [2, "merged"]]);
    assert.deepEqual(seen.filter((r) => r.outcome === "drift").map((r) => r.detail), ["drift check failed: gh down", "drift check failed: gh down"]);
  });

  it("without drift: identical rows and store shape", async () => {
    const saves = [];
    const run = (extra) => orchestrate({ issues: [1, 2], parallel: 2, readBody: async (n) => (n === 2 ? "Depends on #1" : ""), resolveLane: lanesOf({ 1: "milestone/m1", 2: "milestone/m1" }),
      store: { load: () => null, save: (s) => saves.push(Object.keys(s).sort().join(",")) }, now: () => 0, runOne: async (n) => merged(20 + n), ...extra });
    const a = await run({}); const keysA = [...saves]; saves.length = 0;
    const b = await run({ drift: { onMerged: async () => {} } });
    assert.deepEqual(a, b);
    assert.deepEqual([...new Set(keysA)], [...new Set(saves)]);
  });

  it("block_dispatch: holds only queued issues whose Affected Files touch the flagged package; they end held", async () => {
    const bodies = { 1: "", 2: "Depends on #1\n\n## Affected Files\n- `packages/db/src/x.ts`\n", 3: "Depends on #1\n\n## Affected Files\n- `packages/core/src/y.ts`\n" };
    const st = fakeGh();
    const d = makeDrift({ repo: "o/r", cwd: "/x", io: { gh: st.gh, git: async () => "" }, config: { packageLines: 10000, blockDispatch: true }, affectedFiles,
      runScript: async () => JSON.stringify({ ...REPORT, crossings: [REPORT.crossings[1]] }) });
    const ran = [];
    const rows = await orchestrate({ issues: [1, 2, 3], parallel: 1, readBody: async (n) => bodies[n], resolveLane: lanesOf({ 1: "milestone/m1", 2: "milestone/m1", 3: "milestone/m1" }), drift: d,
      runOne: async (n) => { ran.push(n); return merged(20 + n); } });
    assert.deepEqual(ran, [1, 3]);
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome, r.detail ?? null]), [[1, "merged", null], [2, "held", "drift: packages/db flagged"], [3, "merged", null]]);
    assert.equal(st.created.length, 1);
  });
});

describe("readDrift (forge#4161)", () => {
  const withYaml = (yaml, f) => {
    const dir = mkdtempSync(join(tmpdir(), "drift-yaml-"));
    try { if (yaml != null) writeFileSync(join(dir, "forge.yaml"), yaml); return f(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it("null without forge.yaml, without the block, or with nothing set", () => {
    assert.equal(withYaml(null, readDrift), null);
    assert.equal(withYaml("orchestration:\n  max_deferrals: 3\n", readDrift), null);
    assert.equal(withYaml("orchestrate:\n  drift:\n    pair_growth: 0\n    block_dispatch: false\n", readDrift), null);
  });
  it("reads the orchestrate.drift thresholds, block_dispatch and generated globs", () => {
    const y = "orchestrate:\n  drift:\n    pair_growth: 5\n    package_lines: 10000\n    file_lines: 600\n    block_dispatch: true\n    generated_globs: data/*, *.lock\n";
    assert.deepEqual(withYaml(y, readDrift), { pairGrowth: 5, packageLines: 10000, fileLines: 600, blockDispatch: true, generatedGlobs: ["data/*", "*.lock"] });
    assert.deepEqual(withYaml("orchestrate:\n  drift:\n    file_lines: 600\n", readDrift), { pairGrowth: null, packageLines: null, fileLines: 600, blockDispatch: false, generatedGlobs: [] });
  });
});
