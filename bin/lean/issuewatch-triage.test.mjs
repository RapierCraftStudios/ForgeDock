// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { triageTick, needsInfo, triageLabels, maxPerHour } from "./issuewatch-triage.mjs";
import { validateWatch } from "./issuewatch.mjs";

const W = (o = {}) => validateWatch("t", { mode: "triage", ...o });
const iss = (n, o = {}) => ({ number: n, title: `t${n}`, body: "## Goal\nx\n\n## Acceptance\n- [ ] works", labels: [], comments: [], author: { login: "me" }, ...o });
const setup = (issues, o = {}) => {
  const writes = [], models = [], seams = [];
  const io = { now: () => 1e12, gh: async (a) => { writes.push(a); return ""; }, triageClassify: async (i) => { models.push(i.number); return { type: "bug", severity: "P2", migrations: "none", confidence: 0.9, lane_hint: "none", ...o.llm }; }, pause: o.pause,
    claim: () => { seams.push("claim"); throw new Error("claim"); }, launch: () => { seams.push("launch"); throw new Error("launch"); }, batch: { add: () => { seams.push("batch"); throw new Error("batch"); } } };
  return { io, writes, models, seams, run: (extra = {}) => triageTick({ watch: o.watch ?? W(), repo: "o/r", io, state: o.state ?? {}, listOpen: async () => issues, trusted: () => true, ...extra }) };
};

test("a new issue gets labels and a text-only FORGE:CLASSIFY comment; no needs-info with acceptance criteria", async () => {
  const s = setup([iss(1)]);
  const r = await s.run();
  assert.equal(r.classified.length, 1);
  const edit = s.writes.find((a) => a[1] === "edit"), com = s.writes.find((a) => a[1] === "comment");
  assert.equal(edit[edit.indexOf("--add-label") + 1], "type:bug,priority:P2");
  const body = com[com.indexOf("--body") + 1];
  assert.match(body, /FORGE:CLASSIFY/);
  const rec = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
  assert.equal(rec.source, "text-only"); assert.ok(rec.confidence <= 0.5); assert.notEqual(rec.migrations, "none");
});

test("needs-info and lane label: body without criteria, lane_hint release", async () => {
  const s = setup([iss(2, { body: "it is broken" })], { llm: { lane_hint: "release" } });
  await s.run();
  const edit = s.writes.find((a) => a[1] === "edit");
  assert.equal(edit[edit.indexOf("--add-label") + 1], "type:bug,priority:P2,lane:release,needs-info");
});

test("needsInfo: heading or checklist counts, comments do not", () => {
  assert.equal(needsInfo("## Acceptance criteria\nx"), false);
  assert.equal(needsInfo("- [x] done"), false);
  assert.equal(needsInfo("plain"), true);
  assert.equal(needsInfo("<!-- ## Acceptance -->\nplain"), true);
  assert.deepEqual(triageLabels({ type: "chore", severity: "P3", lane_hint: "none" }), ["type:chore", "priority:P3"]);
});

test("spies: no claim, launch or batch add, also when the cap is hit", async () => {
  const s = setup([1, 2, 3].map((n) => iss(n)), { watch: W({ "triage.max_per_hour": 1 }) });
  await s.run();
  assert.deepEqual(s.seams, []);
});

test("paused intake: no model call and no write", async () => {
  const s = setup([iss(1)], { pause: async () => ({ reason: "intake paused" }) });
  const r = await s.run();
  assert.ok(r.paused); assert.equal(s.models.length, 0); assert.equal(s.writes.length, 0);
});

test("cap: max_per_hour 2 with 5 issues makes exactly 2 model calls; the rest wait for the next tick", async () => {
  const state = {};
  const s = setup([1, 2, 3, 4, 5].map((n) => iss(n)), { watch: W({ "triage.max_per_hour": 2 }), state });
  await s.run();
  assert.equal(s.models.length, 2);
  await s.run();
  assert.equal(s.models.length, 2, "same hour: still capped");
  s.io.now = () => 1e12 + 3700000;
  await s.run();
  assert.equal(s.models.length, 4);
});

test("policy classify.triage_max_per_hour is the fallback cap", () => {
  assert.equal(maxPerHour(W(), { classify: { triage_max_per_hour: 3 } }), 3);
  assert.equal(maxPerHour(W({ "triage.max_per_hour": 7 }), { classify: { triage_max_per_hour: 3 } }), 7);
  assert.equal(maxPerHour(W(), null), 10);
});

test("idempotent and trust: classified and untrusted issues are skipped", async () => {
  const s = setup([iss(1, { comments: [{ body: "<!-- FORGE:CLASSIFY -->\n{}" }] }), iss(2), iss(3)]);
  await s.run({ trusted: (i) => i.number !== 3 });
  assert.deepEqual(s.models, [2]);
});

test("a non-triage watch makes no write and no call", async () => {
  const s = setup([iss(1)], { watch: validateWatch("p", {}) });
  await s.run();
  assert.equal(s.writes.length + s.models.length, 0);
});

test("a failing model call is recorded, counted against the cap and does not stop the pass", async () => {
  const s = setup([iss(1), iss(2)]);
  let n = 0; const ok = s.io.triageClassify;
  s.io.triageClassify = async (i) => { if (!n++) throw new Error("boom"); return ok(i); };
  const r = await s.run();
  assert.equal(r.classified.length, 1); assert.equal(r.calls, 2);
});

test("P0 from text alone is clamped to P1", async () => {
  const s = setup([iss(1)], { llm: { severity: "P0" } });
  await s.run();
  assert.match(s.writes.find((a) => a[1] === "edit").join(" "), /priority:P1/);
});
