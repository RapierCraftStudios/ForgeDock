// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";
import { parseIntegration } from "./integration.mjs";
import {
  parseCiPolicy, sumUsage, project, detectBudget, resolveCiMode, formatBudgetLine, coerceVerify, writeEffective, hitRates, remoteSuites,
  attestPayload, recordHostCheck, budgetAlerts, formatDigest, writeCiBlock, ciFromCli, budgetReportLine, effectiveModeSync, readParity,
} from "./ci-budget.mjs";

const tmp = () => tmpDir("cib-");
const NOW = Date.parse("2026-11-10T12:00:00Z"); // day 10 of 30
const item = (q, o = {}) => ({ product: "actions", unitType: "Minutes", sku: "actions_linux", quantity: q, repositoryName: "AlterLab", ...o });
/** gh stub: repo meta, billing usage, org plan. */
const ghFor = ({ priv = true, org = true, items = [item(15000)], plan = "enterprise", usageFails = false } = {}) => async (a) => {
  const u = a.join(" ");
  if (/^api repos\/[^/]+\/[^/]+$/.test(u)) return JSON.stringify({ private: priv, owner: { login: "Acme", type: org ? "Organization" : "User" } });
  if (/settings\/billing\/usage/.test(u)) { if (usageFails) throw new Error("HTTP 403"); return JSON.stringify({ usageItems: items }); }
  if (/^api (orgs\/|user$)/.test(u)) return JSON.stringify({ plan: { name: plan } });
  throw new Error(`unexpected ${u}`);
};

test("parseCiPolicy: defaults, flat keys, junk ignored", () => {
  assert.deepEqual(parseCiPolicy(null), { mode: "auto", monthlyMinutes: null, reservePct: 10, includedMinutes: null, plan: null });
  const p = parseCiPolicy({ mode: "local-first", monthly_minutes: "2000", reserve_pct: "20", plan: "Free" });
  assert.equal(p.mode, "local-first"); assert.equal(p.monthlyMinutes, 2000); assert.equal(p.reservePct, 20); assert.equal(p.plan, "free");
  assert.equal(parseCiPolicy({ mode: "bogus", monthly_minutes: "-3", reserve_pct: "99" }).mode, "auto");
});

test("usage sums actions minutes with OS rates; projection is linear", () => {
  const u = sumUsage({ usageItems: [item(100), item(10, { sku: "actions_macos", repositoryName: "B" }), { product: "copilot", quantity: 999 }] });
  assert.equal(u.total, 200); assert.equal(u.byRepo.B, 100);
  assert.equal(project(15000, NOW).projected, 45000);
});

test("private Enterprise repo: over budget in auto switches to local-first and the report says so", async () => {
  const policy = parseCiPolicy({ monthly_minutes: "40000" });
  const facts = await detectBudget({ gh: ghFor(), repo: "Acme/AlterLab", policy, now: NOW });
  assert.equal(facts.mtd, 15000); assert.equal(facts.projected, 45000); assert.equal(facts.plan, "enterprise");
  const res = resolveCiMode({ policy, facts });
  assert.equal(res.effective, "local-first"); assert.equal(res.switched, true);
  const line = formatBudgetLine({ res, facts, release: { runs: 1, minutes: 78 } });
  assert.match(line, /this release: 1 CI run, 78 min/); assert.match(line, /auto -> local-first/); assert.match(line, /month: 15k\/40k, projected 45k/); assert.match(line, /SWITCHED/);
});

test("under budget stays remote; plan table supplies the included minutes", async () => {
  const policy = parseCiPolicy(null);
  const facts = await detectBudget({ gh: ghFor({ items: [item(5000)] }), repo: "Acme/x", policy, now: NOW });
  assert.equal(facts.budget, 50000);
  assert.equal(resolveCiMode({ policy, facts }).effective, "remote");
});

test("public repo: free hosted minutes, never auto-switched even over any budget", async () => {
  const policy = parseCiPolicy({ monthly_minutes: "10" });
  const facts = await detectBudget({ gh: ghFor({ priv: false }), repo: "Acme/pub", policy, now: NOW });
  const res = resolveCiMode({ policy, facts });
  assert.equal(res.effective, "remote"); assert.equal(res.switched, false); assert.equal(res.free, true);
  assert.match(formatBudgetLine({ res, facts }), /free hosted minutes/);
});

