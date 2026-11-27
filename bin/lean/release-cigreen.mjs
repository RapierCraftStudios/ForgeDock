// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `ci-green` step of `forgedock release`: the default, ForgeDock-owned order is release PR -> CI green -> ONE review pass. Review never
 * starts on a head whose required checks are pending or red, because a CI failure then moves the head and voids the review.
 *
 * The step waits for every required check of the release PR head (branch protection and rulesets of the default branch plus forge.yaml
 * gate.required_checks; forgedock/verify, forge/deploy-gate and the gate-marker check are excluded). A check that fails is rerun ONCE
 * (reusing the #5502/#6014 attempt cap); if the rerun passes it is a flake: it counts as green and a `flaky-test` issue is filed, naming
 * the test when the log shows it. A check still red after its rerun is real: the existing fix path runs once (`fixRound`), the new head
 * is waited on again, and a second red ends in a block. There is no switch to turn the step off; forge.yaml `release.ci_green.max_wait_min`
 * and `release.block_severity` only tighten or loosen it. Timings (`ci_green_min`, `review_min`, `fix_rounds`, `review_passes`) are
 * recorded in `state.timing`, which release status prints and the ledger mirrors.
 */
import { ciState, requiredSet } from "../review-staging.mjs";
import { requiredChecksRead } from "./effects.mjs";
import { attemptGuard, classifyFailure } from "./release-flakes.mjs";

export const CI_GREEN_POLL_MS = 30_000;
export const CI_GREEN_MAX_WAIT_MIN = 40;
const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const json = (s) => JSON.parse(String(s || "null"));

/** forge.yaml `release.ci_green.max_wait_min` and `release.block_severity` (lowest blocking severity; default high) -> `{ciGreen, blockSeverity}`; only set keys are returned. */
export function ciGreenKeys(r) {
  const out = {};
  const wait = Number(r?.ci_green?.max_wait_min ?? r?.ci_green_max_wait_min);
  if (Number.isFinite(wait) && wait > 0) out.ciGreen = { maxWaitMin: Math.min(wait, 240) };
  const sev = String(r?.block_severity ?? "").trim().toUpperCase();
  if (SEVERITY_ORDER.includes(sev)) out.blockSeverity = sev;
  return out;
}

/** Set of severities that block: CRITICAL down to `config.blockSeverity` (default HIGH). */
export function blockSetOf(config) {
  const at = SEVERITY_ORDER.indexOf(config?.blockSeverity);
  return new Set(SEVERITY_ORDER.slice(0, at >= 0 ? at + 1 : 2));
}

/** `state.timing[key]`: minutes (1 decimal) added for `ms`, or a raw count with `raw`, or the value itself with `set`. */
export function addTiming(ctx, key, n, { raw = false, set = false } = {}) {
  const t = (ctx.state.timing ??= {});
  t[key] = set ? n : raw ? (t[key] ?? 0) + n : Math.round(((t[key] ?? 0) + n / 60_000) * 10) / 10;
  ctx.save?.();
}

/** Best-effort test name from a failed log: tap `not ok`, node test runner, jest/mocha, pytest/cargo style lines. */
export function flakyTestName(log) {
  const text = String(log ?? "");
  const pats = [/^\s*not ok \d+ - (.+)$/m, /^\s*(?:✖|✗|×) (.+?)(?: \(\d[^)]*\))?\s*$/m, /^\s*● (.+)$/m, /^\s*(?:FAILED|FAIL) (\S+(?:::\S+)*)/m, /^\s*test (\S+) \.\.\. FAILED/m, /^\s*\d+\) (.+)$/m];
  for (const re of pats) { const m = re.exec(text); if (m?.[1]?.trim()) return m[1].trim().slice(0, 120); }
  return null;
}

const runIdOf = (link) => /\/actions\/runs\/(\d+)/.exec(String(link ?? ""))?.[1] ?? null;
const bucketOf = (status, conclusion) => {
  if (status && status !== "completed") return "pending";
  if (["success", "neutral", "skipped"].includes(conclusion)) return "pass";
  if (conclusion === "cancelled") return "cancel";
  return conclusion ? "fail" : "pending";
};

