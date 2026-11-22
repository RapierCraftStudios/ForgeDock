// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5824: the batch dependency DAG in code: declared and logical edges, overlap warnings, plan table, false holds.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDag, contractDeliverables, declaredDeps, falseHolds, formatFalseHolds, formatPlan, logicalDepsOf, planView } from "./dag.mjs";
import { renderContract } from "./render.mjs";
import { orchestrate } from "./orchestrate.mjs";

const OWNER = { authorAssociation: "OWNER", author: { login: "maintainer" } };
const contractComment = (paths, who = OWNER) => ({ ...who, body: `<!-- FORGE:CONTRACT -->\n${renderContract({ requirements: [], deliverables: paths.map((path, i) => ({ id: `D${i + 1}`, path, change: "x", requirements: [] })), preserve: [], validate: [] }, "0123456789ab")}` });
const view = (body, { title = "t", comments = [], trusted = true } = {}) => planView({ title, body, comments }, { trusted });
const viewsOf = (o) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

describe("#5824 declared edges", () => {
  it("reads every form the command spec lists: bold, list, colon, comma/and lists, any case, Blocked by", () => {
    const forms = ["Depends on #1", "**Depends on** #1", "- Depends on: #1, #2", "* depends ON #1 and #2", "**Blocked by:** #2", "blocked by #1, #2 (needs the helper)", "__Depends on__ #1 & #2"];
    for (const f of forms) {
      const want = /#2/.test(f) ? (/#1/.test(f) ? [1, 2] : [2]) : [1];
      assert.deepEqual(declaredDeps(9, view(`Intro\n${f}\nmore`)).sort(), want, f);
    }
  });

  it("ignores mid-line mentions, self references and an untrusted body", () => {
    assert.deepEqual(declaredDeps(9, view("This depends on #1 somehow.\nDepends on #9")), []);
    assert.deepEqual(declaredDeps(9, view("Depends on #1", { trusted: false })), []);
  });

  it("in-batch dependencies are edges, out-of-batch ones are listed as outside", () => {
    const dag = buildDag([1, 2], viewsOf({ 1: view(""), 2: view("Depends on #1, #7") }));
    assert.deepEqual(dag.edges, [{ from: 1, to: 2, kind: "declared" }]);
    assert.deepEqual(dag.outside, [{ issue: 2, dep: 7 }]);
  });
});

describe("#5824 logical edges and overlap", () => {
  it("a dependency's new contract deliverable named by the dependent is a logical edge", () => {
    const v = viewsOf({ 1: view("adds the helper", { comments: [contractComment(["bin/lean/newhelper.mjs"])] }), 2: view("use `bin/lean/newhelper.mjs` in the runner") });
    const dag = buildDag([1, 2], v, { exists: () => false });
    assert.deepEqual(dag.edges, [{ from: 1, to: 2, kind: "logical", why: "bin/lean/newhelper.mjs" }]);
    assert.deepEqual(logicalDepsOf(dag, 2), [1]);
    assert.deepEqual(dag.overlaps, []);
  });

  it("no contract, an existing deliverable, or an untrusted contract gives no edge; shared files are a warning only", () => {
    const noContract = buildDag([1, 2], viewsOf({ 1: view("edit `bin/a/x.mjs`"), 2: view("also `bin/a/x.mjs`") }));
    assert.deepEqual(noContract.edges, []);
    assert.deepEqual(noContract.overlaps, [{ a: 1, b: 2, files: ["bin/a/x.mjs"] }]);
    const existing = buildDag([1, 2], viewsOf({ 1: view("", { comments: [contractComment(["bin/a/x.mjs"])] }), 2: view("touch bin/a/x.mjs") }), { exists: () => true });
    assert.deepEqual(existing.edges, []);
    assert.equal(existing.overlaps.length, 1);
    const stranger = { authorAssociation: "NONE", author: { login: "someone" } };
    assert.deepEqual(contractDeliverables([contractComment(["bin/a/y.mjs"], stranger)]), []);
    assert.deepEqual(contractDeliverables([contractComment(["bin/a/y.mjs"]), contractComment(["bin/a/z.mjs"])]), ["bin/a/z.mjs"]);
  });

  it("a cycle closed by logical edges drops them; a declared cycle stays for the runner", () => {
    const v = viewsOf({
      1: view("Depends on #2\nuses `bin/b/one.mjs`", { comments: [contractComment(["bin/b/two.mjs"])] }),
      2: view("uses `bin/b/two.mjs`", { comments: [contractComment(["bin/b/one.mjs"])] }),
    });
    const dag = buildDag([1, 2], v);
    assert.deepEqual(dag.edges, [{ from: 2, to: 1, kind: "declared" }]);
    assert.equal(dag.dropped.length, 1);
    const decl = buildDag([1, 2], viewsOf({ 1: view("Depends on #2"), 2: view("Depends on #1") }));
    assert.equal(decl.edges.length, 2);
  });
});