test("billing API failure is fail-soft: remote, usage unknown", async () => {
  const policy = parseCiPolicy(null);
  const facts = await detectBudget({ gh: ghFor({ usageFails: true }), repo: "Acme/x", policy, now: NOW });
  const res = resolveCiMode({ policy, facts });
  assert.equal(facts.usage, null); assert.equal(res.effective, "remote"); assert.match(res.reason, /unknown/);
});

test("configured local-attested is honoured as is", () => {
  const res = resolveCiMode({ policy: parseCiPolicy({ mode: "local-attested" }), facts: null });
  assert.equal(res.effective, "local-attested");
});

test("local-first coerces verify.mode ci|hybrid to local; remote leaves it", () => {
  const cwd = tmp(), dir = tmp();
  writeFileSync(join(cwd, "forge.yaml"), "ci:\n  mode: local-first\n");
  assert.equal(coerceVerify({ mode: "ci" }, { cwd, dir }).mode, "local");
  assert.equal(coerceVerify({ mode: "hybrid" }, { cwd, dir }).mode, "local");
  assert.equal(coerceVerify({ mode: "local" }, { cwd, dir }).mode, "local");
  writeFileSync(join(cwd, "forge.yaml"), "ci:\n  mode: remote\n");
  assert.equal(coerceVerify({ mode: "ci" }, { cwd, dir }).mode, "ci");
  writeFileSync(join(cwd, "forge.yaml"), "verify:\n  mode: ci\n"); // no ci block: auto with no cache = remote (unchanged default)
  assert.equal(coerceVerify({ mode: "ci" }, { cwd, dir }).mode, "ci");
});

test("auto uses the cached resolution of the budget check", () => {
  const cwd = tmp(), dir = tmp();
  writeFileSync(join(cwd, "forge.yaml"), "ci:\n  mode: auto\n");
  assert.equal(effectiveModeSync({ cwd, dir, now: NOW }), "remote");
  writeEffective({ cwd, dir, now: NOW, res: { effective: "local-first", configured: "auto", switched: true, reason: "x" } });
  assert.equal(coerceVerify({ mode: "ci" }, { cwd, dir, now: NOW }).mode, "local");
  assert.equal(effectiveModeSync({ cwd, dir, now: NOW + 3 * 86400000 }), "remote"); // stale cache ignored
});

test("parity: hit rate counts local green -> remote red per suite", () => {
  const rows = [
    { local: { unit: "pass", lint: "pass" }, remote: { unit: "fail", lint: "pass" } },
    { local: { unit: "pass" }, remote: { unit: "pass" } },
    { local: { unit: "fail" }, remote: { unit: "fail" } },
  ];
  const r = hitRates(rows);
  assert.deepEqual([r.unit.greenLocal, r.unit.redRemote, r.lint.redRemote], [2, 1, 0]);
  assert.deepEqual(remoteSuites({ check_runs: [{ name: "a", conclusion: "success" }, { name: "b", conclusion: "failure" }, { name: "c", conclusion: null }] }), { a: "pass", b: "fail" });
});

test("recordHostCheck appends a parity row and posts the attested status only in local-attested", async () => {
  const dir = tmp(), calls = [];
  const gh = async (a) => { calls.push(a.join(" ")); return JSON.stringify({ nameWithOwner: "Acme/x" }); };
  await recordHostCheck({ cwd: dir, head: "abc123", ok: true, suites: [{ name: "unit", ok: true }], gh, dir, mode: "local-first" });
  assert.equal(calls.length, 0); assert.deepEqual(readParity(dir)[0].local, { unit: "pass" });
  await recordHostCheck({ cwd: dir, head: "abc123", ok: false, suites: [{ name: "unit", ok: false }], gh, dir, mode: "local-attested" });
  assert.ok(calls.some((c) => /api repos\/Acme\/x\/statuses\/abc123 .*state=failure .*context=forgedock\/ci-local/.test(c)));
  assert.equal(attestPayload({ ok: true, suites: [] }).state, "success");
  await recordHostCheck({ cwd: dir, head: "h", ok: true, suites: [], gh: async () => { throw new Error("boom"); }, dir, mode: "local-attested" }); // fail-soft
});

