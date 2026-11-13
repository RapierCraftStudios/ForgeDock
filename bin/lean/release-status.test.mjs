// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { releaseFromCli, gateState } from "./release.mjs";
import { collectStatus, renderStatus, watchStatus, explainIssue, explainPr, renderExplain, parseNextAction, registerPlannerRule, PLANNER_RULES } from "./release-status.mjs";

const REPO = "o/r", ID = "r20261112-141530-4242", HEAD = "a".repeat(40);
const STATE = { v: 1, id: ID, repo: REPO, steps: { preflight: { done: true, at: "T1" }, "release-pr": { done: true, at: "T2", result: { pr: 7, head: HEAD } }, promotion: { done: false, at: "T3" } }, release: { snapshot: "s1", issues: [12, 5], picks: [] } };
const b64 = (o) => ({ content: Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64") });

/** io fake: GitHub is a read-only world; any non-GET api call is recorded in `writes`. */
function fakeIo(world = {}) {
  const writes = [], printed = [], gh = [];
  const w = { controls: null, state: STATE, active: { lease: { holder: "h", epoch: 2, release: ID }, holds: [] }, issues: {}, marker: "pass", deployGate: "success", checks: [], ...world };
  const io = {
    writes, printed, now: () => 1, print: (l) => printed.push(l), sleep: async () => {},
    api: async (method, path) => {
      if (method !== "GET") { writes.push([method, path]); throw new Error("write"); }
      if (path.includes("git/matching-refs")) return [{ ref: `refs/heads/forge-ledger/${ID}` }, { ref: "refs/heads/forge-ledger/_active" }];
      if (path.includes("git/ref/heads/forge-ledger/")) return { object: { sha: "h" } };
      if (path.includes("contents/state.json")) return b64(w.state);
      if (path.includes("contents/active.json")) return b64(w.active);
      if (path.includes("contents/controls.jsonl") && w.controls) return b64(w.controls.map((c) => JSON.stringify(c)).join("\n"));
      throw Object.assign(new Error("HTTP 404"), { status: 404 });
    },
    gh: async (a) => {
      gh.push(a); const j = a.join(" ");
      if (j.includes("repo view")) return JSON.stringify({ nameWithOwner: REPO });
      if (j.includes("--json comments")) return JSON.stringify({ comments: w.marker ? [{ body: `FORGE:GATE_${w.marker.toUpperCase()}` }] : [] });
      if (j.includes("--json headRefOid")) return JSON.stringify({ headRefOid: HEAD });
      if (a[0] === "api" && /\/status$/.test(a[1])) return JSON.stringify([]);
      if (a[0] === "api") return JSON.stringify([{ name: "forge/deploy-gate", conclusion: w.deployGate }, ...w.checks]);
      if (a[0] === "issue" && a[1] === "view") return JSON.stringify(w.issues[a[2]]);
      if (a[0] === "issue" && a[1] === "list") return JSON.stringify(Object.values(w.issues));
      throw new Error(`unexpected gh ${j}`);
    },
  };
  return io;
}
const managedDir = mkdtempSync(join(tmpdir(), "rs5554-")); writeFileSync(join(managedDir, "forge.yaml"), "release:\n  managed: true\n");
const local = { load: () => null, ids: () => [] };
const base = (io, over = {}) => ({ io, repo: REPO, config: { managed: true }, local, gateState, ...over });

describe("release status / explain (#5554)", () => {
  it("R1: status reads the ledger plus GitHub, JSON has schema and next_actions, no write is made", async () => {
    const io = fakeIo(), s = await collectStatus(base(io));
    assert.equal(s.schema, "forgedock.release.status/v1");
    assert.equal(s.id, ID); assert.equal(s.source, "ledger"); assert.equal(s.next_step, "promotion");
    assert.deepEqual(s.pr.gate, { marker: "pass", deployGate: "success" });
    assert.deepEqual(s.release.issues, [5, 12]);
    assert.ok(s.next_actions.includes(`forgedock release --resume ${ID} --repo ${REPO} --merge`));
    assert.deepEqual(io.writes, []);
  });

  it("R4: golden text output", async () => {
    const out = renderStatus(await collectStatus(base(fakeIo(), { id: ID })));
    assert.equal(out, [
      `${ID}  o/r  status=running next=promotion  source=ledger  hold=no  intake=unknown`,
      "  wave: unknown  lane: unknown", "  lease: holder=h epoch=2 heartbeat_age_s=unknown", "  cut: s1",
      "  [x] preflight  T1", "  [ ] host-preflight", "  [x] release-pr  T2", "  [ ] review", "  [ ] fixes", "  [ ] mark-ready", "  [ ] rehearsal", "  [ ] promotion  T3", "  [ ] post-merge",
      `  PR #7  head ${HEAD}  gate marker=pass deploy-gate=success  ci: total=1 failed=0 pending=0`,
      "  review: unknown", "  merge: unknown", "  deploy: unknown", "  rollback: target=unknown auto=unknown",
      "  release set: #5 #12  picks=0",
      "  next:",
      `    forgedock release --resume ${ID} --repo o/r`,
      `    forgedock release --resume ${ID} --repo o/r --merge`,
      `    forgedock release hold ${ID} --repo o/r --reason <reason>`,
      `    forgedock release cancel ${ID} --repo o/r --reason <reason>`,
      `    forgedock release lane ${ID} --repo o/r --force <lane> --reason <reason>`,
      `    forgedock release explain 7 --repo o/r`,
      `    forgedock release explain ${ID} --repo o/r`,
      `    forgedock release status ${ID} --repo o/r --json`,
    ].join("\n"));
  });

  it("R4: a second host (other cwd, env, clock) prints the same bytes", async () => {
    const run = async (cwd, now) => { const io = fakeIo(); io.now = () => now; const code = await releaseFromCli(["status", "--json", "--repo", REPO], { io, cwd: managedDir, env: { HOME: cwd, FORGEDOCK_RELEASE_DIR: `${cwd}/rel`, HOSTNAME: cwd } }); return [code, io.printed.join("\n")]; };
    const [a, b] = [await run("/tmp/hostA", 1), await run("/tmp/hostB", 99)];
    assert.deepEqual(a, b); assert.equal(a[0], 0); assert.equal(JSON.parse(a[1]).source, "ledger");
  });

  it("R1: local cache is used when release.managed is off, with no ledger call", async () => {
    const io = fakeIo(), calls = []; const api = io.api; io.api = async (...a) => { calls.push(a); return api(...a); };
    const s = await collectStatus({ ...base(io, { config: {}, id: ID }), local: { load: () => STATE, ids: () => [ID] } });
    assert.equal(s.source, "local"); assert.deepEqual(calls, []);
  });

  const RULES = ["classification", "skip_labels", "min_confidence", "risk.rules", "forces", "priority", "theme", "depends_on", "release_set", "planner", "lane"];

  it("R5: explain #N gives an ordered {step,rule,config_key,result,would_change} trace, planner not installed, lane", async () => {
    const issues = { 40: { number: 40, title: "fix(api): x", body: "Depends on #41", labels: [{ name: "P1" }, { name: "needs-human" }] }, 41: { number: 41, title: "y", body: "", labels: [] } };
    const e = await explainIssue({ io: fakeIo({ issues }), repo: REPO, number: 40, state: { id: ID, release: { issues: [12] } }, watch: { theme_map: { api: ["scope:api"] } } });
    assert.deepEqual(e.trace.map((t) => t.rule), RULES);
    assert.deepEqual(e.trace.map((t) => t.step), RULES.map((_, i) => i + 1));
    assert.deepEqual(e.trace.map((t) => t.result), ["n/a", "fail", "n/a", "n/a", "n/a", "pass", "pass", "fail", "fail", "n/a", "n/a"]);
    assert.ok(e.trace.every((t) => t.config_key && Array.isArray(t.would_change)));
    assert.equal(e.classification, "absent"); assert.match(e.trace[0].detail, /classification: absent/);
    assert.equal(e.trace[1].config_key, "plan.skip_labels");
    assert.equal(e.trace[9].detail, "planner: not installed");
    assert.equal(e.lane, "excluded");
    assert.match(e.trace[7].detail, /#41/);
    assert.ok(e.would_change.some((w) => w.includes("needs-human")));
    assert.ok(e.trace[10].would_change[0].includes("release lane #40 --force"));
    assert.match(renderExplain(e), /^#40  lane=excluded\n  1\. n\/a   classification  \[FORGE:CLASSIFY\]  classification: absent/);
  });

  it("R5: explain #N reads the FORGE:CLASSIFY record, risk/forces rules, min_confidence, a registered planner rule and a controls lane", async () => {
    const body = "<!-- FORGE:CLASSIFY -->\n" + JSON.stringify({ files: ["a.js"], confidence: 0.4, source: "model", set_by: "bot" });
    const issues = { 12: { number: 12, title: "fix(api): z", body: "", labels: [{ name: "P2" }, { name: "risky" }], comments: [{ body }] } };
    const policy = { min_confidence: 0.8, risk_rules: [{ label: "risky", lane: "solo" }], forces: [{ label: "force-x" }] };
    PLANNER_RULES.length = 0; registerPlannerRule(() => ({ rule: "units_max", config_key: "plan.units_max", result: "pass", detail: "ok" }));
    try {
      const e = await explainIssue({ io: fakeIo({ issues }), repo: REPO, number: 12, state: { id: ID, release: { issues: [12] } }, watch: { theme_map: { api: ["scope:api"] } }, policy, controls: [{ type: "lane", issue: 12, lane: "solo", actor: "op" }] });
      assert.deepEqual(e.classification, { files: ["a.js"], confidence: 0.4, source: "model", set_by: "bot" });
      assert.deepEqual(e.trace.map((t) => [t.rule, t.config_key, t.result]).slice(0, 5), [["classification", "FORGE:CLASSIFY", "pass"], ["skip_labels", "plan.skip_labels", "pass"], ["min_confidence", "classify.min_confidence", "fail"], ["risk.rules", "risk.rules[0]", "fail"], ["forces", "forces[0]", "pass"]]);
      assert.equal(e.trace.at(-2).rule, "units_max"); assert.ok(!e.trace.some((t) => t.rule === "planner"));
      assert.equal(e.lane, "solo"); assert.match(e.trace.at(-1).detail, /control decision by op/);
    } finally { PLANNER_RULES.length = 0; }
  });

  it("R6: explain <PR> lists each required check, the demotion (actor, expiry, reason, issue) and the gate decision", async () => {
    const io = fakeIo({ marker: "failure", deployGate: "failure", checks: [{ name: "lint", conclusion: "failure" }, { name: "unit", conclusion: "failure" }, { name: "e2e", conclusion: "success" }] });
    const controls = [{ type: "exempt", check: "unit", actor: "op", until: "2026-12-01T00:00:00Z", reason: "flaky", issue: 99 }];
    const e = await explainPr({ io, repo: REPO, pr: 7, gateState, controls });
    assert.equal(e.decision, "hold");
    assert.deepEqual(e.trace.map((t) => [t.rule, t.result]), [["gate_marker", "fail"], ["deploy_gate", "fail"], ["check:e2e", "pass"], ["check:forge/deploy-gate", "fail"], ["check:lint", "fail"], ["check:unit", "n/a"]]);
    assert.deepEqual(e.demoted, [{ check: "unit", actor: "op", expires: "2026-12-01T00:00:00Z", reason: "flaky", issue: 99 }]);
    assert.match(e.trace.at(-1).detail, /demoted by op until 2026-12-01T00:00:00Z: flaky \(issue 99\)/);
    const ok = await explainPr({ io: fakeIo(), repo: REPO, pr: 7, gateState });
    assert.equal(ok.decision, "pass");
  });

  it("R5/R6: explain via the CLI dispatches #N, bare number and PR URL, and every command is read-only", async () => {
    const issues = { 12: { number: 12, title: "t", body: "", labels: [] } };
    for (const [arg, kind] of [["#12", "issue"], ["7", "pr"], ["https://github.com/o/r/pull/7", "pr"], [ID, "release"]]) {
      const io = fakeIo({ issues, controls: [{ type: "lane", issue: 12, lane: "pool" }] });
      assert.equal(await releaseFromCli(["explain", arg, "--json", "--repo", REPO], { io, cwd: managedDir, env: { FORGEDOCK_RELEASE_DIR: join(managedDir, "rel") }, deps: {} }).catch((e) => e.message), 0, arg);
      assert.equal(JSON.parse(io.printed.join("")).kind, kind); assert.deepEqual(io.writes, []);
    }
  });

  it("R2/R3: missing fields print unknown; recorded fields are shown; every next_actions command parses", async () => {
    const st = { ...STATE, wave: { n: 1, of: 3 }, lane: "fast", merge_sha: "m1", deploy: { run: 5, stage: "canary", attempt: 2 }, rollback: { target: "v1", armed: true }, steps: { ...STATE.steps, review: { done: true, result: { verdict: "pass" } }, promotion: { done: true } } };
    const active = { lease: { holder: "h", epoch: 2, release: ID, heartbeat_at: "1970-01-01T00:00:00.100Z" }, holds: ["x"], intake: { paused: true } };
    const io = fakeIo({ state: st, active }); io.now = () => 5100;
    const s = await collectStatus(base(io));
    assert.equal(s.wave, "1/3"); assert.equal(s.lane, "fast"); assert.equal(s.lease.heartbeat_age_s, 5); assert.equal(s.hold, true); assert.equal(s.intake, "paused");
    assert.equal(s.merge_sha, "m1"); assert.deepEqual(s.deploy, { run: 5, stage: "canary", attempt: 2 }); assert.equal(s.rollback_target, "v1"); assert.equal(s.auto_rollback, "armed");
    assert.deepEqual(s.review, { verdict: "pass", head: HEAD });
    const bare = await collectStatus(base(fakeIo()));
    for (const k of ["wave", "lane", "cut_sha", "review", "merge_sha", "deploy", "rollback_target", "auto_rollback", "intake"]) assert.ok(bare[k] === "unknown" || k === "cut_sha", k);
    for (const x of [s, bare]) for (const a of x.next_actions) parseNextAction(a);
    assert.ok(s.next_actions.some((a) => /release resume .* --reason <reason>/.test(a)));
    assert.ok(s.next_actions.some((a) => /release rollback/.test(a)));
    assert.throws(() => parseNextAction("forgedock release hold x"), /needs --reason/);
    assert.throws(() => parseNextAction("forgedock release status x --bogus"), /unknown option/);
  });

  it("R1: no active release prints `no active release`", async () => {
    const io = fakeIo({ active: {} });
    assert.equal(await releaseFromCli(["status", "--repo", REPO], { io, cwd: managedDir, env: { FORGEDOCK_RELEASE_DIR: join(managedDir, "rel") }, deps: {} }), 1);
    assert.deepEqual(io.printed, ["no active release"]);
  });

  it("R4/R11: status --watch prints only on change, stops at a terminal state, honours --interval", async () => {
    const seq = ["running", "running", "done"], slept = [], printed = [];
    const last = await watchStatus({ collect: async () => ({ status: seq.shift(), id: ID, repo: REPO, steps: [], next_actions: [] }), print: (l) => printed.push(l), sleep: async (ms) => slept.push(ms), asJson: true, intervalMs: 2500 });
    assert.equal(last.status, "done"); assert.equal(printed.length, 2); assert.deepEqual(slept, [2500, 2500]);
  });

  it("R4: bare `release --watch` and `status --watch --interval` run the loop; a terminal release ends it; bad interval and unknown options are rejected", async () => {
    const term = { ...STATE, status: "done" };
    const run = (argv) => { const io = fakeIo({ state: term }); return releaseFromCli(argv, { io, cwd: managedDir, env: { FORGEDOCK_RELEASE_DIR: join(managedDir, "rel") }, deps: {} }).then((code) => [code, io]); };
    for (const argv of [["--watch", "--repo", REPO], ["status", "--watch", "--interval", "3", "--repo", REPO]]) { const [code, io] = await run(argv); assert.equal(code, 0); assert.equal(io.printed.length, 1); assert.match(io.printed[0], /status=done/); }
    await assert.rejects(run(["status", "--watch", "--interval", "0", "--repo", REPO]), /positive number/);
    await assert.rejects(releaseFromCli(["status", "--bogus"], { io: fakeIo() }), /unknown option --bogus/);
    await assert.rejects(releaseFromCli(["hold", "--reason", "x"], { io: fakeIo() }), /not available in this build/);
  });
});
