// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { loadWatches, validateWatch, issueWatchFromCli, runWatch, formatStatus, claimIssue, repoDir } from "./issuewatch.mjs";
import { priorityOf, poolScore, triggers, classifyTheme, classifyPool, releasePriorities, closure, decide, formatDryRun, releaseTick } from "./issuewatch-release.mjs";

const NOW = Date.parse("2026-10-30T00:00:00Z");
const iss = (n, o = {}) => ({ number: n, title: `t${n}`, body: "", labels: [], milestone: null, authorAssociation: "OWNER", author: { login: "me" }, createdAt: "2026-10-29T00:00:00Z", ...o });
const lbl = (...n) => n.map((name) => ({ name }));
const THEMES = { security: ["label:security", "path:infra/ssh-guard/**"], stealth: ["path:services/worker/**/anti_detection/**", "label:scraper"], billing: ["label:billing", "scope:pricing"] };
const W = (o = {}) => validateWatch("r", { mode: "release", threshold: { min_issues: 3 }, theme_map: THEMES, ...o });

test("config: flow-map threshold, theme_map block and immediate list parse; release keys need mode release", () => {
  const w = loadWatches(`issue_watch:\n  watches:\n    sr:\n      milestone: none\n      mode: release\n      threshold: { min_issues: 15, min_score: 40, max_age_days: 5 }\n      immediate: [label:security, priority:P0]\n      max_release_issues: 40\n      theme_map:\n        security: [label:security, path:infra/ssh-guard/**]\n        billing:  [label:billing, path:shared/pricing.py]\n      parallel: 6\n`).sr;
  assert.deepEqual(w.threshold, { min_issues: 15, min_score: 40, max_age_days: 5 });
  assert.deepEqual(w.immediate, ["label:security", "priority:P0"]);
  assert.deepEqual(w.theme_map.security, ["label:security", "path:infra/ssh-guard/**"]);
  assert.equal(w.max_release_issues, 40);
  assert.equal(w.parallel, 6);
  assert.throws(() => validateWatch("x", { threshold: { min_issues: 3 } }), /needs mode: release/);
  assert.throws(() => validateWatch("x", { mode: "release" }), /threshold or immediate/);
  assert.throws(() => validateWatch("x", { mode: "release", threshold: { min_issues: 0 } }), /positive/);
  assert.throws(() => validateWatch("x", { mode: "release", immediate: ["bogus"] }), /immediate/);
  assert.throws(() => validateWatch("x", { mode: "release", threshold: { min_issues: 1 }, theme_map: { a: ["nope"] } }), /theme_map/);
});

test("score weights P0=8 P1=4 P2=2 P3=1 and unprioritised 1", () => {
  assert.equal(priorityOf(iss(1, { labels: lbl("priority:P1") })), "P1");
  assert.equal(poolScore([iss(1, { labels: lbl("P0") }), iss(2, { labels: lbl("priority:P1") }), iss(3, { labels: lbl("P2") }), iss(4, { labels: lbl("P3") }), iss(5)]), 16);
});

test("each trigger type fires alone, and none fires below thresholds", () => {
  const w = W({ threshold: { min_issues: 3, min_score: 10, max_age_days: 5 }, immediate: ["label:security", "priority:P0"] });
  const kinds = (pool) => triggers(pool, w, NOW).map((t) => t.kind);
  assert.deepEqual(kinds([iss(1), iss(2)]), []);
  assert.deepEqual(kinds([iss(1), iss(2), iss(3)]), ["min_issues"]);
  assert.deepEqual(kinds([iss(1, { labels: lbl("P0") }), iss(2, { labels: lbl("P2") })]).includes("min_score"), true);
  assert.deepEqual(kinds([iss(1, { createdAt: "2026-10-20T00:00:00Z" })]), ["max_age_days"]);
  assert.deepEqual(kinds([iss(1, { labels: lbl("security") })]), ["immediate"]);
  assert.deepEqual(kinds([iss(1, { labels: lbl("P0") })]).includes("immediate"), true);
  assert.deepEqual(triggers([], w, NOW), []);
});

test("themes classify from labels, title scope and named paths; first rule wins; scope equal to a theme name works", () => {
  assert.equal(classifyTheme(iss(1, { labels: lbl("security") }), THEMES).theme, "security");
  assert.equal(classifyTheme(iss(2, { body: "Touches `infra/ssh-guard/keys.py`." }), THEMES).theme, "security");
  assert.equal(classifyTheme(iss(3, { body: "see services/worker/x/anti_detection/ua.py" }), THEMES).theme, "stealth");
  assert.equal(classifyTheme(iss(4, { title: "fix(pricing): rounding" }), THEMES).theme, "billing");
  assert.equal(classifyTheme(iss(5, { title: "feat(stealth): x" }), THEMES).via, "scope:stealth");
  assert.equal(classifyTheme(iss(6, { body: "docs/readme.md" }), THEMES), null);
});

