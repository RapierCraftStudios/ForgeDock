// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * e2e merge gate (#4403): a lane that adds or changes e2e specs, or whose contract has `[type:e2e]` criteria, triggers
 * the repo's e2e run (a PR label or a workflow dispatch) and waits on it before merge. Tiered CI skips e2e on lane PRs,
 * so the required checks alone never run those specs. All GitHub effects go through the injected io.
 */
import { ciPollDelayMs } from "../engine.mjs";
import { matchesGlob, verifiableFiles, skipsCi, runCiVerify, collectFailedLogs, VERIFY_CHECK_NAME, DEFAULT_SKIP_PATHS, DEFAULT_GRACE_MS } from "./verify.mjs";

export const E2E_MODES = Object.freeze(["auto", "always", "never"]);
/** Common e2e layouts across ecosystems (Playwright, Cypress, Nest/Jest e2e, plain e2e/ trees). */
export const E2E_DEFAULT_PATHS = Object.freeze(["e2e/**", "**/e2e/**", "*.e2e.*", "*.e2e-spec.*", "cypress/**", "playwright/**"]);
export const NO_TRIGGER = "no e2e_label or e2e_workflow configured";

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const list = (v) => (Array.isArray(v) ? v : str(v) ? str(v).split(",") : null)?.map((x) => String(x).trim()).filter(Boolean) ?? null;

/**
 * forge.yaml `verify:` e2e keys → {mode, label, workflow, pathsInput, checks, paths, blocking}. mode defaults to auto
 * (inert without a label or workflow), blocking to changed (only the lane's own specs block the merge).
 */
export function parseE2e(sec = {}) {
  const s = sec && typeof sec === "object" ? sec : {};
  const mode = E2E_MODES.includes(str(s.e2e)) ? str(s.e2e) : "auto";
  const label = /^[A-Za-z0-9._:/ -]+$/.test(str(s.e2e_label)) ? str(s.e2e_label) : null;
  const workflow = /^[A-Za-z0-9._/-]+$/.test(str(s.e2e_workflow)) ? str(s.e2e_workflow) : null;
  const pathsInput = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(str(s.e2e_paths_input)) ? str(s.e2e_paths_input) : null;
  const checks = list(s.e2e_checks) ?? [];
  const paths = list(s.e2e_paths) ?? [...E2E_DEFAULT_PATHS];
  const blocking = str(s.e2e_blocking) === "all" ? "all" : "changed";
  return { mode, label, workflow, pathsInput, checks, paths, blocking };
}

/** Changed files (minus the engine's hand-off files) that are e2e specs per `cfg.paths`. */
export const e2eSpecs = (files, cfg = parseE2e({})) => verifiableFiles(files).filter((f) => (cfg.paths ?? []).some((g) => matchesGlob(f, g)));
/** True when a contract requirement quote carries a `[type:e2e]` criterion. */
export const contractWantsE2e = (contract) => (Array.isArray(contract?.requirements) ? contract.requirements : []).some((r) => /\[type:e2e\]/i.test(String(r?.quote ?? "")));

/** Whether this lane runs the e2e gate: {run, reason, specs}. */
export function e2eWanted({ cfg, files, contract } = {}) {
  const c = cfg ?? parseE2e({});
  const specs = e2eSpecs(files, c);
  if (c.mode === "never") return { run: false, reason: "verify.e2e: never", specs };
  if (!c.label && !c.workflow) return { run: false, reason: NO_TRIGGER, specs };
  if (c.mode === "always") {
    return skipsCi(files, DEFAULT_SKIP_PATHS) ? { run: false, reason: "docs-only change", specs } : { run: true, reason: "verify.e2e: always", specs };
  }
  if (specs.length) return { run: true, reason: `${specs.length} e2e spec(s) changed`, specs };
  if (contractWantsE2e(contract)) return { run: true, reason: "contract has [type:e2e] criteria", specs };
  return { run: false, reason: "no e2e spec changed and no [type:e2e] criteria", specs };
}

