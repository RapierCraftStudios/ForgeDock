import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyEdges, orderMilestones, runLive, skeletonProblems, unmetDependencies } from "../../scripts/plan-validate-live.mjs";

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
  const synced = (oid) => async (a) => (a[0] === "pr" ? JSON.stringify({ baseRefName: "staging", mergedAt: "x", mergeCommit: { oid } }) : gh({ state: "CLOSED", closedByPullRequestsReferences: [{ number: 3 }] })(a));
  it("passes when the merge commit is an ancestor of the lane though the PR base differs", async () => {
    const seen = [];
    const isAncestor = async (sha, base) => { seen.push([sha, base]); return true; };
    assert.deepEqual(await unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: synced("abc1234567890"), isAncestor }), []);
    assert.deepEqual(seen, [["abc1234567890", "milestone/m2"]]);
  });
  it("refuses naming the merge commit when it is not on the lane", async () => {
    const u = await unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: synced("abc1234567890"), isAncestor: async () => false });
    assert.match(u[0].why, /merge commit abc1234567 is not on milestone\/m2/);
  });
  it("lists only the unmet dependency of a batch", async () => {
    const g = async (a) => {
      if (a[0] === "issue" && a[2] === "7") return JSON.stringify({ body: "Depends on #8, #9", milestone: { title: "M2" } });
      if (a[0] === "issue") return JSON.stringify({ state: "CLOSED", closedByPullRequestsReferences: [{ number: Number(a[2]) }] });
      return JSON.stringify({ baseRefName: "staging", mergedAt: "x", mergeCommit: { oid: `sha${a[2]}` } });
    };
    const u = await unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: g, isAncestor: async (s) => s === "sha8" });
    assert.deepEqual(u.map((x) => x.dep), [9]);
  });
  it("tags a merged dependency whose commit is missing as kind commit with its sha, and an open one as other", async () => {
    const [c] = await unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: synced("abc1234567890"), isAncestor: async () => false });
    assert.deepEqual([c.kind, c.sha], ["commit", "abc1234567890"]);
    const [o] = await unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: gh({ state: "OPEN" }) });
    assert.deepEqual([o.kind, o.sha], ["other", null]);
  });
  it("passes when the dependency is merged into the lane", async () => {
    const g = async (a) => (a[0] === "pr" ? JSON.stringify({ baseRefName: "milestone/m2", mergedAt: "x" }) : gh({ state: "CLOSED", closedByPullRequestsReferences: [{ number: 3 }] })(a));
    assert.deepEqual(await unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: g }), []);
  });
  describe("closed with empty closedByPullRequestsReferences (#5086)", () => {
    const lane = (list) => async (a) => {
      if (a[0] === "pr" && a[1] === "list") { if (a.includes("--search")) return "[]"; if (list instanceof Error) throw list; assert.ok(a.includes("feat/issue-9-lean")); return JSON.stringify(list); }
      return gh({ state: "CLOSED", closedByPullRequestsReferences: [] })(a);
    };
    const run = (list, isAncestor) => unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: lane(list), isAncestor });
    const pr = (base) => [{ number: 5, baseRefName: base, mergedAt: "x", mergeCommit: { oid: "def" } }];
    it("passes a dependency closed with empty closedByPullRequestsReferences whose lane PR merged into the milestone branch", async () => {
      assert.deepEqual(await run(pr("milestone/m2")), []);
    });
    it("passes when the lane PR merged elsewhere but its commit is on the base, holds when it is not", async () => {
      assert.deepEqual(await run(pr("staging"), async () => true), []);
      const [u] = await run(pr("staging"), async () => false);
      assert.deepEqual([u.kind, u.sha], ["commit", "def"]);
    });
    it("still refuses when no merged PR exists", async () => {
      const [u] = await run([]);
      assert.match(u.why, /closed but not merged into milestone\/m2/);
      assert.equal(u.kind, "other");
    });
    it("still refuses when the lane PR lookup fails", async () => {
      const [u] = await run(new Error("boom"));
      assert.equal(u.kind, "other");
    });
  });
  describe("engine record and PR bodies when closing references are empty (#5120)", () => {
    const state = (m) => `Body\n\n<!-- FORGE:STATE\n${JSON.stringify({ v: 1, mergedTo: m })}\n-->`;
    const mk = ({ rec, head = [], search = [], prs = {}, throwAll = false }) => async (a) => {
      if (a[0] === "issue" && a[2] === "7") return JSON.stringify({ body: "Depends on #9", milestone: { title: "M2" } });
      if (a[0] === "issue" && a[2] === "9") return JSON.stringify({ state: "CLOSED", closedByPullRequestsReferences: [] });
      if (throwAll) throw new Error("boom");
      if (a[0] === "api") return JSON.stringify(rec ?? {});
      if (a[0] === "pr" && a[1] === "view") return JSON.stringify(prs[a[2]] ?? {});
      if (a[0] === "pr" && a[1] === "list") return JSON.stringify(a.includes("--search") ? search : head);
      throw new Error("unexpected");
    };
    const run = (g, isAncestor) => unmetDependencies({ issues: [7], baseOf: async () => "milestone/m2", gh: g, isAncestor });
    const trusted = (m) => ({ body: state(m), author_association: "MEMBER", user: { type: "User" } });
    const merged = { baseRefName: "milestone/m2", mergedAt: "x", mergeCommit: { oid: "abc1234" } };
    it("passes on a trusted mergedTo record whose PR merged with that commit", async () => {
      const g = mk({ rec: trusted({ lane: "milestone/m2", pr: 4, sha: "abc1234" }), prs: { 4: merged } });
      assert.deepEqual(await run(g), []);
    });
    it("refuses a mergedTo record from an untrusted author", async () => {
      const rec = { ...trusted({ lane: "milestone/m2", pr: 4, sha: "abc1234" }), author_association: "NONE" };
      const [u] = await run(mk({ rec, prs: { 4: merged } }));
      assert.match(u.why, /closed but not merged into milestone\/m2/);
    });
    it("refuses a mergedTo record naming another lane or a different commit", async () => {
      const other = await run(mk({ rec: trusted({ lane: "staging", pr: 4, sha: "abc1234" }), prs: { 4: merged } }));
      assert.equal(other.length, 1);
      const diff = await run(mk({ rec: trusted({ lane: "milestone/m2", pr: 4, sha: "fff9999" }), prs: { 4: merged } }));
      assert.equal(diff.length, 1);
    });
    it("passes on a merged PR whose body closes the dependency", async () => {
      const search = [{ number: 6, baseRefName: "milestone/m2", mergedAt: "x", mergeCommit: { oid: "c1" }, title: "t", body: "Root cause\n\nCloses #9" }];
      assert.deepEqual(await run(mk({ search })), []);
    });
    it("ignores a body hit without a closing reference to the dependency", async () => {
      const mkp = (body) => [{ number: 6, baseRefName: "milestone/m2", mergedAt: "x", mergeCommit: { oid: "c1" }, title: "t", body }];
      assert.equal((await run(mk({ search: mkp("see #9") }))).length, 1);
      assert.equal((await run(mk({ search: mkp("Closes #90") }))).length, 1);
    });
    it("holds a body-search PR merged elsewhere whose commit is not on the base", async () => {
      const search = [{ number: 6, baseRefName: "staging", mergedAt: "x", mergeCommit: { oid: "c1" }, title: "Fixes #9", body: "" }];
      const [u] = await run(mk({ search }), async () => false);
      assert.deepEqual([u.kind, u.sha], ["commit", "c1"]);
    });
    it("every fallback failing still reads as closed but not merged, not unreadable", async () => {
      const g = mk({});
      const failing = async (a) => (a[0] === "api" || a[0] === "pr" ? Promise.reject(new Error("boom")) : g(a));
      const [u] = await run(failing);
      assert.match(u.why, /closed but not merged into milestone\/m2/);
      assert.equal(u.kind, "other");
    });
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

  it("#5167 a refusal is recorded for `forgedock status` and alerted, with no batch dir and the same error", async () => {
    const { deps, seen } = mk();
    const lines = [], notes = [];
    deps.notify = async (cmd, p) => { notes.push(p); return { ok: true }; };
    deps.healthConfig = { rootFailed: true, terminalShare: 0.5, stalled: true, checksMin: [15, 60], issue: null, notifyCommand: "n" };
    const l = console.log; console.log = (...a) => lines.push(a.join(" "));
    try { await assert.rejects(orchestrateFromCli(["7", "--repo", "o/r", "--no-prefilter"], deps), /^Error: parallel milestone start refused: #7 depends on #9/); } finally { console.log = l; }
    assert.deepEqual(seen, []);
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(deps.batchRoot), ["refusals.json"], "no batch dir");
    const { statusLines } = await import("../lean/batch-health.mjs");
    assert.match(statusLines(deps.batchRoot).join("\n"), /LAUNCH REFUSED .*parallel milestone start refused: #7 depends on #9/);
    assert.ok(lines.some((x) => /^BATCH UNHEALTHY \(refused launch\) \(launch\)\n {2}cause: refused/.test(x)), lines.join("\n"));
    assert.equal(notes.length, 1);
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

describe("orchestrate admit-and-hold (#5031)", async () => {
  const { orchestrateFromCli } = await import("../engine-cli.mjs");
  const { tmpDir } = await import("./_tmp.mjs");
  const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
  // #9 is closed by a PR merged into staging (sha abc...); #7 (lane main) waits until `landed.on` flips.
  const mk = () => {
    const landed = { on: false, calls: 0 };
    const io = { gh: async (a) => {
      if (a[0] === "repo" && a[1] === "view") return "main\n";
      if (a[0] === "issue" && a[2] === "7") return JSON.stringify({ body: "Depends on #9", milestone: { title: "M Two" } });
      if (a[0] === "issue" && a[2] === "9") return JSON.stringify({ state: "CLOSED", closedByPullRequestsReferences: [{ number: 3 }] });
      if (a[0] === "pr") return JSON.stringify({ baseRefName: "staging", mergedAt: "x", mergeCommit: { oid: "abc1234567890" } });
      return "o/r\n";
    }, git: async (a) => { if (a.includes("--is-ancestor")) { landed.calls++; if (!landed.on) throw new Error("not ancestor"); } return ""; } };
    const leanIo = { gh: async (a) => (a[0] === "repo" ? "main\n" : JSON.stringify({ milestone: { title: "M Two" }, body: "" })),
      git: async (a) => (a[0] === "ls-remote" ? "abc\tref\n" : "") };
    const seen = [];
    const deps = { dir: tmpDir("pvl-"), batchRoot: tmpDir("pvl-batch-"), allowTmpfs: true, emitTelemetry: async () => {}, io, leanIo, pollMs: 10,
      leanModule: { runCore: async (o) => { seen.push([o.issue, landed.on]); return { terminalReason: "merged", pr: 1, cost_usd: 0, wall_ms: 1 }; } } };
    return { deps, seen, landed };
  };

  it("admits an issue whose dependency commit is not on the base and runs it only once the commit lands", async () => {
    const { deps, seen, landed } = mk();
    setTimeout(() => { landed.on = true; }, 80);
    await quiet(() => orchestrateFromCli(["7", "--repo", "o/r", "--no-prefilter"], deps));
    assert.deepEqual(seen, [[7, true]]);
    assert.ok(landed.calls > 2, "the commit was re-checked while held");
  });

  it("keeps the base wait across a resume: plan.json records it and a resumed batch holds the issue again", async () => {
    const { deps, seen, landed } = mk();
    const { readFileSync, readdirSync, writeFileSync } = await import("node:fs");
    setTimeout(() => { landed.on = true; }, 60);
    await quiet(() => orchestrateFromCli(["7", "--repo", "o/r", "--no-prefilter"], deps));
    const [id] = readdirSync(deps.batchRoot);
    const planPath = `${deps.batchRoot}/${id}/plan.json`;
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    assert.deepEqual(JSON.parse(JSON.stringify(plan.baseWaits)), { 7: [{ dep: 9, sha: "abc1234567890", base: "milestone/m-two" }] }, JSON.stringify(plan.baseWaits));
    // simulate a batch stopped before #7 ran (schedd restart): clear its result, then resume with the commit not yet landed
    const stPath = `${deps.batchRoot}/${id}/state.json`;
    const st = JSON.parse(readFileSync(stPath, "utf8"));
    st.results = {}; st.pending = [7]; writeFileSync(stPath, JSON.stringify(st));
    for (const f of readdirSync(`${deps.batchRoot}/${id}`)) if (/report/.test(f)) (await import("node:fs")).rmSync(`${deps.batchRoot}/${id}/${f}`, { recursive: true, force: true });
    landed.on = false; landed.calls = 0; seen.length = 0;
    setTimeout(() => { landed.on = true; }, 80);
    await quiet(() => orchestrateFromCli(["--resume", id], deps));
    assert.deepEqual(seen, [[7, true]], "the resumed batch ran #7 only after the commit landed");
    assert.ok(landed.calls > 1, "the commit was re-checked after the resume");
  });
});

describe("walking skeleton on live milestones (#5337)", () => {
  const lab = (number, milestone, body, ...labels) => ({ ...is(number, milestone, body), labels: labels.map((name) => ({ name })) });
  const codes = (issues) => skeletonProblems({ open: ["M1"], issues }).map((p) => `${p.code}${p.issue ? `:${p.issue}` : ""}`);

  it("passes when one skeleton exists and every sibling depends on it transitively", () => {
    assert.deepEqual(codes([lab(1, "M1", "", "skeleton"), lab(2, "M1", "Depends on #1"), lab(3, "M1", "Depends on #2"), lab(4, "M1", "", "epic")]), []);
  });
  it("rejects a milestone with no skeleton issue", () => {
    assert.deepEqual(codes([lab(1, "M1", ""), lab(2, "M1", "Depends on #1")]), ["missing-skeleton"]);
  });
  it("rejects two skeletons", () => {
    assert.deepEqual(codes([lab(1, "M1", "", "skeleton"), lab(2, "M1", "", "skeleton")]), ["multiple-skeletons:2"]);
  });
  it("rejects a sibling that does not reach the skeleton", () => {
    assert.deepEqual(codes([lab(1, "M1", "", "skeleton"), lab(2, "M1", "")]), ["not-behind-skeleton:2"]);
  });
  it("ignores closed milestones and runLive exits 1 on a missing skeleton", async () => {
    assert.deepEqual(skeletonProblems({ open: [], issues: [lab(1, "M1", "")] }), []);
    const gh = async (a) => (a[0] === "api"
      ? JSON.stringify([[{ ...ms("M1", 1), state: "open" }]])
      : JSON.stringify([{ number: 1, body: "", state: "OPEN", labels: [], milestone: { title: "M1" } }]));
    const lines = [];
    assert.equal(await runLive(["validate", "--live"], { gh, out: (t) => lines.push(t) }), 1);
    assert.match(lines.join("\n"), /\[missing-skeleton\] M1/);
  });
});
