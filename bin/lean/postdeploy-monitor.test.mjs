// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sweepDue, formatDueSummary } from "./postdeploy-monitor.mjs";
import { PROBE_MARKER } from "./probe.mjs";
import { isTrustedIssueComment } from "./prefilter.mjs";

const T0 = Date.parse("2026-10-26T00:00:00Z");
const H = 3600e3;
const CHECKS = JSON.stringify({ soak: { run: "echo ok", for: "7d", every: "6h" } });
const BODY = "## Acceptance Criteria\n\n- [ ] `R1: health row exists` — post-deploy: [check:soak] soak\n\n<!-- FORGE:DEFERRED_FROM: #40 -->\n";
const rec = (o) => ({ authorAssociation: "OWNER", author: { login: "bot" }, body: `<!-- ${PROBE_MARKER} -->\n${JSON.stringify({ fix: "fix1234567890", default_sha: "rel1", result: "pass", at: new Date(T0).toISOString(), window_until: new Date(T0 + 7 * 24 * H).toISOString(), every_ms: 6 * H, ...o })}` });

function world({ comments = [rec({})], head = "rel1", file = CHECKS, code = 0, state = "OPEN" } = {}) {
  const w = { gh: [], git: [], spawned: [] };
  w.io = {
    gh: async (a) => {
      w.gh.push(a);
      const k = a.slice(0, 2).join(" ");
      if (k === "repo view") return "main\n";
      if (k === "issue list") return JSON.stringify([{ number: 41 }]);
      if (k === "issue view") return JSON.stringify({ number: 41, state, title: "", body: BODY, labels: [{ name: "post-deploy-monitoring" }], comments });
      if (k === "issue create") return "https://github.com/o/r/issues/77\n";
      return "";
    },
    git: async (a) => { w.git.push(a); if (a[0] === "show") { if (file == null) throw new Error("missing"); return file; } if (a[0] === "rev-parse") return `${head}\n`; return ""; },
  };
  w.spawn = async (o) => { w.spawned.push(o.run); return { code, stdout: code ? "broke" : "ok", stderr: "" }; };
  return w;
}
const sweep = (w, o = {}) => sweepDue({ repo: "o/r", cwd: "/repo", io: w.io, now: () => T0 + H, config: { env: [], timeoutS: 5 }, env: {}, spawn: w.spawn, ...o });
const calls = (w, k) => w.gh.filter((a) => a.slice(0, 2).join(" ") === k);

const trustedOk = isTrustedIssueComment(rec({}));

describe("post-deploy windowed monitoring (#4627)", () => {
  it("fixture comments count as trusted", () => assert.ok(trustedOk));

  it("not due: cadence not elapsed and no new release", async () => {
    const w = world();
    const rows = await sweep(w);
    assert.equal(rows[0].outcome, "not-due"); assert.deepEqual(w.spawned, []);
  });

  it("due by cadence: re-runs the default-branch command and records a pass; the follow-up stays open", async () => {
    const w = world();
    const rows = await sweep(w, { now: () => T0 + 7 * H });
    assert.equal(rows[0].outcome, "pass"); assert.deepEqual(w.spawned, ["echo ok"]);
    assert.ok(w.git.some((a) => a.join(" ") === "show origin/main:.forge/post-deploy-checks.json"));
    assert.equal(calls(w, "issue comment").length, 1);
    assert.equal(calls(w, "issue close").length, 0); assert.equal(calls(w, "issue create").length, 0);
  });

  it("due by a new release (origin/main moved) well before the cadence", async () => {
    const w = world({ head: "rel2" });
    const rows = await sweep(w);
    assert.equal(rows[0].outcome, "pass"); assert.deepEqual(w.spawned, ["echo ok"]);
  });

  it("window end closes the follow-up and drops the label without running", async () => {
    const w = world();
    const rows = await sweep(w, { now: () => T0 + 8 * 24 * H });
    assert.equal(rows[0].outcome, "window-ended"); assert.deepEqual(w.spawned, []);
    assert.equal(calls(w, "issue close").length, 1);
    assert.ok(calls(w, "issue edit").some((a) => a.includes("--remove-label")));
  });

  it("pass then fail files one regression naming the fix commit and both releases, then closes the follow-up", async () => {
    const w = world({ head: "rel2", code: 1 });
    const rows = await sweep(w);
    assert.equal(rows[0].outcome, "fail"); assert.equal(rows[0].regression, "77");
    const [create] = calls(w, "issue create");
    const text = create[create.indexOf("--body") + 1];
    assert.match(create[create.indexOf("--title") + 1], /Regression: post-deploy check soak failed on main \(fix of #40\)/);
    assert.match(text, /FORGE:REGRESSION/); assert.match(text, /fix1234567890/); assert.match(text, /`rel1`/); assert.match(text, /`rel2`/); assert.match(text, /broke/);
    assert.equal(calls(w, "issue close").length, 1);
    assert.ok(!w.gh.some((a) => a[1] === "reopen"));
    const cm = calls(w, "issue comment")[0];
    assert.match(cm[cm.indexOf("--body") + 1], /"result":"fail".*"regression":77/s);
  });

  it("a follow-up whose latest record is a fail is never re-run or re-filed", async () => {
    const w = world({ head: "rel3", code: 1, comments: [rec({}), rec({ result: "fail", default_sha: "rel2", regression: 77 })] });
    const rows = await sweep(w);
    assert.equal(rows[0].outcome, "skipped"); assert.deepEqual(w.spawned, []); assert.equal(calls(w, "issue create").length, 0);
  });

  it("an untrusted record never counts", async () => {
    const w = world({ comments: [{ authorAssociation: "NONE", author: { login: "rando" }, body: rec({}).body }] });
    assert.equal((await sweep(w, { now: () => T0 + 9 * H }))[0].outcome, "skipped");
    assert.deepEqual(w.spawned, []);
  });

  it("a check missing on the default branch is unrunnable and never run", async () => {
    for (const file of [null, JSON.stringify({ other: "echo hi" })]) {
      const w = world({ file, head: "rel2" });
      assert.equal((await sweep(w))[0].outcome, "unrunnable"); assert.deepEqual(w.spawned, []);
    }
  });

  it("dry run runs nothing and writes nothing", async () => {
    const w = world({ head: "rel2" });
    assert.equal((await sweep(w, { dryRun: true }))[0].outcome, "due");
    assert.deepEqual(w.spawned, []);
    assert.equal(calls(w, "issue comment").length + calls(w, "issue close").length + calls(w, "issue create").length, 0);
  });

  it("no monitored follow-up: no git, no run; the summary names outcomes", async () => {
    const w = world();
    w.io.gh = async (a) => (a[0] === "repo" ? "main\n" : "[]");
    assert.deepEqual(await sweep(w), []); assert.equal(w.git.length, 0);
    assert.equal(formatDueSummary([{ issue: 1, outcome: "pass" }, { issue: 2, outcome: "fail" }]), "monitoring: pass #1; regression #2");
  });

  it("reports sink rows for pass and fail only when not a dry run", async () => {
    const seen = [];
    await sweep(world({ head: "rel2", code: 1 }), { onResult: (r) => seen.push(r.outcome) });
    assert.deepEqual(seen, ["fail"]);
  });
});
