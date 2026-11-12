// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { releaseFromCli, gateState } from "./release.mjs";
import { collectStatus, renderStatus, watchStatus, explainIssue, explainPr } from "./release-status.mjs";

const REPO = "o/r", ID = "r20261112-141530-4242", HEAD = "a".repeat(40);
const STATE = { v: 1, id: ID, repo: REPO, steps: { preflight: { done: true, at: "T1" }, "release-pr": { done: true, at: "T2", result: { pr: 7, head: HEAD } }, promotion: { done: false, at: "T3" } }, release: { snapshot: "s1", issues: [12, 5], picks: [] } };
const b64 = (o) => ({ content: Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64") });

/** io fake: GitHub is a read-only world; any non-GET api call is recorded in `writes`. */
function fakeIo(world = {}) {
  const writes = [], printed = [], gh = [];
  const w = { state: STATE, active: { lease: { holder: "h", epoch: 2, release: ID }, holds: [] }, issues: {}, marker: "pass", deployGate: "success", checks: [], ...world };
  const io = {
    writes, printed, now: () => 1, print: (l) => printed.push(l), sleep: async () => {},
    api: async (method, path) => {
      if (method !== "GET") { writes.push([method, path]); throw new Error("write"); }
      if (path.includes("git/matching-refs")) return [{ ref: `refs/heads/forge-ledger/${ID}` }, { ref: "refs/heads/forge-ledger/_active" }];
      if (path.includes("git/ref/heads/forge-ledger/")) return { object: { sha: "h" } };
      if (path.includes("contents/state.json")) return b64(w.state);
      if (path.includes("contents/active.json")) return b64(w.active);
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
      `${ID}  o/r  status=running next=promotion  source=ledger  hold=no  intake=open`,
      "  lease: h (epoch 2)",
      "  [x] preflight  T1", "  [ ] host-preflight", "  [x] release-pr  T2", "  [ ] review", "  [ ] fixes", "  [ ] mark-ready", "  [ ] rehearsal", "  [ ] promotion  T3", "  [ ] post-merge",
      `  PR #7  head ${HEAD}  gate marker=pass deploy-gate=success`,
      "  release set: #5 #12  picks=0",
      "  next:",
      `    forgedock release --resume ${ID} --repo o/r`,
      `    forgedock release --resume ${ID} --repo o/r --merge`,
      `    forgedock release explain 7 --repo o/r`,
      `    forgedock release explain ${ID} --repo o/r`,
      `    forgedock release status ${ID} --repo o/r --json`,
    ].join("\n"));
  });

  it("R4: a second host (other cwd, env, clock) prints the same bytes", async () => {
    const run = async (cwd, now) => { const io = fakeIo(); io.now = () => now; const code = await releaseFromCli(["status", "--json", "--repo", REPO], { io, cwd, env: { FORGEDOCK_RELEASE_DIR: `${cwd}/rel`, HOSTNAME: cwd } }); return [code, io.printed.join("\n")]; };
    assert.deepEqual(await run("/tmp/hostA", 1), await run("/tmp/hostB", 99));
  });

  it("R1: local cache is used when release.managed is off, with no ledger call", async () => {
    const io = fakeIo(), calls = []; const api = io.api; io.api = async (...a) => { calls.push(a); return api(...a); };
    const s = await collectStatus({ ...base(io, { config: {}, id: ID }), local: { load: () => STATE, ids: () => [ID] } });
    assert.equal(s.source, "local"); assert.deepEqual(calls, []);
  });

  it("R2: explain #N gives an ordered rule trace, lane and what would change it", async () => {
    const issues = { 40: { number: 40, title: "fix(api): x", body: "Depends on #41", labels: [{ name: "P1" }, { name: "needs-human" }] }, 41: { number: 41, title: "y", body: "", labels: [] } };
    const e = await explainIssue({ io: fakeIo({ issues }), repo: REPO, number: 40, state: { id: ID, release: { issues: [12] } }, watch: { theme_map: { api: ["scope:api"] } } });
    assert.deepEqual(e.trace.map((t) => t.rule), ["skip_labels", "priority", "theme", "depends_on", "release_set"]);
    assert.deepEqual(e.trace.map((t) => t.pass), [false, true, true, false, false]);
    assert.ok(e.trace.every((t) => t.config_key));
    assert.equal(e.lane, "excluded");
    assert.match(e.trace[3].detail, /#41/);
    assert.ok(e.would_change.some((w) => w.includes("needs-human")));
  });

  it("R2: explain <PR> reports the gate decision and the failing check", async () => {
    const e = await explainPr({ io: fakeIo({ marker: "failure", deployGate: "failure", checks: [{ name: "lint", conclusion: "failure" }] }), repo: REPO, pr: 7, gateState });
    assert.equal(e.decision, "hold");
    assert.deepEqual(e.trace.map((t) => t.pass), [false, false, false]);
    assert.match(e.trace[2].detail, /lint/);
  });

  it("R3: status --watch polls until the release is terminal", async () => {
    const seq = ["running", "running", "done"], slept = [], printed = [];
    const last = await watchStatus({ collect: async () => ({ status: seq.shift(), id: ID, repo: REPO, steps: [], next_actions: [] }), print: (l) => printed.push(l), sleep: async (ms) => slept.push(ms), asJson: true });
    assert.equal(last.status, "done"); assert.equal(printed.length, 3); assert.equal(slept.length, 2);
  });

  it("R3: bare `release --watch` is still accepted and status rejects unknown options", async () => {
    await assert.rejects(releaseFromCli(["status", "--bogus"], { io: fakeIo() }), /unknown option --bogus/);
  });
});
