// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEmitTelemetry, mapRecord } from "./telemetry-seam.mjs";

const attempt = { event: "PHASE_ATTEMPT_USAGE", phase: "build", attempt: 2, issue: 7, duration_ms: 1234, cost_usd: 0.123456789, model: "sonnet", turns: null,
  usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } };

function harness(over = {}) {
  const calls = [];
  const emit = makeEmitTelemetry({ repo: "o/r", emitFn: (...a) => { calls.push(a); }, now: () => 5000, env: {}, ...over });
  return { calls, emit };
}

describe("engine telemetry seam", () => {
  it("flattens usage, omits nulls and passes repo/issue/run/phase as ctx (not payload)", async () => {
    const { calls, emit } = harness();
    await emit(attempt);
    const [event, payload, ctx] = calls[0];
    assert.equal(event, "phase_attempt");
    assert.deepEqual(payload, { attempt: 2, model: "sonnet", duration_ms: 1234, cost_usd: 0.123457, input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 4 });
    assert.equal(ctx.repo, "o/r");
    assert.equal(ctx.issue, 7);
    assert.equal(ctx.phase, "build");
    assert.match(ctx.run, /^r_7_\d+$/);
    for (const v of Object.values(payload)) assert.notEqual(typeof v, "object");
  });
  it("maps RUN_TERMINAL with reason, code and wall time; ignores other records", async () => {
    let t = 1000;
    const { calls, emit } = harness({ now: () => t });
    t = 61000;
    await emit({ event: "RUN_TERMINAL", reason: "needs-human", code: "review.escalated", issue: 7 });
    await emit({ event: "PHASE_START", phase: "build", issue: 7 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "run_terminal");
    assert.deepEqual(calls[0][1], { reason: "needs-human", code: "review.escalated", wall_ms: 60000 });
    assert.equal(calls[0][2].phase, undefined);
  });
  it("null usage yields a record with no token fields", () => {
    assert.deepEqual(mapRecord({ event: "PHASE_ATTEMPT_USAGE", phase: "build", attempt: 1, usage: null, duration_ms: 5 }).payload, { attempt: 1, duration_ms: 5 });
  });
  it("never throws, even when the emitter throws, and honours FORGE_TELEMETRY=off", async () => {
    const boom = harness({ emitFn: () => { throw new Error("down"); } });
    await boom.emit(attempt);
    const off = harness({ env: { FORGE_TELEMETRY: "off" } });
    await off.emit(attempt);
    assert.equal(off.calls.length, 0);
  });
  it("drops records with no resolvable repo (the Node emitter would drop them) and resolves lazily once", async () => {
    let resolves = 0;
    const none = harness({ repo: null, resolveRepo: () => { resolves++; return null; } });
    await none.emit(attempt); await none.emit(attempt);
    assert.equal(none.calls.length, 0);
    assert.equal(resolves, 1);
    const some = harness({ repo: null, resolveRepo: () => "a/b" });
    await some.emit(attempt);
    assert.equal(some.calls[0][2].repo, "a/b");
  });
});
