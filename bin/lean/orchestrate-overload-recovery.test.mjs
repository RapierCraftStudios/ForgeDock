// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5749: an env.validate_timeout recovery lane waits while the host is overloaded; other recoveries are unchanged.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orchestrate } from "./orchestrate.mjs";

const harness = ({ script, overloadedUntil }) => {
  let t = 1_000_000; const calls = [], decisions = [];
  return orchestrate({ issues: [7], parallel: 1, readBody: async () => "", now: () => t, pollMs: 1000,
    sleep: async (ms) => { t += Math.max(1, Number(ms) || 0); },
    recovery: { maxAttempts: 1, mechanicalMaxAttempts: 3 },
    overload: () => ({ overloaded: overloadedUntil > 0 && t >= 1_000_500 && t < overloadedUntil }), // the first admission precedes the load spike
    runOne: async (n, _l, ctx = {}) => { calls.push({ recover: ctx.recover?.attempt ?? 0, at: t }); t += 1000; const k = calls.length - 1; return script[Math.min(k, script.length - 1)]; },
    decide: (d) => decisions.push(d), onUpdate: () => {} }).then((rows) => ({ rows, calls, decisions, start: 1_000_000 }));
};
const TIMEOUT = { terminalReason: "needs-human", code: "env.validate_timeout", detail: "timed out", cost_usd: 1 };
const UNIMPL = { terminalReason: "needs-human", code: "conformance.unimplemented", detail: "V1 missing", cost_usd: 1 };
const MERGED = { terminalReason: "merged", pr: 1 };

describe("#5749 overload defers env.validate_timeout recovery", () => {
  it("#5749 env.validate_timeout recovery waits while overloaded", async () => {
    const o = await harness({ script: [TIMEOUT, MERGED], overloadedUntil: 1_000_000 + 60_000 });
    assert.equal(o.calls.length, 2);
    assert.ok(o.calls[1].at >= 1_000_000 + 60_000, `recovery started at +${o.calls[1].at - o.start} ms, before the overload cleared`);
    assert.ok(o.decisions.some((d) => /deferred: the host is overloaded/.test(d.what)));
    const n = await harness({ script: [TIMEOUT, MERGED], overloadedUntil: 0 });
    assert.ok(n.calls[1].at < 1_000_000 + 10_000, "no overload: the recovery starts at once");
    assert.ok(!n.decisions.some((d) => /overloaded/.test(d.what)));
  });
  it("#5749 conformance.unimplemented keeps resume counts under overload", async () => {
    const o = await harness({ script: [UNIMPL, MERGED], overloadedUntil: 1_000_000 + 60_000 });
    assert.equal(o.calls.length, 2);
    assert.equal(o.calls[1].recover, 1, "the same single recovery attempt as before");
    assert.ok(!o.decisions.some((d) => /overloaded/.test(d.what)));
  });
});
