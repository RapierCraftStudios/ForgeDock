// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5647: while a recovery lane is queued or running the issue shows workflow:recovering, not needs-human.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { orchestrate } from "./orchestrate.mjs";

process.env.FORGEDOCK_SCHED_DIR = tmpDir("recovering-sched-");
const NH = (code) => ({ terminalReason: "needs-human", code, detail: `ended ${code}` });
const run = (script, extra = {}) => {
  const marks = [], relabels = [], rows = [];
  let k = 0;
  return orchestrate({ issues: [1], parallel: 1, recovery: { maxAttempts: 1 }, readBody: async () => "", onUpdate: (r) => rows.push(r.outcome),
    runOne: async () => script[Math.min(k++, script.length - 1)],
    markRecovering: async (x) => { marks.push(x); }, relabelNeedsHuman: async (x) => { relabels.push(x); }, ...extra })
    .then((res) => ({ res, marks, relabels, rows }));
};

describe("workflow:recovering during recovery (#5647)", () => {
  it("a recoverable needs-human row calls markRecovering once with attempt/max and the row goes recovering", async () => {
    const r = await run([NH("base.conflict"), { terminalReason: "merged" }]);
    assert.deepEqual(r.marks, [{ issue: 1, code: "base.conflict", attempt: 1, max: 1 }]);
    assert.ok(r.rows.includes("recovering"));
    assert.equal(r.res[0].outcome, "merged");
    assert.deepEqual(r.relabels, []);
  });
  it("a throwing markRecovering does not block the recovery lane", async () => {
    const r = await run([NH("base.conflict"), { terminalReason: "merged" }], { markRecovering: async () => { throw new Error("gh down"); } });
    assert.equal(r.res[0].outcome, "merged");
  });
  it("an exhausted recovery ends needs-human through relabelNeedsHuman, after the single mark", async () => {
    const r = await run([NH("base.conflict"), NH("base.conflict")]);
    assert.equal(r.marks.length, 1);
    assert.equal(r.res[0].outcome, "needs-human");
    assert.equal(r.relabels.length, 1);
  });
  it("a human-owned code is never marked recovering", async () => {
    const r = await run([NH("builder.blocked")]);
    assert.deepEqual(r.marks, []);
  });
});
