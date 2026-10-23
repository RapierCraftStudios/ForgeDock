// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Light-lane execution (#4450, parent #4442). An eligible issue (light.mjs, mode on) runs ONE builder session: failing
 * test first, then the fix, then the targeted tests. No plan session, no pre-frozen contract: the contract record is
 * derived afterwards from the diff and the test (deriveLightContract) and checked by the same validateContract as a
 * planned one. The deterministic gates are kept (targeted tests, red/green repro, the API-shape detector of #4449);
 * any upgrade trigger hands the lane to the full plan -> freeze -> implement path, with the light work kept on the
 * branch and carried over as a digest (#4400). runLightStep takes every effect as a callback, so lean.mjs only wires it.
 */
import { classifyPath } from "./routing.mjs";
import { upgradeTriggers } from "./light.mjs";
import { inIssue } from "./conformance.mjs";
import { LEAN_DIR, RESULT_FILE, IMPLEMENTATION_FILE, FORGEDOCK_CLI, hostRules } from "./prompts.mjs";

const UPGRADE_NOTE_MAX = 10;
const DETAIL_MAX = 200;
const one = (s, max = DETAIL_MAX) => {
  const t = String(s ?? "").replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim().replace(/</g, "&lt;");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The one builder session of a light lane: failing test, fix, targeted tests, result.json with what the contract is derived from. */
export function lightBuildPrompt(n, opts = {}) {
  return `Resolve issue #${n} (read it with gh issue view ${n} --comments) in ONE session; this is a light lane for a small, well-specified issue. There is no plan step and no frozen contract: the engine derives the contract from your diff and your test.

${hostRules(opts)}

1. Write the failing regression test first and run it: it must fail on the current code for the reason the issue describes.
2. Make the smallest fix that makes it pass. Keep the public API shape unchanged (signatures, sync/async, generator/function, exported names); the engine checks it.
3. Run the targeted tests (the new test plus the existing tests of the files you changed), run the repo's formatter on the files you changed, and commit. Do not push or touch GitHub.
4. Run \`node ${FORGEDOCK_CLI} check\` in the worktree and fix until it passes.

When done and committed, write ${IMPLEMENTATION_FILE} (markdown, no HTML comments):
### Approach
### Changes   (file: what)
### Verification   (each test command, its result, and whether the new test fails without the fix)

Finally write ${RESULT_FILE}: {"status":"fixed","summary":"one line","requirement":"<one sentence of the issue, verbatim, that this fix delivers>","repro_test":{"path":"<test file>","id":"<test name>","command":"<exact command that runs only that test>"},"tests":[{"command":"<targeted test command>","result":"pass|fail: ...","fails_without_fix":true|false|"unknown"}]}
If the issue is invalid, already fixed, blocked, or bigger than a small fix (more than a couple of files, a design decision), do not grind: write {"status":"upgrade","summary":"<why>"} and stop. The engine then runs the full lane, keeping what you committed.`;
}

/** "-" (binary) and junk count 0. */
const count = (v) => (/^\d+$/.test(String(v ?? "")) ? Number(v) : 0);
/** A numstat path, rename forms resolved to the new path: `a => b`, `dir/{a => b}/f`. */
const newPath = (p) => {
  const s = String(p ?? "").trim();
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(s);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\/+/g, "/");
  const arrow = s.indexOf(" => ");
  return arrow >= 0 ? s.slice(arrow + 4) : s;
};
/** `git diff --numstat` output -> {files:[{path, added, deleted}]} for upgradeTriggers; the engine's own dir is skipped. */
export function parseNumstat(out) {
  const files = [];
  for (const line of String(out ?? "").split("\n")) {
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(line.trim() ? line : "");
    if (!m) continue;
    const path = newPath(m[3]);
    if (!path || path === LEAN_DIR || path.startsWith(`${LEAN_DIR}/`)) continue;
    files.push({ path, added: count(m[1]), deleted: count(m[2]) });
  }
  return { files };
}

/** detectApiShape output (apishape.mjs) -> upgradeTriggers apiShape strings; a missing or unreadable result is `unknown` (#4449). */
export function apiShapeReasons(r) {
  if (!r || typeof r !== "object" || !["none", "changed", "unknown"].includes(r.status)) return ["api shape: no detector result (unknown)"];
  const out = [];
  for (const c of Array.isArray(r.changes) ? r.changes : []) out.push(one(`${c?.file ?? "?"}: ${c?.symbol ?? "?"} ${c?.change ?? "changed"}`));
  for (const u of Array.isArray(r.unknown) ? r.unknown : []) out.push(one(`${u?.file ?? "?"}: unknown${u?.lang ? ` (${u.lang})` : ""}${u?.reason ? `, ${u.reason}` : ""}`));
  if (r.status !== "none" && !out.length) out.push(`api shape: ${r.status}`);
  return out;
}

/**
 * The contract record of a light lane, from the diff and the builder's test (pure). requirement: the builder's verbatim
 * issue sentence, else the issue title; deliverables: the changed non-test files; validate: the repro command plus each
 * targeted test command; repro_test: the builder's, else "none" with a reason. validateContract judges it like any other.
 */
export function deriveLightContract({ title = "", issueText = "", result = null, files = [] } = {}) {
  const r = result && typeof result === "object" ? result : {};
  const said = typeof r.requirement === "string" ? r.requirement.trim() : "";
  const quote = said && inIssue(said, issueText) ? said : String(title ?? "").trim();
  const paths = [...new Set((Array.isArray(files) ? files : []).map((f) => String(f ?? "").trim()).filter((f) => f && f !== LEAN_DIR && !f.startsWith(`${LEAN_DIR}/`)))];
  const code = paths.filter((f) => classifyPath(f) !== "test");
  const t = r.repro_test;
  const repro = t && typeof t === "object" && !Array.isArray(t) && String(t.path ?? "").trim() && String(t.command ?? "").trim()
    ? { path: String(t.path).trim(), id: String(t.id ?? "").trim(), command: String(t.command).trim() } : null;
  const commands = [...new Set([repro?.command, ...(Array.isArray(r.tests) ? r.tests : []).map((x) => (x && typeof x === "object" ? String(x.command ?? "").trim() : ""))].filter(Boolean))];
  return {
    requirements: [{ id: "R1", quote, disposition: "deliver" }],
    deliverables: code.map((path, i) => ({ id: `D${i + 1}`, path, change: "light-lane fix (derived from the diff)", requirements: ["R1"] })),
    validate: commands.map((command, i) => ({ id: `V${i + 1}`, command })),
    ...(repro ? { repro_test: repro } : { repro_test: "none", repro_test_reason: "the light-lane builder named no repro test" }),
  };
}

/** The full lane's prompt addition after an upgrade: why the light lane stopped (bounded, one line per reason). */
export function upgradeNote(reasons) {
  const rs = (Array.isArray(reasons) ? reasons : []).filter((x) => x && x.code);
  if (!rs.length) return "";
  const lines = rs.slice(0, UPGRADE_NOTE_MAX).map((x) => `- ${one(x.code, 40)}: ${one(x.detail)}`);
  if (rs.length > UPGRADE_NOTE_MAX) lines.push(`- … ${rs.length - UPGRADE_NOTE_MAX} more`);
  return `\n\nLight-lane upgrade: a single light builder session already worked on this issue and its commits are on the branch. The engine moved the issue to the full lane because:\n${lines.join("\n")}\nKeep the committed work that fits the issue; plan and fix what these reasons show.`;
}

/**
 * One light lane step. ctx callbacks (all async unless noted): build() runs the one builder session; readResult();
 * checkpoint() commits uncommitted work; changedFiles(); numstat() -> `git diff --numstat` text; runTests(commands) ->
 * [{command, rc, output}] or null (no runner); fixTests(failed) resumes the builder once; reproOf(contract) -> {base, head}
 * or null; apiShape() -> detectApiShape output or null; validate(contract) -> {ok, problems} (sync). Plus title, issueText,
 * riskPaths, cfg. Returns {upgrade:false, contract, files, repro, testFailures} or {upgrade:true, reasons, files, ...}.
 * Never throws: an internal error is the upgrade reason light_error.
 */
export async function runLightStep(ctx) {
  const up = (reasons, extra = {}) => ({ upgrade: true, reasons, contract: null, files: [], repro: null, testFailures: 0, ...extra });
  try {
    await ctx.build();
    const result = await ctx.readResult();
    await ctx.checkpoint();
    const files = await ctx.changedFiles();
    if (!files.length) return up([{ code: "no_commit", detail: `the light builder made no commit (status ${one(result?.status ?? "none", 40)})` }]);
    if (result?.status !== "fixed") return up([{ code: "not_fixed", detail: `light builder status ${one(result?.status ?? "none", 40)}${result?.summary ? `: ${one(result.summary)}` : ""}` }], { files });
    const contract = deriveLightContract({ title: ctx.title, issueText: ctx.issueText, result, files });
    const vc = ctx.validate(contract);
    if (!vc?.ok) return up([{ code: "contract_invalid", detail: `derived contract: ${one((vc?.problems ?? [])[0] ?? "invalid")}` }], { files });

    let testFailures = 0;
    const commands = contract.validate.map((v) => v.command);
    let runs = await ctx.runTests(commands);
    let failed = (runs ?? []).filter((x) => x?.rc !== 0);
    if (failed.length) {
      testFailures = 1;
      await ctx.fixTests(failed);
      runs = await ctx.runTests(commands);
      failed = (runs ?? []).filter((x) => x?.rc !== 0);
      if (failed.length) testFailures = 2;
    }
    const now = await ctx.changedFiles();
    const repro = await ctx.reproOf(contract);
    const diff = parseNumstat(await ctx.numstat());
    const apiShape = apiShapeReasons(await ctx.apiShape());
    const t = upgradeTriggers({ diff, repro, testFailures, riskPaths: ctx.riskPaths ?? [], apiShape, cfg: ctx.cfg ?? {} });
    const latest = deriveLightContract({ title: ctx.title, issueText: ctx.issueText, result: (await ctx.readResult()) ?? result, files: now });
    return { upgrade: t.upgrade, reasons: t.reasons, contract: t.upgrade ? null : (ctx.validate(latest)?.ok ? latest : contract), files: now, repro, testFailures };
  } catch (e) {
    return up([{ code: "light_error", detail: one(e?.message ?? e) }]);
  }
}
