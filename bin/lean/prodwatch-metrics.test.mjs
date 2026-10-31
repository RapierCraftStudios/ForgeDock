// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, sourceMode, emitMetrics } from "./prodwatch-metrics.mjs";
import { effectiveMode } from "./decision-engine.mjs";

const H = 3600_000;
const row = (o) => ({ source: "memo", signalAt: 0, ...o });

describe("#4837 prodwatch metrics", () => {
  it("computes timings and rates per source", () => {
    const m = computeMetrics([
      row({ fp: "a", issueAt: H, mergedAt: 5 * H, verifiedAt: 6 * H }),
      row({ fp: "b", issueAt: 3 * H, mergedAt: 9 * H, reopened: true }),
      row({ fp: "a", invalid: true }),
      row({ fp: "c", invalid: true, issueAt: "1970-01-01T05:00:00Z" }),
      { source: "sql", signalAt: 0, issueAt: H },
    ]).memo;
    assert.equal(m.sample, 4);
    assert.equal(m.fp_rate, 0.5);
    assert.equal(m.fix_ineffective_rate, 0.5);
    assert.equal(m.recurrence_rate, 0.25);
    assert.equal(m.signal_to_issue_ms, 3 * H);
    assert.equal(m.signal_to_merge_ms, 7 * H);
    assert.equal(m.signal_to_verified_ms, 6 * H);
  });

  it("tolerates empty, malformed and missing timestamps", () => {
    assert.deepEqual(computeMetrics(null), {});
    const m = computeMetrics([row({ issueAt: "bad" }), null, { signalAt: 1 }]).memo;
    assert.equal(m.signal_to_issue_ms, null);
    assert.equal(m.fix_ineffective_rate, 0);
  });

  it("sourceMode drops to shadow only above the cap over the minimum sample", () => {
    assert.equal(sourceMode("memo", { sample: 4, invalid: 4 }).mode, "live");
    assert.deepEqual(sourceMode("memo", { sample: 10, invalid: 5 }), { mode: "live", gated: false, rate: 0.5 });
    assert.deepEqual(sourceMode("memo", { sample: 10, invalid: 6 }), { mode: "shadow", gated: true, rate: 0.6 });
    assert.equal(sourceMode("memo", { memo: { sample: 10, invalid: 9 } }).mode, "shadow");
    assert.equal(sourceMode("memo", { memo: { sample: 10, invalid: 9 } }, { max: 0.95 }).mode, "live");
    assert.equal(sourceMode("memo", undefined).mode, "live");
  });

  it("matches effectiveMode calibration at the sample boundary", () => {
    const e = effectiveMode({ mode: "live", reversalMax: 0.5 }, { decided: 5, reversed: 3 });
    assert.equal(sourceMode("s", { sample: 5, invalid: 3 }).mode, e.mode);
  });

  it("emits one record per source and never throws", () => {
    const got = [];
    assert.equal(emitMetrics(computeMetrics([row({}), { source: "sql", signalAt: 0 }]), { emit: (r) => got.push(r) }), 2);
    assert.deepEqual(got.map((r) => [r.event, r.source]), [["PRODWATCH_METRICS", "memo"], ["PRODWATCH_METRICS", "sql"]]);
    assert.equal(emitMetrics({ a: {} }, { emit: () => { throw new Error("x"); } }), 0);
  });
});
