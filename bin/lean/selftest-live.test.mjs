// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSelftestLive, stripState, selftestFromCli, STEPS } from "./selftest-live.mjs";

/** A fake sandbox world. `d` toggles a defect: add4859 (--add skips), wipe4860 (body wiped), double (resume relaunches), orderBA, noRemoteAuth. */
function world(d = {}) {
  const w = { issues: {}, closed: [], calls: [], killed: 0, pid: 100, results: {}, order: [], deps: {}, running: {}, clock: 0, pool: !!d.pool };
  const gh = async (a) => {
    w.calls.push(a.join(" "));
    if (a[0] === "api" && a[1] === "-X" && a[2] === "PUT") return "{}";
    if (a[0] === "issue" && a[1] === "create") {
      const n = 10 + Object.keys(w.issues).length; w.issues[n] = { body: a[a.indexOf("--body") + 1], state: "OPEN", labels: [] }; return `https://github.com/o/r/issues/${n}\n`;
    }
    if (a[0] === "issue" && a[1] === "view") {
      const n = a[2], i = w.issues[n];
      if (a.includes("body")) return JSON.stringify({ body: d.wipe4860 && w.wiped ? "<!-- FORGE:STATE {} -->" : `${i.body}\n<!-- FORGE:STATE {"v":1} -->` });
      return JSON.stringify({ state: i.state, labels: i.labels.map((name) => ({ name })) });
    }
    if (a[0] === "issue" && a[1] === "close") { w.closed.push(a[2]); return ""; }
    if (a[0] === "pr" && a[1] === "view") return JSON.stringify({ state: "MERGED", mergedAt: `2026-01-01T00:0${a[2] === "101" ? (d.orderBA ? 2 : 1) : (d.orderBA ? 1 : 2)}:00Z` });
    if (a[0] === "pr" && a[1] === "list") return "";
    if (a[0] === "api") { throw new Error("fail cleanup api"); }
    throw new Error(`unexpected gh ${a.join(" ")}`);
  };
  const io = {
    now: () => (w.clock += 1000), sleep: async () => { w.tick = (w.tick ?? 0) + 1; if (d.wipe4860 && w.tick >= 1) w.wiped = true; finish(); },
    gh, cliVersion: async () => "1.39.0",
    cli: async (a) => {
      if (a[1] === "--add") { const n = Number(a[3]); if (d.add4859) return { code: 0, stdout: `#${n} skipped: unreadable`, stderr: "" }; w.order.push(n); w.deps[n] = [Number(Object.keys(w.issues)[0])]; return { code: 0, stdout: "added", stderr: "" }; }
      throw new Error("cli " + a);
    },
    orchestrate: {
      start: async (repo, issues) => { w.order.push(...issues); w.running[issues[0]] = { pid: ++w.pid }; w.a = issues[0]; return { id: "b1", kill: async () => { w.killed++; } }; },
      resume: async (id) => { w.resumedAt = w.tick ?? 0; if (d.double) w.running[w.a] = { pid: ++w.pid }; return { id, kill: async () => { w.killed++; } }; },
      state: async () => ({ order: w.order, deps: w.deps, running: w.running, results: w.results }),
    },
    remote: w.pool ? { run: async ({ issue }) => { w.remoteIssue = issue; return { where: d.local ? "local" : "remote", authenticated: !d.noRemoteAuth, engineVersion: d.oldEngine ? "1.37.0" : "1.39.0" }; } } : null,
  };
  function finish() {
    if (w.resumedAt !== undefined && !w.finished && (w.tick ?? 0) >= w.resumedAt + 2) {
      w.finished = true;
      const [a, b] = Object.keys(w.issues).map(Number);
      w.results = { [a]: { outcome: "merged", pr: 101 }, [b]: { outcome: "merged", pr: 102 } };
      for (const n of [a, b]) w.issues[n].labels.push("workflow:merged"), w.issues[n].state = "CLOSED";
    }
  }
  return { w, io };
}
const run = (d, extra = {}) => { const { w, io } = world(d); return runSelftestLive({ repo: "o/sandbox", io, pollMs: 1, timeoutMs: 60000, ...extra }).then((r) => ({ w, r })); };

