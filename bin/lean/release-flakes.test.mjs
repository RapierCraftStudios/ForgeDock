// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFlakeConfig, classifyFailure, detectSameShaFlip, flakeEntry, planRerun, repeatedFlakes, fileFlakeIssue, canQuarantine, activeQuarantines, shouldWriteMarker, isUnskippable, recordFlakes, UNSKIPPABLE_CLASSES } from "./release-flakes.mjs";
import { rerunInfraFlakes } from "./release.mjs";

const NOW = Date.parse("2026-11-12T00:00:00Z"), DAY = 86_400_000;
const cfg = parseFlakeConfig({ ci: { rerun_budget_min: 30 } });

describe("release flakes (#5568)", () => {
  it("defaults and overrides", () => {
    assert.deepEqual([cfg.quarantineAfter, cfg.windowDays, cfg.quarantineDays, cfg.quarantineMax], [3, 14, 14, 15]);
    assert.equal(parseFlakeConfig({ quarantine: { days: 7, max: 2 }, ci: { unskippable: ["x"] } }).unskippable.includes("x"), true);
  });

  it("records a same-SHA fail-then-pass flip but not a plain failure or a different sha", () => {
    const r = (sha, conclusion, id, at) => ({ sha, check: "unit", conclusion, id, at });
    const flips = detectSameShaFlip([r("a", "failure", 1, "2026-11-01T00:00:00Z"), r("a", "success", 2, "2026-11-01T01:00:00Z"), r("b", "failure", 3, "2026-11-02T00:00:00Z"), r("c", "failure", 4, "2026-11-02T00:00:00Z"), r("d", "success", 5, "2026-11-02T00:00:00Z")]);
    assert.deepEqual(flips, [{ check: "unit", test: null, sha: "a", run_ids: [1, 2] }]);
  });

  it("infra signatures are classified and hashed stably", () => {
    assert.deepEqual(classifyFailure("Error: pg_isready: no response"), { class: "infra", signature: "postgres-init" });
    assert.equal(classifyFailure("Unable to upload artifact").class, "infra");
    assert.equal(classifyFailure("AssertionError: 1 !== 2").class, "unknown");
    assert.equal(flakeEntry({ check: "c", signature: "s", kind: "infra", at: "t" }).signature_hash, flakeEntry({ check: "c", signature: "s", kind: "infra", at: "u" }).signature_hash);
  });

  it("rerun: once per job, infra only, inside the budget, every job decided", () => {
    const jobs = [{ key: "a", class: "infra", minutes: 10 }, { key: "b", class: "unknown" }, { key: "c", class: "infra", minutes: 10 }, { key: "d", class: "infra", minutes: 50 }];
    const p = planRerun({ jobs, done: ["c"], spentMin: 5, budgetMin: 30 });
    assert.deepEqual(p.map((d) => d.rerun), [true, false, false, false]);
    assert.match(p[3].why, /rerun_budget_min/); assert.match(p[2].why, /once/);
    assert.equal(planRerun({ jobs: [jobs[0]], budgetMin: 0 })[0].rerun, false);
  });

  it("repeated flakes inside the window file one flake issue (deduped)", async () => {
    const at = (d) => new Date(NOW - d * DAY).toISOString();
    const fl = [1, 2, 3].map((d) => flakeEntry({ check: "e2e", test: "t1", kind: "flip", at: at(d), runIds: [d] })).concat(flakeEntry({ check: "e2e", test: "old", kind: "flip", at: at(40) }));
    const rep = repeatedFlakes(fl, cfg, NOW);
    assert.equal(rep.length, 1); assert.equal(rep[0].target, "e2e:t1");
    const issues = []; const calls = [];
    const gh = async (a) => { calls.push(a); if (a[1] === "list") return JSON.stringify(issues); issues.push({ number: 7, body: a[a.indexOf("--body") + 1] }); return "https://github.com/o/r/issues/7"; };
    const first = await fileFlakeIssue({ gh, repo: "o/r", ...rep[0], cfg });
    assert.deepEqual(first, { issue: 7, created: true }); assert.ok(calls.at(-1).includes("flake"));
    assert.deepEqual(await fileFlakeIssue({ gh, repo: "o/r", ...rep[0], cfg }), { issue: 7, created: false });
    assert.equal(await fileFlakeIssue({ gh, repo: "o/r", target: "migration:x", cfg }), null);
  });

  it("quarantine needs the flake issue, respects the cap and never takes unskippable classes", () => {
    const base = { target: "e2e:t1", exemptions: {}, issueLabels: ["flake"], cfg, now: NOW };
    assert.equal(canQuarantine(base).ok, true);
    assert.match(canQuarantine({ ...base, issueLabels: [] }).why, /flake/);
    assert.equal(canQuarantine({ ...base, issueOpen: false }).ok, false);
    for (const c of UNSKIPPABLE_CLASSES) assert.equal(canQuarantine({ ...base, target: `${c}:x` }).ok, false, c);
    const live = (i) => [`t${i}`, { mode: "quarantine", at: new Date(NOW - DAY).toISOString(), until: new Date(NOW + DAY).toISOString() }];
    const full = Object.fromEntries(Array.from({ length: 15 }, (_, i) => live(i)));
    assert.match(canQuarantine({ ...base, exemptions: full }).why, /cap 15/);
    assert.equal(canQuarantine({ ...base, target: "t3", exemptions: full }).ok, true);
    assert.equal(isUnskippable("migration"), true);
  });

  it("a quarantine is blocking again at its 14 day expiry, or at `until`", () => {
    const q = (ageD, untilD) => ({ x: { mode: "quarantine", at: new Date(NOW - ageD * DAY).toISOString(), until: new Date(NOW + untilD * DAY).toISOString() } });
    assert.deepEqual(activeQuarantines(q(1, 5), cfg, NOW), ["x"]);
    assert.deepEqual(activeQuarantines(q(15, 5), cfg, NOW), []);
    assert.deepEqual(activeQuarantines(q(1, -1), cfg, NOW), []);
  });

  it("a retry-pass run writes no cache marker (I29)", () => {
    assert.equal(shouldWriteMarker({ passed: true }), true);
    for (const k of ["retried", "flakeAnnotated", "rerun"]) assert.equal(shouldWriteMarker({ passed: true, [k]: true }), false, k);
    assert.equal(shouldWriteMarker({ passed: false }), false);
  });

  it("recordFlakes commits flakes.json with active.json", async () => {
    const files = {};
    const io = { api: async (m, p, b) => {
      if (m === "GET" && /git\/ref\/heads/.test(p)) return { object: { sha: "h" } };
      if (m === "GET" && /contents\/active\.json/.test(p)) return { content: Buffer.from("{}").toString("base64") };
      if (m === "GET") return { tree: { sha: "t" } };
      if (/git\/trees/.test(p)) { for (const t of b.tree) files[t.path] = t.content; return { sha: "t1" }; }
      return { sha: "c1" };
    } };
    const r = await recordFlakes({ io, repo: "o/r", credential: "driver" }, [flakeEntry({ check: "c", kind: "infra", at: "t" })]);
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(files["flakes.json"]).flakes.length, 1); assert.ok(files["active.json"]);
  });

  it("rerunInfraFlakes reruns an infra-failed run once, skips a real failure, records the flake", async () => {
    const calls = [], files = {};
    const logs = { 1: "Unable to upload artifact", 2: "AssertionError" };
    const active = { epoch: 1, lease: { holder: "A", epoch: 1, release: "r1" } };
    const api = async (m, p, b) => {
      if (m === "GET" && /git\/ref\/heads/.test(p)) return { object: { sha: "h" } };
      if (m === "GET" && /contents\/active\.json/.test(p)) return { content: Buffer.from(JSON.stringify(active)).toString("base64") };
      if (m === "GET") return { tree: { sha: "t" } };
      if (/git\/trees/.test(p)) { for (const t of b.tree) files[t.path] = t.content; return { sha: "t1" }; }
      return { sha: "c1" };
    };
    const io = { now: () => NOW, api, gh: async (a) => {
      calls.push(a);
      if (a[1] === "list") return JSON.stringify([{ databaseId: 1, name: "unit" }, { databaseId: 2, name: "lint" }]);
      if (a[1] === "view") return logs[a[2]];
      return "";
    } };
    const fence = { lctx: { io, repo: "o/r", credential: "driver" }, lease: { holder: "A", epoch: 1, release: "r1" }, record: async () => {}, now: () => "t" };
    const r = await rerunInfraFlakes({ io, repo: "o/r", head: "abc", fence, policy: { ci: { rerun_budget_min: 30 } } });
    assert.deepEqual(r.reran, ["unit"]); assert.equal(r.skipped[0].name, "lint");
    assert.deepEqual(calls.filter((c) => c[1] === "rerun"), [["run", "rerun", "1", "--repo", "o/r", "--failed"]]);
    assert.equal(JSON.parse(files["flakes.json"]).flakes[0].signature, "artifact-upload");
    const none = await rerunInfraFlakes({ io, repo: "o/r", head: "abc", fence, policy: {} });
    assert.deepEqual(none, { reran: [], skipped: [] }); // no ci.rerun_budget_min: no rerun
  });
});
