// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { openBatch } from "./batch.mjs";
import { validateExecutionPatch, sanitizeOverride, effectiveExecution, parseSetExecution, applySetExecution, formatOverride, lazyWeight, liveRemote, LIVE_MODES } from "./live-execution.mjs";

describe("#5138 live execution control", () => {
  it("validates patches: max_remote a non-negative integer, mode remote|hybrid|local", () => {
    assert.deepEqual(LIVE_MODES, ["remote", "hybrid", "local"]);
    assert.deepEqual(validateExecutionPatch({ maxRemote: 0, mode: "local" }), { maxRemote: 0, mode: "local" });
    assert.deepEqual(validateExecutionPatch({ maxRemote: "3" }), { maxRemote: 3 });
    for (const bad of [{ maxRemote: -1 }, { maxRemote: 1.5 }, { maxRemote: "x" }]) assert.throws(() => validateExecutionPatch(bad), /non-negative integer/);
    assert.throws(() => validateExecutionPatch({ mode: "cloud" }), /placement must be one of/);
    assert.throws(() => validateExecutionPatch({ provider: "yes" }), /boolean/);
    assert.deepEqual(sanitizeOverride({ maxRemote: -2, mode: "x", provider: true }), { provider: true });
    assert.equal(sanitizeOverride(null), null);
  });

  it("merges the override over the pinned exec", () => {
    const exec = { mode: "remote", maxRemote: 4, provider: "container" };
    assert.deepEqual(effectiveExecution(exec, null), exec);
    assert.deepEqual(effectiveExecution(exec, { maxRemote: 1, mode: "hybrid" }), { mode: "hybrid", maxRemote: 1, provider: "container" });
    assert.equal(formatOverride({ maxRemote: 2, mode: "hybrid" }), "max_remote 2, placement hybrid");
  });

  it("parses --set-max-remote / --set-placement", () => {
    assert.equal(parseSetExecution(["--set-parallel", "b", "2"]), null);
    assert.deepEqual(parseSetExecution(["--set-max-remote", "b1", "2"]), { id: "b1", patch: { maxRemote: 2 } });
    assert.deepEqual(parseSetExecution(["--set-placement", "b1", "hybrid", "--set-max-remote", "b1", "0"]), { id: "b1", patch: { maxRemote: 0, mode: "hybrid" } });
    assert.throws(() => parseSetExecution(["--set-max-remote", "b1", "-1"]), /non-negative/);
    assert.throws(() => parseSetExecution(["--set-placement", "b1"]), /usage/);
    assert.throws(() => parseSetExecution(["--set-placement", "b1", "x"]), /placement must be/);
    assert.throws(() => parseSetExecution(["--set-placement", "b1", "local", "--set-max-remote", "b2", "1"]), /same batch/);
  });

  it("applySetExecution: missing batch and a provider-less batch going remote/hybrid are refused", () => {
    const root = tmpDir("live-exec-");
    assert.throws(() => applySetExecution(openBatch(root, "nope"), { mode: "local" }), /no batch nope/);
    const b = openBatch(root, "b1");
    b.writePlan({ argv: ["1"] });
    for (const mode of ["remote", "hybrid"]) assert.throws(() => applySetExecution(b, { mode }), /no remote provider/);
    assert.deepEqual(applySetExecution(b, { mode: "local", maxRemote: 0 }), { mode: "local", maxRemote: 0 });
    b.setExecution({ provider: true });
    assert.deepEqual(applySetExecution(b, { mode: "hybrid" }), { mode: "hybrid", maxRemote: 0, provider: true });
    assert.deepEqual(b.readExecution(), { mode: "hybrid", maxRemote: 0, provider: true });
  });

  it("liveRemote getters follow the override file; local places on the host; onChange once per change", () => {
    let o = null;
    const changes = [], placed = [];
    const r = liveRemote({ onBudget: "stop" }, { exec: { mode: "remote", maxRemote: 2 }, readOverride: () => o, onChange: (e) => changes.push(`${e.mode}/${e.maxRemote}`),
      place: (e, n) => { placed.push([e.mode, n]); return { where: "remote", reason: `mode ${e.mode}` }; } });
    assert.equal(r.max, 2);
    assert.equal(r.fallbackLocal, false);
    assert.deepEqual(r.place(1), { where: "remote", reason: "mode remote" });
    o = { maxRemote: 5 };
    assert.equal(r.max, 5);
    o = { maxRemote: 5, mode: "hybrid" };
    assert.equal(r.fallbackLocal, true);
    r.place(2);
    o = { maxRemote: 5, mode: "local" };
    assert.deepEqual(r.place(3), { where: "local", reason: "live placement: local" });
    assert.deepEqual(placed, [["remote", 1], ["hybrid", 2]]);
    assert.deepEqual(changes, ["remote/5", "hybrid/5", "local/5"]);
    assert.equal({ ...r }.onBudget, "stop");
  });

  it("lazyWeight is light until the computed weight resolves, and computes once", async () => {
    let calls = 0;
    const w = lazyWeight({ compute: async () => { calls++; return { heavy: true, signals: ["tsc"] }; } });
    assert.deepEqual(w.get(), { heavy: false, signals: [] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(w.get(), { heavy: true, signals: ["tsc"] });
    w.get();
    assert.equal(calls, 1);
    assert.deepEqual(lazyWeight({ initial: { heavy: true, signals: [] } }).get(), { heavy: true, signals: [] });
    const failing = lazyWeight({ compute: () => { throw new Error("scan"); } });
    failing.get(); await new Promise((r) => setImmediate(r));
    assert.deepEqual(failing.get(), { heavy: false, signals: [] });
  });
});
