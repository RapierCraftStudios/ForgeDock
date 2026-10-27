import { test } from "node:test";
import assert from "node:assert/strict";
import { freezeScope, classifyNew, convergence, formatStopReport } from "../../scripts/settle-scope.mjs";

const frozen = freezeScope([{ number: 1 }, { number: 2 }]);
const iss = (number, extra = {}) => ({ number, state: "OPEN", body: "", ...extra });

test("decomposition children (and grandchildren) join the measured set and stay in the milestone", () => {
  const r = convergence({ frozen, decomposedParents: new Set([1, 10]), current: [iss(1, { state: "CLOSED" }), iss(2, { state: "CLOSED" }), iss(10, { parent: 1 }), iss(11, { parent: 10 })] });
  assert.deepEqual(r.bySource["decomposition-child"], [10, 11]);
  assert.deepEqual(r.open, [10, 11]);
  assert.equal(r.converged, false);
  assert.equal(classifyNew({ issue: iss(10, { parent: 1 }), measured: frozen, decomposedParents: new Set([1]) }).target, "milestone");
});

test("deferred follow-ups are growth but never measured; they go to the next milestone or backlog", () => {
  const f = iss(20, { body: "x\n<!-- FORGE:DEFERRED_FROM: #1 -->" });
  assert.deepEqual(classifyNew({ issue: f, measured: frozen }), { source: "deferred-followup", target: "next-milestone-or-backlog" });
  const r = convergence({ frozen, current: [iss(1, { state: "CLOSED" }), iss(2, { state: "CLOSED" }), f] });
  assert.equal(r.converged, true);
  assert.deepEqual(r.open, []);
  assert.deepEqual(r.bySource["deferred-followup"], [20]);
});

test("a child of a non-decomposed frozen issue is not a decomposition child when parents are named", () => {
  const c = classifyNew({ issue: iss(30, { parent: 2 }), measured: frozen, decomposedParents: new Set([1]) });
  assert.equal(c.source, "other");
});

test("STOP report states growth and sources", () => {
  const current = [iss(1), iss(2, { state: "CLOSED" }), iss(10, { parent: 1 }), iss(20, { body: "<!-- FORGE:DEFERRED_FROM: #2 -->" }), iss(21, { body: "review finding" })];
  const result = convergence({ frozen, current, decomposedParents: new Set([1]) });
  const text = formatStopReport({ frozen, result, passes: 3, limit: 3 });
  assert.match(text, /after 3\/3 passes/);
  assert.match(text, /frozen 2, set grew by 3/);
  assert.match(text, /decomposition-child 1 \(#10\)/);
  assert.match(text, /deferred-followup 1 \(#20\)/);
  assert.match(text, /review-finding 1 \(#21\)/);
});

test("no growth reports zero", () => {
  const result = convergence({ frozen, current: [iss(1, { state: "CLOSED" }), iss(2, { state: "CLOSED" })] });
  assert.equal(result.grew, 0);
  assert.match(formatStopReport({ frozen, result }), /grew by 0$/);
});
