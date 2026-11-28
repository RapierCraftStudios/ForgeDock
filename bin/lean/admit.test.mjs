// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { failingRequired, baseHealth, baseRedComment, hasAdmitComment, classifyDryRun, renderStamp, stampable, isNonStoppable, NON_STOPPABLE_CODES, REPEAT_COUNTED_CODES, repeatCounted, inputOf, fingerprintStop, admitEvent, fetchBaseChecks } from "./admit.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";

const run = (name, conclusion, extra = {}) => ({ name, conclusion, url: `https://x/${name}`, completed_at: "2026-11-28T10:00:00Z", ...extra });

test("failingRequired: only required, latest per name, red conclusions", () => {
  const rows = [run("lint", "failure"), run("lint", "success", { completed_at: "2026-11-28T11:00:00Z" }), run("e2e", "failure"), run("docs", "failure"), run("unit", "success")];
  assert.deepEqual(failingRequired({ checks: rows, required: ["lint", "e2e", "unit"] }).map((f) => f.name), ["e2e"]);
  assert.deepEqual(failingRequired({ checks: rows, required: [] }), []); // no known required set: fail open
  assert.deepEqual(failingRequired({ checks: [run("e2e", "cancelled"), run("e2e2", "in_progress")], required: ["e2e", "e2e2"] }), []);
});

test("baseHealth: a failure the issue names is not a foreign red", () => {
  const rows = [run("e2e", "failure", { summary: "FAIL test/api/users.test.mjs" })];
  assert.equal(baseHealth({ checks: rows, required: ["e2e"], issueText: "Fix a typo in the README" }).red, true);
  assert.equal(baseHealth({ checks: rows, required: ["e2e"], issueText: "users.test.mjs is flaky: test/api/users.test.mjs" }).red, false);
  assert.equal(baseHealth({ checks: rows, required: ["e2e"], issueText: "the e2e check is red" }).red, false);
});

test("baseRedComment carries the links and a key the probe dedupes on", () => {
  const f = [{ name: "e2e", conclusion: "failure", url: "https://x/e2e", summary: "boom" }];
  const body = baseRedComment({ base: "origin/staging", sha: "abcdef1234567890", failing: f });
  assert.match(body, /https:\/\/x\/e2e/);
  assert.ok(hasAdmitComment([{ body }], "base.red origin/staging@abcdef123456"));
  assert.ok(!hasAdmitComment([{ body }], "base.red origin/staging@000000000000"));
});

test("fetchBaseChecks parses check runs and tolerates missing statuses", async () => {
  const gh = async (a) => { if (a.includes("--paginate")) return `${JSON.stringify(run("e2e", "failure"))}\n`; throw new Error("404"); };
  assert.equal((await fetchBaseChecks({ gh, repo: "o/r", sha: "abc" })).length, 1);
});

test("classifyDryRun: docker deferred to CI, owned tools ignored, other tools stop the lane", () => {
  const misses = [{ ids: ["V1"], tool: "docker", kind: "command" }, { ids: ["V2"], tool: "ffmpeg", kind: "command" }, { ids: ["V3"], tool: "pytest", kind: "command" }, { ids: ["V4"], tool: "x", kind: "python-module" }];
  const r = classifyDryRun({ misses, owned: (t) => t === "pytest" });
  assert.deepEqual(r, { docker: ["V1"], tools: ["ffmpeg"], ids: ["V2"] });
});

const stamped = (code, base, input, extra = "") => ({ body: `<!-- FORGE:NEEDS_HUMAN -->\n## Needs human\nx\n\nsig=0123456789ab ${renderStamp({ base, input, code })}${extra}`, __mine: true });

test("fingerprintStop: same base head and input stops; a moved base or changed input admits", () => {
  const input = "a".repeat(16), base = "b".repeat(40);
  const c = [stamped("ci.red", base, input)];
  assert.equal(fingerprintStop({ comments: c, base, input })?.code, "ci.red");
  assert.equal(fingerprintStop({ comments: c, base: "c".repeat(40), input }), null);
  assert.equal(fingerprintStop({ comments: c, base, input: "d".repeat(16) }), null);
});

test("fingerprintStop: engine-owned env codes, a FORGE:DECISION and unstamped parks never stop", () => {
  const input = "a".repeat(16), base = "b".repeat(40);
  assert.equal(fingerprintStop({ comments: [stamped(OUTCOME_CODES.ENV_TOOL_MISSING, base, input)], base, input }), null);
  assert.ok(!stampable(OUTCOME_CODES.ENV_TOOL_MISSING) && !stampable(OUTCOME_CODES.BASE_RED) && stampable("ci.red"));
  const decision = { body: "<!-- FORGE:DECISION -->\nretry with the e2e deferred", __mine: true };
  assert.equal(fingerprintStop({ comments: [stamped("ci.red", base, input), decision], base, input }), null);
  const unstamped = { body: "<!-- FORGE:NEEDS_HUMAN -->\nold\n\nsig=0123456789ab", __mine: true };
  assert.equal(fingerprintStop({ comments: [stamped("ci.red", base, input), unstamped], base, input })?.code, "ci.red"); // a later unstamped park leaves the stamp standing
  assert.equal(fingerprintStop({ comments: [unstamped], base, input }), null);
});

test("fingerprintStop honours trust", () => {
  const input = "a".repeat(16), base = "b".repeat(40);
  assert.equal(fingerprintStop({ comments: [stamped("ci.red", base, input)], base, input, trusted: () => false }), null);
});

