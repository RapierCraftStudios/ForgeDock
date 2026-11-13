// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { laneStartGuard, waveDone, confirmGo, runP0, divergence, P0_BOUNDS } from "./release-p0.mjs";
import { buildDispatchArgs } from "./release-control.mjs";
import { applyOnExceed } from "./release-minutes.mjs";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const mk = (cwd) => (args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ENV }, stdio: ["pipe", "pipe", "pipe"] });

/** origin (bare) + work clone on main; `live` is the first commit, main may be ahead of it. */
function repoWorld({ ahead = false } = {}) {
  const root = tmpDir("p0-"), origin = join(root, "o.git"), work = join(root, "w");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { env: { ...process.env, ...ENV } });
  const git = mk(work);
  git(["checkout", "-q", "-b", "main"]);
  writeFileSync(join(work, "a.txt"), "1\n"); git(["add", "."]); git(["commit", "-qm", "one"]);
  const live = git(["rev-parse", "HEAD"]).trim();
  if (ahead) { writeFileSync(join(work, "b.txt"), "2\n"); git(["add", "."]); git(["commit", "-qm", "two"]); }
  git(["push", "-q", "origin", "main"]);
  return { git, live };
}
const deploy = { live_release_command: "live", pipelines: { hotfix: { workflow: "hotfix.yml", inputs: {} } } };
const ctxFor = (w, extra = {}) => {
  const recorded = [];
  return { recorded, io: { git: w.git, rehearse: async () => ({ ok: true, output: w.live }), gh: async () => "[]" }, repo: "o/r", def: "main", deploy, recordDivergence: async (r) => { recorded.push(r); }, ...extra };
};

describe("laneStartGuard (I10)", () => {
  it("train is refused with the divergence in the message when default is ahead of live", async () => {
    const w = repoWorld({ ahead: true });
    const r = await laneStartGuard(ctxFor(w), "train");
    assert.match(r.refused, /train lane refused: main .* != live/);
  });
  it("train starts when default == live", async () => {
    const w = repoWorld();
    assert.equal((await laneStartGuard(ctxFor(w), "train")).ok, true);
  });
  it("p0 in the same state proceeds, bases on live and records the divergence", async () => {
    const w = repoWorld({ ahead: true });
    const c = ctxFor(w, { release: "r1" });
    const r = await laneStartGuard(c, "p0");
    assert.equal(r.ok, true); assert.equal(r.base, w.live); assert.match(r.divergence, /!= live/);
    assert.equal(c.recorded.length, 1); assert.equal(c.recorded[0].live, w.live);
  });
  it("an unreadable live sha refuses a guarded lane; other lanes are not guarded", async () => {
    const w = repoWorld();
    const c = ctxFor(w); c.io.rehearse = async () => ({ ok: false, output: "" });
    assert.match((await laneStartGuard(c, "p0")).refused, /cannot read the live sha/);
    assert.equal((await laneStartGuard(c, "feature")).ok, true);
  });
});

describe("WAVE_DONE (I11)", () => {
  const wctx = (w, state, view) => ({ ...ctxFor(w), state, io: { ...ctxFor(w).io, gh: async () => JSON.stringify(view) } });
  it("refuses with no landing PR and while the PR is unmerged", async () => {
    const w = repoWorld();
    assert.equal((await waveDone(wctx(w, {}, {}))).done, false);
    const r = await waveDone(wctx(w, { p0: { landingPr: 5 } }, { state: "OPEN" }));
    assert.equal(r.done, false); assert.match(r.why, /not merged/);
  });
  it("refuses merged-but-live != default, passes when equal", async () => {
    const ahead = repoWorld({ ahead: true });
    assert.match((await waveDone(wctx(ahead, { p0: { landingPr: 5 } }, { state: "MERGED" }))).why, /!= live/);
    const eq = repoWorld();
    assert.deepEqual(await waveDone(wctx(eq, { p0: { landingPr: 5 } }, { state: "MERGED" })), { done: true });
    assert.equal(divergence({ io: { git: eq.git }, def: "main", live: eq.live }).equal, true);
  });
});

