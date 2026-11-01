// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4965: the scheduler pass that adds epic and late children to a running batch.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";

const merged = { terminalReason: "merged" };
const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); } };

/** A batch with epic #1 running behind a gate; `list` is what the one list call returns. */
async function run({ mode, list, pollS = 0.001, elsewhere = [], epics = [], bodies = {}, extra = {} }) {
  const started = [], log = [], decisions = [];
  let calls = 0, open;
  const g = new Promise((r) => { open = r; });
  const done = orchestrate({ issues: [1], parallel: 3, pollMs: 5, trusted: () => true, readBody: async (n) => bodies[n] ?? "", onUpdate: (r) => log.push(r), decide: (d) => decisions.push(d),
    autoChildren: { mode, pollS, epics }, getChildren: async () => { calls++; return { list: typeof list === "function" ? list() : list, elsewhere }; },
    runOne: async (n) => { started.push(n); if (n === 1) await g; return merged; }, ...extra });
  return { started, log, decisions, calls: () => calls, open, done };
}
const L = (...kids) => [{ number: 1, body: "", labels: [] }, ...kids.map((n) => ({ number: n, body: "**Parent**: #1", labels: [] }))];

describe("#4965 auto_add_children", () => {
  it("epic: adds open children of a batch issue, one decision and one added row listing them", async () => {
    const r = await run({ mode: "epic", list: L(2, 3), bodies: { 3: "Blocked by #2" } });
    await until(() => r.started.includes(2) && r.started.includes(3));
    r.open(); await r.done;
    const added = r.log.filter((x) => x.outcome === "added");
    assert.equal(added.length, 1);
    assert.match(added[0].detail, /#2, #3; edges #3 blocked by #2/);
    assert.equal(r.decisions.filter((d) => /auto_add_children/.test(d.what)).length, 1);
    assert.ok(r.started.indexOf(2) < r.started.indexOf(3));
  });
  it("decomposed (default) and off never call getChildren", async () => {
    for (const mode of ["decomposed", "off"]) {
      const r = await run({ mode, list: L(2) });
      await new Promise((x) => setTimeout(x, 40));
      r.open(); await r.done;
      assert.equal(r.calls(), 0, mode);
      assert.deepEqual(r.started, [1]);
    }
  });
  it("needs-human children and children live in another batch are not added", async () => {
    const list = [...L(2, 3), { number: 4, body: "**Parent**: #1", labels: [{ name: "needs-human" }] }];
    const r = await run({ mode: "all", list, elsewhere: [3] });
    await until(() => r.started.includes(2));
    await new Promise((x) => setTimeout(x, 40));
    r.open(); await r.done;
    assert.deepEqual([...r.started].sort(), [1, 2]);
  });
  it("an --epic root outside the batch adds its children; late children join on a later pass", async () => {
    let list = [{ number: 50, body: "", labels: [] }, { number: 51, body: "**Parent**: #50", labels: [] }];
    const r = await run({ mode: "epic", epics: [50], list: () => list });
    await until(() => r.started.includes(51));
    list = [...list, { number: 52, body: "**Parent**: #50", labels: [] }];
    await until(() => r.started.includes(52));
    r.open(); await r.done;
    assert.equal(r.log.filter((x) => x.outcome === "added").length, 2);
  });
  it("scans at most once per poll window: one list call per pass", async () => {
    const r = await run({ mode: "epic", list: L(), pollS: 3600 });
    await new Promise((x) => setTimeout(x, 80));
    r.open(); await r.done;
    assert.equal(r.calls(), 1);
  });
  it("a decomposed lane's sub-issues join in decomposed|epic|all, not in off", async () => {
    for (const [mode, joins] of [["decomposed", true], ["epic", true], ["all", true], ["off", false]]) {
      const started = [];
      await orchestrate({ issues: [1], parallel: 3, pollMs: 5, readBody: async () => "", autoChildren: { mode, pollS: 3600 }, getChildren: async () => ({ list: [], elsewhere: [] }),
        runOne: async (n) => { started.push(n); return n === 1 ? { terminalReason: "decomposed", subissues: [2] } : merged; } });
      assert.equal(started.includes(2), joins, mode);
    }
  });
});