test("LLM fallback only for unclassified issues, counted, and cached", async () => {
  const calls = [];
  const classify = async (rest) => { calls.push(rest.map((i) => i.number)); return { 7: "billing", 8: "nonsense" }; };
  const pool = [iss(1, { labels: lbl("security") }), iss(7), iss(8)];
  const r = await classifyPool(pool, W(), { classify });
  assert.deepEqual(calls, [[7, 8]]);
  assert.equal(r.llm, 2);
  assert.deepEqual([r.themes[1].theme, r.themes[7].theme, r.themes[8].theme], ["security", "billing", "general"]);
  const r2 = await classifyPool([pool[0]], W(), { classify });
  assert.equal(r2.llm, 0); assert.equal(calls.length, 1); // all classified by rules: no call
  const none = await classifyPool(pool, W(), {}); // no classifier: general, no count
  assert.equal(none.llm, 0); assert.equal(none.themes[7].theme, "general");
});

test("releasePriorities reads an inline or bulleted NORTHSTAR list", () => {
  assert.deepEqual(releasePriorities("# X\nRelease priorities: Security, billing\n"), ["security", "billing"]);
  assert.deepEqual(releasePriorities("Release priorities:\n- security\n- `stealth`\n\nother"), ["security", "stealth"]);
  assert.deepEqual(releasePriorities("nothing"), []);
});

const pooled = (...o) => { const pool = o.map((x, k) => iss(k + 1, x)); return { pool, openByNum: new Map(pool.map((i) => [i.number, i])) }; };
const themesOf = (pool, w) => Object.fromEntries(pool.map((i) => [i.number, classifyTheme(i, w.theme_map) ?? { theme: "general", via: "unclassified" }]));

test("decide picks the top-scoring theme; NORTHSTAR order breaks ties; nothing is cut below threshold", () => {
  const w = W();
  const { pool, openByNum } = pooled({ labels: lbl("billing") }, { labels: lbl("billing") }, { labels: lbl("security") });
  const d = decide({ pool, openByNum, themes: themesOf(pool, w), watch: w, now: NOW });
  assert.equal(d.theme, "billing"); assert.deepEqual(d.release.set.map((i) => i.number), [1, 2]);
  assert.match(d.below[0], /security pool 1 < threshold/);
  const tie = pooled({ labels: lbl("billing") }, { labels: lbl("security") }, { labels: lbl("security") }, { labels: lbl("billing") });
  assert.equal(decide({ pool: tie.pool, openByNum: tie.openByNum, themes: themesOf(tie.pool, w), watch: w, now: NOW, priorities: ["security"] }).theme, "security");
  const few = pooled({ labels: lbl("billing") });
  const d2 = decide({ pool: few.pool, openByNum: few.openByNum, themes: themesOf(few.pool, w), watch: w, now: NOW });
  assert.equal(d2.release, null);
});

test("immediate security issue below threshold cuts a security release alone, without other themes", () => {
  const w = W({ threshold: { min_issues: 5 }, immediate: ["label:security"] });
  const { pool, openByNum } = pooled({ labels: lbl("billing") }, { labels: lbl("security") }, { labels: lbl("billing", "P0") }, { labels: lbl("security") });
  const d = decide({ pool, openByNum, themes: themesOf(pool, w), watch: w, now: NOW });
  assert.equal(d.forced, true); assert.equal(d.theme, "security");
  assert.deepEqual(d.release.set.map((i) => i.number).sort(), [2, 4]);
  assert.ok(d.release.excluded.some((e) => e.number === 1 && /theme billing/.test(e.reason)));
});

test("release set pulls the Depends on closure (cross-theme, marked), skips closed deps, and respects the cap", () => {
  const w = W({ max_release_issues: 3 });
  const a = iss(1, { labels: lbl("security"), body: "**Depends on** #9\n" });
  const dep = iss(9, { labels: lbl("billing"), body: "Depends on #10" });
  const deep = iss(10, { labels: lbl("billing") });
  const b = iss(2, { labels: lbl("security"), body: "Depends on #99" }); // 99 is closed/unknown
  const c = iss(3, { labels: lbl("security") });
  const pool = [a, b, c], all = [a, b, c, dep, deep];
  const openByNum = new Map(all.map((i) => [i.number, i]));
  assert.deepEqual(closure(a, openByNum).map((i) => i.number).sort((x, y) => x - y), [1, 9, 10]);
  const d = decide({ pool, openByNum, themes: themesOf(pool, w), watch: w, now: NOW });
  assert.deepEqual(d.release.set.map((i) => i.number).sort((x, y) => x - y), [1, 9, 10]); // cap 3 filled by #1's closure
  assert.deepEqual(d.release.pulled.map((p) => [p.number, p.theme, p.for]), [[9, "billing", 1], [10, "billing", 1]]);
  assert.deepEqual(d.release.excluded.map((e) => e.number).sort(), [2, 3]); // roll over, still pooled
  const wide = decide({ pool, openByNum, themes: themesOf(pool, w), watch: W({ max_release_issues: 10 }), now: NOW });
  assert.equal(wide.release.set.length, 5);
});

