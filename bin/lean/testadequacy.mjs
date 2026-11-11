// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5449: test adequacy per requirement. Pure, deterministic first: the engine derives each row from facts it already has
 * (the executed evidence tests, the mutation result, the repro red/green words, the optional test plan and regression set
 * of the epic's other children); the reviewer only adds an optional `test_adequacy` judgment per requirement.
 * Verdicts: `adequate`, `weak (reason)`, `missing`. Inputs a lane does not have report "n/a", never a guess.
 */
import { isTestPath, isOutOfBand, unverifiedRequirements } from "./conformance.mjs";

export const TEST_MISSING = "conformance.test_missing";
export const TEST_WEAK = "conformance.test_weak";

const NA = "n/a";
const planOf = (contract, id) => (Array.isArray(contract?.test_plan) ? contract.test_plan : contract?.test_plan?.requirements ?? []).find?.((p) => p?.requirement === id || p?.id === id) ?? null;
const testsOf = (contract, r) => (contract?.deliverables ?? []).filter((d) => (d.requirements ?? []).includes(r.id) && isTestPath(d.path)).map((d) => String(d.path));
const greenId = (id, { runs = [], reruns = null, ciCovered = [] }) => (reruns?.[id] ? reruns[id].rc === 0 : (Array.isArray(runs) ? runs : []).some((x) => x?.id === id && x.exit === 0) || ciCovered.includes(id));

/** The red/green words of the lane's repro test as one cell: "BASE=FAILED HEAD=RAN", or n/a. */
export const reproCell = (repro) => (repro?.base && repro?.head ? `BASE=${repro.base} HEAD=${repro.head}` : NA);

/** Whether the contract's planned regression set (`regression_set`: validate ids, from #5448) ran green: true, false, or null without a set. */
export function regressionRan(contract, evidence = {}) {
  const ids = (Array.isArray(contract?.regression_set) ? contract.regression_set : []).map((x) => String(x?.id ?? x));
  return ids.length ? ids.every((id) => greenId(id, evidence)) : null;
}

/**
 * One row per deliver requirement that is not verified out of band.
 * @param {object} contract
 * @param {{runs?: object[], reruns?: object|null, ciCovered?: string[], mutation?: {id: string, status: string}[], repro?: {base?: string, head?: string}|null, review?: object|null}} [o]
 * @returns {{id: string, planned: string, test: string, level: string, redgreen: string, mutation: string, regression: string, verdict: "adequate"|"weak"|"missing", reason: string}[]}
 */
export function testAdequacyRows(contract, { runs = [], reruns = null, ciCovered = [], mutation = null, repro = null, review = null } = {}) {
  const ev = { runs, reruns, ciCovered };
  // a repro test proved red on the base and green on head is itself the executed proof for a bug lane
  const redGreen = repro?.base === "FAILED" && repro?.head === "RAN" && contract?.repro_test && typeof contract.repro_test === "object";
  const unverified = new Map(unverifiedRequirements(contract, ev).filter(() => !redGreen).map((u) => [u.id, u.reason]));
  const ran = regressionRan(contract, ev);
  const quality = String(contract?.repro_quality ?? "").toLowerCase();
  return (contract?.requirements ?? []).filter((r) => r.disposition === "deliver" && !isOutOfBand(r)).map((r) => {
    const plan = planOf(contract, r.id);
    const m = (mutation ?? []).filter((x) => x?.id === r.id).map((x) => x.status);
    const mut = !m.length ? NA : m.includes("survived") ? "survived" : m.includes("killed") ? "killed" : "skipped";
    const j = (review?.requirements ?? []).find((x) => x?.id === r.id)?.test_adequacy;
    const reasons = [];
    if (mut === "survived") reasons.push("the test passes with the change reverted");
    if (/patch[-_ ]?echo|weak/.test(quality) && contract?.repro_test && contract.repro_test !== "none") reasons.push(`repro quality ${quality}`);
    if (repro?.base === "RAN" && repro?.head === "RAN") reasons.push("the repro passes on the base");
    if (ran === false) reasons.push("the planned regression set did not run green");
    if (/^weak/i.test(String(j?.verdict ?? ""))) reasons.push(String(j?.reason || "reviewer: the test does not prove the root cause").slice(0, 200));
    const missing = unverified.has(r.id);
    return { id: r.id, planned: plan ? String(plan.proof ?? plan.command ?? "planned") : NA, test: testsOf(contract, r).join(", ") || (redGreen ? String(contract.repro_test.path ?? "repro_test") : "none"), level: String(plan?.level ?? NA), redgreen: reproCell(repro), mutation: mut, regression: ran == null ? NA : ran ? "ran" : "not run",
      verdict: missing ? "missing" : reasons.length ? "weak" : "adequate", reason: missing ? unverified.get(r.id) : reasons.join("; ") };
  });
}

/** Display text of a row verdict: `adequate`, `weak (reason)` or `missing`. */
export const verdictText = (row) => (row.verdict === "weak" ? `weak (${row.reason})` : row.verdict);

/**
 * Gate failures for the rows, bug lanes only. `missing` always blocks; `weak` only in the first gate round (one builder
 * resume to strengthen the test), after which it is recorded in the review table.
 */
export function testAdequacyFailures(rows, { bug = false, firstRound = true } = {}) {
  if (!bug) return [];
  return (rows ?? []).flatMap((r) => (r.verdict === "missing" ? [{ code: TEST_MISSING, kind: "test_missing", detail: `${r.id} has no executed test that proves it (${r.reason}); write or run a test that fails without the fix` }]
    : r.verdict === "weak" && firstRound ? [{ code: TEST_WEAK, kind: "test_weak", detail: `${r.id} test is weak: ${r.reason}; strengthen it so it fails when the root cause is present` }] : []));
}

/** Per-lane telemetry scalars (FORGE:TELEMETRY); a fact the lane does not have is omitted, never guessed. */
export function testAdequacyTelemetry(contract, rows, { repro = null, mutation = null, regression = null } = {}) {
  const reqs = (contract?.requirements ?? []).filter((r) => r.disposition === "deliver" && !isOutOfBand(r));
  const ids = [...new Set((contract?.requirements ?? []).filter((r) => r.disposition === "post-deploy" && r.check).map((r) => String(r.check)))];
  const out = { tests_declared: reqs.filter((r) => testsOf(contract, r).length).length, tests_ran: (rows ?? []).filter((r) => r.verdict !== "missing").length };
  if (contract?.repro_test && contract.repro_test !== "none") out.repro_quality = String(contract.repro_quality ?? (repro?.base === "FAILED" && repro?.head === "RAN" ? "red_green" : repro?.base ? "unproven" : "unrun"));
  if (mutation?.length) out.mutation_killed = mutation.filter((x) => x?.status === "killed").length;
  if (regression != null) out.regression_suite_ran = Boolean(regression);
  if (ids.length) out.post_deploy_check_ids = ids.join(",");
  return out;
}

/** The class of a lane for outcome splits: the worst row verdict (missing > weak > adequate), or null without rows. */
export const adequacyClass = (rows) => (!rows?.length ? null : rows.some((r) => r.verdict === "missing") ? "missing" : rows.some((r) => r.verdict === "weak") ? "weak" : "adequate");

/** Counts by verdict for a lane's `conformance.test_adequacy` record. */
export const adequacyCounts = (rows) => (rows?.length ? { adequate: rows.filter((r) => r.verdict === "adequate").length, weak: rows.filter((r) => r.verdict === "weak").length, missing: rows.filter((r) => r.verdict === "missing").length } : null);

/** Batch report line from orchestrate rows (`row.conformance.test_adequacy`), or null when no lane has rows. */
export function formatTestAdequacySummary(rows) {
  const cs = (rows ?? []).map((r) => r?.conformance?.test_adequacy).filter((c) => c && typeof c === "object");
  if (!cs.length) return null;
  const sum = (k) => cs.reduce((n, c) => n + (c[k] || 0), 0);
  const total = sum("adequate") + sum("weak") + sum("missing");
  const pct = (k) => `${total ? Math.round((sum(k) / total) * 100) : 0}%`;
  return `test adequacy: ${cs.length} lane${cs.length === 1 ? "" : "s"}, ${total} requirement(s): adequate ${pct("adequate")}, weak ${pct("weak")}, missing ${pct("missing")}`;
}