test("inputOf ignores labels, follows title/body/decisions/contract", () => {
  const a = inputOf({ iss: { title: "t", body: "b" }, comments: [] });
  assert.equal(a, inputOf({ iss: { title: "t", body: "b", labels: ["x"] }, comments: [] }));
  assert.notEqual(a, inputOf({ iss: { title: "t", body: "b2" }, comments: [] }));
  assert.notEqual(a, inputOf({ iss: { title: "t", body: "b" }, comments: [{ body: "<!-- FORGE:DECISION -->\nd" }] }));
});

test("admitEvent always records zero builder spend", () => {
  assert.equal(admitEvent({ outcome: "base_red", code: "base.red" }).builder_spend_usd, 0);
});

// #6231: one non-stoppable list for the stamp writer, the stop reader and lean.mjs.
test("transient and infrastructure codes are never stamped and never stop admission (#6231)", () => {
  const input = "a".repeat(16), base = "b".repeat(40);
  for (const code of ["engine.error", "sandbox.transient", "sandbox.lost", "sandbox.auth", "backend.auth", "env.setup_failed", "gh.unavailable", "net.transient", "lane.mismatch", "lease.held", "rate_limited", "base.red"]) {
    assert.ok(isNonStoppable(code), code);
    assert.ok(!stampable(code), code);
    assert.equal(fingerprintStop({ comments: [stamped(code, base, input)], base, input }), null, code); // an old stamp of such a code (written by an earlier engine) never stops either
  }
  assert.ok(NON_STOPPABLE_CODES.has("engine.error"));
  for (const code of ["ci.red", "review.failed", "build.acceptance_failed"]) assert.ok(stampable(code) && !isNonStoppable(code), code);
});

// #6243: deterministic crash/timeout codes stay unstamped but their identical repeats still count toward the summary park.
test("REPEAT_COUNTED_CODES stay non-stampable yet count as repeats (#6243)", () => {
  assert.ok(REPEAT_COUNTED_CODES.size >= 5);
  for (const code of REPEAT_COUNTED_CODES) { assert.ok(isNonStoppable(code) && !stampable(code), code); assert.ok(repeatCounted(code), code); }
  for (const code of ["engine.error", "cli.timeout", "cli.idle", "backend.cli_failed", "run.interrupted"]) assert.ok(repeatCounted(code), code);
  for (const code of ["rate_limited", "quota.exhausted", "net.transient", "gh.unavailable", "lease.held", "host.busy", "base.red"]) assert.ok(!repeatCounted(code), code);
});

// #6232: whole-token check names, contract/deliverable files, label or link.
const redRow = [{ name: "test", conclusion: "failure", summary: "FAIL bin/lean/foo.test.mjs\n at bin/lean/foo.mjs:3" }];
const req = ["test"];
test("base.red: a check name matches as a whole token, not a substring (#6232)", () => {
  assert.equal(baseHealth({ checks: redRow, required: req, issueText: "handle the latest contest of attestation" }).red, true);
  assert.equal(baseHealth({ checks: redRow, required: req, issueText: "the test check is red" }).red, false);
});
test("base.red: an issue whose frozen contract touches the failing files, or is labelled or linked as the fix, is admitted (#6232)", () => {
  const issue = (x) => ({ text: "refactor the planner", ...x });
  assert.equal(baseHealth({ checks: redRow, required: req, issue: issue({}) }).red, true); // a bystander is still deferred
  assert.equal(baseHealth({ checks: redRow, required: req, issue: issue({ contractText: JSON.stringify({ deliverables: ["bin/lean/foo.mjs"] }) }) }).red, false);
  assert.equal(baseHealth({ checks: redRow, required: req, issue: issue({ contractText: JSON.stringify({ files: ["bin/lean/other.mjs"] }) }) }).red, false); // same directory: the check's scope
  assert.equal(baseHealth({ checks: redRow, required: req, issue: issue({ contractText: JSON.stringify({ files: ["docs/readme.md"] }) }) }).red, true);
  assert.equal(baseHealth({ checks: redRow, required: req, issue: issue({ labels: [{ name: "base-red" }] }) }).red, false);
  assert.equal(baseHealth({ checks: redRow, required: req, issue: issue({ linkedBaseRed: true }) }).red, false);
});

// #6233: only the documented logged-out signal is a login failure; anything else unknown fails open with a warning.
import { classifyAuthStatus } from "./effects.mjs";
test("classifyAuthStatus: logged-out is ok:false, success ok:true, other non-zero or no run is unknown (#6233)", () => {
  assert.equal(classifyAuthStatus({ status: 0, out: '{"loggedIn": true}' }).ok, true);
  assert.equal(classifyAuthStatus({ status: 1, out: '{"loggedIn": false}' }).ok, false);
  assert.equal(classifyAuthStatus({ status: 1, out: "Not logged in. Run claude login" }).ok, false);
  const other = classifyAuthStatus({ status: 2, out: "unexpected flag" });
  assert.equal(other.ok, null); assert.match(other.warning, /exited 2/);
  assert.equal(classifyAuthStatus({ status: 1, out: "ECONNREFUSED proxy" }).ok, null); // a non-logged-out failure is not backend.auth
  assert.equal(classifyAuthStatus({ error: Object.assign(new Error("x"), { code: "ENOENT" }), status: null }).ok, null);
  assert.equal(classifyAuthStatus({ status: null }).ok, null);
});
