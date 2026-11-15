// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { readLedger, appendLedger, recallEntry, graduation, flakesFromLedger, quarantineFromLedger } from "./testengine-recall.mjs";

const NOW = Date.parse("2026-11-15T00:00:00Z"), DAY = 86_400_000;
const subset = { mode: "subset", tests: ["t/a.test.js", "t/b.test.js"], suites: ["@e2e"], total: 5 };
const everything = { mode: "all", tests: ["t/a.test.js", "t/b.test.js", "t/c.test.js"], suites: [], total: 3 };
const entry = (o = {}) => recallEntry({ selection: subset, config: "c1", sha: "s", now: NOW, ...o });
const many = (n, o) => Array.from({ length: n }, () => entry(o));

describe("recallEntry", () => {
  it("is ok when every failing test is inside the selection", () => {
    const e = entry({ failed: ["t/b.test.js", "@e2e", "t/b.test.js"], runId: 7, event: "pull_request" });
    assert.deepEqual(e, { v: 1, at: "2026-11-15T00:00:00.000Z", sha: "s", run_id: "7", event: "pull_request", ran: "all", config: "c1", mode: "subset", selected: 2, total: 5, failed: ["@e2e", "t/b.test.js"], missed: [], unattributed: [], ok: true });
  });
  it("records a failure outside the selection as a miss", () => {
    const e = entry({ failed: ["t/a.test.js", "t/c.test.js"] });
    assert.deepEqual([e.ok, e.missed], [false, ["t/c.test.js"]]);
  });
  it("counts an unattributable failure as a miss, unless everything was selected", () => {
    assert.equal(entry({ unattributed: ["some test"] }).ok, false);
    const e = recallEntry({ selection: everything, config: "c1", failed: ["t/zzz.test.js"], unattributed: ["x"], now: NOW });
    assert.deepEqual([e.ok, e.missed, e.unattributed], [true, [], []]);
  });
});

describe("graduation", () => {
  const opts = { after: 50, minFailing: 1, config: "c1" };
  it("needs `after` consecutive measured runs", () => {
    const g = graduation(many(49, { failed: ["t/a.test.js"] }), opts);
    assert.deepEqual([g.graduated, g.streak, g.needed], [false, 49, 50]);
    assert.match(g.why, /49 of 50 consecutive full runs/);
    assert.equal(graduation(many(50, { failed: ["t/a.test.js"] }), opts).graduated, true);
    assert.deepEqual(graduation([], opts).streak, 0);
  });
  it("a streak of green runs does not graduate until a subset selection caught a failure", () => {
    const g = graduation(many(60), opts);
    assert.deepEqual([g.graduated, g.streak, g.caught], [false, 60, 0]);
    assert.match(g.why, /only 0 of the 1 required/);
    assert.equal(graduation([...many(60), entry({ failed: ["t/a.test.js"] })], opts).graduated, true);
    assert.equal(graduation(many(60), { ...opts, minFailing: 0 }).graduated, true);
    const allMode = Array.from({ length: 60 }, () => recallEntry({ selection: everything, config: "c1", failed: ["t/a.test.js"], now: NOW }));
    assert.equal(graduation(allMode, opts).graduated, false, "a failure caught by run-everything proves nothing about the selection");
  });
  it("a miss restarts the count, also after graduation", () => {
    const ok = many(50, { failed: ["t/a.test.js"] });
    const g = graduation([...ok, entry({ failed: ["t/c.test.js"], sha: "bad" }), ...many(3)], opts);
    assert.deepEqual([g.graduated, g.streak, g.last_miss.sha], [false, 3, "bad"]);
    assert.match(g.why, /since the last miss/);
  });
  it("a selection-config change restarts the count", () => {
    const g = graduation([...many(50, { failed: ["t/a.test.js"] }), ...many(2, { config: "c2" })], { ...opts, config: "c2" });
    assert.deepEqual([g.graduated, g.streak], [false, 2]);
    assert.match(g.why, /since the selection config changed/);
  });
  it("an enforced run is neutral: it neither counts nor breaks the streak", () => {
    const g = graduation([...many(50, { failed: ["t/a.test.js"] }), ...many(5, { ran: "selection", failed: ["t/c.test.js"] })], opts);
    assert.deepEqual([g.graduated, g.streak], [true, 50]);
  });
});

describe("ledger file", () => {
  it("appends and reads back, skipping torn lines", () => {
    const f = join(tmpDir("recall-"), "deep", "recall.jsonl");
    assert.deepEqual(readLedger(f), []);
    appendLedger(f, entry()); appendFileSync(f, '{"v":1,"at"\n{"other":true}\n'); appendLedger(f, entry({ sha: "t" }));
    assert.deepEqual(readLedger(f).map((e) => e.sha), ["s", "t"]);
    writeFileSync(f, "");
    assert.deepEqual(readLedger(f), []);
  });
});

describe("flaky quarantine from the ledger", () => {
  const at = (d) => NOW - d * DAY;
  const flip = (sha, d, test = "t/a.test.js") => [entry({ sha, failed: [test], runId: `${sha}-1`, now: at(d) }), entry({ sha, failed: [], runId: `${sha}-2`, now: at(d) + 1000 })];
  const cfg = { quarantine: "report", quarantineAfter: 3, quarantineWindowDays: 14 };
  it("a test that failed and then passed on one sha is a flip; a consistent failure is not", () => {
    const f = flakesFromLedger([...flip("s1", 1), entry({ sha: "s2", failed: ["t/b.test.js"] }), entry({ sha: "s2", failed: ["t/b.test.js"] })]);
    assert.deepEqual(f.map((x) => [x.check, x.test, x.kind, x.sha, x.run_ids]), [["tests", "t/a.test.js", "flip", "s1", ["s1-1", "s1-2"]]]);
  });
  it("ignores enforced runs (a test that was not run did not pass)", () => {
    assert.deepEqual(flakesFromLedger([entry({ sha: "s1", failed: ["t/a.test.js"] }), entry({ sha: "s1", ran: "selection" })]), []);
  });
  it("reports a test that flipped K times in the window, blocking by default", () => {
    const entries = [...flip("s1", 1), ...flip("s2", 2), ...flip("s3", 3), ...flip("s4", 1, "t/b.test.js")];
    const q = quarantineFromLedger(entries, cfg, NOW);
    assert.deepEqual(q.map((x) => [x.target, x.count, x.blocking]), [["tests:t/a.test.js", 3, true]]);
    assert.match(q[0].why, /report only/);
    assert.deepEqual(quarantineFromLedger([...flip("s1", 1), ...flip("s2", 2), ...flip("s3", 20)], cfg, NOW), [], "outside the window");
  });
  it("non-blocking only by opt-in, never for an unskippable class, and off reports nothing", () => {
    const entries = [...flip("s1", 1), ...flip("s2", 2), ...flip("s3", 3), ...flip("m1", 1, "tests/migration/test_up.py"), ...flip("m2", 2, "tests/migration/test_up.py"), ...flip("m3", 3, "tests/migration/test_up.py")];
    const q = quarantineFromLedger(entries, { ...cfg, quarantine: "non-blocking" }, NOW);
    assert.deepEqual(q.map((x) => [x.test, x.blocking]), [["t/a.test.js", false], ["tests/migration/test_up.py", true]]);
    assert.match(q[1].why, /unskippable/);
    assert.deepEqual(quarantineFromLedger(entries, { ...cfg, quarantine: "off" }, NOW), []);
  });
});
