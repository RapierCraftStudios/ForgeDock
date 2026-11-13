// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyStep, closeIssues, hasVerified, verifiedMarker, soakMinutes, sliBreaches, verifyConfigured, verifyReleaseById, SOAK_MIN } from "./release-verify.mjs";
import { validatePolicy } from "./release-config.mjs";

const SHA = "a".repeat(40);
const TABLE = { smoke1: { run: "check smoke1", timeout: 5 }, win1: { run: "check win1", for: "7d" } };

/** World: `runs` by workflow, `issues` by number {state, body, comments[]}; records every gh call and rehearsed command. */
function world(o = {}) {
  const w = { runs: {}, issues: { 7: { state: "OPEN", body: "does X [check:smoke1]", comments: [] } }, gh: [], ran: [], logs: {}, rollups: [{ number: 99 }], metrics: undefined, table: TABLE, checkOk: true, ...o };
  const io = {
    print: () => {}, sleep: async () => {}, now: () => 1_000,
    git: (a) => { if (w.table == null) throw new Error("no such file"); return JSON.stringify(w.table); },
    rehearse: async (cmd) => { w.ran.push(cmd); return { ok: w.checkOk, output: "boom" }; },
    gh: async (a) => {
      w.gh.push(a.join(" "));
      if (a[0] === "run" && a[1] === "list") { if (w.unreadable) throw new Error("HTTP 502"); const r = w.runs[a[a.indexOf("--workflow") + 1]]; return JSON.stringify(r ? [r] : []); }
      if (a[0] === "run" && a[1] === "view") return w.logs[a[2]] ?? "";
      if (a[0] === "workflow") { const wf = a[2]; w.runs[wf] ??= w.dispatchRun ?? { databaseId: 50, status: "completed", conclusion: "success" }; return ""; }
      if (a[0] === "issue" && a[1] === "view") { const i = w.issues[a[2]]; if (!i) throw new Error("not found"); return JSON.stringify(i); }
      if (a[0] === "issue" && a[1] === "list") return JSON.stringify(w.rollups);
      if (a[0] === "issue" && a[1] === "comment") { const i = w.issues[a[2]]; if (i) i.comments.push({ body: a[a.indexOf("--body") + 1] }); return ""; }
      if (a[0] === "issue" && (a[1] === "close" || a[1] === "create")) { if (a[1] === "close") w.issues[a[2]].state = "CLOSED"; return ""; }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
  };
  if (w.metrics) io.metrics = w.metrics;
  return { w, io };
}
const ok = { databaseId: 5, status: "completed", conclusion: "success" };
const mk = (io, verify, over = {}) => ({ io, repo: "o/r", def: "main", config: { verify, verifyRisk: "full", deployBounds: { pollMs: 1, runPollMs: 1 } }, state: { id: "r1", repo: "o/r", release: { issues: [7] }, deploy: { merge: SHA, phase: "VERIFYING" } }, save() {}, ...over });

describe("release verify (#5562)", () => {
  it("defaults: soak minutes by risk class, overridable; verifyConfigured is off for an empty block", () => {
    assert.deepEqual(SOAK_MIN, { low: 10, medium: 20, full: 30, p0: 15 });
    assert.equal(soakMinutes("p0"), 15); assert.equal(soakMinutes("full", 45), 45); assert.equal(soakMinutes("low", { low: 3 }), 3);
    assert.equal(verifyConfigured({}), false); assert.equal(verifyConfigured({ slis: [] }), false); assert.equal(verifyConfigured({ close_requires: "verified" }), true);
  });
  it("the policy schema accepts the verify layer keys", () => {
    const r = validatePolicy({ schema: 1, verify: { workflow: "v.yml", results: [{ workflow: "smoke.yml", kind: "smoke" }], flags: [{ flag: "F", off_command: "x" }], slis: [], close_requires: "verified" } });
    assert.ok(!JSON.stringify(r).includes("verify."), JSON.stringify(r));
  });
  it("layer 1: green results pass; an unreadable source blocks (I5); a missing run blocks", async () => {
    const v = { results: [{ workflow: "smoke.yml", kind: "smoke" }], close_requires: "deployed" };
    let { w, io } = world({ runs: { "smoke.yml": ok } });
    assert.equal((await verifyStep(mk(io, v), SHA)).verified, true);
    ({ w, io } = world({ unreadable: true }));
    assert.match((await verifyStep(mk(io, v), SHA)).reason, /cannot read smoke.yml results \(I5\)/);
    ({ io } = world({ runs: {} }));
    assert.match((await verifyStep(mk(io, v), SHA)).reason, /no completed run/);
  });
  it("layer 1: a real smoke failure emits the rollback trigger once", async () => {
    const v = { results: [{ workflow: "smoke.yml", kind: "smoke" }] };
    const { io } = world({ runs: { "smoke.yml": { databaseId: 5, status: "completed", conclusion: "failure" } }, logs: { 5: "assertion failed: /health returned wrong body" } });
    const trig = []; const c = mk(io, v, { rollbackTrigger: (t) => trig.push(t) });
    const r = await verifyStep(c, SHA); const r2 = await verifyStep(c, SHA);
    assert.ok(r.rollback); assert.ok(r2.rollback); assert.equal(trig.length, 1);
  });
  it("smoke identity/transport failure: one re-verify, then hold, never a rollback", async () => {
    const v = { results: [{ workflow: "smoke.yml", kind: "smoke" }] };
    const { w, io } = world({ runs: { "smoke.yml": { databaseId: 5, status: "completed", conclusion: "failure" } }, logs: { 5: "HTTP 401 unauthorized" } });
    const c = mk(io, v), trig = []; c.rollbackTrigger = (t) => trig.push(t);
    const r = await verifyStep(c, SHA);
    assert.equal(r.hold?.label, "needs-agent"); assert.equal(c.state.verify.reverifies, 1); assert.equal(trig.length, 0); assert.equal(r.rollback, undefined);
    assert.equal(w.gh.filter((g) => g.startsWith("run list")).length, 2, "exactly one re-verify read");
  });
  it("a convergence failure with smoke green is released-with-convergence-failures: repair issue, no rollback", async () => {
    const v = { results: [{ workflow: "smoke.yml", kind: "smoke" }, { workflow: "conv.yml", kind: "convergence" }], close_requires: "deployed" };
    const { w, io } = world({ runs: { "smoke.yml": ok, "conv.yml": { databaseId: 6, status: "completed", conclusion: "failure" } } });
    const r = await verifyStep(mk(io, v), SHA);
    assert.equal(r.outcome, "released-with-convergence-failures");
    assert.equal(w.gh.filter((g) => g.startsWith("issue create")).length, 1);
  });
  it("layer 2: the verification workflow is dispatched once through fenced() and its failure triggers rollback", async () => {
    const v = { workflow: "verify.yml", close_requires: "deployed" };
    let { w, io } = world();
    const calls = []; const fence = { lctx: { io: { api: async () => ({ content: Buffer.from(JSON.stringify({ epoch: 3, lease: { holder: "h", epoch: 3 } })).toString("base64") }) }, repo: "o/r" }, lease: { holder: "h", epoch: 3, release: "r" }, now: () => "t", record: async (r) => calls.push(r) };
    const c = mk(io, v, { fence });
    assert.equal((await verifyStep(c, SHA)).verified, true);
    assert.equal(w.gh.filter((g) => g.startsWith("workflow run")).length, 1);
    assert.ok(calls.some((i) => i.action === "dispatch" && i.epoch === 3 && /verify:/.test(i.key)));
    ({ w, io } = world({ dispatchRun: { databaseId: 50, status: "completed", conclusion: "failure" } }));
    assert.ok((await verifyStep(mk(io, v), SHA)).rollback);
  });
  it("layer 2: a dispatch intent already recorded is never repeated on resume", async () => {
    const { w, io } = world();
    const c = mk(io, { workflow: "verify.yml" }, { state: { id: "r1", release: { issues: [] }, deploy: { merge: SHA }, intents: [{ action: "dispatch", key: `r1:deploy:0:verify:${SHA}` }] } });
    const r = await verifyStep(c, SHA);
    assert.match(r.reason, /already recorded/); assert.equal(w.gh.filter((g) => g.startsWith("workflow run")).length, 0);
  });
  it("layer 3: an SLI breach in a fixture series emits the rollback trigger; within tolerance passes", async () => {
    const slis = [{ name: "5xx", tolerance: 0.1 }, { name: "success", worse: "lower", tolerance: 0.05 }];
    const series = (cur) => async ({ sli }) => ({ baseline: 100, current: cur[sli.name] });
    let { io } = world({ metrics: series({ "5xx": 150, success: 100 }) });
    const trig = []; const c = mk(io, { slis, close_requires: "deployed" }); c.rollbackTrigger = (t) => trig.push(t);
    const r = await verifyStep(c, SHA);
    assert.match(r.reason, /SLI breach over 30 min: 5xx 150/); assert.equal(trig.length, 1);
    ({ io } = world({ metrics: series({ "5xx": 105, success: 97 }) }));
    const ok2 = await verifyStep(mk(io, { slis, close_requires: "deployed" }), SHA);
    assert.equal(ok2.verified, true); assert.match(ok2.sli, /pass \(30 min soak, 2 sli\)/);
    assert.deepEqual(sliBreaches([{ name: "a" }], { a: { baseline: 10, current: 13 } }).map((x) => x.sli), ["a"]);
  });
  it("layer 3: no metric source skips and says so; an unreadable metric blocks (I5)", async () => {
    const v = { slis: [{ name: "5xx" }], close_requires: "deployed" };
    let { io } = world();
    const lines = []; io.print = (l) => lines.push(l);
    const r = await verifyStep(mk(io, v), SHA);
    assert.equal(r.sli, "skipped (no host)"); assert.ok(lines.some((l) => l.includes("sli: skipped (no host)")));
    ({ io } = world({ metrics: async () => { throw new Error("prometheus down"); } }));
    assert.match((await verifyStep(mk(io, v), SHA)).reason, /cannot read SLI 5xx \(I5\)/);
  });
  it("layer 4: each check runs once, from the default branch; an unreadable registry blocks; windowed checks become follow-ups", async () => {
    const v = { post_deploy_checks_file: ".forge/post-deploy-checks.json", close_requires: "deployed" };
    let { w, io } = world({ issues: { 7: { state: "OPEN", body: "[check:smoke1] [check:win1]", comments: [] }, 8: { state: "OPEN", body: "[check:smoke1]", comments: [] } } });
    const c = mk(io, v); c.state.release.issues = [7, 8];
    assert.equal((await verifyStep(c, SHA)).verified, true);
    assert.deepEqual(w.ran, ["check smoke1"], "smoke1 runs once for two issues; windowed win1 never runs");
    assert.ok(w.gh.some((g) => g.startsWith("issue comment 99") && g.includes("[check:win1]")));
    ({ io } = world({ table: null }));
    assert.match((await verifyStep(mk(io, v), SHA)).reason, /cannot read .* from origin\/main \(I13, I5\)/);
    ({ io } = world({ checkOk: false }));
    assert.equal((await verifyStep(mk(io, v), SHA)).hold?.kind, "check");
  });
  it("layer 5: a flag-gated feature is verified off and never activated", async () => {
    const { w, io } = world();
    const r = await verifyStep(mk(io, { flags: [{ flag: "NEW_UI", off_command: "flag-state NEW_UI off" }], close_requires: "deployed" }), SHA);
    assert.equal(r.verified, true); assert.deepEqual(w.ran, ["flag-state NEW_UI off"]);
    const bad = world({ checkOk: false });
    assert.equal((await verifyStep(mk(bad.io, { flags: [{ flag: "NEW_UI", off_command: "x" }] }), SHA)).hold?.kind, "flag");
  });
  it("I19: close is refused without FORGE:VERIFIED naming the deploy sha, allowed with it; deployed mode opts out", async () => {
    const { w, io } = world({ issues: { 7: { state: "OPEN", body: "", comments: [{ body: verifiedMarker("b".repeat(40)) }] } } });
    const c = mk(io, {});
    let r = await closeIssues(c, { issues: [7], sha: SHA });
    assert.equal(r.closed.length, 0); assert.match(r.refused[0].why, /no FORGE:VERIFIED/); assert.ok(!w.gh.some((g) => g.startsWith("issue close")));
    w.issues[7].comments.push({ body: verifiedMarker(SHA) });
    r = await closeIssues(c, { issues: [7], sha: SHA }); assert.deepEqual(r.closed, [7]);
    w.issues[7].state = "OPEN"; w.issues[7].comments = [];
    assert.deepEqual((await closeIssues(c, { issues: [7], sha: SHA, mode: "deployed" })).closed, [7]);
    assert.equal(hasVerified([{ body: "<!-- FORGE:VERIFIED fp=abc123 -->" }], SHA), false);
  });
  it("end to end: verified issue gets the marker comment then closes; resume repeats no dispatch, check or comment", async () => {
    const v = { workflow: "verify.yml", post_deploy_checks_file: "f.json" };
    const { w, io } = world();
    const c = mk(io, v);
    const r = await verifyStep(c, SHA);
    assert.equal(r.verified, true); assert.deepEqual(r.closed, [7]);
    assert.ok(hasVerified(w.issues[7].comments, SHA));
    const before = w.gh.filter((g) => /^(workflow run|issue comment)/.test(g)).length, ran = w.ran.length;
    w.issues[7].state = "OPEN"; await verifyStep(c, SHA);
    assert.equal(w.gh.filter((g) => /^(workflow run|issue comment)/.test(g)).length, before); assert.equal(w.ran.length, ran);
  });
  it("verifyReleaseById refuses before LIVE_CHECK and runs the layers after it", async () => {
    const { io } = world();
    assert.match((await verifyReleaseById({ io, state: { id: "r1", deploy: { phase: "DEPLOYING" } }, save() {}, def: "main", policy: {} })).reason, /LIVE_CHECK/);
    const state = { id: "r1", repo: "o/r", release: { issues: [] }, deploy: { phase: "LIVE", merge: SHA } };
    assert.equal((await verifyReleaseById({ io, state, save() {}, def: "main", policy: { verify: { close_requires: "deployed" } }, lane: "p0" })).verified, true);
  });
});

/** I22 scanner: write verbs against production in a module's source. */
const WRITE_VERBS = [/\bssh\s/, /\bscp\s/, /\bsystemctl\b/, /\bdocker\s+(run|exec|rm|stop|restart|kill|compose|build|push|cp)\b/, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|TRUNCATE)\b/i, /\bkubectl\s+(apply|delete|scale|rollout)\b/];
const writeVerbs = (src) => WRITE_VERBS.filter((re) => re.test(src)).map(String);

describe("release verify I22: no write path to production", () => {
  it("the module has no write verbs", () => {
    assert.deepEqual(writeVerbs(readFileSync(new URL("./release-verify.mjs", import.meta.url), "utf8")), []);
  });
  it("the scan fails on a seeded violation", () => {
    for (const bad of ["await sh('ssh prod systemctl restart api')", "run(`docker exec app sh`)", "q('DELETE FROM users')"]) assert.ok(writeVerbs(bad).length, bad);
  });
});