describe("confirmation, budget and dispatch allowlist", () => {
  it("asks for a typed go unless --yes", async () => {
    assert.equal(await confirmGo({ yes: true }), true);
    assert.equal(await confirmGo({ yes: false, ask: async () => "go", plan: "p" }), true);
    assert.equal(await confirmGo({ yes: false, ask: async () => "yes", plan: "p" }), false);
    assert.equal(await confirmGo({ yes: false }), false);
  });
  it("budget never blocks a p0", () => {
    assert.equal(applyOnExceed({ lane: "p0", forecast: 999, remaining: 1, cfg: { onExceed: "stop" } }).action, "proceed");
  });
  it("the dispatch builder rejects both break-glass inputs; the module never sets them", () => {
    for (const k of ["override_freeze", "acknowledge_hotfix_revert"]) assert.throws(() => buildDispatchArgs({ workflow: "w.yml", repo: "o/r", ref: "main", inputs: { [k]: "true" } }), /break-glass/);
    const src = readFileSync(new URL("./release-p0.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(src, /override_freeze|acknowledge_hotfix_revert/);
  });
  it("runP0 refuses pipeline inputs carrying a break-glass key", async () => {
    const state = { id: "r1", steps: {} };
    const cfg = { deploy: { ...deploy, pipelines: { hotfix: { workflow: "h.yml", inputs: { override_freeze: "true" } } } } };
    const r = await runP0({ io: {}, repo: "o/r", def: "main", state, save() {}, config: cfg }, { issue: 1 });
    assert.equal(r.status, "refused"); assert.match(r.reason, /break-glass/);
  });
});

describe("runP0 concurrency (I10)", () => {
  async function run(claim, preempt) {
    const w = repoWorld({ ahead: true });
    const tip = w.git(["rev-parse", "HEAD"]).trim();
    const calls = { gh: [], claims: [] };
    const io = {
      git: (a) => { if (a[0] === "ls-remote") return "x\trefs/heads/p0/issue-1\n"; if (a[0] === "rev-parse" && a[1] === "refs/remotes/origin/p0/issue-1") return `${tip}\n`; if (a[0] === "fetch" && a[3]?.startsWith("+")) return ""; return w.git(a); },
      rehearse: async () => ({ ok: true, output: w.live }), sleep: async () => {}, now: () => 1, api: async () => ({}),
      gh: async (a) => { calls.gh.push(a.join(" ")); if (a[0] === "run" && a[1] === "list") return JSON.stringify([{ databaseId: 9 }]); return "[]"; },
    };
    const state = { id: "r1", steps: {} };
    const ledger = { takeFence: async () => ({ fence: null }), claimDeploy: async (_c, o) => { calls.claims.push(o); return claim(o); }, releaseDeploy: async () => ({}) };
    const r = await runP0({ io, repo: "o/r", def: "main", state, save() {}, ledger, config: { deploy, p0Bounds: { pollMs: 0, queuePolls: 2 } } }, { issue: 1, preempt }).catch((e) => ({ status: "threw", reason: e.message }));
    return { r, calls };
  }
  it("queues behind a DEPLOYING release and never cancels without --preempt", async () => {
    const { r, calls } = await run(() => ({ queued: "release r0 is DEPLOYING" }), false);
    assert.equal(r.status, "queued");
    assert.equal(calls.claims.length, 3); assert.ok(calls.claims.every((c) => c.preempt === false));
    assert.ok(!calls.gh.some((c) => c.startsWith("run cancel")));
  });
  it("--preempt cancels the in-flight runs, audited through the claim", async () => {
    const { calls } = await run(() => ({ ok: true, preempted: "r0" }), true);
    assert.equal(calls.claims[0].preempt, true);
    assert.ok(calls.gh.some((c) => c.startsWith("run cancel 9")));
  });
  it("exposes bounds", () => assert.ok(P0_BOUNDS.queuePolls > 0));
});
