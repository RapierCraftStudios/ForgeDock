// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runFixCloseReasonsCli } from "./fixclosereasons.mjs";

const L = (...n) => n.map((name) => ({ name }));
function fake({ lists, failOn } = {}) {
  const calls = [], out = [];
  const gh = async (a) => {
    calls.push(a);
    if (a[0] === "issue" && a[1] === "list") return JSON.stringify(lists[a[a.indexOf("--label") + 1]] ?? []);
    if (a[0] === "api" && failOn === a[3].split("/").pop()) throw new Error("boom");
    return "";
  };
  return { gh, calls, out, print: (t) => out.push(t) };
}
const lists = {
  "workflow:merged": [
    { number: 1, stateReason: "NOT_PLANNED", labels: L("workflow:merged") },
    { number: 2, stateReason: "COMPLETED", labels: L("workflow:merged") },
    { number: 3, stateReason: "NOT_PLANNED", labels: L("workflow:merged", "workflow:invalid") },
  ],
  "workflow:decomposed": [
    { number: 4, stateReason: "NOT_PLANNED", labels: L("workflow:decomposed") },
    { number: 1, stateReason: "NOT_PLANNED", labels: L("workflow:merged", "workflow:decomposed") },
  ],
};

describe("#5177 fix-close-reasons", () => {
  it("re-closes NOT_PLANNED merged and decomposed issues as completed with a comment; leaves the rest", async () => {
    const f = fake({ lists });
    assert.equal(await runFixCloseReasonsCli(["o/r", "--apply"], f), 0);
    const patches = f.calls.filter((a) => a[0] === "api");
    assert.deepEqual(patches.map((a) => a[3]), ["repos/o/r/issues/1", "repos/o/r/issues/4"]);
    for (const p of patches) assert.deepEqual(p.slice(0, 3).concat(p.slice(4)), ["api", "-X", "PATCH", "-f", "state=closed", "-f", "state_reason=completed"]);
    const comments = f.calls.filter((a) => a[1] === "comment");
    assert.deepEqual(comments.map((a) => a[2]), ["1", "4"]);
    assert.match(comments[0][comments[0].indexOf("--body") + 1], /delivered and merged/);
    assert.match(comments[1][comments[1].indexOf("--body") + 1], /decomposed/);
    assert.match(f.out.at(-1), /2 found, 2 changed, 0 failed/);
  });
  it("is a dry run without --apply: no write", async () => {
    const f = fake({ lists });
    assert.equal(await runFixCloseReasonsCli(["o/r"], f), 0);
    assert.equal(f.calls.filter((a) => a[0] !== "issue" || a[1] !== "list").length, 0);
    assert.match(f.out.join("\n"), /would re-close #1/);
  });
  it("--milestone narrows the list query", async () => {
    const f = fake({ lists: {} });
    await runFixCloseReasonsCli(["o/r", "--milestone", "M1"], f);
    for (const c of f.calls) assert.equal(c[c.indexOf("--milestone") + 1], "M1");
    assert.equal(f.calls.length, 2);
  });
  it("counts a failed write and exits 1, continuing with the next issue", async () => {
    const f = fake({ lists, failOn: "1" });
    assert.equal(await runFixCloseReasonsCli(["o/r", "--apply"], f), 1);
    assert.match(f.out.at(-1), /2 found, 1 changed, 1 failed/);
  });
  it("throws usage without a repo", async () => {
    await assert.rejects(runFixCloseReasonsCli([], fake()), /usage: forgedock fix-close-reasons/);
    await assert.rejects(runFixCloseReasonsCli(["--apply"], fake()), /usage/);
  });
});
