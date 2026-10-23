// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// #4432: issue numbers are per repo, so the host-global run log is keyed by repo + issue.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import * as runlog from "../engine/runlog.mjs";
import { lastLocalRun } from "../engine-cli.mjs";
import { readLocalRuns } from "../stats/local-source.mjs";

const { appendEvent, readLog } = runlog;
const ONE = "acme/one", TWO = "acme/two";
const lines = (path) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const write = (path, events) => writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

describe("run log keyed by repo + issue (#4432)", () => {
  it("two repos with the same issue number produce separate run logs", () => {
    const dir = tmpDir("runlog-repo-");
    appendEvent(dir, 2, { event: "RUN_START", issue: 2, repo: ONE }, { repo: ONE });
    appendEvent(dir, 2, { event: "RUN_START", issue: 2, repo: TWO }, { repo: TWO });
    appendEvent(dir, 2, { event: "PHASE_START", phase: "implement" }, { repo: ONE });
    const one = readLog(dir, 2, { repo: ONE }), two = readLog(dir, 2, { repo: TWO });
    assert.deepEqual(one.map((e) => [e.seq, e.event, e.repo ?? null]), [[1, "RUN_START", ONE], [2, "PHASE_START", null]]);
    assert.deepEqual(two.map((e) => [e.seq, e.event, e.repo]), [[1, "RUN_START", TWO]]);
    assert.deepEqual(readdirSync(dir).sort(), ["acme__one__2.jsonl", "acme__two__2.jsonl"]);
  });

  it("no repo keeps the legacy <issue>.jsonl name", () => {
    const dir = tmpDir("runlog-repo-");
    appendEvent(dir, 5, { event: "RUN_START", issue: 5 });
    assert.deepEqual(readdirSync(dir), ["5.jsonl"]);
    assert.equal(readLog(dir, 5).length, 1);
    assert.equal(runlog.runLogPath(dir, 5, "a b/c"), join(dir, "a_b__c__5.jsonl"), "segments are sanitised");
  });

  it("read fallback: with no repo file, only that repo's slices of the legacy file are returned", () => {
    const dir = tmpDir("runlog-repo-");
    write(join(dir, "2.jsonl"), [
      { seq: 1, event: "RUN_START", repo: ONE, run: "a" }, { seq: 2, event: "PHASE_START", phase: "x" },
      { seq: 3, event: "RUN_START", repo: TWO, run: "b" }, { seq: 4, event: "RUN_TERMINAL", reason: "merged" },
      { seq: 5, event: "RUN_START", repo: ONE, run: "c" },
    ]);
    assert.deepEqual(readLog(dir, 2, { repo: ONE }).map((e) => e.seq), [1, 2, 5]);
    assert.deepEqual(readLog(dir, 2, { repo: TWO }).map((e) => e.seq), [3, 4]);
    assert.deepEqual(readLog(dir, 2, { repo: "acme/three" }), []);
    assert.equal(readLog(dir, 2).length, 5, "no repo reads the legacy file as is");
  });
});

describe("migrateRunLogs (#4432)", () => {
  it("splits a legacy file holding two repos by RUN_START.repo; repo-less slices stay; idempotent", () => {
    const dir = tmpDir("runlog-migrate-");
    write(join(dir, "2.jsonl"), [
      { seq: 1, event: "PHASE_START", phase: "orphan" }, // before any RUN_START: unattributable
      { seq: 2, event: "RUN_START", repo: ONE, run: "a", ts: "t2" }, { seq: 3, event: "PHASE_COMMIT", phase: "build" },
      { seq: 4, event: "RUN_START", repo: TWO, run: "b" }, { seq: 5, event: "RUN_TERMINAL", reason: "merged" },
      { seq: 6, event: "RUN_START", run: "old" }, { seq: 7, event: "RUN_TERMINAL", reason: "done" }, // no repo
      { seq: 8, event: "RUN_START", repo: ONE, run: "c" },
    ]);
    // the repo file already holds a newer run: it is kept after the migrated slices
    write(join(dir, "acme__one__2.jsonl"), [{ seq: 1, event: "RUN_START", repo: ONE, run: "new" }]);
    write(join(dir, "7.jsonl"), [{ seq: 1, event: "RUN_START", repo: TWO, run: "z" }]);
    const res = runlog.migrateRunLogs(dir);
    assert.deepEqual(res, { files: 2, slices: 4, kept: 1 });
    const one = lines(join(dir, "acme__one__2.jsonl"));
    assert.deepEqual(one.map((e) => [e.seq, e.event, e.run ?? e.phase ?? null]), [[1, "RUN_START", "a"], [2, "PHASE_COMMIT", "build"], [3, "RUN_START", "c"], [4, "RUN_START", "new"]]);
    assert.equal(one[0].ts, "t2", "fields other than seq are kept");
    assert.deepEqual(lines(join(dir, "acme__two__2.jsonl")).map((e) => [e.seq, e.event]), [[1, "RUN_START"], [2, "RUN_TERMINAL"]]);
    assert.deepEqual(lines(join(dir, "2.jsonl")).map((e) => e.run ?? e.phase), ["orphan", "old", undefined]);
    assert.deepEqual(lines(join(dir, "acme__two__7.jsonl")).map((e) => e.run), ["z"]);
    assert.ok(!existsSync(join(dir, "7.jsonl")), "a fully attributed legacy file is gone");
    assert.ok(!readdirSync(dir).some((f) => f.includes(".migrating-") || f.includes(".tmp-")), "no claim or tmp file left");
    const before = readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]);
    runlog.migrateRunLogs(dir); // the remainder holds only repo-less slices: nothing moves
    assert.deepEqual(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]), before);
    appendEvent(dir, 2, { event: "PHASE_START", phase: "next" }, { repo: ONE });
    assert.equal(readLog(dir, 2, { repo: ONE }).at(-1).seq, 5, "appends continue the renumbered seq");
  });

  it("a corrupt legacy file is left in place; a missing dir is a no-op", () => {
    const dir = tmpDir("runlog-migrate-");
    writeFileSync(join(dir, "3.jsonl"), '{"seq":1,"event":"RUN_START","repo":"acme/one"}\nnot json\n{"seq":3,"event":"RUN_TERMINAL"}\n');
    assert.deepEqual(runlog.migrateRunLogs(dir), { files: 0, slices: 0, kept: 0 });
    assert.deepEqual(readdirSync(dir), ["3.jsonl"]);
    assert.deepEqual(runlog.migrateRunLogs(join(dir, "absent")), { files: 0, slices: 0, kept: 0 });
  });
});

describe("enumerators read repo-keyed names (#4432)", () => {
  it("lastLocalRun and readLocalRuns take the issue number from a repo-keyed file", () => {
    const dir = tmpDir("runlog-enum-");
    appendEvent(dir, 12, { event: "RUN_START", issue: 12, repo: ONE }, { repo: ONE });
    appendEvent(dir, 12, { event: "RUN_TERMINAL", reason: "merged" }, { repo: ONE });
    appendEvent(dir, 3, { event: "RUN_START", issue: 3 });
    utimesSync(join(dir, "3.jsonl"), new Date(1000), new Date(1000));
    assert.deepEqual(lastLocalRun(dir), { issue: 12, terminal: true, terminalReason: "merged" });
    const runs = readLocalRuns(dir);
    assert.ok(runs.some((r) => r.issue === 12 && r.repo === ONE), JSON.stringify(runs));
  });
});
