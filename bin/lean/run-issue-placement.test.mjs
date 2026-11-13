// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5542: `run-issue` follows forge.yaml `execution:` like `orchestrate`, and `--local` keeps the lane on this host.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseExecution, openExecutionBudget } from "./execution.mjs";
import { makeLedger } from "./ledger.mjs";
import { runFromCli } from "../engine-cli.mjs";

const logs = async (fn) => { const out = [], l = console.log; console.log = (x) => out.push(String(x)); try { return { res: await fn(), out }; } finally { console.log = l; } };

function fakeProvider(finish) {
  const p = { name: "fake", calls: [], live: new Set(), results: {}, idFor: (n) => `fake-${n}`,
    async start({ issue }) { p.calls.push(["start", issue]); p.results[issue] = finish(issue); return { provider: "fake", id: `fake-${issue}`, issue }; },
    async status() { return "exited"; }, async fetchResult(h) { return p.results[h.issue] ?? null; }, async teardown() { return true; } };
  return p;
}

const leanIo = { gh: async (a) => (a.includes("milestone") ? JSON.stringify({ milestone: null }) : a[0] === "repo" ? "main\n" : JSON.stringify({ body: "" })),
  git: async (a) => (a[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : a[0] === "rev-parse" ? ".git\n" : "") };
const setup = (name, prov, extra = {}) => {
  const work = tmpDir(name);
  const ran = [];
  return { work, ran, deps: { env: {}, batchRoot: join(work, "batches"), allowTmpfs: true, pollMs: 5, orchestration: { breaker: null, maxDeferrals: 3 }, io: { gh: async () => "o/r\n" }, leanIo, sched: null, maintenance: null,
    executionBudget: openExecutionBudget({ file: join(work, "budget.json") }), emitTelemetry: () => {}, dir: join(work, "runs"), batchId: `rp-${name}`,
    execution: parseExecution({ mode: "remote", max_remote: "1", provider: "container" }), sandboxProvider: prov,
    sandboxLedger: (n) => makeLedger({ root: join(work, "ledger"), batch: `rp-${name}`, lane: `sandbox-${n}`, owner: "t", issue: n }),
    ...extra } };
};
const core = (ran) => ({ runCore: async (o) => { ran.push(o.placement ?? null); return { terminalReason: "merged", pr: 1 }; } });

describe("run-issue placement (#5542)", () => {
  it("remote execution routes run-issue to the provider", async () => {
    const prov = fakeProvider((n) => ({ terminalReason: "merged", pr: 100 + n, cost_usd: 0 }));
    const { deps, work } = setup("remote", prov);
    const rf = join(work, "result.json");
    const { res, out } = await logs(() => runFromCli(["7", "--repo", "o/r", "--no-prefilter", "--result-file", rf], deps));
    assert.deepEqual(prov.calls.filter((c) => c[0] === "start").map((c) => c[1]), [7]);
    assert.equal(res.terminalReason, "merged");
    assert.ok(out.some((l) => /^placement: remote/.test(l)), out.join("\n"));
  });

  it("--local forces local placement", async () => {
    const prov = fakeProvider(() => ({ terminalReason: "merged" }));
    const { deps, ran } = setup("local", prov, {});
    const { out } = await logs(() => runFromCli(["7", "--repo", "o/r", "--lane", "staging", "--local"], { ...deps, leanModule: core(ran) }));
    assert.equal(ran.length, 1);
    assert.deepEqual(prov.calls, []);
    assert.ok(out.includes("placement: local (--local)"));
  });

  it("an already placed lane (--placement) is not re-delegated", async () => {
    const prov = fakeProvider(() => ({ terminalReason: "merged" }));
    const { deps, ran } = setup("placed", prov);
    await logs(() => runFromCli(["7", "--repo", "o/r", "--lane", "staging", "--placement", "remote", "--placement-reason", "mode remote"], { ...deps, leanModule: core(ran) }));
    assert.equal(ran.length, 1);
    assert.equal(ran[0].where, "remote");
    assert.deepEqual(prov.calls, []);
  });

  it("no execution config runs locally and says so", async () => {
    const prov = fakeProvider(() => ({ terminalReason: "merged" }));
    const { deps, ran } = setup("none", prov, { execution: undefined });
    const { out } = await logs(() => runFromCli(["7", "--repo", "o/r", "--lane", "staging"], { ...deps, leanModule: core(ran) }));
    assert.equal(ran.length, 1);
    assert.ok(out.some((l) => /^placement: local/.test(l)));
  });

  it("remote run-issue result file carries bench fields", async () => {
    const prov = fakeProvider((n) => ({ terminalReason: "merged", pr: `https://x/pull/${n}`, cost_usd: 1.5, wall_ms: 1200, model_ms: 900 }));
    const { deps, work } = setup("bench", prov);
    const rf = join(work, "result.json");
    await logs(() => runFromCli(["8", "--repo", "o/r", "--no-prefilter", "--result-file", rf], deps));
    const r = JSON.parse(readFileSync(rf, "utf8"));
    assert.equal(r.terminalReason, "merged");
    assert.equal(r.cost_usd, 1.5); assert.equal(r.wall_ms, 1200); assert.equal(r.model_ms, 900);
    assert.match(String(r.pr), /8$/);
  });
});
