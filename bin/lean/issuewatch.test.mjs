// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWatches, validateWatch, loadWatches, matchesSelectors, issueVersion, hasUnresolvedDefer, classifyIssue, laneFor, dagOrder, claimIssue, acquireLock, tick, runWatch, formatStatus, repoDir, watchDir, issueWatchFromCli } from "./issuewatch.mjs";
import { openBatch } from "./batch.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "iw-"));
const iss = (n, o = {}) => ({ number: n, title: `t${n}`, body: "", labels: [], milestone: null, authorAssociation: "OWNER", author: { login: "me" }, createdAt: "2026-10-01T00:00:00Z", ...o });
const lbl = (...n) => n.map((name) => ({ name }));
const W = (o = {}) => validateWatch("w", o);

/** gh fake: `issues` open list, `closed` set of closed numbers, `bodies` for view/edit. */
function fakeIo(env, issues, { closed = new Set(), exit = () => 0, bodies = {} } = {}) {
  const calls = [], launched = [], batchOps = [];
  let clock = Date.parse("2026-10-30T00:00:00Z"), nb = 0;
  const io = { env: { FORGEDOCK_WATCH_DIR: env }, calls, launched, batchOps, closed, bodies, tickClock: (ms) => { clock += ms; }, now: () => clock, sleep: async () => {},
    gh: async (a) => {
      calls.push(a);
      if (a[1] === "list") return JSON.stringify(issues.filter((i) => !closed.has(i.number)));
      if (a[1] === "view" && a.includes("state")) return JSON.stringify({ state: closed.has(+a[2]) ? "CLOSED" : "OPEN" });
      if (a[1] === "view") return JSON.stringify({ body: bodies[a[2]] ?? "" });
      if (a[1] === "edit") { bodies[a[2]] = a[a.indexOf("--body") + 1]; return ""; }
      return "";
    },
    launch: (n, lane) => { launched.push([n, lane]); return { poll: () => ({ code: exit(n) }) }; },
    batch: { add: (id, nums) => batchOps.push(["add", id, nums]), start: async (nums, k, lane) => { batchOps.push(["start", nums, k, lane]); return `b${++nb}`; }, reported: (id) => io.reported?.has(id) ?? false } };
  return io;
}

test("parseWatches reads three nesting levels, lists, quotes and ISO times", () => {
  const w = loadWatches(`project:\n  name: x\nissue_watch:\n  watches:\n    nomilestone:\n      milestone: none\n      exclude_labels: [epic, post-deploy]\n      include_followups: defer-only\n      mode: batch\n      parallel: 12\n    release-1-4:\n      version: "1.4"\n      max_issues: 300\n      until: 2026-11-15T00:00:00Z\nother:\n  a: b\n`);
  assert.deepEqual(Object.keys(w), ["nomilestone", "release-1-4"]);
  assert.deepEqual(w.nomilestone.exclude_labels, ["epic", "post-deploy"]);
  assert.equal(w.nomilestone.parallel, 12);
  assert.equal(w["release-1-4"].max_issues, 300);
  assert.equal(w["release-1-4"].until, "2026-11-15T00:00:00Z");
  assert.equal(w["release-1-4"].version, "1.4");
  assert.deepEqual(parseWatches("project:\n  a: b\n"), {});
});

test("validateWatch rejects unknown keys, bad mode, regex, date, numbers", () => {
  assert.throws(() => W({ bogus: 1 }), /unknown key/);
  assert.throws(() => W({ mode: "x" }), /mode/);
  assert.throws(() => W({ title_regex: "(" }), /title_regex/);
  assert.throws(() => W({ until: "soon" }), /until/);
  assert.throws(() => W({ max_issues: "0" }), /max_issues/);
  assert.throws(() => W({ version: "1" }), /version/);
  assert.equal(W().mode, "per-issue");
  assert.equal(W().max_issues, null);
});