describe("selftest --live steps (#4865)", () => {
  it("all steps pass and cleanup runs", async () => {
    const { w, r } = await run({});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(w.closed, ["10", "11"]);
    assert.match(r.notes.join(), /remote: skipped/);
  });
  it("fixtures: B depends on A and the issue bodies are the fixture text", async () => {
    const { w } = await run({});
    assert.match(w.issues[11].body, /\*\*Depends on\*\*: #10/);
  });
  it("the #4859 defect (--add skips the issue) fails the add step", async () => {
    const { r, w } = await run({ add4859: true });
    assert.equal(r.ok, false); assert.equal(r.step, "add"); assert.match(r.message, /skipped #11/);
    assert.deepEqual(w.closed, ["10", "11"], "cleanup ran after the failure");
  });
  it("the #4860 defect (body wiped to FORGE:STATE) fails the body step", async () => {
    const { r } = await run({ wipe4860: true });
    assert.equal(r.ok, false); assert.equal(r.step, "body"); assert.match(r.message, /lost its body text/);
  });
  it("a lane launched twice after --resume fails the resume step", async () => {
    const { r } = await run({ double: true });
    assert.equal(r.step, "resume"); assert.match(r.message, /launched again/);
  });
  it("B merging before A fails the merge step", async () => {
    const { r } = await run({ orderBA: true });
    assert.equal(r.step, "merge"); assert.match(r.message, /B merged before A/);
  });
  it("remote step: stale sandbox engine or no auth fails it; matching passes", async () => {
    assert.equal((await run({ pool: true })).r.ok, true);
    assert.match((await run({ pool: true, oldEngine: true })).r.message, /1\.37\.0 != CLI 1\.39\.0/);
    assert.equal((await run({ pool: true, noRemoteAuth: true })).r.step, "remote");
    assert.match((await run({ pool: true, local: true })).r.message, /not in the pool/);
    const ok = await run({ pool: true });
    assert.equal(ok.w.remoteIssue, 12); assert.deepEqual(ok.w.closed, ["10", "11", "12"]);
  });
  it("unknown fixture language fails at setup", async () => {
    assert.equal((await runSelftestLive({ repo: "o/r", lang: "ruby", io: {} })).step, "setup");
  });
  it("stripState drops only the annotation", () => assert.equal(stripState("hi\n<!-- FORGE:STATE\n{}\n-->"), "hi"));
  it("has the seven ordered phases", () => assert.deepEqual(STEPS.map((s) => s.name), ["create", "add", "body", "resume", "merge", "remote"]));
});

describe("selftestFromCli", () => {
  it("requires --live or --static and a sandbox repo", async () => {
    await assert.rejects(selftestFromCli([]), /usage/);
    await assert.rejects(selftestFromCli(["--live"], { cwd: "/nonexistent", print: () => {}, io: { gh: async () => "" } }), /no sandbox repo/);
  });
  it("a failing step is named in the output, returned not-ok, and the marker is posted as fail", async () => {
    const { io } = world({ add4859: true }); const out = [], posted = [];
    const gh = io.gh;
    io.gh = async (a) => {
      if (a[0] === "pr" && a[1] === "view" && a.includes("headRefOid")) return "a".repeat(40);
      if (a[0] === "repo") return JSON.stringify({ nameWithOwner: "o/r" });
      if (a[0] === "pr" && a[1] === "comment") { posted.push(a.at(-1)); return ""; }
      if (a[1] === "--help" || a[2] === "--help") return "JSON FIELDS\n  body, number, title\n";
      return gh(a);
    };
    const r = await selftestFromCli(["--live", "--repo", "o/sandbox", "--pr", "9"], { cwd: "/nonexistent", print: (l) => out.push(l), io, timing: { pollMs: 1 } });
    assert.equal(r.ok, false); assert.equal(r.step, "add");
    assert.ok(out.some((l) => /FAILED at step add/.test(l)));
    assert.match(posted[0], /FORGE:SELFTEST result=fail sha=a{40} step=add/);
  });
});
