// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Release gate (#5561, epic #5549, invariants I1/I5): the merge to the default branch depends on the `forge/release-gate`
 * check run produced by a workflow from real CI conclusions, never on an agent-posted GATE_PASS marker. `computeGate` is the
 * pure function that workflow runs; `readReleaseGate` reads the check run (accepted only from the configured app);
 * `mergeGuard` is the MERGING guard. Every function fails closed on unreadable input.
 */
import { checkChain } from "./release-snapshot.mjs";

export const GATE_CHECK = "forge/release-gate";
const PASS_VERDICTS = ["pass", "approve", "approved"];

/**
 * Pass only when every required check concluded `success` on exactly `head` (neutral, skipped, missing and other-sha runs do
 * not count) and the review verdict was recorded for `head`.
 * @param {{checks: {name: string, conclusion: string, head?: string, sha?: string}[], required: string[], reviewVerdict: {head: string, verdict: string}, head: string}} p
 * @returns {{pass: boolean, reasons: string[]}}
 */
export function computeGate({ checks, required, reviewVerdict, head } = {}) {
  const no = (...reasons) => ({ pass: false, reasons });
  if (typeof head !== "string" || !head) return no("unreadable input: no head sha");
  if (!Array.isArray(checks)) return no("unreadable input: checks");
  if (!Array.isArray(required) || !required.length || required.some((r) => typeof r !== "string" || !r)) return no("unreadable input: no required checks");
  const reasons = [];
  for (const name of required) {
    const runs = checks.filter((c) => c?.name === name && (c.head ?? c.sha) === head);
    if (!runs.length) reasons.push(`${name}: missing on ${head}`);
    else if (!runs.every((c) => c.conclusion === "success")) reasons.push(`${name}: ${runs.find((c) => c.conclusion !== "success").conclusion ?? "unfinished"}, not success`);
  }
  if (!reviewVerdict || typeof reviewVerdict !== "object") reasons.push("review verdict: not recorded");
  else if (reviewVerdict.head !== head) reasons.push(`review verdict is for ${reviewVerdict.head ?? "no head"}, not ${head}`);
  else if (!PASS_VERDICTS.includes(String(reviewVerdict.verdict ?? "").toLowerCase())) reasons.push(`review verdict is ${reviewVerdict.verdict ?? "absent"}`);
  return reasons.length ? { pass: false, reasons } : { pass: true, reasons: [] };
}

/**
 * The `forge/release-gate` check run at `head`, accepted only from the configured gate app.
 * @returns {Promise<{ok: true, conclusion: string} | {ok: false, why: string}>}
 */
export async function readReleaseGate({ io, repo, head, identity }) {
  if (!identity?.app) return { ok: false, why: "no gate identity configured (credentials.gate_app)" };
  let runs;
  try { runs = JSON.parse(await io.gh(["api", `repos/${repo}/commits/${head}/check-runs`, "--jq", "[.check_runs[] | {name, conclusion, head: .head_sha, app: .app.slug}]"])); } catch (e) { return { ok: false, why: `cannot read check runs: ${String(e?.message ?? e).split("\n")[0]}` }; }
  if (!Array.isArray(runs)) return { ok: false, why: "cannot read check runs: unexpected shape" };
  const mine = runs.filter((c) => c?.name === GATE_CHECK && c.head === head);
  if (!mine.length) return { ok: false, why: `no ${GATE_CHECK} on ${head}` };
  const trusted = mine.filter((c) => c.app === identity.app);
  if (!trusted.length) return { ok: false, why: `${GATE_CHECK} on ${head} was not posted by ${identity.app}` };
  return { ok: true, conclusion: trusted.every((c) => c.conclusion === "success") ? "success" : String(trusted.find((c) => c.conclusion !== "success").conclusion ?? "pending") };
}

/**
 * MERGING guard (I1): plan approval current (hash match, I2), every required check green on the exact head, the gate status
 * exists for that sha and passed, and head == cut sha + recorded picks (`checkChain`, including main-sync).
 * @returns {Promise<{ok: true} | {ok: false, why: string}>}
 */
export async function mergeGuard({ io, repo, head, state, policy, staging }) {
  const no = (why) => ({ ok: false, why });
  const plan = state?.plan;
  if (!plan?.hash || plan.approved_hash !== plan.hash) return no("plan approval is not current (approved hash does not match the plan hash)");
  if (!policy) return no("release policy is unreadable");
  const required = policy.ci?.required_checks;
  let checks;
  try { checks = JSON.parse(await io.gh(["api", `repos/${repo}/commits/${head}/check-runs`, "--jq", "[.check_runs[] | {name, conclusion, head: .head_sha}]"])); } catch (e) { return no(`cannot read check runs: ${String(e?.message ?? e).split("\n")[0]}`); }
  const rev = state.steps?.review?.result;
  const g = computeGate({ checks, required, reviewVerdict: rev ? { head: rev.head, verdict: rev.verdict } : null, head });
  if (!g.pass) return no(`required checks not green: ${g.reasons.join("; ")}`);
  const gate = await readReleaseGate({ io, repo, head, identity: { app: policy.credentials?.gate_app } });
  if (!gate.ok) return no(gate.why);
  if (gate.conclusion !== "success") return no(`${GATE_CHECK} is ${gate.conclusion}, not success`);
  if (!state.release) return no("no FORGE:RELEASE record to verify the head against");
  const chain = checkChain({ git: io.git, record: state.release, sha: head, staging, exact: true });
  if (!chain.ok) return no(`release head ${head} is not snapshot + recorded cherry-picks: ${chain.why}`);
  return { ok: true };
}
