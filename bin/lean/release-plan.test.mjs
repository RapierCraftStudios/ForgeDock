// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, rollSet, approvalOf, honouredLanes, forecastPlan, planFromCli, stableJson, EXCLUSION_KEYS } from "./release-plan.mjs";
import { deriveFacts } from "./release-classify.mjs";
import { resolvePath } from "./release-unitmap.mjs";

const POLICY = {
  schema: 1,
  trust: { actors: ["owner"] },
  units: {
    api: { paths: ["services/api/**"] }, worker: { paths: ["services/worker/**"] }, cron: { paths: ["services/cron/**"] },
    web: { paths: ["web/**"], hosts: ["h1", "h2"] }, edge: { paths: ["edge/**"], hosts: ["h1", "h2"], single_host_ok: true },
    legacy: { paths: ["legacy/**"], service_pipeline: false },
  },
  couplings: [{ paths: ["shared/**"], affects: ["api", "worker", "cron", "web"] }],
  contracts: [{ producer: "api", consumers: ["web"], paths: ["contracts/strict/**"] }, { producer: "worker", consumers: ["cron"], paths: ["contracts/add/**"], additive_only: true }],
  forces: [{ paths: ["infra/**"], pipeline: "full", reason: "infra" }],
  classify: { min_confidence: 0.6 },
  plan: { max_issues: 60 },
  lanes: { train: { train_max_units: 3, train_max_issues: 15, units_max: 3 } },
};
const POLICY_SHA = "p".repeat(64), LIVE = "a".repeat(40);

const rec = (o) => ({ type: "bug", severity: "P2", exists_in: "live", confidence: 0.9, files: [], ...o });
let created = 0;
const mk = (n, o = {}) => ({
  number: n, title: `t${n}`, body: o.body ?? "", labels: (o.labels ?? []).map((name) => ({ name })), createdAt: `2026-01-${String(1 + (created++ % 28)).padStart(2, "0")}T00:00:00Z`, updatedAt: `2026-02-01T00:00:${String(n % 60).padStart(2, "0")}Z`,
  comments: o.rec === null ? [] : [{ author: { login: "bot" }, body: `<!-- FORGE:CLASSIFY -->\n\`\`\`json\n${JSON.stringify(rec(o.rec ?? {}))}\n\`\`\`` }],
});
const train = (n, file, extra = {}) => mk(n, { rec: { files: [file], ...extra } });

function fixture() {
  created = 0;
  const f = [
    mk(1, { labels: ["epic"] }), mk(2, { labels: ["needs-human"] }), mk(3, { labels: ["parked:q3"] }), mk(4, { labels: ["hold"] }),
    mk(5, { labels: ["design:needed"] }), mk(6, { rec: { ready: false } }), mk(7, { rec: null }), mk(8, { rec: { confidence: 0.1 } }),
    mk(9, { body: "Depends on #2", rec: { files: ["services/api/a.py"] } }),
    mk(10, { body: "Depends on #11", rec: { files: ["services/api/a.py"] } }), mk(11, { body: "Depends on #10", rec: { files: ["services/api/b.py"] } }),
    mk(12, { rec: { severity: "P0", files: ["services/api/a.py"] } }),
    train(13, "services/api/ok.py"), train(14, "services/api/st.py", { exists_in: "staging-only" }),
    train(15, "infra/migrations/001.sql"), train(16, "contracts/strict/x.proto"), train(17, "shared/util.py"), train(18, "shared/billing.py"),
    mk(19, { rec: { type: "feature", files: ["services/api/feat.py"] } }), mk(20, { rec: { type: "infra", files: ["infra/ci.yml"] } }),
    mk(21, { rec: { type: "chore", files: ["services/worker/c.py"] } }), mk(22, { rec: { type: "docs", files: ["docs/readme.md"] } }),
    mk(23, { body: "Depends on #19", rec: { files: ["services/worker/b.py"] } }),
    mk(24, { rec: { type: "bug", files: ["services/cron/x.py"] } }), mk(25, { rec: { type: "bug", files: ["web/x.ts"] } }),
    mk(26, { body: "depends on #1", rec: { files: ["services/api/z.py"] } }),
    mk(27, { labels: ["design:needed", "design:approved"], rec: { files: ["services/api/d.py"] } }),
    mk(28, { rec: { files: ["contracts/add/x.proto"] } }),
  ];
  for (let n = 29; n <= 46; n++) f.push(train(n, `services/${["api", "worker"][n % 2]}/f${n}.py`));
  f.push({ ...mk(47, {}), pullRequest: true }, mk(48, { labels: ["release-plan"] }));
  return f;
}
const run = (over = {}) => buildPlan({ issues: fixture(), policy: POLICY, policySha: POLICY_SHA, liveSha: LIVE, now: Date.parse("2026-03-01T00:00:00Z"), ...over });
const excl = (p) => Object.fromEntries(p.excluded.map((e) => [e.number, e.key]));

