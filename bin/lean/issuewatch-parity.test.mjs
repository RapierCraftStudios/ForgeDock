// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { loadWatches, validateWatch, planClaims, tick, runWatch, formatStatus, formatClaimPlan } from "./issuewatch.mjs";
import { isPullRequest, closingPrIssues, releaseInFlight, watchLiveness, DEFAULT_SKIP_LABELS } from "./issuewatch-parity.mjs";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const iss = (n, o = {}) => ({ number: n, title: `t${n}`, body: "", labels: [], milestone: null, author: { login: "me" }, createdAt: "2026-11-09T00:00:00Z", ...o });
const lbl = (...n) => n.map((name) => ({ name }));
const state = () => ({ name: "w", repo: "o/r", phase: "running", claimed: [], inflight: [], merged: [], verified: [], unverified: [], closed: [], failed: [], folded: [], retries: {}, lanes: {}, batch: null, laneFor: {} });

function fakeIo(env, issues, { openPrs = [] } = {}) {
  const batchOps = [], reported = new Set(); let nb = 0;
  return { env: { FORGEDOCK_WATCH_DIR: env, FORGEDOCK_RELEASE_DIR: join(env, "releases") }, batchOps, reported, now: () => NOW, sleep: async () => {}, issues,
    gh: async function (a) {
      if (a[0] === "api") return this.issues.map((i) => `${i.number}\tOWNER`).join("\n");
      if (a[0] === "pr" && a[1] === "list") return JSON.stringify(openPrs);
      if (a[0] === "issue" && a[1] === "list") return JSON.stringify(this.issues);
      if (a[1] === "view") return JSON.stringify({ state: "OPEN", body: "" });
      return "";
    },
    batch: { add: (id, nums) => batchOps.push(["add", id, nums]), start: async (nums) => { batchOps.push(["start", nums]); return `b${++nb}`; }, reported: (id) => reported.has(id) } };
}
const bind = (io) => { const g = io.gh; io.gh = (a) => g.call(io, a); return io; };

