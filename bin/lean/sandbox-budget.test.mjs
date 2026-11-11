import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLedger, sandboxStartBudget, SANDBOX_START_P50_BUDGET_MS } from "./phaseledger.mjs";

const lane = (ms, steps = {}) => { let t = 0; const l = createLedger(() => t); for (const [k, v] of Object.entries(steps)) l.addStep("sandbox_start", k, v); t = ms; l.enter("plan"); return l.snapshot(); };

test("sandbox_start p50 budget is 3 s and judges the median, not the max", () => {
  assert.equal(SANDBOX_START_P50_BUDGET_MS, 3000);
  assert.equal(sandboxStartBudget([lane(1000), lane(2000), lane(20000)]).ok, true);
  const r = sandboxStartBudget([lane(4000), lane(5000), lane(900)]);
  assert.equal(r.ok, false); assert.equal(r.p50, 4000);
  assert.equal(sandboxStartBudget([]).ok, true);
});

test("sandbox_start sub-timings (sparse_plan, git_worktree_add, sparse_checkout) ride the ledger snapshot", () => {
  const s = lane(2500, { sparse_plan: 300, git_worktree_add: 1500, sparse_checkout: 400 });
  assert.deepEqual(s.sandbox_start.steps, { sparse_plan: 300, git_worktree_add: 1500, sparse_checkout: 400 });
});

// Bench corpus gate: FORGE_BENCH_LOG=<log.jsonl of a bench run>. Without it only the unit checks above run.
test("bench corpus: sandbox_start p50 <= 3 s", { skip: !process.env.FORGE_BENCH_LOG }, () => {
  const rows = readFileSync(process.env.FORGE_BENCH_LOG, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const r = sandboxStartBudget(rows.map((x) => x?.phases).filter(Boolean));
  assert.ok(r.n > 0, "no ledger rows in the bench log");
  assert.ok(r.ok, `sandbox_start p50 ${r.p50} ms > ${r.budgetMs} ms`);
});
