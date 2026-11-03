// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionStep, decisionsActive, decisionContext, decisionCounts, escalationOf, terminalCodeOf, claimsUsed } from "./issuewatch-decisions.mjs";
import { validateWatch, matchesSelectors, formatStatus, runWatch, labelNames, isBot, TRUSTED, decisionLaunch } from "./issuewatch.mjs";
import { loadPolicy } from "./decision-engine.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";

const W = (o = {}) => validateWatch("w", o);
const NOW = Date.parse("2026-10-30T12:00:00Z");
const esc = (id, text, at = "2026-10-30T13:00:00Z") => ({ url: `https://x/issues/1#issuecomment-${id}`, authorAssociation: "MEMBER", createdAt: at, body: `<!-- FORGE:NEEDS_HUMAN -->\n## Needs human\n${text}` });
const stateC = (code) => ({ url: "https://x/issues/1#issuecomment-1", authorAssociation: "MEMBER", createdAt: "2026-10-29T00:00:00Z", body: `<!-- FORGE:STATE\n${JSON.stringify({ terminalCode: code })}\n-->` });
const good = { choice: "use option A", clause: "NORTHSTAR 2: cut waste", rejected: "B", reversibility: "reversible", confidence: "high" };
const files = (m) => (p) => { const k = p.replace(/^\.\//, ""); if (k in m) return m[k]; throw new Error("ENOENT"); };
const ctxOf = (yaml = "decisions:\n  mode: live\n", extra = {}) => decisionContext({ loadPolicy, readFile: files({ "NORTHSTAR.md": "# star", "forge.yaml": yaml, ...extra }), cwd: "." });

/** gh fake: `issues` = [{number, comments, labels?, author?, body?}] all open and needs-human. Records every write. */
function fakeIo(issues, { judge = () => good, bodies = {} } = {}) {
  const writes = [], io = { writes, bodies, now: () => NOW, judge: async (q) => { io.judged.push(q.issue); return judge(q); }, judged: [] };
  io.gh = async (a) => {
    if (a[0] === "api") return issues.map((i) => `${i.number}\t${i.assoc ?? "OWNER"}`).join("\n");
    if (a[1] === "list") return JSON.stringify(issues.map((i) => ({ number: i.number, title: `t${i.number}`, body: i.body ?? "", labels: [{ name: "needs-human" }, ...(i.labels ?? []).map((name) => ({ name }))], milestone: null, author: { login: "me" }, createdAt: "2026-10-01T00:00:00Z" })));
    if (a[1] === "view" && a.includes("comments,body,labels")) { const i = issues.find((x) => x.number === +a[2]); return JSON.stringify({ comments: i.comments, body: i.body ?? "", labels: [] }); }
    if (a[1] === "view" && a.includes("comments,labels")) { const i = issues.find((x) => x.number === +a[2]); return JSON.stringify({ comments: i.comments, labels: (i.labels ?? []).map((name) => ({ name })) }); }
    if (a[1] === "view") return JSON.stringify({ body: bodies[a[2]] ?? "" });
    writes.push(a);
    return "";
  };
  return io;
}
const st = (watch, extra = {}) => ({ name: "w", repo: "o/r", phase: "running", started: NOW, claimed: [], inflight: [], merged: [], verified: [], unverified: [], closed: [], failed: [], folded: [], retries: {}, lanes: {}, batch: null, laneFor: {}, ...extra });
const run = (io, watch, state, ctx, o = {}) => decisionStep({ watch, repo: "o/r", io, state, ctx, shared: { matches: matchesSelectors, fold: async ({ issue }) => { state.folded.push(issue.number); }, labelNames, isBot, TRUSTED }, ...o });
const trusted = (c) => c.authorAssociation === "MEMBER";
const DECISION = "- Which retry strategy for the sync job?";

test("#4793 validateWatch: sweep_needs_human and max_launches", () => {
  assert.equal(W().sweep_needs_human, false);
  assert.equal(W().max_launches, null);
  assert.equal(W({ sweep_needs_human: "true", max_launches: 2 }).sweep_needs_human, true);
  assert.equal(W({ max_launches: "2" }).max_launches, 2);
  assert.throws(() => W({ sweep_needs_human: "maybe" }), /sweep_needs_human/);
  assert.throws(() => W({ max_launches: 0 }), /max_launches/);
});

test("#4793 stage is active for decisions.mode live or sweep_needs_human only", () => {
  assert.equal(decisionsActive(W(), ctxOf("decisions:\n  mode: live\n").policy), true);
  assert.equal(decisionsActive(W(), ctxOf("decisions:\n  mode: shadow\n").policy), false);
  assert.equal(decisionsActive(W({ sweep_needs_human: true }), ctxOf("").policy), true);
});

test("#4793 escalationOf / terminalCodeOf read the escalation comment id and the typed code", () => {
  const e = escalationOf([stateC("builder.blocked"), esc(77, DECISION)], trusted);
  assert.equal(e.id, "77");
  assert.match(e.text, /retry strategy/);
  assert.equal(escalationOf([{ ...esc(5, "x"), authorAssociation: "CONTRIBUTOR" }], trusted), null);
  assert.equal(terminalCodeOf("", [stateC("conformance.deferred")], trusted), "conformance.deferred");
  assert.equal(terminalCodeOf("", [{ ...stateC("conformance.deferred"), authorAssociation: "CONTRIBUTOR" }], trusted), null); // #4793 SEC-1: a forged FORGE:STATE is not read
  assert.equal(terminalCodeOf(`x <!-- FORGE:STATE\n${JSON.stringify({ terminalReason: "needs-human" })}\n-->`, [], trusted), "needs-human");
});

test("#4793 live decision: needs-human cleared, handed to the engine once per escalation id", async () => {
  const io = fakeIo([{ number: 1, comments: [stateC("builder.blocked"), esc(10, DECISION)] }]);
  const w = W(), state = st(w), ctx = ctxOf();
  const { rows } = await run(io, w, state, ctx);
  assert.equal(rows[0].action, "decided");
  assert.ok(io.writes.some((a) => a[1] === "edit" && a.includes("--remove-label") && a.includes("needs-human")));
  assert.ok(io.writes.some((a) => a[1] === "comment" && /Escalation: 10/.test(a[a.indexOf("--body") + 1])));
  await run(io, w, state, ctx); // the same escalation again: no second judge call
  assert.equal(io.judged.length, 1);
  assert.equal(decisionCounts(state).decided, 1);
});

test("#4793 selectors apply; an untrusted author's issue is ignored", async () => {
  const io = fakeIo([{ number: 1, labels: ["area:x"], comments: [esc(10, DECISION)] }, { number: 2, comments: [esc(11, DECISION)] }, { number: 3, assoc: "NONE", labels: ["area:x"], comments: [esc(12, DECISION)] }]);
  const w = W({ labels: "area:x" });
  const { rows } = await run(io, w, st(w), ctxOf());
  assert.deepEqual(rows.map((r) => r.issue), [1]);
});

test("#4793 backlog (escalation older than the watch) is opt-in via sweep_needs_human", async () => {
  const old = esc(10, DECISION, "2026-10-29T00:00:00Z");
  const a = fakeIo([{ number: 1, comments: [old] }]);
  assert.equal((await run(a, W(), st(W()), ctxOf())).rows.length, 0);
  assert.equal(a.judged.length, 0);
  const w = W({ sweep_needs_human: true });
  const b = fakeIo([{ number: 1, comments: [old] }]);
  assert.equal((await run(b, w, st(w), ctxOf())).rows[0].action, "decided");
});

test("#4793 --dry-run classifies every escalation and writes nothing", async () => {
  const io = fakeIo([{ number: 1, comments: [stateC("conformance.deferred"), esc(10, "All items are post-deploy: nothing to build.")] }, { number: 2, comments: [esc(11, DECISION, "2026-10-29T00:00:00Z")] }]);
  const w = W(), state = st(w);
  const { rows } = await run(io, w, state, ctxOf(), { dryRun: true });
  assert.deepEqual(rows.map((r) => [r.issue, r.kind, !!r.backlog]), [[1, "post-deploy", false], [2, "decision", true]]);
  assert.equal(io.writes.length, 0);
  assert.equal(io.judged.length, 0);
  assert.equal(state.decisions.rows.length, 0);
});

test("#4793 max_issues and max_launches cap the stage", async () => {
  const mk = () => fakeIo([1, 2, 3].map((n) => ({ number: n, comments: [esc(10 + n, DECISION)] })));
  const w1 = W({ max_issues: 2 }), s1 = st(w1);
  assert.equal((await run(mk(), w1, s1, ctxOf())).rows.length, 2);
  const w2 = W({ max_launches: 1 }), s2 = st(w2);
  assert.equal((await run(mk(), w2, s2, ctxOf(), { launch: () => true })).rows.length, 1);
  const w3 = W({ max_issues: 2 }), s3 = st(w3, { claimed: [9] }); // an earlier claim uses a slot
  assert.equal((await run(mk(), w3, s3, ctxOf())).rows.length, 1);
});

test("#4793 post-deploy-only escalation is folded into the rollup and closed", async () => {
  const io = fakeIo([{ number: 1, comments: [stateC("conformance.deferred"), esc(10, "All items are post-deploy: nothing to build.")] }]);
  const w = W({ postdeploy_rollup: 50 }), state = st(w);
  const { rows } = await run(io, w, state, ctxOf());
  assert.equal(rows[0].folded, true);
  assert.deepEqual(state.folded, [1]);
  assert.ok(io.writes.some((a) => a[1] === "close" && a[2] === "1"));
  assert.equal(decisionCounts(state).folded, 1);
  const none = fakeIo([{ number: 1, comments: [esc(10, "All items are post-deploy: nothing to build.")] }]);
  const w2 = W(), s2 = st(w2); // no rollup: kept, never closed
  assert.equal((await run(none, w2, s2, ctxOf())).rows[0].action, "post-deploy-kept");
  assert.equal(none.writes.length, 0);
});

test("#4793 evidence escalation goes back to a prod-monitor lane only when forge.yaml declares a read-only source", async () => {
  const text = "The check needs read-only production data we do not have.";
  const declared = ctxOf("decisions:\n  mode: live\nprod_watch:\n  sources:\n    am: {kind: alertmanager, run: am-alerts}\n");
  assert.equal(declared.hasSource, true);
  const io = fakeIo([{ number: 1, comments: [esc(10, text)] }]);
  const w = W(), state = st(w);
  const { rows } = await run(io, w, state, declared, { launch: () => true });
  assert.equal(rows[0].action, "evidence-needed");
  assert.ok(io.writes.some((a) => a[1] === "comment" && /prod monitor/.test(a[a.indexOf("--body") + 1])));
  assert.ok(io.writes.some((a) => a.includes("--remove-label")));
  assert.deepEqual(state.decisions.launched, [1]);
  assert.equal(decisionCounts(state).evidence, 1);
  const io2 = fakeIo([{ number: 1, comments: [esc(10, text)] }]);
  const none = ctxOf();
  assert.equal(none.hasSource, false);
  assert.equal((await run(io2, w, st(w), none)).rows[0].action, "evidence-kept");
  assert.equal(io2.writes.length, 0);
});

test("#4793 external part keeps needs-human and counts as external-kept", async () => {
  const io = fakeIo([{ number: 1, comments: [esc(10, "- Rotate the production API key (credentials)")] }]);
  const w = W(), state = st(w);
  assert.equal((await run(io, w, state, ctxOf())).rows[0].action, "external");
  assert.equal(decisionCounts(state).external_kept, 1);
  assert.equal(io.writes.length, 0);
});

test("#4793 shadow mode posts the decision and keeps the label", async () => {
  const io = fakeIo([{ number: 1, comments: [esc(10, DECISION)] }]);
  const w = W({ sweep_needs_human: true }), state = st(w);
  assert.equal((await run(io, w, state, ctxOf("decisions:\n  mode: shadow\n"))).rows[0].action, "shadow");
  assert.ok(!io.writes.some((a) => a.includes("--remove-label")));
});

test("#4793 shadow mode never folds, closes, clears the label or launches a post-deploy or evidence escalation", async () => {
  const shadow = ctxOf("decisions:\n  mode: shadow\nprod_watch:\n  sources:\n    am: {kind: alertmanager, run: am-alerts}\n");
  const io = fakeIo([{ number: 1, comments: [stateC("conformance.deferred"), esc(10, "All items are post-deploy: nothing to build.")] }, { number: 2, comments: [esc(11, "The check needs read-only production data we do not have.")] }]);
  const w = W({ sweep_needs_human: true, postdeploy_rollup: 50 }), state = st(w), launched = [];
  const { rows } = await run(io, w, state, shadow, { launch: (i) => launched.push(i.number) });
  assert.deepEqual(rows.map((r) => r.action), ["shadow", "shadow"]);
  assert.deepEqual(state.folded, []);
  assert.deepEqual(launched, []);
  assert.ok(!io.writes.some((a) => a[1] === "close" || a.includes("--remove-label")));
  assert.equal(io.writes.filter((a) => a[1] === "comment").length, 2);
});

test("#4793 a live decision relaunches the issue through the launch hook", async () => {
  const io = fakeIo([{ number: 1, comments: [esc(10, DECISION)] }]);
  const w = W(), state = st(w), launched = [];
  await run(io, w, state, ctxOf(), { launch: (i) => launched.push(i.number) });
  assert.deepEqual(launched, [1]);
  assert.deepEqual(state.decisions.launched, [1]);
  assert.deepEqual(claimsUsed(state), { issues: 1, launches: 1 });
});

test("#4793 a judge failure is not recorded as handled: retried, then left to a human after three rounds", async () => {
  const io = fakeIo([{ number: 1, comments: [esc(10, DECISION)] }], { judge: () => { throw new Error("claude timed out"); } });
  const w = W(), state = st(w), ctx = ctxOf();
  assert.equal((await run(io, w, state, ctx)).rows[0].action, "error");
  assert.equal(state.decisions.handled["10"], undefined);
  assert.equal(state.decisions.rows.length, 0);
  await run(io, w, state, ctx); await run(io, w, state, ctx);
  assert.equal(state.decisions.handled["10"], "error");
  await run(io, w, state, ctx);
  assert.equal(io.judged.length, 3);
});

test("#4793 a NEEDS_HUMAN comment from an untrusted author is not an escalation", async () => {
  const io = fakeIo([{ number: 1, comments: [{ ...esc(10, DECISION), authorAssociation: "CONTRIBUTOR" }] }]);
  const w = W();
  assert.equal((await run(io, w, st(w), ctxOf())).rows.length, 0);
  assert.equal(io.judged.length, 0);
});

test("#4793 a veto label reverts a live decision once", async () => {
  const issues = [{ number: 1, comments: [esc(10, DECISION)] }];
  const io = fakeIo(issues);
  const w = W(), state = st(w), ctx = ctxOf();
  await run(io, w, state, ctx);
  issues[0].labels = ["forge:decision-veto"];
  await run(io, w, state, ctx);
  assert.ok(io.writes.some((a) => a[1] === "edit" && a.includes("--add-label") && a.includes("needs-human")));
  assert.equal(state.decisions.stats.reversed, 1);
  assert.equal(state.decisions.live.length, 0);
});

test("#4793 formatStatus shows the decision counts only once the stage ran", async () => {
  const w = W(), plain = st(w);
  assert.ok(!/needs-human decisions/.test(formatStatus(plain, w, NOW)));
  const io = fakeIo([{ number: 1, comments: [esc(10, DECISION)] }]);
  await run(io, w, plain, ctxOf());
  assert.match(formatStatus(plain, w, NOW), /decided 1  evidence-gathered 0  folded 0  external-kept 0/);
});

test("#4793 runWatch runs the stage under decisions.mode: live, stays inert otherwise, and max_launches stops claims", async () => {
  const mkCwd = (yaml) => { const d = tmpDir("iwc-"); writeFileSync(join(d, "NORTHSTAR.md"), "# star"); if (yaml) writeFileSync(join(d, "forge.yaml"), yaml); return d; };
  const base = (n, i = {}) => ({ number: n, title: `t${n}`, body: "", labels: [], milestone: null, authorAssociation: "OWNER", author: { login: "me" }, createdAt: "2026-10-01T00:00:00Z", ...i });
  const go = async (yaml, w) => {
    const issues = [base(1, { labels: [{ name: "needs-human" }] }), base(2), base(3)], writes = [], launched = [];
    const dir = tmpDir("iwd-");
    const io = { env: { FORGEDOCK_WATCH_DIR: dir }, now: () => NOW, sleep: async () => {}, requiredChecks: async () => [], judge: async () => good,
      gh: async (a) => {
        if (a[0] === "api") return issues.map((i) => `${i.number}\tOWNER`).join("\n");
        if (a[1] === "list") return JSON.stringify((a.includes("--label") ? issues.filter((i) => i.labels.length) : issues.filter((i) => !i.labels.length)).map(({ authorAssociation: _a, ...i }) => i));
        if (a[1] === "view" && a.includes("comments,body,labels")) return JSON.stringify({ comments: [esc(10, DECISION)], body: "", labels: [] });
        if (a[1] === "view") return JSON.stringify({ state: "OPEN", comments: [], labels: [] });
        writes.push(a);
        return "";
      },
      launch: (n) => { launched.push(n); return { poll: () => null }; } };
    const state = await runWatch({ watch: w, repo: "o/r", io, dir, branches: {}, defaults: [], once: true, cwd: mkCwd(yaml) });
    return { state, writes, launched };
  };
  const inert = await go("decisions:\n  mode: shadow\n", W());
  assert.equal(inert.state.decisions, undefined);
  assert.equal(inert.writes.length, 0);
  const live = await go("decisions:\n  mode: live\n", W());
  assert.equal(live.state.decisions.rows[0].action, "decided");
  assert.ok(live.writes.some((a) => a.includes("--remove-label")));
  assert.deepEqual(live.launched, [1, 2, 3]); // the decided issue is relaunched, then the watch claims the rest
  const capped = await go("", W({ max_launches: 2 }));
  assert.equal(capped.launched.length, 2);
  assert.deepEqual(capped.state.claimed.length, 2);
});

test("#4793 the engine's own App login counts as trusted though it is a CONTRIBUTOR; another CONTRIBUTOR does not", async () => {
  const from = (login) => ({ ...esc(10, DECISION), authorAssociation: "CONTRIBUTOR", author: { login } });
  const w = W();
  assert.equal((await run(fakeIo([{ number: 1, comments: [from("rapiercraft-forgedock")] }]), w, st(w), ctxOf())).rows.length, 1);
  assert.equal((await run(fakeIo([{ number: 1, comments: [from("some-contributor")] }]), w, st(w), ctxOf())).rows.length, 0);
});

test("#4793 judge calls are capped per round even when max_issues is unset", async () => {
  const issues = Array.from({ length: 30 }, (_, k) => ({ number: k + 1, comments: [{ ...esc(100 + k, DECISION), url: `https://x/issues/${k + 1}#issuecomment-${100 + k}` }] }));
  const io = fakeIo(issues);
  const w = W(), state = st(w);
  assert.equal(w.max_issues, null);
  await run(io, w, state, ctxOf());
  assert.equal(io.judged.length, 20);
  await run(io, w, state, ctxOf()); // the rest is picked up next round
  assert.equal(io.judged.length, 30);
});

test("release #5068 MAT-1: a batch watch requeues a claimed issue into its batch; release and unclaimed issues release the claim", () => {
  const calls = [];
  const io = { batch: { requeue: (id, n) => { calls.push([id, n]); return true; } } };
  const b = W({ mode: "batch" }), sb = st(b, { batch: "b1", claimed: [5], failed: [5] });
  assert.equal(decisionLaunch({ i: { number: 5 }, watch: b, repo: "o/r", io, state: sb, handles: new Map() }), true);
  assert.deepEqual(calls, [["b1", 5]]);
  assert.deepEqual(sb.failed, []);
  assert.deepEqual(sb.claimed, [5]); // still the batch's
  const refused = { batch: { requeue: () => false } };
  assert.equal(decisionLaunch({ i: { number: 5 }, watch: b, repo: "o/r", io: refused, state: st(b, { batch: "b1", claimed: [5] }), handles: new Map() }), false);
  const sb2 = st(b, { batch: "b1", claimed: [] }); // a backlog issue the batch never took: the next tick adds it
  assert.equal(decisionLaunch({ i: { number: 6 }, watch: b, repo: "o/r", io, state: sb2, handles: new Map() }), true);
  assert.deepEqual(calls.length, 1);
  const r = W({ mode: "release", immediate: ["priority:P0"] }), sr = st(r, { claimed: [7, 8], lanes: { 7: "staging" }, failed: [7] });
  assert.equal(decisionLaunch({ i: { number: 7 }, watch: r, repo: "o/r", io, state: sr, handles: new Map() }), true);
  assert.deepEqual(sr.claimed, [8]); // re-selectable by the next release pass
  assert.deepEqual(sr.failed, []);
  assert.equal(decisionLaunch({ i: { number: 9 }, watch: r, repo: "o/r", io, state: st(r, { inflight: [9] }), handles: new Map() }), false);
});

test("release #5068 MAT-4: a launch that does not happen is not counted against max_launches", async () => {
  const io = fakeIo([{ number: 1, comments: [esc(10, DECISION)] }]);
  const w = W(), state = st(w);
  await run(io, w, state, ctxOf(), { launch: () => false });
  assert.deepEqual(state.decisions.launched, []);
});

test("release #5068 MAT-2: one unreadable issue does not end the round", async () => {
  const io = fakeIo([1, 2].map((n) => ({ number: n, comments: [esc(10 + n, DECISION)] })));
  const gh = io.gh;
  io.gh = async (a) => { if (a[1] === "view" && a[2] === "1") throw new Error("HTTP 502"); return gh(a); };
  const w = W(), state = st(w);
  const { rows } = await run(io, w, state, ctxOf(), { launch: () => true });
  assert.deepEqual(rows.map((r) => [r.issue, r.action]), [[1, "error"], [2, "decided"]]);
});

test("release #5068 BUG-1: a live decision whose label clear failed is finished next round, not skipped", async () => {
  const posted = { ...esc(20, "x"), body: "<!-- FORGE:DECISION -->\n## Decision\nEscalation: 11\n### Decision 1\nuse A" };
  const io = fakeIo([{ number: 1, comments: [{ ...esc(11, DECISION), url: "https://x/issues/1#issuecomment-11" }, posted] }]);
  const w = W(), state = st(w), launched = [];
  const { rows } = await run(io, w, state, ctxOf(), { launch: (i) => launched.push(i.number) });
  assert.equal(rows[0].action, "decided");
  assert.ok(io.writes.some((a) => a.includes("--remove-label")));
  assert.deepEqual(launched, [1]);
  assert.equal(io.judged.length, 0); // not judged again
  assert.equal(state.decisions.stats.decided, 0); // not counted twice
  const vetoed = { ...posted, body: "<!-- FORGE:DECISION -->\n## Decision vetoed\nEscalation: 11\n" };
  const io2 = fakeIo([{ number: 1, comments: [{ ...esc(11, DECISION), url: "https://x/issues/1#issuecomment-11" }, posted, vetoed] }]);
  const s2 = st(w);
  await run(io2, w, s2, ctxOf(), { launch: () => true });
  assert.ok(!io2.writes.some((a) => a.includes("--remove-label")));
});