test("selectors: milestone slug / none, labels, exclude_labels, title_regex, since", () => {
  const m = iss(1, { milestone: { title: "Release 1.4" } });
  assert.ok(matchesSelectors(m, W({ milestone: "release-1.4" }))); // slug form
  assert.ok(!matchesSelectors(m, W({ milestone: "other" })));
  assert.ok(!matchesSelectors(m, W({ milestone: "none" })));
  assert.ok(matchesSelectors(iss(2), W({ milestone: "none" })));
  assert.ok(!matchesSelectors(iss(2), W({ milestone: "some" })));
  assert.ok(matchesSelectors(iss(3, { labels: lbl("a", "b") }), W({ labels: ["a"] })));
  assert.ok(!matchesSelectors(iss(3, { labels: lbl("a") }), W({ labels: ["a", "b"] })));
  assert.ok(!matchesSelectors(iss(4, { labels: lbl("epic") }), W({ exclude_labels: ["epic"] })));
  assert.ok(matchesSelectors(iss(4, { labels: lbl("x") }), W({ exclude_labels: ["epic"] })));
  assert.ok(matchesSelectors(iss(5, { title: "fix: a" }), W({ title_regex: "^fix:" })));
  assert.ok(!matchesSelectors(iss(5, { title: "feat: a" }), W({ title_regex: "^fix:" })));
  assert.ok(matchesSelectors(iss(6), W({ since: "2026-09-01T00:00:00Z" })));
  assert.ok(!matchesSelectors(iss(6), W({ since: "2026-10-02T00:00:00Z" })));
});

test("version: from the milestone title, from a version:x.y label, title wins", () => {
  assert.equal(issueVersion(iss(1, { milestone: { title: "v1.4 hardening" } })), "1.4");
  assert.equal(issueVersion(iss(2, { labels: lbl("version:1.5") })), "1.5");
  assert.equal(issueVersion(iss(3, { milestone: { title: "Release 1.4" }, labels: lbl("version:1.5") })), "1.4");
  assert.equal(issueVersion(iss(4)), null);
  const w = W({ version: "1.4" });
  assert.ok(matchesSelectors(iss(1, { milestone: { title: "Release 1.4" } }), w));
  assert.ok(matchesSelectors(iss(2, { labels: lbl("version:1.4") }), w));
  assert.ok(!matchesSelectors(iss(3, { labels: lbl("version:1.5") }), w));
});

test("search is passed to gh", async () => {
  const dir = tmp(), io = fakeIo(dir, [iss(1)]);
  await tick({ watch: W({ search: "label:bug sort:created-asc" }), repo: "o/r", io, state: { claimed: [], inflight: [], merged: [], verified: [], failed: [], folded: [], retries: {}, lanes: {}, phase: "running" } });
  const list = io.calls.find((a) => a[1] === "list");
  assert.equal(list[list.indexOf("--search") + 1], "label:bug sort:created-asc");
});

test("lane: milestone → pattern, else staging, pin allowed, default branch refused", () => {
  const b = { staging: "staging", featurePattern: "milestone/{slug}" };
  assert.equal(laneFor(iss(1, { milestone: { title: "Release 1.4" } }), W(), { branches: b, defaults: ["main"] }), "milestone/release-14");
  assert.equal(laneFor(iss(2), W(), { branches: b, defaults: ["main"] }), "staging");
  assert.equal(laneFor(iss(2), W({ lane: "dev" }), { branches: b, defaults: ["main"] }), "dev");
  assert.throws(() => laneFor(iss(2), W({ lane: "main" }), { branches: b, defaults: ["main"] }), /default branch/);
});

test("follow-ups: defer-only claims bot follow-ups with an unchecked defer item; plain bot issues and post-deploy-only excluded", () => {
  const bot = (body, title = "follow-up: 1 deferred item(s)") => iss(9, { title, body, authorAssociation: "CONTRIBUTOR", author: { login: "forge[bot]" } });
  const defer = "- [ ] `R1: x` — defer: separate work\n";
  const pd = "- [ ] `R2: y` — post-deploy: check later\n";
  assert.ok(hasUnresolvedDefer(defer));
  assert.ok(!hasUnresolvedDefer("- [x] `R1: x` — defer: done\n"));
  assert.ok(!hasUnresolvedDefer(pd));
  assert.equal(classifyIssue(bot(defer), W({ include_followups: "defer-only" })), "claim");
  assert.equal(classifyIssue(bot(defer + pd), W({ include_followups: "defer-only" })), "claim");
  assert.equal(classifyIssue(bot(defer), W()), null);
  assert.equal(classifyIssue(bot(defer, "chore: bot issue"), W({ include_followups: "defer-only" })), null);
  assert.equal(classifyIssue(bot(pd), W({ include_followups: "defer-only" })), null);
  assert.equal(classifyIssue(bot(pd), W({ include_followups: "defer-only", postdeploy_rollup: "50" })), "fold");
  assert.equal(classifyIssue(iss(1, { authorAssociation: "NONE" }), W()), null);
});

