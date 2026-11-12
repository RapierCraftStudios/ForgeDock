// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { postMergeStep } from "./release-postmerge.mjs";
import { fenceCheck, fenced, epochTrailer, epochMarker } from "./release-fence.mjs";

const mkCtx = (active) => ({ repo: "o/r", credential: "driver", io: { api: async (_m, path) => {
  if (!/contents\/active\.json\?ref=_active$/.test(path)) throw new Error(`unrouted ${path}`);
  if (active.get() instanceof Error) throw active.get();
  return { content: Buffer.from(JSON.stringify(active.get())).toString("base64") };
} } });
const cell = (v) => ({ v, get() { return this.v; } });
const act = (holder, epoch) => ({ epoch, lease: { holder, epoch } });
const LEASE = { holder: "A", epoch: 1 };
const mkFence = (active, rec = []) => ({ lctx: mkCtx(active), lease: LEASE, now: () => "t", record: async (r) => { rec.push(r); } });

describe("release fence (#5553)", () => {
  it("fenceCheck: ok for the current lease, fenced after a takeover, unreadable when _active cannot be read", async () => {
    const a = cell(act("A", 1)), ctx = mkCtx(a);
    assert.deepEqual(await fenceCheck(ctx, LEASE), { ok: true, epoch: 1 });
    a.v = act("B", 2);
    assert.deepEqual(await fenceCheck(ctx, LEASE), { fenced: true, current: 2 });
    a.v = new Error("HTTP 503");
    assert.match((await fenceCheck(ctx, LEASE)).unreadable, /503/);
  });

  it("the intent is written before the effect, names the epoch, and the effect receives it", async () => {
    const order = [], a = cell(act("A", 1)), f = mkFence(a);
    f.record = async (r) => { order.push(`record:${r.action}:${r.epoch}:${!!r.done}`); };
    const r = await fenced(f, { action: "merge", key: "k" }, async (e) => { order.push(`effect:${e}`); return "v"; });
    assert.deepEqual(r, { ok: true, value: "v" });
    assert.deepEqual(order, ["record:merge:1:false", "effect:1", "record:merge:1:true"]);
  });

  it("zombie: after a takeover the effect and the intent are never run", async () => {
    const rec = [], a = cell(act("B", 2));
    let ran = 0;
    const r = await fenced(mkFence(a, rec), { action: "dispatch", key: "k" }, async () => { ran++; });
    assert.match(r.refused, /fenced/);
    assert.equal(ran, 0);
    assert.equal(rec.length, 0);
  });

  it("a takeover that slips in between the first read and the intent write is caught by the re-check", async () => {
    const a = cell(act("A", 1)), f = mkFence(a);
    f.record = async () => { a.v = act("B", 2); };
    let ran = 0;
    assert.match((await fenced(f, { action: "merge", key: "k" }, async () => { ran++; })).refused, /fenced/);
    assert.equal(ran, 0);
  });

  it("I5: an unreadable _active performs no irreversible action", async () => {
    let ran = 0;
    const r = await fenced(mkFence(cell(new Error("partition"))), { action: "rerun", key: "k" }, async () => { ran++; });
    assert.match(r.refused, /cannot read _active/);
    assert.equal(ran, 0);
  });

  it("without a fence (unmanaged release) the effect just runs with no epoch", async () => {
    assert.deepEqual(await fenced(null, { action: "merge", key: "k" }, async (e) => e), { ok: true, value: null });
  });

  it("the epoch carriers", () => {
    assert.equal(epochTrailer(3), "Forge-Epoch: 3");
    assert.equal(epochMarker(3), "<!-- FORGE:EPOCH 3 -->");
  });

  it("publish.yml accepts forge_epoch and rejects a stale one as its first step", () => {
    const y = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
    assert.match(y, /workflow_dispatch:[^\n]*\n\s+inputs:\n\s+forge_epoch:/);
    assert.match(y, /    steps:\n      - name: Reject a stale forge_epoch/);
    assert.match(y, /ref=_active/);
  });

  it("post-merge dispatch carries forge_epoch; a fenced host dispatches nothing", async () => {
    const run = async (active) => {
      const calls = []; let listed = 0;
      const io = { print() {}, sleep: async () => {}, gh: async (a) => {
        calls.push(a);
        if (a[0] === "pr" && a[1] === "view") return JSON.stringify({ state: "MERGED", mergeCommit: { oid: "m".repeat(40) } });
        if (a[0] === "run" && a[1] === "list") return JSON.stringify(++listed <= 2 ? [] : [{ databaseId: 5, status: "completed", conclusion: "success" }]);
        return "";
      } };
      const ctx = { io, repo: "o/r", def: "main", staging: "staging", config: { postMerge: { publishPolls: 2, runPolls: 2 } }, state: { steps: { "release-pr": { result: { pr: 7 } } } }, fence: mkFence(cell(active)) };
      return { out: await postMergeStep(ctx), calls };
    };
    const good = await run(act("A", 1));
    assert.equal(good.out.published, true);
    assert.deepEqual(good.calls.find((a) => a[0] === "workflow").slice(-2), ["-f", "forge_epoch=1"]);
    const zombie = await run(act("B", 2));
    assert.equal(zombie.out.blocked, true);
    assert.equal(zombie.calls.some((a) => a[0] === "workflow"), false);
  });
});