test("dry run prints would cut, theme scores and per-issue themes", () => {
  const w = W();
  const { pool, openByNum } = pooled({ labels: lbl("billing") }, { labels: lbl("billing") }, { labels: lbl("billing") }, { labels: lbl("security") });
  const themes = themesOf(pool, w);
  const out = formatDryRun(decide({ pool, openByNum, themes, watch: w, now: NOW }), pool, themes);
  assert.match(out, /would cut: billing \(3 issues, score \d+; security pool 1 < threshold\)/);
  assert.match(out, /theme scores: billing=\d+ \(3\), security=\d+ \(1\)/);
  assert.match(out, /#4 security \[label:security\] \(stays pooled\)/);
});

/** Fake io for releaseTick: gh records writes; batch start/reported controllable. */
function world(issues, { closed = new Set(), prs = [] } = {}) {
  const io = { calls: [], batches: [], reported: new Set(), closed, now: () => NOW, classify: undefined,
    gh: async (a) => {
      io.calls.push(a);
      if (a[0] === "issue" && a[1] === "view") return JSON.stringify({ state: closed.has(+a[2]) ? "CLOSED" : "OPEN" });
      if (a[0] === "pr" && a[1] === "list") return JSON.stringify(prs);
      if (a[0] === "pr" && a[1] === "create") return "https://github.com/o/r/pull/77\n";
      if (a[0] === "issue" && a[1] === "list") return JSON.stringify(issues);
      return "";
    },
    batch: { start: async (nums, k, lane) => { io.batches.push([nums, k, lane]); return `b${io.batches.length}`; }, reported: (id) => io.reported.has(id) } };
  return io;
}
const step = (io, w, state, o = {}) => {
  const claims = o.claims ?? new Set();
  return releaseTick({ watch: w, repo: "o/r", io, state, defaults: ["main"], listOpen: async () => JSON.parse(await io.gh(["issue", "list"])),
    eligible: (i) => !state.claimed.includes(i.number) && !claims.has(i.number), claim: (n) => { if (claims.has(n)) return false; claims.add(n); return true; },
    laneFor: () => "staging", dagOrder: (x) => x, policy: { path: "NORTHSTAR.md", text: "" } });
};
const fresh = () => ({ claimed: [], inflight: [], merged: [], verified: [], failed: [], lanes: {}, started: null });

test("claims nothing below the threshold; at the threshold posts a plan, tags with a label, starts one batch, then opens the deploy PR once and never merges", async () => {
  const issues = [iss(1, { labels: lbl("billing") }), iss(2, { labels: lbl("billing") })];
  const io = world(issues), w = W(), st = fresh();
  await step(io, w, st);
  assert.equal(io.batches.length, 0); assert.deepEqual(st.claimed, []); assert.deepEqual(st.pool, [1, 2]);
  issues.push(iss(3, { labels: lbl("billing") }), iss(4, { labels: lbl("security") }));
  await step(io, w, st);
  assert.deepEqual(io.batches, [[[1, 2, 3], 4, "staging"]]);
  assert.deepEqual(st.claimed, [1, 2, 3]); assert.equal(st.release.tag, "billing-2026-10-30");
  const comment = io.calls.find((a) => a[1] === "comment");
  assert.match(comment[comment.length - 1], /<!-- FORGE:RELEASE_PLAN \{/); assert.equal(comment[2], "1");
  assert.ok(io.calls.some((a) => a[0] === "label" && a[1] === "create" && a.includes("release:billing-2026-10-30")));
  assert.equal(io.calls.filter((a) => a[1] === "edit" && a.includes("--add-label")).length, 3);
  await step(io, w, st); // batch not reported: one batch per release, nothing new
  assert.equal(io.batches.length, 1); assert.equal(io.calls.filter((a) => a[0] === "pr").length, 0);
  io.reported.add("b1"); io.closed.add(1);
  await step(io, w, st);
  const creates = io.calls.filter((a) => a[0] === "pr" && a[1] === "create");
  assert.equal(creates.length, 1); assert.deepEqual([creates[0][creates[0].indexOf("--base") + 1], creates[0][creates[0].indexOf("--head") + 1]], ["main", "staging"]);
  assert.equal(io.calls.some((a) => a[0] === "pr" && a[1] === "merge"), false);
  assert.deepEqual([st.merged, st.failed.sort()], [[1], [2, 3]]); assert.equal(st.releases[0].deployPr, 77);
});

test("rollover: issues left out stay pooled with their age and go in the next release; a new batch starts after the report", async () => {
  const issues = [1, 2, 3, 4].map((n) => iss(n, { labels: lbl("billing"), createdAt: `2026-10-0${n}T00:00:00Z` }));
  const io = world(issues), w = W({ max_release_issues: 3 }), st = fresh();
  await step(io, w, st);
  assert.deepEqual(io.batches[0][0], [1, 2, 3]);
  io.reported.add("b1"); issues.push(iss(5, { labels: lbl("billing") }), iss(6, { labels: lbl("billing") }));
  await step(io, w, st); // settles the first release and cuts the next in the same pass
  assert.deepEqual(io.batches[1][0], [4, 5, 6]); assert.equal(st.releases.length, 1);
});

test("a merge-protected default: a milestone target tags with a release/<tag> milestone", async () => {
  const io = world([1, 2, 3].map((n) => iss(n, { labels: lbl("security") }))), w = W({ milestone: "v1" }), st = fresh();
  await step(io, w, st);
  assert.ok(io.calls.some((a) => a[0] === "api" && a.includes("title=release/security-2026-10-30")));
  assert.equal(io.calls.filter((a) => a[1] === "edit" && a.includes("--milestone")).length, 3);
});

test("claimed elsewhere is not double-claimed; an existing deploy PR is reused; dry run writes nothing", async () => {
  const io = world([1, 2, 3, 4].map((n) => iss(n, { labels: lbl("billing") })), { prs: [{ number: 5 }] }), w = W(), st = fresh(), claims = new Set([2]);
  await step(io, w, st, { claims });
  assert.deepEqual(io.batches[0][0], [1, 3, 4]);
  io.reported.add("b1"); await step(io, w, st, { claims });
  assert.equal(io.calls.some((a) => a[0] === "pr" && a[1] === "create"), false); assert.equal(st.releases[0].deployPr, 5);
  const io2 = world([1, 2, 3].map((n) => iss(n, { labels: lbl("billing") }))), st2 = fresh();
  const r = await releaseTick({ watch: w, repo: "o/r", io: io2, state: st2, defaults: ["main"], listOpen: async () => JSON.parse(await io2.gh(["issue", "list"])), eligible: () => true, claim: () => { throw new Error("no"); }, laneFor: () => "staging", dagOrder: (x) => x, dryRun: true });
  assert.equal(r.decision.theme, "billing"); assert.deepEqual(io2.calls.filter((a) => a[1] !== "list"), []); assert.equal(io2.batches.length, 0);
});

test("max_issues and until stop new releases (done once nothing is in flight)", async () => {
  const io = world([1, 2, 3].map((n) => iss(n, { labels: lbl("billing") }))), w = W({ until: "2026-10-29T00:00:00Z" }), st = fresh();
  await step(io, w, st);
  assert.equal(st.phase, "done"); assert.equal(io.batches.length, 0);
});

test("CLI: --dry-run prints the cut without writing; refuses a non-release watch; status shows the pool", async () => {
  const dir = tmpDir("iwr-"), cwd = tmpDir("iwr-cwd-");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${cwd}/forge.yaml`, `issue_watch:\n  watches:\n    sr:\n      mode: release\n      threshold: { min_issues: 2 }\n      theme_map:\n        billing: [label:billing]\n    plain:\n      milestone: none\n`);
  const issues = [1, 2].map((n) => iss(n, { labels: lbl("billing") }));
  const io = world(issues); io.env = { FORGEDOCK_WATCH_DIR: dir }; io.sleep = async () => {};
  const orig = io.gh; io.gh = async (a) => (a[0] === "repo" ? (a.includes("--jq") ? "main\n" : JSON.stringify({ nameWithOwner: "o/r" })) : orig(a));
  const out = [];
  const r = await issueWatchFromCli(["run", "--name", "sr", "--dry-run"], { cwd, env: io.env, io, print: (l) => out.push(l) });
  assert.match(out.join("\n"), /would cut: billing \(2 issues/);
  assert.equal(io.batches.length, 0); assert.ok(r.dryRun);
  await assert.rejects(issueWatchFromCli(["run", "--name", "plain", "--dry-run"], { cwd, env: io.env, io, print() {} }), /mode: release/);
  const w = loadWatches(`issue_watch:\n  watches:\n    sr:\n      mode: release\n      threshold: { min_issues: 2 }\n`).sr;
  assert.match(formatStatus({ name: "sr", repo: "o/r", phase: "running", claimed: [1], inflight: [1], merged: [], verified: [], failed: [], pool: [2, 3], llm: 2, releases: [], release: { theme: "billing", issues: [1], batch: "b1" } }, w), /pool: 2.*active: billing.*llm-classified: 2/);
});