test("#5313 a PR is never a claim: a PR-shaped item and an is:pr search are both refused", async () => {
  assert.ok(isPullRequest({ url: "https://github.com/o/r/pull/9" }) && isPullRequest({ pullRequest: {} }) && !isPullRequest({ url: "https://github.com/o/r/issues/9" }));
  assert.throws(() => validateWatch("w", { search: "is:pr label:x" }), /issues only/);
  assert.doesNotThrow(() => validateWatch("w", { search: "-is:pr label:x" }));
  const io = bind(fakeIo(tmpDir("iwp-"), [iss(1), iss(2, { url: "https://github.com/o/r/pull/2" })]));
  const plan = await planClaims({ watch: validateWatch("w", { mode: "batch" }), repo: "o/r", io, state: state() });
  assert.deepEqual(plan.claim.map((c) => c.number), [1]);
  assert.match(formatClaimPlan(plan), /skip #2: pull request/);
});

test("#5313 an issue with an open closing PR is skipped, and default skip labels apply to batch watches", async () => {
  const io = bind(fakeIo(tmpDir("iwp-"), [iss(1), iss(2), ...DEFAULT_SKIP_LABELS.map((l, k) => iss(10 + k, { labels: lbl(l) }))], { openPrs: [{ number: 77, closingIssuesReferences: [{ number: 2 }] }] }));
  assert.deepEqual([...(await closingPrIssues(io.gh, "o/r"))], [[2, 77]]);
  const plan = await planClaims({ watch: validateWatch("w", { mode: "batch" }), repo: "o/r", io, state: state() });
  assert.deepEqual(plan.claim.map((c) => c.number), [1]);
  assert.ok(plan.skip.some((s) => s.number === 2 && s.reason === "open closing PR #77"));
  assert.equal(plan.skip.filter((s) => /^skip label /.test(s.reason)).length, DEFAULT_SKIP_LABELS.length);
  const per = await planClaims({ watch: validateWatch("w", {}), repo: "o/r", io, state: state() }); // per-issue: no default list
  assert.ok(per.claim.some((c) => c.number === 10));
  const off = await planClaims({ watch: validateWatch("w", { mode: "batch", skip_labels: [] }), repo: "o/r", io, state: state() });
  assert.ok(off.claim.some((c) => c.number === 10));
});

test("#5313 an AlterLab-equivalent config (two windows, skip labels) plans the claims the script would", async () => {
  const w = loadWatches(`issue_watch:\n  watches:\n    nomilestone:\n      milestone: none\n      since: 2026-11-08T00:00:00Z\n      include_followups: defer-only\n      mode: batch\n    milestoned:\n      milestone: "1.5"\n      since: 2026-11-01T00:00:00Z\n      mode: batch\n`);
  const ms = { title: "1.5" };
  const issues = [iss(1), iss(2, { createdAt: "2026-11-01T00:00:00Z" }), iss(3, { milestone: ms }), iss(4, { milestone: ms, labels: lbl("host-task") }), iss(5, { url: "https://github.com/o/r/pull/5" }), iss(6, { milestone: ms, createdAt: "2026-10-01T00:00:00Z" })];
  const io = bind(fakeIo(tmpDir("iwp-"), issues));
  const claims = async (n) => (await planClaims({ watch: w[n], repo: "o/r", io, state: state() })).claim.map((c) => c.number);
  assert.deepEqual(await claims("nomilestone"), [1]);
  assert.deepEqual(await claims("milestoned"), [3]);
});

const relDir = (env, id, st, ageMs) => { const d = join(env, "releases", id); mkdirSync(d, { recursive: true }); const f = join(d, "state.json"); writeFileSync(f, JSON.stringify(st)); const t = (NOW - ageMs) / 1000; utimesSync(f, t, t); };

test("#5313 releaseInFlight: a running job counts; ended, stale, other-repo and missing roots do not", () => {
  const env = tmpDir("iwp-"), root = join(env, "releases");
  relDir(env, "r20261110-100000-1", { repo: "o/r", steps: { preflight: { done: true } } }, 60000);
  const r = releaseInFlight({ root, repo: "o/r", now: NOW });
  assert.equal(r.id, "r20261110-100000-1"); assert.equal(r.step, "host-preflight");
  assert.equal(releaseInFlight({ root, repo: "x/y", now: NOW }), null);
  const e2 = tmpDir("iwp-"); relDir(e2, "r20261110-100000-2", { repo: "o/r", status: "stopped", steps: {} }, 1000); relDir(e2, "r20261110-100000-3", { repo: "o/r", steps: {} }, 7 * 3600 * 1000);
  assert.equal(releaseInFlight({ root: join(e2, "releases"), repo: "o/r", now: NOW }), null);
  assert.equal(releaseInFlight({ root: join(e2, "nope"), now: NOW }), null);
});

test("#5313 a release in flight pauses the watch (no claims), the next pass resumes by itself, status shows it", async () => {
  const env = tmpDir("iwp-"), dir = join(env, "w"); mkdirSync(dir, { recursive: true });
  const io = bind(fakeIo(env, [iss(1)])), watch = validateWatch("w", { mode: "batch" });
  relDir(env, "r20261110-110000-9", { repo: "o/r", steps: {} }, 30000);
  const pass = () => runWatch({ watch, repo: "o/r", io, dir, once: true, intervalMs: 300000, cwd: env });
  let s = await pass();
  assert.equal(io.batchOps.length, 0); assert.match(s.paused.reason, /release r20261110-110000-9 in flight/);
  const text = formatStatus(s, watch, io.now());
  assert.match(text, /state: paused \(release r20261110-110000-9 in flight/); assert.match(text, /last heartbeat: 2026-11-10T12:00:00.000Z/);
  assert.equal(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).paused.release, "r20261110-110000-9");
  writeFileSync(join(env, "releases", "r20261110-110000-9", "state.json"), JSON.stringify({ repo: "o/r", status: "done", steps: {} })); // the job ends
  s = await pass();
  assert.equal(s.paused, null); assert.deepEqual(io.batchOps[0], ["start", [1]]);
  assert.match(formatStatus(s, watch, io.now()), /state: running/);
});

test("#5313 watchLiveness: a fresh heartbeat runs, an old one is stale, a finished watch is done", () => {
  const beat = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(watchLiveness({ phase: "running", heartbeat: beat(1000), heartbeatEveryMs: 300000 }, NOW).state, "running");
  assert.equal(watchLiveness({ phase: "running", heartbeat: beat(3600000), heartbeatEveryMs: 300000 }, NOW).state, "stale");
  assert.equal(watchLiveness({ phase: "running", heartbeat: beat(1000), paused: { reason: "release r1 in flight" } }, NOW).state, "paused");
  assert.equal(watchLiveness({ phase: "done", heartbeat: beat(9e9) }, NOW).state, "done");
  assert.equal(watchLiveness(null, NOW).state, "unknown");
  assert.match(formatStatus({ ...state(), heartbeat: beat(3600000), heartbeatEveryMs: 300000 }, validateWatch("w", {}), NOW), /state: stale/);
});

test("#5313 a batch that reported between the settle check and the add is never added to: a new batch starts", async () => {
  const io = bind(fakeIo(tmpDir("iwp-"), [iss(1)])), watch = validateWatch("w", { mode: "batch" }), st = state();
  await tick({ watch, repo: "o/r", io, state: st, dir: tmpDir("iwp-") });
  assert.deepEqual(io.batchOps, [["start", [1]]]);
  let checks = 0; io.batch.reported = (id) => id === "b1" && ++checks > 1; // not reported at the settle check, reported at the re-check
  io.issues = [iss(3)];
  await tick({ watch, repo: "o/r", io, state: st, dir: tmpDir("iwp-") });
  assert.deepEqual(io.batchOps.at(-1), ["start", [3]]);
  assert.ok(!io.batchOps.some((o) => o[0] === "add"));
});

test("#5313 the follow-up rules and skip reasons show in the --dry-run plan: defer-only claims, post-deploy-only folds, PR and skip label skipped", async () => {
  const bot = { author: { login: "forgedock[bot]" } };
  const deferBody = "- [ ] fix it — defer: later\n";
  const pdBody = "- [ ] `check it` — post-deploy: live\n";
  const issues = [iss(1, { ...bot, title: "Follow-up: a", body: deferBody }), iss(2, { ...bot, title: "Follow-up: b", body: pdBody }), iss(3, { labels: lbl("epic") }), iss(4, { url: "https://github.com/o/r/pull/4" }), iss(5)];
  const io = bind(fakeIo(tmpDir("iwp-"), issues));
  const watch = validateWatch("w", { mode: "batch", include_followups: "defer-only", postdeploy_rollup: 100 });
  const plan = await planClaims({ watch, repo: "o/r", io, state: state() });
  const out = formatClaimPlan(plan);
  assert.deepEqual(plan.claim.map((c) => c.number), [1, 5]);
  assert.deepEqual(plan.fold, [2]);
  assert.match(out, /would fold #2/);
  assert.match(out, /skip #3: skip label epic/);
  assert.match(out, /skip #4: pull request/);
});
