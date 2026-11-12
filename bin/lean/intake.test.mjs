// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { githubPause, setIntake, readActive, intakeFromCli, INTAKE_LABEL } from "./intake.mjs";

const REPO = "o/r";
const err = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

/** In-memory GitHub shared by every "host": _active branch files, ledger states, open PRs, issue labels. */
function fakeGh({ prs = [], ledgers = {} } = {}) {
  const g = { files: {}, head: null, prs, ledgers, labels: new Set(), calls: [], n: 0, commits: {} };
  const b64 = (t) => ({ content: Buffer.from(t).toString("base64") });
  g.api = async (method, path, body) => {
    g.calls.push(`${method} ${path}`);
    let m;
    if ((m = /git\/ref\/heads\/(.+)$/.exec(path))) { if (m[1] !== "_active" || !g.head) throw err(404); return { object: { sha: g.head } }; }
    if ((m = /git\/commits\/(\w+)$/.exec(path))) return { tree: { sha: g.commits[m[1]] } };
    if (method === "POST" && /git\/trees$/.test(path)) { const files = { ...(g.commits.__files ?? {}) }; for (const e of body.tree) files[e.path] = e.content; g.commits.__files = files; return { sha: `t${++g.n}` }; }
    if (method === "POST" && /git\/commits$/.test(path)) { const sha = `c${++g.n}`; g.commits[sha] = body.tree; return { sha }; }
    if (method === "POST" && /git\/refs$/.test(path)) { g.head = body.sha; g.files = { ...g.commits.__files }; return {}; }
    if (method === "PATCH" && /git\/refs\//.test(path)) { g.head = body.sha; g.files = { ...g.commits.__files }; return {}; }
    if ((m = /contents\/([^?]+)\?ref=(.+)$/.exec(path))) {
      const br = decodeURIComponent(m[2]);
      if (br === "_active") { if (g.files[m[1]] === undefined) throw err(404); return b64(g.files[m[1]]); }
      const st = g.ledgers[br.replace("forge-ledger/", "")]; if (!st) throw err(404); return b64(JSON.stringify(st));
    }
    if (/pulls\?state=open/.test(path)) return g.prs;
    if (method === "POST" && /issues\/\d+\/labels$/.test(path)) { body.labels.forEach((l) => g.labels.add(l)); return []; }
    if (method === "DELETE" && /issues\/\d+\/labels\//.test(path)) { g.labels.delete(decodeURIComponent(path.split("/labels/")[1])); return []; }
    throw new Error(`unrouted ${method} ${path}`);
  };
  g.get = async (p) => { try { return await g.api("GET", p); } catch (e) { if (e.status === 404) return null; throw e; } };
  return g;
}

describe("intake pause from GitHub (#5555)", () => {
  it("the 2026-11-12 case: an open release/* PR pauses with no local state or _active", async () => {
    const g = fakeGh({ prs: [{ number: 9, head: { ref: "release/20261112-1" } }] });
    const r = await githubPause({ get: g.get, repo: REPO });
    assert.equal(r.paused, true); assert.equal(r.source, "pr"); assert.match(r.reason, /#9/);
  });
  it("train/*, hotfix/* heads pause; feature heads do not", async () => {
    for (const ref of ["train/a", "hotfix/b"]) assert.equal((await githubPause({ get: fakeGh({ prs: [{ number: 1, head: { ref } }] }).get, repo: REPO })).paused, true);
    assert.equal((await githubPause({ get: fakeGh({ prs: [{ number: 1, head: { ref: "feat/x" } }] }).get, repo: REPO })).paused, false);
  });
  it("intake pause on host A is honoured by host B, writes the label and an audit line; resume reverses", async () => {
    const g = fakeGh();
    const r = await setIntake({ io: { api: g.api }, repo: REPO, paused: true, reason: "freeze", by: "op", tracker: 7, now: 1_000 });
    assert.ok(r.ok); assert.ok(g.labels.has(INTAKE_LABEL));
    assert.equal((await readActive(g.get, REPO)).intake.paused, true);
    assert.match(g.files["controls.jsonl"], /"verb":"intake-pause"/);
    const hostB = await githubPause({ get: g.get, repo: REPO });
    assert.equal(hostB.paused, true); assert.match(hostB.reason, /freeze/);
    await setIntake({ io: { api: g.api }, repo: REPO, paused: false, by: "op", tracker: 7, now: 2_000 });
    assert.equal(g.labels.has(INTAKE_LABEL), false);
    assert.equal((await githubPause({ get: g.get, repo: REPO })).paused, false);
    assert.equal(g.files["controls.jsonl"].trim().split("\n").length, 2);
  });
  it("an active ledger entry pauses; an ended one does not", async () => {
    const g = fakeGh({ ledgers: { "r20261112-101500-1": { status: undefined } } });
    g.files["active.json"] = JSON.stringify({ lease: { holder: "h", release: "r20261112-101500-1" } }); g.head = "x";
    assert.equal((await githubPause({ get: g.get, repo: REPO })).source, "ledger");
    g.ledgers["r20261112-101500-1"] = { status: "done" };
    assert.equal((await githubPause({ get: g.get, repo: REPO })).paused, false);
  });
  it("auto-resume: a pause naming an ended release resumes only when enabled", async () => {
    const g = fakeGh({ ledgers: { "r1": { status: "done" } } });
    await setIntake({ io: { api: g.api }, repo: REPO, paused: true, release: "r1", now: 1 });
    assert.equal((await githubPause({ get: g.get, repo: REPO })).paused, true);
    const r = await githubPause({ get: g.get, repo: REPO, autoResume: true });
    assert.equal(r.paused, false); assert.equal(r.resume, true);
  });
  it("CLI pause writes through io.api and status reports it", async () => {
    const g = fakeGh(), out = [];
    const io = { api: g.api, gh: async () => JSON.stringify({}), now: () => 5 };
    await intakeFromCli(["pause", "--repo", REPO, "--reason", "why", "--tracker", "3"], { io, by: "me", print: (l) => out.push(l), cwd: "/nonexistent" });
    const s = await intakeFromCli(["status", "--repo", REPO], { io, print: (l) => out.push(l), cwd: "/nonexistent" });
    assert.equal(s.paused, true); assert.match(out.join("\n"), /PAUSED/);
    await assert.rejects(intakeFromCli(["bogus"], { io }), /usage/);
  });
});

describe("issue-watch pass reads GitHub intake (#5555)", () => {
  const run = async (yaml, g) => {
    const { writeFileSync } = await import("node:fs"), { join } = await import("node:path");
    const { runWatch, validateWatch } = await import("./issuewatch.mjs");
    const cwd = tmpDir("intake-"), dir = tmpDir("intake-w-");
    writeFileSync(join(cwd, "forge.yaml"), yaml);
    const gh = async (a) => { g.calls.push(`gh ${a.join(" ")}`); if (a[0] === "api") return JSON.stringify(await g.get(a[1])); throw new Error(`unexpected gh ${a.join(" ")}`); };
    const io = { env: { FORGEDOCK_WATCH_DIR: dir, PATH: "" }, gh, now: () => 1_000, sleep: async () => {}, releaseInFlight: () => null };
    return runWatch({ watch: validateWatch("w", { mode: "batch" }), repo: REPO, io, dir, branches: {}, defaults: [], once: true, cwd });
  };
  it("managed: an open release PR pauses the pass within one poll and nothing is claimed", async () => {
    const g = fakeGh({ prs: [{ number: 9, head: { ref: "release/20261112-1" } }] });
    const state = await run("release:\n  managed: true\n", g);
    assert.match(state.paused.reason, /release PR #9/); assert.equal(state.claimed.length, 0);
  });
  it("unmanaged (defaults): no GitHub call is made for the pause", async () => {
    const g = fakeGh({ prs: [{ number: 9, head: { ref: "release/x" } }] });
    await run("project: x\n", g).catch(() => {});
    assert.equal(g.calls.filter((c) => /pulls|contents|git\/ref/.test(c)).length, 0);
  });
});