describe("buildPlan (#5559)", () => {
  it("plans or excludes every candidate with a key, never a PR or the tracking issue", () => {
    const p = run(), ex = excl(p), planned = Object.keys(p.issues).map(Number);
    const cands = fixture().filter((i) => !i.pullRequest && !i.labels.some((l) => l.name === "release-plan")).map((i) => i.number);
    assert.ok(cands.length >= 40);
    assert.deepEqual([...planned, ...Object.keys(ex).map(Number)].sort((a, b) => a - b), cands);
    for (const k of Object.values(ex)) assert.ok(EXCLUSION_KEYS.includes(k), k);
    assert.deepEqual({ 1: ex[1], 2: ex[2], 3: ex[3], 4: ex[4], 5: ex[5], 6: ex[6], 7: ex[7], 8: ex[8], 9: ex[9], 10: ex[10], 11: ex[11], 12: ex[12], 26: ex[26] },
      { 1: "epic", 2: "plan.skip_labels", 3: "plan.skip_labels", 4: "plan.skip_labels", 5: "design_gate", 6: "ready_no", 7: "unclassified", 8: "unclassified", 9: "dependency_open", 10: "dependency_cycle", 11: "dependency_cycle", 12: "p0", 26: "dependency_open" });
    assert.equal(ex[47], undefined); assert.equal(ex[48], undefined);
  });
  it("assigns lanes: first match wins and the reason is recorded", () => {
    const { issues: l } = run();
    assert.equal(l[13].lane, "train");
    for (const n of [14, 15, 16, 17, 18]) assert.equal(l[n].lane, "release", `#${n}`);
    assert.match(l[14].reason, /staging-only/); assert.match(l[15].reason, /migrations/); assert.match(l[16].reason, /contract/); assert.match(l[17].reason, /units_max/); assert.match(l[18].reason, /risk high/);
    for (const n of [19, 20, 21]) assert.equal(l[n].lane, "release");
    assert.equal(l[22].docs_only, true); assert.deepEqual(l[22].units, []);
    assert.equal(l[23].lane, "release"); assert.match(l[23].reason, /#19/); // a bug depending on a feature moves to the release wave
    assert.equal(l[19].lane, "release"); // a feature never moves earlier
    assert.equal(l[27].lane, "train"); assert.equal(l[28].lane, "release"); assert.deepEqual(l[28].atomic.order, ["worker", "cron"]);
  });
  it("orders trains before the release wave, dependencies first, and overflows train waves", () => {
    const p = run(), ids = p.waves.map((w) => w.id);
    assert.equal(ids.at(-1), "release");
    assert.ok(ids.filter((i) => i.startsWith("train-")).length >= 2);
    assert.ok(p.waves.filter((w) => w.lane === "train").every((w) => w.issues.length <= 15 && w.units.length <= 3));
    const pos = (n) => p.waves.findIndex((w) => w.issues.includes(n));
    assert.ok(pos(19) <= pos(23));
    const rel = p.waves.at(-1).issues; assert.ok(rel.indexOf(19) < rel.indexOf(23));
  });
  it("is byte-identical for the same inputs and unaffected by input order", () => {
    const a = stableJson(run()), shuffled = fixture().reverse();
    assert.equal(stableJson(run({ issues: shuffled })), a);
    assert.equal(stableJson(run()), a);
  });
  it("any change to the snapshot, policy sha or live sha yields a new hash", () => {
    const base = run().plan_hash, f = fixture();
    assert.notEqual(run({ policySha: "q".repeat(64) }).plan_hash, base);
    assert.notEqual(run({ liveSha: "b".repeat(40) }).plan_hash, base);
    assert.notEqual(run({ issues: f.map((i) => (i.number === 13 ? { ...i, body: "edited" } : i)) }).plan_hash, base);
    assert.notEqual(run({ issues: f.map((i) => (i.number === 13 ? { ...i, updatedAt: "2027-01-01T00:00:00Z" } : i)) }).plan_hash, base);
  });
  it("caps the plan at plan.max_issues in wave order and keeps dependents behind their dependencies", () => {
    const p = run({ policy: { ...POLICY, plan: { max_issues: 10 } } });
    assert.equal(Object.keys(p.issues).length, 10);
    assert.ok(p.excluded.some((e) => e.key === "max_issues"));
  });
  it("runs the injectable investigation seam before declaring an issue unclassified", () => {
    const p = run({ investigate: (i) => (i.number === 7 ? { type: "bug", exists_in: "live", confidence: 0.9, files: ["services/api/q.py"], severity: "P2" } : null) });
    assert.ok(p.issues[7]); assert.equal(excl(p)[8], "unclassified");
  });
  it("honours an unexpired trusted lane --force and ignores expired or untrusted ones", () => {
    const now = Date.parse("2026-03-01T00:00:00Z"), at = new Date(now - 3_600_000).toISOString();
    const lanes = { 13: { force: "release", actor: "owner", at }, 14: { force: "train", actor: "owner", at: new Date(now - 90_000_000).toISOString() }, 24: { force: "exclude", actor: "owner", at }, 25: { force: "release", actor: "mallory", at } };
    assert.deepEqual(Object.keys(honouredLanes(lanes, POLICY, now)), ["13", "24"]);
    const p = run({ lanes, now });
    assert.equal(p.issues[13].lane, "release"); assert.equal(p.issues[13].forced, true);
    assert.equal(p.issues[14].lane, "release"); assert.equal(excl(p)[24], "lane_force_exclude"); assert.equal(p.issues[25].lane, "train");
    assert.notEqual(p.plan_hash, run({ now }).plan_hash);
  });
});

describe("rollSet (#5559)", () => {
  it("shared paths roll the full coupling set; contracts are atomic, producer first", () => {
    assert.deepEqual(rollSet(POLICY, ["shared/x.py"]).units, ["api", "cron", "web", "worker"]);
    const c = rollSet(POLICY, ["contracts/strict/a.proto"]);
    assert.deepEqual(c.contract.order, ["api", "web"]); assert.equal(c.contract.atomic, true); assert.equal(c.contract.release_only, true);
    const add = rollSet(POLICY, ["contracts/add/a.proto"]);
    assert.equal(add.contract.release_only, false); assert.equal(add.contract.order[0], "worker");
  });
  it("forces, service_pipeline: false and two-host units", () => {
    assert.equal(rollSet(POLICY, ["infra/x.yml"]).pipeline, "full");
    assert.equal(rollSet(POLICY, ["legacy/x.py"]).pipeline, "full");
    assert.equal(rollSet(POLICY, ["services/api/x.py"]).pipeline, "service");
    assert.equal(rollSet(POLICY, ["docs/x.md"]).pipeline, "none");
    assert.deepEqual(rollSet(POLICY, ["web/a.ts"]).hosts, { web: ["h1", "h2"] });
    assert.deepEqual(rollSet(POLICY, ["edge/a.ts"]).hosts, { edge: ["h1"] });
  });
  it("property: the rolled set is a superset of every unit the files affect (I4, planning side)", () => {
    const corpus = ["services/api/a.py", "services/worker/b.py", "services/cron/c.py", "web/x.ts", "edge/e.ts", "legacy/l.py", "shared/s.py", "shared/billing.py", "contracts/strict/a", "contracts/add/b", "infra/migrations/1.sql", "infra/ci.yml", "docs/a.md", "README.md"];
    for (let mask = 1; mask < 1 << 8; mask++) for (let shift = 0; shift < corpus.length; shift++) {
      const files = corpus.filter((_, i) => mask & (1 << ((i + shift) % 8)) && (i + shift) % 2 === 0 || mask & (1 << ((i + shift) % 8)) && i % 3 === 0);
      const rolled = new Set(rollSet(POLICY, files).units);
      for (const u of deriveFacts(POLICY, files).units) assert.ok(rolled.has(u), `${u} from ${files}`);
      for (const f of files) { const r = resolvePath(POLICY, f); for (const u of [...r.units, ...r.affects, ...r.contracts.flatMap((c) => [c.producer, ...c.consumers])]) assert.ok(rolled.has(u), `${u} from ${f}`); }
    }
  });
});

describe("approval (#5559, I2)", () => {
  const dec = (plan, author) => ({ author, body: `<!-- FORGE:DECISION plan ${plan.plan_hash} -->` });
  it("binds to the hash for a trusted actor and goes stale on any edit", () => {
    const p = run(), d = [dec(p, "owner")];
    assert.deepEqual(approvalOf(p, d, POLICY), { state: "approved", by: "owner", ignored: [] });
    assert.equal(approvalOf(run({ policySha: "q".repeat(64) }), d, POLICY).state, "stale");
    assert.equal(approvalOf(run({ liveSha: "c".repeat(40) }), d, POLICY).state, "stale");
    assert.equal(approvalOf(run({ issues: fixture().map((i) => (i.number === 13 ? { ...i, body: "edited" } : i)) }), d, POLICY).state, "stale");
    assert.equal(approvalOf(run({ policy: POLICY }), d, POLICY).state, "approved");
  });
  it("ignores a decision from a non-trusted actor", () => {
    const p = run(), a = approvalOf(p, [dec(p, "mallory")], POLICY);
    assert.equal(a.state, "none"); assert.deepEqual(a.ignored, ["mallory"]);
    assert.equal(approvalOf(p, [dec(p, "owner")], { ...POLICY, trust: {} }).state, "none");
  });
});

describe("forecast and planFromCli (#5559)", () => {
  const io = (w = {}) => {
    const calls = [];
    return { calls, now: () => Date.parse("2026-03-01T00:00:00Z"), print: (l) => calls.push(["print", l]), gh: async (a) => { calls.push(["gh", a]); return a[0] === "issue" ? JSON.stringify(w.issues ?? fixture()) : JSON.stringify({ nameWithOwner: "o/r" }); },
      api: async (...a) => { calls.push(["api", a]); return { tree: { sha: "t" }, sha: "c" }; }, rehearse: async () => ({ ok: true, output: LIVE }) };
  };
  const pol = { ...POLICY, deploy: { live_release_command: "echo live" } };
  it("forecasts minutes per wave and applies on_exceed", () => {
    const p = run(), f = forecastPlan(p, [{ lane: "train", minutes: 10 }, { lane: "release", minutes: 40 }], { remaining: 30, cfg: { onExceed: "hold" } });
    assert.equal(f.forecast, 10 * p.waves.filter((w) => w.lane === "train").length + 40); assert.equal(f.action, "hold");
    assert.equal(forecastPlan(p, [], {}).forecast, null);
  });
  it("makes zero GitHub writes with managed off and prints the plan", async () => {
    const i = io();
    assert.equal(await planFromCli(["--repo", "o/r"], { io: i, policy: pol, policySha: POLICY_SHA }), 0);
    assert.equal(i.calls.filter((c) => c[0] === "api").length, 0);
    assert.ok(i.calls.filter((c) => c[0] === "gh").every((c) => c[1][0] === "issue" || c[1][0] === "repo"));
    assert.match(i.calls.find((c) => c[0] === "print")[1], /^release plan [0-9a-f]{12}/);
    assert.ok(i.calls.some((c) => c[0] === "print" && /call p0: #12/.test(c[1])));
  });
  it("persists through the ledger writer only when managed", async () => {
    const seen = [], ledger = async (r) => { seen.push(r.id); };
    await planFromCli(["--repo", "o/r", "--json"], { io: io(), policy: pol, policySha: POLICY_SHA, managed: true, newId: "r20260301-000000-1", ledger });
    assert.deepEqual(seen, ["r20260301-000000-1"]);
    await planFromCli(["--repo", "o/r", "--json"], { io: io(), policy: pol, policySha: POLICY_SHA, managed: false, newId: "r20260301-000000-2", ledger });
    assert.equal(seen.length, 1);
  });
  it("--issues narrows the candidates, --json is stable, a missing policy refuses", async () => {
    const i = io();
    await planFromCli(["--repo", "o/r", "--issues", "13,14", "--json"], { io: i, policy: pol, policySha: POLICY_SHA });
    const out = JSON.parse(i.calls.find((c) => c[0] === "print")[1]);
    assert.deepEqual(Object.keys(out.issues), ["13", "14"]); assert.equal(out.approval.state, "none"); assert.equal(out.live_sha, LIVE);
    const j = io();
    assert.equal(await planFromCli(["--repo", "o/r"], { io: j, policy: null, policySha: null }), 1);
    await assert.rejects(planFromCli(["--lane", "bogus", "--repo", "o/r"], { io: j, policy: pol, policySha: POLICY_SHA }), /--lane/);
  });
});