describe("#5824 plan table and false holds", () => {
  it("prints one row per issue with waits-on, files and overlap warnings", () => {
    const v = viewsOf({ 1: view("edit `bin/a/x.mjs`", { title: "first | piped" }), 2: view("Depends on #1\n`bin/a/x.mjs`"), 3: view("also `bin/a/x.mjs`") });
    const dag = buildDag([1, 2, 3], v);
    const lines = formatPlan([1, 2, 3], v, dag, { parallel: 3, parallelFrom: "--parallel" });
    assert.match(lines[0], /^plan: 3 issue\(s\), 1 edge\(s\) \(declared 1, logical 0\), K=3 \(--parallel\)$/);
    assert.match(lines.find((l) => l.startsWith("| #2 ")), /\| #1 \| bin\/a\/x\.mjs \| #3 \|$/);
    assert.match(lines.find((l) => l.startsWith("| #1 ")), /first \/ piped/);
    assert.match(lines.at(-1), /overlaps are warnings only, never edges: #1\/#3 .*#2\/#3/);
  });

  it("counts planned declared edges an operator removed; unreadable issues are not judged", async () => {
    const dag = { edges: [{ from: 1, to: 2, kind: "declared" }, { from: 3, to: 2, kind: "declared" }, { from: 1, to: 4, kind: "declared" }, { from: 1, to: 5, kind: "logical", why: "p" }] };
    const removed = await falseHolds(dag, async (n) => { if (n === 4) throw new Error("gh down"); return n === 2 ? [3] : []; });
    assert.deepEqual(removed, [{ from: 1, to: 2, kind: "declared" }]);
    assert.equal(formatFalseHolds(dag, removed), "false holds: 1/4 planned edge(s) removed by an operator (#2 on #1)");
    assert.equal(formatFalseHolds({ edges: [] }, []), null);
  });
});

describe("#5824 orchestrate honours logical edges", () => {
  it("an issue with a logical dependency starts only after it merges, without a Depends on line", async () => {
    const started = [], done = [];
    const rows = await orchestrate({ issues: [2, 1], parallel: 2, readBody: async () => "", recovery: { maxAttempts: 0 }, logicalDeps: (n) => (n === 2 ? [1] : []),
      runOne: async (n) => { started.push({ n, after: [...done] }); await new Promise((r) => setTimeout(r, 5)); done.push(n); return { terminalReason: "merged", pr: 100 + n }; } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    assert.deepEqual(started.find((s) => s.n === 2).after, [1]);
  });
});

describe("#5824 forgedock orchestrate prints the plan from code and reports false holds", () => {
  it("plan table before the first lane, DAG kept in the plan, one view per issue, a removed edge counted", async () => {
    const { tmpDir } = await import("../tests/_tmp.mjs");
    const { openBatch } = await import("./batch.mjs");
    const { orchestrateFromCli } = await import("../engine-cli.mjs");
    const { writeFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const bodies = { 1: "adds the thing", 2: "**Depends on:** #1" }, views = { 1: 0, 2: 0 };
    const leanIo = { gh: async (a) => {
      if (a[0] === "api") return "OWNER\n";
      if (a[0] === "issue" && a[1] === "view") { if (a.some((x) => /^title,body,/.test(x))) views[a[2]] = (views[a[2]] ?? 0) + 1; return JSON.stringify({ title: `issue ${a[2]}`, body: bodies[a[2]] ?? "", milestone: null, comments: [], author: { login: "o" } }); }
      return a[0] === "repo" ? "main\n" : "[]";
    }, git: async (a) => (a[0] === "ls-remote" ? "abc\tref\n" : "") };
    const batchRoot = tmpDir("dag-batch-");
    const deps = { dir: tmpDir("dag-run-"), batchRoot, sched: null, allowTmpfs: true, emitTelemetry: async () => {}, leanIo, pollMs: 5, preflight: null,
      io: { gh: async (a) => (a[0] === "issue" ? JSON.stringify({ body: bodies[a[2]] ?? "", state: "OPEN" }) : "o/r\n"), git: async () => "" },
      leanModule: { runCore: async (o) => { if (o.issue === 1) bodies[2] = "operator dropped the line"; return { terminalReason: "merged", pr: o.issue, cost_usd: 0, wall_ms: 1 }; } } };
    const adm = tmpDir("dag-adm-"), prevCwd = process.cwd();
    writeFileSync(join(adm, "forge.yaml"), "engine:\n  admission_enabled: false\n");
    process.chdir(adm);
    const lines = [], l = console.log; console.log = (...a) => lines.push(a.join(" "));
    try { await orchestrateFromCli(["1", "2", "--repo", "o/r", "--no-prefilter", "--parallel", "2"], deps); } finally { console.log = l; process.chdir(prevCwd); }
    const out = lines.join("\n");
    assert.match(out, /plan: 2 issue\(s\), 1 edge\(s\) \(declared 1, logical 0\), K=2 \(--parallel\)/);
    assert.match(out, /\| #2 \| issue 2 \| #1 \|/);
    assert.match(out, /false holds: 1\/1 planned edge\(s\) removed by an operator \(#2 on #1\)/);
    assert.equal(views[1], 1, "the plan pass's view is reused by the runner");
    const b = openBatch(batchRoot, readdirSync(batchRoot)[0]);
    assert.deepEqual(b.readPlan().dag.edges, [{ from: 1, to: 2, kind: "declared" }]);
    assert.equal(b.readReport().dag.falseHolds.length, 1);
  });
});
