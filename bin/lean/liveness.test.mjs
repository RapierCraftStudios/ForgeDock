// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { holderGone, classifyTransportLoss, sandboxBudgetKey } from "./liveness.mjs";

describe("#5991 liveness helpers", () => {
  it("holderGone: only a lease whose batch is known not live", () => {
    assert.equal(holderGone({ batch: "b1" }, { liveBatches: ["b2"] }), true);
    assert.equal(holderGone({ batch: "b1" }, { liveBatches: new Set(["b1"]) }), false);
    assert.equal(holderGone({ batch: "b1" }, { liveBatches: [] }), true);
    // negative examples: unknown liveness, no batch on the lease, no lease
    assert.equal(holderGone({ batch: "b1" }, { liveBatches: null }), false);
    assert.equal(holderGone({ batch: "b1" }), false);
    assert.equal(holderGone({ by: "x" }, { liveBatches: ["b2"] }), false);
    assert.equal(holderGone(null, { liveBatches: [] }), false);
  });
  it("classifyTransportLoss: 90 s with the agent answering, the window otherwise", () => {
    assert.equal(classifyTransportLoss({ agentOnline: true, waitedMs: 90000, windowMs: 300000 }), "unreachable");
    assert.equal(classifyTransportLoss({ agentOnline: true, waitedMs: 89999, windowMs: 300000 }), "wait");
    assert.equal(classifyTransportLoss({ agentOnline: false, waitedMs: 200000, windowMs: 300000 }), "wait");
    assert.equal(classifyTransportLoss({ agentOnline: null, waitedMs: 299999, windowMs: 300000 }), "wait");
    assert.equal(classifyTransportLoss({ agentOnline: null, waitedMs: 300000, windowMs: 300000 }), "unreachable");
    assert.equal(classifyTransportLoss({ agentOnline: true, waitedMs: 5000, windowMs: 5000 }), "unreachable"); // a shorter window still wins
  });
  it("sandboxBudgetKey is stable per sandbox lifetime", () => {
    assert.equal(sandboxBudgetKey("b1", "fdrsbx-9"), sandboxBudgetKey("b1", "fdrsbx-9"));
    assert.notEqual(sandboxBudgetKey("b1", "fdrsbx-9"), sandboxBudgetKey("b2", "fdrsbx-9"));
  });
});