test("postdeploy_rollup folds a post-deploy-only follow-up into the release checklist once", async () => {
  const dir = tmp();
  const f = iss(9, { title: "follow-up: 1 deferred item(s)", body: "- [ ] `R2: y` — post-deploy: check\n", authorAssociation: "CONTRIBUTOR", author: { login: "forge[bot]" } });
  const io = fakeIo(dir, [f], { bodies: { 50: "## Release\n- [ ] ship\n" } });
  const watch = W({ include_followups: "defer-only", postdeploy_rollup: "50" });
  const state = { claimed: [], inflight: [], merged: [], verified: [], failed: [], folded: [], retries: {}, lanes: {}, phase: "running" };
  await tick({ watch, repo: "o/r", io, state });
  await tick({ watch, repo: "o/r", io, state });
  assert.match(io.bodies[50], /- \[ \] #9 follow-up: 1 deferred item\(s\) — post-deploy/);
  assert.equal(io.bodies[50].match(/#9\b/g).length, 1);
  assert.deepEqual(io.launched, []);
  assert.deepEqual(state.claimed, []);
});

test("two named watches on one repo never double-claim", async () => {
  const dir = tmp();
  const issues = [1, 2, 3, 4].map((n) => iss(n));
  const mk = () => ({ claimed: [], inflight: [], merged: [], verified: [], failed: [], folded: [], retries: {}, lanes: {}, phase: "running" });
  const a = { watch: validateWatch("a", { max_inflight: "3" }), io: fakeIo(dir, issues), state: mk() };
  const b = { watch: validateWatch("b", { max_inflight: "3" }), io: fakeIo(dir, issues), state: mk() };
  await Promise.all([a, b].map((x) => tick({ ...x, repo: "o/r", handles: new Map() })));
  await Promise.all([a, b].map((x) => tick({ ...x, repo: "o/r", handles: new Map() })));
  const all = [...a.state.claimed, ...b.state.claimed];
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...all].sort(), [1, 2, 3, 4]);
  assert.equal(claimIssue(repoDir("o/r", { FORGEDOCK_WATCH_DIR: dir }), 1, "c"), false);
});

test("max_issues stops claiming at N, drains, then finishes", async () => {
  const dir = tmp();
  const io = fakeIo(dir, [1, 2, 3, 4, 5].map((n) => iss(n)), { exit: () => 0 });
  const watch = W({ max_issues: "3", max_inflight: "2" });
  const state = await runWatch({ watch, repo: "o/r", io, dir: watchDir("o/r", "w", { FORGEDOCK_WATCH_DIR: dir }), once: false, intervalMs: 1 });
  assert.equal(state.claimed.length, 3);
  assert.equal(state.phase, "done");
  assert.equal(io.launched.length, 3);
  assert.match(formatStatus(state, watch, io.now()), /claims: 3\/3/);
});

test("max_issues drain keeps retrying: a deferred (75) lane relaunches until it merges", async () => {
  const dir = tmp();
  let n75 = 1;
  const io = fakeIo(dir, [iss(1), iss(2)], { exit: () => (n75-- > 0 ? 75 : 0) });
  const state = await runWatch({ watch: W({ max_issues: "1" }), repo: "o/r", io, dir: watchDir("o/r", "w", { FORGEDOCK_WATCH_DIR: dir }), intervalMs: 1 });
  assert.equal(io.launched.length, 2); // launch + one retry
  assert.deepEqual(state.merged, [1]);
  assert.equal(state.claimed.length, 1);
});

test("until stops claiming and drains; a failed lane is counted", async () => {
  const dir = tmp();
  const io = fakeIo(dir, [iss(1), iss(2)], { exit: () => 1 });
  const watch = W({ until: "2026-10-30T00:10:00Z", max_inflight: "1" });
  const state = { claimed: [], inflight: [], merged: [], verified: [], failed: [], folded: [], retries: {}, lanes: {}, phase: "running" };
  const handles = new Map();
  await tick({ watch, repo: "o/r", io, state, handles });
  assert.deepEqual(state.inflight, [1]);
  io.tickClock(20 * 60 * 1000);
  await tick({ watch, repo: "o/r", io, state, handles });
  assert.deepEqual(state.failed, [1]);
  assert.equal(state.phase, "done");
  assert.deepEqual(state.claimed, [1]); // nothing claimed after until
});

test("no cap: keeps claiming across passes (forever)", async () => {
  const dir = tmp();
  const io = fakeIo(dir, [iss(1)], { exit: () => 0 });
  const watch = W();
  const state = { claimed: [], inflight: [], merged: [], verified: [], failed: [], folded: [], retries: {}, lanes: {}, phase: "running" };
  const handles = new Map();
  for (let i = 0; i < 3; i++) await tick({ watch, repo: "o/r", io, state, handles });
  io.closed.add(1);
  await tick({ watch, repo: "o/r", io, state, handles });
  assert.equal(state.phase, "running");
  assert.equal(watch.max_issues, null);
});

test("lock is per (repo, name): a live holder blocks, another name does not, a dead holder is taken over", () => {
  const d = tmp(), a = join(d, "a"), b = join(d, "b");
  mkdirSync(a); mkdirSync(b);
  acquireLock(a, { pid: 111, host: "h", alive: () => true });
  assert.throws(() => acquireLock(a, { pid: 222, host: "h", alive: () => true }), /already running/);
  acquireLock(b, { pid: 222, host: "h", alive: () => true });
  acquireLock(a, { pid: 222, host: "h", alive: () => false });
});

test("batch mode adds to one batch, rolls to a new one after the report, and orders by Depends on", async () => {
  const dir = tmp();
  const issues = [iss(1, { body: "Depends on #2" }), iss(2), iss(3)];
  const io = fakeIo(dir, issues);
  const watch = W({ mode: "batch", parallel: "7", max_inflight: "2" });
  const state = { claimed: [], inflight: [], merged: [], verified: [], failed: [], folded: [], retries: {}, lanes: {}, phase: "running", batch: null };
  await tick({ watch, repo: "o/r", io, state });
  assert.deepEqual(io.batchOps[0], ["start", [2, 1], 7, "staging"]); // dependency first
  io.closed.add(2); io.closed.add(1);
  await tick({ watch, repo: "o/r", io, state });
  assert.deepEqual(io.batchOps[1], ["add", "b1", [3]]);
  io.reported = new Set(["b1"]);
  io.closed.add(3);
  await tick({ watch, repo: "o/r", io, state });
  assert.equal(state.batch, null);
  assert.deepEqual(state.verified.sort(), [1, 2, 3]);
  io.reported = new Set();
  issues.push(iss(4));
  await tick({ watch, repo: "o/r", io, state });
  assert.deepEqual(io.batchOps[2], ["start", [4], 7, "staging"]); // a new batch
  assert.deepEqual(dagOrder([iss(1, { body: "Depends on: #2, #3" }), iss(2), iss(3)]).map((i) => i.number), [2, 3, 1]);
});

test("batch mode with the real batch file: addIssues lands in the batch's add file", async () => {
  const root = tmp();
  const b = openBatch(root, "b1"); mkdirSync(b.dir, { recursive: true });
  b.writePlan({ issues: [1] }); b.store.save({ order: [1] });
  const io = fakeIo(tmp(), [iss(5)]);
  io.batch.add = (id, nums) => openBatch(root, id).addIssues(nums);
  const state = { claimed: [], inflight: [], merged: [], verified: [], failed: [], folded: [], retries: {}, lanes: {}, phase: "running", batch: "b1" };
  await tick({ watch: W({ mode: "batch" }), repo: "o/r", io, state });
  assert.deepEqual(b.readAdded(), [5]);
});

test("status prints selector, claims, inflight, merged, verified, failed, time remaining; CLI status/run", async () => {
  const dir = tmp(), cwd = tmp();
  writeFileSync(join(cwd, "forge.yaml"), "branches:\n  default: main\nissue_watch:\n  watches:\n    r:\n      version: \"1.4\"\n      max_issues: 5\n      until: 2026-10-30T02:00:00Z\n");
  const io = fakeIo(dir, [iss(1, { labels: lbl("version:1.4") })], { exit: () => 0 });
  io.gh = ((orig) => async (a) => (a[0] === "repo" ? (a.includes("nameWithOwner") ? JSON.stringify({ nameWithOwner: "o/r" }) : "main") : orig(a)))(io.gh);
  const out = [];
  await issueWatchFromCli(["run", "--name", "r", "--once"], { cwd, env: { FORGEDOCK_WATCH_DIR: dir }, io, print: (l) => out.push(l) });
  assert.ok(existsSync(join(watchDir("o/r", "r", { FORGEDOCK_WATCH_DIR: dir }), "status.json")));
  out.length = 0;
  await issueWatchFromCli(["status", "--name", "r"], { cwd, env: { FORGEDOCK_WATCH_DIR: dir }, io, print: (l) => out.push(l) });
  const t = out.join("\n");
  assert.match(t, /selector: version=1\.4/);
  assert.match(t, /claims: 1\/5\s+inflight: 0\s+merged: 1\s+verified: 0|claims: 1\/5\s+inflight: 1/);
  assert.match(t, /time remaining: 120m/);
  await assert.rejects(issueWatchFromCli(["bogus"], { cwd, env: { FORGEDOCK_WATCH_DIR: dir }, io }), /usage/);
});