test("alerts: projected overage and a new burn source; digest lists repos", () => {
  const usage = sumUsage({ usageItems: [item(9000), item(4000, { repositoryName: "Flipped" })] });
  const facts = { budget: 20000, projected: 39000, usage, mtd: 13000, owner: "Acme" };
  const alerts = budgetAlerts({ facts, seen: ["AlterLab"] });
  assert.ok(alerts.some((a) => /projected overage/.test(a))); assert.ok(alerts.some((a) => /new burn source: Flipped/.test(a)));
  assert.equal(budgetAlerts({ facts, seen: null }).some((a) => /new burn/.test(a)), false);
  assert.match(formatDigest(facts), /AlterLab: 9\.0k min/);
});

test("writeCiBlock: plain-language setup writes a valid ci block, keeping milestone_integration keys", () => {
  const raw = "project:\n  name: x\nci:\n  milestone_integration:\n    workflow: e2e.yml\n    interval_hours: 12\nverify:\n  mode: local\n";
  const out = writeCiBlock(raw, { mode: "local-first", monthly_minutes: 2000, reserve_pct: 15 });
  const p = parseForgeYaml(out);
  assert.equal(parseCiPolicy(p.ci).mode, "local-first"); assert.equal(parseCiPolicy(p.ci).monthlyMinutes, 2000); assert.equal(parseCiPolicy(p.ci).reservePct, 15);
  assert.equal(parseIntegration(p.ci).workflow, "e2e.yml"); assert.equal(parseIntegration(p.ci).intervalHours, 12);
  assert.equal(p.verify.mode, "local");
  assert.equal(parseCiPolicy(parseForgeYaml(writeCiBlock("a: b\n", { mode: "auto" })).ci).mode, "auto"); // creates the block
  const again = parseForgeYaml(writeCiBlock(out, { mode: "remote" }));
  assert.equal(again.ci.mode, "remote"); assert.equal(again.ci.monthly_minutes, "2000");
  assert.throws(() => writeCiBlock(raw, { mode: "fast" }), /ci.mode/);
  assert.throws(() => writeCiBlock(raw, { monthly_minutes: "abc" }), /positive integer/);
});

test("forgedock ci budget prints plan, included, month-to-date, projection and the active mode; flags write forge.yaml", async () => {
  const cwd = tmp(), dir = tmp(), lines = [];
  writeFileSync(join(cwd, "forge.yaml"), "project:\n  name: x\n");
  const gh = async (a) => (a[0] === "repo" ? JSON.stringify({ nameWithOwner: "Acme/AlterLab" }) : ghFor({ items: [item(40000)] })(a));
  const code = await ciFromCli(["budget", "--set-mode", "auto", "--budget", "40000"], { cwd, dir, gh, now: NOW, out: (l) => lines.push(l) });
  const text = lines.join("\n");
  assert.equal(code, 0);
  assert.match(text, /plan: enterprise; included minutes: 50000; budget: 40000/);
  assert.match(text, /month-to-date \(all repos of Acme\): 40000 min; burn 4000\/day; projected 120000/);
  assert.match(text, /mode: auto -> local-first/);
  assert.match(readFileSync(join(cwd, "forge.yaml"), "utf8"), /ci:\n {2}mode: auto\n {2}monthly_minutes: 40000/);
  const j = []; await ciFromCli(["budget", "--json"], { cwd, dir, gh, now: NOW, out: (l) => j.push(l) });
  assert.equal(JSON.parse(j.join("")).mode, "local-first");
  await assert.rejects(() => ciFromCli(["budget", "--nope"], { cwd, dir, gh }), /unknown option/);
  await assert.rejects(() => ciFromCli(["other"], { cwd, dir, gh }), /usage/);
});

test("budgetReportLine never throws and caches the effective mode for the next lane", async () => {
  const cwd = tmp(), dir = tmp();
  writeFileSync(join(cwd, "forge.yaml"), "ci:\n  monthly_minutes: 1000\n");
  const line = await budgetReportLine({ cwd, dir, repo: "Acme/x", gh: ghFor(), now: NOW });
  assert.match(line, /auto -> local-first/);
  assert.equal(effectiveModeSync({ cwd, dir, now: NOW }), "local-first");
  assert.match(await budgetReportLine({ cwd, dir, repo: "Acme/x", gh: async () => { throw new Error("no gh"); }, now: NOW }), /^ci: auto \(remote\) \(usage unknown/);
});