/**
 * The failures attributable to the lane: every failure when it changed no spec; otherwise those whose log names one of
 * its specs (path or basename), plus any whose log is empty (cannot be attributed: fail closed).
 */
export function ownFailures(failures, specs) {
  const fs = failures ?? [];
  if (!specs?.length) return [...fs];
  const needles = [...new Set(specs.flatMap((s) => [String(s), String(s).split("/").at(-1)]))];
  return fs.filter((f) => { const l = String(f?.log ?? ""); return !l.trim() || needles.some((n) => l.includes(n)); });
}

/**
 * One e2e run of `head`: {result: pass|fail|timeout|unavailable, failures, runUrl, runId, detail}. Workflow path:
 * dispatch `cfg.workflow` (runCiVerify). Label path: label the PR, then wait on the head's e2e check runs, where a
 * skipped run (the unlabelled tier) counts as not run.
 */
export async function runE2eGate({ io, pr, branch, head, cfg, specs = [], changedFiles = [], ciMaxMinutes = 360, now = () => Date.now(), sleep, random = Math.random,
  onPoll = async () => {}, exclude = [], graceMs = DEFAULT_GRACE_MS }) {
  const c = cfg ?? parseE2e({});
  if (c.workflow) {
    const v = await runCiVerify({ io, branch, head, changedFiles: specs.length ? specs : changedFiles, verify: { workflow: c.workflow, pathsInput: c.pathsInput, skipPaths: [] },
      ciMaxMinutes, now, sleep, random, onPoll, exclude, graceMs, push: async () => {} });
    if (v.result === "skipped") return { ...v, result: "unavailable", detail: "no changed file to run e2e for" };
    return v;
  }
  const unavailable = (detail) => ({ result: "unavailable", failures: [], runUrl: null, detail });
  if (!c.label) return unavailable(NO_TRIGGER);
  if (!io.addPrLabel || !io.commitChecks) return unavailable("no label or commit-checks seam");
  try { await io.addPrLabel(pr, c.label); }
  catch (e) { return unavailable(`label ${c.label} could not be added to PR #${pr}: ${String(e?.stderr ?? e?.message ?? e).split("\n")[0].slice(0, 200)}`); }
  const startedAt = now();
  const isE2e = (x) => (c.checks.length ? c.checks.includes(x?.name) : x?.name !== VERIFY_CHECK_NAME);
  for (let i = 0; ; i++) {
    let checks = [];
    try { checks = ((await io.commitChecks(head)) ?? []).filter(isE2e); } catch { checks = []; }
    const ran = checks.filter((x) => String(x?.conclusion ?? "").toLowerCase() !== "skipped");
    const names = c.checks.length ? c.checks : [...new Set(checks.map((x) => x.name))];
    const byName = names.map((n) => ran.filter((x) => x.name === n));
    if (names.length && byName.every((rs) => rs.length && rs.every((x) => x.state !== "pending"))) {
      const failed = byName.flatMap((rs) => rs.filter((x) => x.state === "failure"));
      if (!failed.length) return { result: "pass", failures: [], runUrl: null, detail: `${names.length} e2e check(s) green` };
      return { result: "fail", failures: await collectFailedLogs(io, failed), runUrl: failed[0].url ?? null, detail: `${failed.length} e2e check(s) failed: ${failed.map((x) => x.name).join(", ")}` };
    }
    if (!ran.length && now() - startedAt >= graceMs) return unavailable(`no e2e check ran for ${String(head).slice(0, 12)} within ${Math.round(graceMs / 60000)} min of labelling PR #${pr} ${c.label}`);
    if (now() - startedAt >= ciMaxMinutes * 60000) return { result: "timeout", failures: [], runUrl: null, detail: `e2e still pending after ${ciMaxMinutes} min` };
    await onPoll();
    await sleep(ciPollDelayMs(i, random));
  }
}
