import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyEdges, orderMilestones, runLive, unmetDependencies } from "../../scripts/plan-validate-live.mjs";

const ms = (title, number, due_on = null) => ({ title, number, due_on });
const is = (number, milestone, body = "", state = "OPEN") => ({ number, milestone, body, state });
const order = (...m) => orderMilestones(m);

describe("plan validate --live", () => {
  it("orders by due_on (nulls last) then number", () => {
    assert.deepEqual(order(ms("C", 3), ms("B", 2, "2026-02-01T00:00:00Z"), ms("A", 5, "2026-01-01T00:00:00Z")), ["A", "B", "C"]);
  });

  it("classifies ok / held / invalid", () => {
    const r = classifyEdges({ order: ["M1", "M2"], issues: [
      is(1, "M1", "", "CLOSED"), is(2, "M1"), is(3, "M2", "Depends on #1"), is(4, "M2", "Depends on #2"), is(5, "M1", "Depends on #3"),
    ] });
    assert.deepEqual(r.edges.map((e) => [e.from, e.to, e.state]), [[3, 1, "ok"], [4, 2, "held"], [5, 3, "invalid"]]);
    assert.equal(r.ok, false);
  });

  it("a mid-sequence milestone insertion turns an ok edge invalid", () => {
    const issues = [is(1, "M1", "", "CLOSED"), is(2, "M2", "Depends on #1")];
    assert.equal(classifyEdges({ order: order(ms("M1", 1, "2026-01-01T00:00:00Z"), ms("M2", 2, "2026-03-01T00:00:00Z")), issues }).ok, true);
    const inserted = order(ms("M1", 1, "2026-03-01T00:00:00Z"), ms("M2", 2, "2026-03-02T00:00:00Z"), ms("NEW", 3, "2026-01-01T00:00:00Z"));
    assert.deepEqual(inserted, ["NEW", "M1", "M2"]);
    const moved = [is(1, "M2", "", "CLOSED"), is(2, "M1", "Depends on #1")];
    assert.equal(classifyEdges({ order: inserted, issues: moved }).ok, false);
  });

  it("a decomposition that adds a backward edge is invalid", () => {
    const issues = [is(10, "M1", "Depends on #11"), is(11, "M2")];
    const r = classifyEdges({ order: ["M1", "M2"], issues });
    assert.deepEqual(r.edges.map((e) => e.state), ["invalid"]);
  });

  it("runLive exits 1 on invalid and prints the report", async () => {
    const gh = async (a) => (a[0] === "api"
      ? JSON.stringify([[ms("M1", 1), ms("M2", 2)]])
      : JSON.stringify([{ number: 1, body: "Depends on #2", state: "OPEN", milestone: { title: "M1" } }, { number: 2, body: "", state: "OPEN", milestone: { title: "M2" } }]));
    const lines = [];
    assert.equal(await runLive(["validate", "--live"], { gh, out: (t) => lines.push(t) }), 1);
    assert.match(lines.join("\n"), /invalid: #1 \(M1\) depends on #2 \(M2\)/);
  });
});

describe("parallel start gate", () => {
  const gh = (dep) => async (a) => {
    if (a[0] === "issue" && a[2] === "7") return JSON.stringify({ body: "Depends on #9", milestone: { title: "M2" } });
    if (a[0] === "issue" && a[2] === "9") return JSON.stringify(dep);
    if (a[0] === "pr") return JSON.stringify({ baseRefName: "staging", mergedAt: "2026-01-01" });
    throw new Error("unexpected");
  };
  const run = (dep) => unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: gh(dep) });

  it("reports a dependency not closed", async () => {
    assert.deepEqual((await run({ state: "OPEN" })).map((u) => [u.issue, u.dep, u.why]), [[7, 9, "not closed"]]);
  });
  it("reports a dependency merged into a different base", async () => {
    const u = await run({ state: "CLOSED", closedByPullRequestsReferences: [{ number: 3 }] });
    assert.match(u[0].why, /not merged into milestone\/m2/);
  });
  it("passes when the dependency is merged into the lane", async () => {
    const g = async (a) => (a[0] === "pr" ? JSON.stringify({ baseRefName: "milestone/m2", mergedAt: "x" }) : gh({ state: "CLOSED", closedByPullRequestsReferences: [{ number: 3 }] })(a));
    assert.deepEqual(await unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: g }), []);
  });
  it("ignores dependencies inside the batch", async () => {
    assert.deepEqual(await unmetDependencies({ issues: [7, 9], baseOf: async () => "x", gh: gh({ state: "OPEN" }) }), []);
  });
});

describe("orchestrate parallel milestone start", async () => {
  const { orchestrateFromCli } = await import("../engine-cli.mjs");
  const { tmpDir } = await import("./_tmp.mjs");
  const mk = () => {
    const seen = [];
    const io = { gh: async (a) => {
      if (a[0] === "repo" && a[1] === "view") return "main\n";
      if (a[0] === "issue" && a[2] === "7") return JSON.stringify({ body: "Depends on #9", milestone: { title: "M Two" } });
      if (a[0] === "issue" && a[2] === "9") return JSON.stringify({ state: "OPEN" });
      return "o/r\n";
    } };
    const leanIo = { gh: async (a) => (a[0] === "repo" ? "main\n" : JSON.stringify({ milestone: { title: "M Two" }, body: "" })),
      git: async (a) => (a[0] === "ls-remote" ? "abc\tref\n" : "") };
    const deps = { dir: tmpDir("pvl-"), batchRoot: tmpDir("pvl-batch-"), allowTmpfs: true, emitTelemetry: async () => {}, io, leanIo,
      leanModule: { runCore: async (o) => { seen.push(o.issue); return { terminalReason: "merged", pr: 1, cost_usd: 0, wall_ms: 1 }; } } };
    return { deps, seen };
  };
  const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

  it("is refused while a dependency is unmerged", async () => {
    const { deps, seen } = mk();
    await assert.rejects(quiet(() => orchestrateFromCli(["7", "--repo", "o/r", "--no-prefilter"], deps)), /parallel milestone start refused: #7 depends on #9/);
    assert.deepEqual(seen, []);
  });

  it("--force with a reason proceeds and records the reason", async () => {
    const { deps, seen } = mk();
    await quiet(() => orchestrateFromCli(["7", "--repo", "o/r", "--no-prefilter", "--force", "9 lands tomorrow"], deps));
    assert.deepEqual(seen, [7]);
    const { readFileSync, readdirSync } = await import("node:fs");
    const dirs = readdirSync(deps.batchRoot);
    const plan = readdirSync(`${deps.batchRoot}/${dirs[0]}`).find((f) => /plan/.test(f));
    assert.match(readFileSync(`${deps.batchRoot}/${dirs[0]}/${plan}`, "utf8"), /"forced":\s*"9 lands tomorrow"/);
  });
});