/** Real effects of ci-green. Tests inject `ctx.io.ciGreen` with the same shape. */
export function realCiSeam(ctx) {
  const { io, repo } = ctx;
  const gh = (a) => io.gh(a);
  return {
    sleep: (ms) => io.sleep(ms),
    now: () => io.now?.() ?? Date.now(),
    isDraft: async (pr) => Boolean(json(await gh(["pr", "view", String(pr), "--repo", repo, "--json", "isDraft"]))?.isDraft),
    headOf: async (pr) => String(await gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid", "--jq", ".headRefOid"])).trim(),
    checks: async ({ head }) => {
      const runs = json(await gh(["api", `repos/${repo}/commits/${head}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {name, status, conclusion, link: .details_url}]"])) ?? [];
      let statuses = [];
      try { statuses = json(await gh(["api", `repos/${repo}/commits/${head}/status`, "--jq", "[.statuses[] | {name: .context, state, link: .target_url}]"])) ?? []; } catch { /* check runs alone */ }
      return [
        ...runs.map((k) => ({ name: k.name, bucket: bucketOf(k.status, k.conclusion), link: k.link })),
        ...statuses.map((k) => ({ name: k.name, bucket: k.state === "success" ? "pass" : k.state === "pending" ? "pending" : "fail", link: k.link })),
      ];
    },
    required: async () => {
      const read = await requiredChecksRead({ gh, repo, lane: ctx.def });
      return requiredSet(read, ctx.config?.requiredChecks ?? []);
    },
    runAttempt: async (id) => { try { return json(await gh(["run", "view", id, "--repo", repo, "--json", "attempt"]))?.attempt ?? null; } catch { return null; } },
    failedLog: async (id) => { try { return String(await gh(["run", "view", id, "--repo", repo, "--log-failed"])).slice(-20_000); } catch { return ""; } },
    rerunFailed: (id) => gh(["run", "rerun", id, "--repo", repo, "--failed"]),
    fileFlake: async ({ check, test, signature, tail, sha, pr }) => {
      const title = `Flaky test: ${test ?? check}`;
      try {
        const hit = json(await gh(["issue", "list", "--repo", repo, "--state", "open", "--search", `"${title}" in:title`, "--json", "number,title"]))?.find((i) => i.title === title);
        if (hit) return hit.number;
      } catch { /* no lookup: file a new one */ }
      const body = [`Required check \`${check}\` failed on release PR #${pr} at ${String(sha).slice(0, 7)} and passed on one rerun, so the release treated it as green and went on.`, test ? `Test: \`${test}\`` : "The log did not show a test name.", signature ? `Failure signature: ${signature}` : "", "", "```", String(tail ?? "").slice(-1200), "```"].filter((l) => l !== "").join("\n");
      try { await gh(["label", "create", "flaky-test", "--repo", repo, "--color", "FBCA04", "--description", "A test that fails and then passes on rerun", "--force"]); } catch { /* the label is best effort */ }
      for (const labels of [["--label", "flaky-test"], []]) {
        try { return Number(/\/issues\/(\d+)/.exec(String(await gh(["issue", "create", "--repo", repo, "--title", title, "--body", body, ...labels])))?.[1]) || null; } catch { /* retry without the label */ }
      }
      return null;
    },
  };
}
const ciSeamOf = (ctx) => ctx.io.ciGreen ?? (ctx.ciSeam ??= realCiSeam(ctx));

/** Per-head bookkeeping: checks already rerun, the first failure of each (test name, signature) and the flakes already filed. */
const headRec = (state, head) => ((state.ciGreen ??= { heads: {}, flakes: [] }).heads[head] ??= { reran: [], firstFail: {}, filed: [] });

/**
 * Wait until every required check of `pr`'s head is green. @returns
 * `{ok: true, head, flakes}` | `{red: true, head, failing}` (still red after its one rerun) | `{blocked: true, reason}` (timed out).
 */
async function waitGreen(ctx, pr, seam) {
  const { state } = ctx;
  const deadline = seam.now() + (ctx.config?.ciGreen?.maxWaitMin ?? CI_GREEN_MAX_WAIT_MIN) * 60_000;
  for (;;) {
    const head = await seam.headOf(pr);
    const [checks, required] = [await seam.checks({ pr, head }), await seam.required()];
    const st = ciState(checks, required);
    const rec = headRec(state, head);
    if (st.green) {
      const flakes = [];
      for (const [check, ff] of Object.entries(rec.firstFail)) {
        if (rec.filed.includes(check)) continue;
        const issue = await seam.fileFlake({ check, test: ff.test, signature: ff.signature, tail: ff.tail, sha: head, pr });
        rec.filed.push(check);
        state.ciGreen.flakes.push({ check, test: ff.test ?? null, issue: issue ?? null, sha: head });
        flakes.push({ check, test: ff.test ?? null, issue: issue ?? null });
      }
      if (flakes.length) ctx.io.print?.(`release: ci-green: ${flakes.map((f) => `${f.check} (passed on rerun${f.issue ? `, flaky-test #${f.issue}` : ""})`).join("; ")}`);
      ctx.save?.();
      return { ok: true, head, flakes };
    }
    if (st.pending.length) {
      if (seam.now() >= deadline) return { blocked: true, reason: `required checks of #${pr} still pending after ${ctx.config?.ciGreen?.maxWaitMin ?? CI_GREEN_MAX_WAIT_MIN} min (${st.pending.join(", ")}); re-run the release once CI finishes` };
      await seam.sleep(CI_GREEN_POLL_MS);
      continue;
    }
    const fresh = st.failing.filter((n) => !rec.reran.includes(n));
    if (!fresh.length) return { red: true, head, failing: st.failing };
    // First failure of these checks: one rerun of each failed run, never past the attempt cap. A status context has no run: it stays red.
    const ids = new Map();
    for (const name of fresh) {
      rec.reran.push(name);
      const row = checks.find((k) => k.name === name && (k.bucket === "fail" || k.bucket === "cancel"));
      const id = runIdOf(row?.link);
      if (!id) continue;
      if (row.bucket === "fail") {
        const log = await seam.failedLog(id);
        rec.firstFail[name] = { test: flakyTestName(log), signature: classifyFailure(log).signature ?? null, tail: log.slice(-1200) };
      }
      ids.set(id, name);
    }
    ctx.save?.();
    let reran = 0;
    for (const id of ids.keys()) {
      if (!attemptGuard({ attempt: await seam.runAttempt(id) }).allow) continue;
      await seam.rerunFailed(id);
      reran++;
    }
    if (!reran) return { red: true, head, failing: st.failing };
    ctx.io.print?.(`release: ci-green: rerunning ${[...ids.values()].join(", ")} once`);
    await seam.sleep(CI_GREEN_POLL_MS);
  }
}

/**
 * Wait for CI green on `pr`; on a real red run the fix path once (unless `noFix`) and wait again. Time spent is added to `ci_green_min`.
 * @returns `{ok, head}` | `{red, failing}` (only with `noFix` or after the fix round) | `{blocked, reason}`
 */
export async function ciGreenWait(ctx, pr, { noFix = false } = {}) {
  const seam = ciSeamOf(ctx);
  const t0 = Date.now();
  try {
    for (;;) {
      const w = await waitGreen(ctx, pr, seam);
      if (!w.red || noFix) return w;
      if (Object.values(ctx.state.fixloop?.heads ?? {}).some((h) => !h.second)) return { blocked: true, reason: `required checks of #${pr} are red again after the fix round (${w.failing.join(", ")}); the one fix round is spent` };
      const { fixRound, seamOf } = await import("./release-review.mjs");
      const f = await fixRound(ctx, seamOf(ctx), { pr, head: w.head, blocking: [], items: [], guards: [], ciFailing: w.failing.length });
      if (f.blocked) return f;
    }
  } finally { addTiming(ctx, "ci_green_min", Date.now() - t0); }
}

/** The `ci-green` release step. A draft release PR (host preflight mode) has no Actions CI yet, so it is recorded as skipped there. */
export async function ciGreenStep(ctx) {
  const pr = ctx.state?.steps?.["release-pr"]?.result?.pr;
  if (!pr) return { blocked: true, reason: "no release PR recorded by the release-pr step" };
  const seam = ciSeamOf(ctx);
  if (await seam.isDraft?.(pr)) return { green: false, skipped: "draft PR: CI starts at mark-ready, host preflight runs first" };
  const w = await ciGreenWait(ctx, pr);
  if (w.blocked) return w;
  if (w.red) return { blocked: true, reason: `required checks of #${pr} are red: ${w.failing.join(", ")}` };
  return { green: true, head: w.head, flakes: w.flakes, minutes: ctx.state.timing?.ci_green_min ?? 0 };
}
