// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMergeLedger, humanTouches, testDelta } from "./quality-ledger.mjs";
import { createQueueClock } from "../lean/queuecause.mjs";
import { writeFileSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { join } from "node:path";
import { mergeRecords, readMergeLedgers, queueByCause, spendIncrements, versionAt, weekOf, weeklyScorecard } from "./weekly.mjs";
import { blames, gatherEscapes, laneIssueOf, linkEscapes } from "./escapes.mjs";

const T0 = Date.parse("2026-11-23T00:00:00Z"), M = 60000;

describe("MERGE_LEDGER record", () => {
  it("counts test files and non-bot human comments after the run start", () => {
    assert.deepEqual(testDelta(["bin/a.mjs", "bin/a.test.mjs", "tests/x.py"]), { files_changed: 3, test_files: 2 });
    const c = [{ author: { login: "dev" }, createdAt: "2026-11-23T01:00:00Z", body: "do it" }, { author: { login: "bot[bot]" }, createdAt: "2026-11-23T01:00:00Z", body: "x" }, { author: { login: "dev" }, createdAt: "2026-11-22T01:00:00Z", body: "old" }, { __mine: true, author: { login: "dev" }, body: "mine" }, { author: { login: "dev" }, createdAt: "2026-11-23T02:00:00Z", body: "<!-- FORGE:STATUS -->" }];
    assert.equal(humanTouches(c, T0), 1);
  });
  it("first_pass needs no recovery, relaunch or CI fix round", () => {
    const base = { firstPass: true, costUsd: 1.5, phases: { plan: { ms: 10 } }, engineVersion: "1.71.0", tier: "mid" };
    assert.equal(buildMergeLedger(base).first_pass, true);
    assert.equal(buildMergeLedger({ ...base, ciFixRounds: 1 }).first_pass, false);
    assert.equal(buildMergeLedger({ ...base, recovered: true }).first_pass, false);
    assert.equal(buildMergeLedger({ ...base, attempt: 2 }).first_pass, false);
    assert.equal(buildMergeLedger({ ...base, firstPass: null }).first_pass, null);
    const r = buildMergeLedger(base);
    assert.deepEqual([r.cost_usd, r.engine_version, r.model_tier, r.wall_ms_by_phase], [1.5, "1.71.0", "mid", { plan: 10 }]);
  });
});

describe("queue clock", () => {
  it("accrues per cause, is not reset by a requeue and stops while running", () => {
    const c = createQueueClock();
    c.tick([1], () => "hold", 0);
    c.tick([1], () => "capacity", 10 * M); // 10 min of hold
    const first = c.take(1, 25 * M); // 15 min of capacity, lane starts
    assert.deepEqual(first.causes, { hold: 10 * M, capacity: 15 * M });
    c.tick([1], () => "dependency", 100 * M); // requeued later: the running time is not queue time
    const second = c.take(1, 130 * M);
    assert.equal(second.causes.dependency, 30 * M);
    assert.equal(second.causes.hold, 10 * M);
    const restored = createQueueClock(JSON.parse(JSON.stringify(c.toJSON())));
    assert.equal(restored.take(1, 0).causes.hold, 10 * M);
  });
});

describe("weekly scorecard", () => {
  it("dedupes cumulative recovery rows", () => {
    const rows = [{ t: 1, cost_usd: 1 }, { t: 2, cost_usd: 3 }, { t: 3, cost_usd: 3 }, { t: 4, cost_usd: 0.5 }];
    assert.equal(spendIncrements(rows).reduce((s, x) => s + x.usd, 0), 3.5);
  });
  it("splits queue wait by cause with pause overlay and holds", () => {
    const merged = { t: T0 + 100 * M, wall_ms: 10 * M, outcome: "merged" };
    const q = queueByCause([merged], merged, T0, { pause: [[T0, T0 + 20 * M]], breaker: [], hold: [[T0 + 20 * M, Infinity]] });
    assert.equal(q.causes.pause, 20 * M); assert.equal(q.causes.hold, 70 * M); assert.equal(q.total, 90 * M);
  });
  it("attributes the version through upgrade rows and builds the weekly rows", () => {
    const rows = [{ t: T0, outcome: "added", issue: null, detail: "#1" }, { t: T0 + 50 * M, outcome: "readmitted", issue: 9, detail: "re-admitted: engine version changed v1.60.0 → v1.61.0" },
      { t: T0 + 90 * M, outcome: "merged", issue: 1, pr: 11, cost_usd: 2, wall_ms: 30 * M, first_pass: true, detail: "PR #11" }, { t: T0 + 95 * M, outcome: "needs-human", issue: 2, cost_usd: 1, wall_ms: M }];
    assert.equal(versionAt(rows, "1.70.0", T0), "1.60.0");
    const recs = mergeRecords([{ id: "b20261123-000000-1", repo: "o/r", created: T0, engineVersion: "1.70.0", rows }]);
    const [w] = weeklyScorecard(recs).filter((x) => x.merges);
    assert.equal(weekOf(T0), "2026-11-23");
    assert.deepEqual([w.version, w.merges, w.usd_per_merge, w.first_pass_pct, w.issue_to_merge_median_min], ["1.61.0", 1, 3, 1, 90]);
    const all = weeklyScorecard(recs).reduce((s, x) => s + x.non_merged_spend_pct, 0);
    assert.ok(all > 0);
  });
});

describe("merge ledger keying (#6230)", () => {
  it("keeps same-numbered issues of two repos apart", () => {
    const dir = tmpDir("ml-"), led = (fp) => JSON.stringify({ event: "MERGE_LEDGER", first_pass: fp, ts: "2026-11-23T01:00:00Z" }) + "\n";
    writeFileSync(join(dir, "o__a__5.jsonl"), led(true)); writeFileSync(join(dir, "o__b__5.jsonl"), led(false));
    const ledgers = readMergeLedgers({ home: dir, env: { FORGE_RUNS_DIR: dir } });
    const rows = [{ t: T0 + M, outcome: "merged", issue: 5, pr: 1, wall_ms: M }];
    const fp = (repo) => mergeRecords([{ id: `b20261123-000000-${repo}`, repo: `o/${repo}`, created: T0, rows }], ledgers)[0].firstPass;
    assert.deepEqual([fp("a"), fp("b")], [true, false]);
  });
  it("reads a legacy bare ledger only for a repo-less batch", () => {
    const dir = tmpDir("ml-"), led = JSON.stringify({ event: "MERGE_LEDGER", first_pass: false, ts: "2026-11-23T01:00:00Z" }) + "\n";
    writeFileSync(join(dir, "5.jsonl"), led);
    const ledgers = readMergeLedgers({ home: dir, env: { FORGE_RUNS_DIR: dir } });
    const rows = [{ t: T0 + M, outcome: "merged", issue: 5, pr: 1, wall_ms: M }];
    const fp = (repo) => mergeRecords([{ id: "b20261123-000000-x", repo, created: T0, rows }], ledgers)[0].firstPass;
    assert.equal(fp(null), false);
    assert.notEqual(fp("o/a"), false);
  });
});

describe("escape linker", () => {
  const lane = { number: 100, title: "feat: x", body: "Closes #50", headRefName: "feat/issue-50-lean", mergedAt: "2026-11-01T00:00:00Z" };
  it("finds the lane issue and only blaming citations", () => {
    assert.equal(laneIssueOf(lane), 50);
    assert.equal(blames("this regressed in #100", 100), true);
    assert.equal(blames("tracker: #100 #101 #102", 100), false);
  });
  it("links fix PRs, bug issues and reopens inside the window only", () => {
    const [r] = linkEscapes({ lanePrs: [lane],
      candPrs: [{ number: 110, title: "fix: bug from #100", body: "", headRefName: "fix/x", createdAt: "2026-11-03T00:00:00Z" }, { number: 111, title: "fix: late #100", body: "", headRefName: "fix/y", createdAt: "2026-12-01T00:00:00Z" }, { number: 112, title: "feat: #100", body: "", headRefName: "feat/z", createdAt: "2026-11-03T00:00:00Z" }],
      candIssues: [{ number: 120, title: "crash", body: "broke after #50", labels: [{ name: "bug" }], createdAt: "2026-11-02T00:00:00Z" }, { number: 121, title: "idea", body: "broke after #50", labels: [], createdAt: "2026-11-02T00:00:00Z" }], reopens: new Map([[50, 1]]) });
    assert.deepEqual(r.links.map((l) => l.number), [110, 120]);
    assert.equal(r.reopened, 1); assert.equal(r.escaped, true);
    assert.equal(linkEscapes({ lanePrs: [lane], candPrs: [], candIssues: [] })[0].escaped, false);
  });
  it("counts reopens when a paginated events page is empty", async () => {
    const pr = { number: 100, title: "feat: x", body: "", headRefName: "feat/issue-50-lean", mergedAt: "2026-11-01T00:00:00Z" };
    const pages = (raw) => async (args) => {
      if (args[0] === "api") return raw;
      return JSON.stringify(args[1] === "list" && args.includes("merged") ? [pr] : []);
    };
    const re = (t) => ({ event: "reopened", created_at: t }), other = { event: "closed", created_at: "2026-11-01T00:00:00Z" };
    const count = async (raw) => (await gatherEscapes({ repo: "o/r", now: Date.parse("2026-11-10T00:00:00Z"), gh: pages(raw) })).records[0].reopened;
    assert.equal(await count(`${JSON.stringify([])}\n${JSON.stringify([re("2026-11-02T00:00:00Z"), other])}`), 1);
    assert.equal(await count(`${JSON.stringify([re("2026-11-02T00:00:00Z")])}\n${JSON.stringify([])}`), 1);
    assert.equal(await count(`${JSON.stringify([])}\n${JSON.stringify([])}`), 0);
  });
});
