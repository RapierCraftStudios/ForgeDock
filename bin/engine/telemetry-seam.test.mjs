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
  it("maps STRUCTURE_DELTA (forge#4159) to structure_delta with scalar counts and 0/1 flags", () => {
    const m = mapRecord({ event: "STRUCTURE_DELTA", issue: 7, edges_added: 1, edges_removed: 0, import_files_added: 8, import_files_removed: 2, boundary_changed: true, boundary_loosened: false }, 10);
    assert.deepEqual(m, { event: "structure_delta", phase: "implement", payload: { edges_added: 1, edges_removed: 0, import_files_added: 8, import_files_removed: 2, boundary_changed: 1, boundary_loosened: 0 } });
  });
  it("forge#4165: the merge-time STRUCTURE_DELTA and RUN_TERMINAL carry scalar lists, milestone and the pr in ctx", async () => {
    const { calls, emit } = harness();
    await emit({ event: "STRUCTURE_DELTA", issue: 7, pr: 41, phase: "merge", milestone: "M", edges_added: 1, edges_removed: 0, import_files_added: 2, import_files_removed: 0,
      boundary_changed: false, boundary_loosened: false, deps_added: [{ from: "@s/a", to: "@s/b" }], deps_removed: [], new_edges: [{ from: "@s/a", to: "@s/c", file: "x.ts" }, { from: "@s/d", to: "@s/c" }],
      removed_edges: [], top_growth: [{ file: "x.ts", lines: 9 }], decisions: [{ id: "K1", source: "lint" }, { id: "K2", source: null }] });
    await emit({ event: "RUN_TERMINAL", issue: 7, pr: 41, reason: "merged", code: null, milestone: "M", conformance_mode: "shadow", shadow_would: "conforms" });
    assert.equal(calls.length, 2);
    const [[e1, p1, c1], [e2, p2, c2]] = calls;
    assert.deepEqual([e1, c1.pr, c1.phase, e2, c2.pr], ["structure_delta", 41, "merge", "run_terminal", 41]);
    assert.deepEqual([p1.deps_added, p1.new_edges, p1.removed_edges, p1.top_growth, p1.decisions, p1.decisions_lint, p1.decisions_doc, p1.milestone],
      ["@s/a:@s/b", "@s/a:@s/c,@s/d:@s/c", "none", "x.ts+9", "K1:lint,K2:none", 1, 0, "M"]);
    for (const v of [...Object.values(p1), ...Object.values(p2)]) assert.notEqual(typeof v, "object");
    assert.deepEqual(p2, { reason: "merged", wall_ms: 0, milestone: "M", conformance_mode: "shadow", shadow_would: "conforms" });
    assert.equal(mapRecord({ event: "RUN_TERMINAL", reason: "merged", pr: 0 }, 1).pr, undefined, "no pr 0 in ctx");
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
