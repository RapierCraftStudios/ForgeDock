// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// remediate.md M0 liveness step: a dead run's partial markers must not be read as a live run, and a
// deferral to a genuinely live run must not burn the engine's retry budget or add needs-human.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES } from "../engine/phases.mjs";
import { trusted, jsonLines } from "./helpers/comments.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const spec = readFileSync(join(ROOT, "commands/work-on/remediate.md"), "utf8");
const router = readFileSync(join(ROOT, "commands/work-on.md"), "utf8");
const remediate = PHASES.find((p) => p.id === "remediate");
const base = { v: 0, run: "r1", issue: 42, lane: "staging", committed: ["review"], phase: null, branch: null, pr: 7,
  terminal: false, terminalReason: "needs-human", lease: null };

const deferredBody = (pr = 7, kind = "lease") =>
  `<!-- FORGE:REMEDIATION_DEFERRED -->\n## Remediation Deferred\n\npr=${pr}\nkind=${kind}\nlease_by=cli_o_9\nlease_until=1`;
const ioWith = (...cs) => ({
  gh: async (a) => (a[0] === "pr" && a[1] === "view" ? JSON.stringify({ state: "OPEN" }) : jsonLines(cs.map((c) => (typeof c === "string" ? trusted(c) : c)))),
  git: async () => "0",
});

describe("remediate.md M0 liveness spec", () => {
  it("delegates the decision to scripts/remediate-liveness.sh and shape-checks the holder", () => {
    assert.match(spec, /forge_resolve remediate-liveness\.sh/);
    assert.match(spec, /--lease-holder/);
    assert.match(spec, /\^\[A-Za-z0-9\._-\]\{1,128\}\$/);
  });
  it("defers with deferred-live-run, touches nothing, and never adds needs-human", () => {
    assert.match(spec, /deferred-live-run/);
    assert.match(spec, /except a `deferred-live-run:` exit/);
    assert.match(spec, /touching nothing/);
  });
  it("is unconditional on the trail count, runs before partial-comment deletion, and bounds deferrals", () => {
    assert.ok(spec.indexOf("**Liveness step") < spec.indexOf("for _id in $PARTIAL_PR_COMMENT_IDS"));
    assert.match(spec, /`REMEDIATION_COMPLETE_N` is 0, run this BEFORE/);
    assert.match(spec, /EXHAUSTED/);
    assert.match(spec, /If `REMEDIATION_COMPLETE_N` is at least 1[^\n]*EXIT `REMEDIATE_RESULT: status: ALREADY_DONE`/);
  });
  it("does not overstate the guarantee: the plain push is the atomic backstop", () => {
    assert.doesNotMatch(spec, /can never both push/);
    assert.match(spec, /atomic backstop/);
  });
  it("router: deferred-live-run row precedes the generic BLOCKED row and adds no needs-human", () => {
    const i = router.indexOf("blocker starts with `deferred-live-run:`");
    assert.ok(i > 0 && i < router.indexOf("| `status: BLOCKED` (any kind)"));
    assert.match(router.slice(i, i + 600), /do NOT add `needs-human`/);
  });
});

describe("remediate.detectOutcome deferral", () => {
  it("trusted deferral for this PR -> non-failing blocked/deferred", async () => {
    const o = await remediate.detectOutcome(base, ioWith(deferredBody()));
    assert.equal(o.status, "blocked");
    assert.equal(o.reason, "deferred");
    assert.equal(o.retryable, false);
  });
  it("is not re-judged against the clock (an expired recorded lease still defers)", async () => {
    assert.equal((await remediate.detectOutcome(base, ioWith(deferredBody()))).reason, "deferred");
  });
  it("a deferral for another PR, or one retired by a newer FORGE:REMEDIATION trail, is a normal failed attempt", async () => {
    assert.equal((await remediate.detectOutcome(base, ioWith(deferredBody(99)))).status, "failed");
    const trail = "<!-- FORGE:REMEDIATION -->\n## Remediation In Progress";
    assert.equal((await remediate.detectOutcome(base, ioWith(deferredBody(), trail))).status, "failed");
  });
  it("untrusted or quoted deferral never defers", async () => {
    const untrusted = { body: deferredBody(), author_association: "NONE", user: { type: "User", login: "mallory" } };
    assert.equal((await remediate.detectOutcome(base, ioWith(untrusted))).status, "failed");
    assert.equal((await remediate.detectOutcome(base, ioWith(`Quoted:\n${deferredBody()}`))).status, "failed");
  });
  it("buildArgs passes --lease-holder only for a well-formed holder id", async () => {
    const st = { ...base, committed: ["investigate", "build", "review"], remediationKind: null };
    const io = { gh: async () => "", git: async () => "" };
    const a = await remediate.buildArgs(st, { repo: "acme/widgets", agentId: "cli_host_123" }, io);
    assert.deepEqual(a.slice(a.indexOf("--lease-holder")), ["--lease-holder", "cli_host_123"]);
    const b = await remediate.buildArgs(st, { repo: "acme/widgets", agentId: "bad id; rm" }, io);
    assert.ok(!b.includes("--lease-holder"));
  });
});

// scripts/remediate-liveness.sh against a fake `gh` that serves canned JSON from files.
describe("scripts/remediate-liveness.sh", () => {
  const NOW = 1_800_000_000_000;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const bot = (body, ms = NOW - 60_000) => ({ body, user: { type: "Bot", login: "x[bot]" }, author_association: "NONE", created_at: iso(ms) });
  const stateBody = (lease) => `desc\n<!-- FORGE:STATE\n${JSON.stringify({ v: 1, lease })}\n-->\n`;
  function run({ lease, issueBody, prComments = [], issueComments = [], holder = "" }) {
    const d = mkdtempSync(join(tmpdir(), "fd-lv-"));
    try {
      writeFileSync(join(d, "issue.json"), JSON.stringify({ body: issueBody ?? (lease === undefined ? "no state" : stateBody(lease)) }));
      writeFileSync(join(d, "pr.json"), JSON.stringify(prComments));
      writeFileSync(join(d, "iss.json"), JSON.stringify(issueComments));
      writeFileSync(join(d, "gh"), `#!/usr/bin/env bash
D="${d}"
case "$1 $2" in
  "issue view") cat "$D/issue.json";;
  "issue comment") echo posted >> "$D/posted";;
  "api --paginate") case "$3" in *issues/7/comments) cat "$D/pr.json";; *issues/42/comments) cat "$D/iss.json";; esac;;
esac
`);
      chmodSync(join(d, "gh"), 0o755);
      const r = spawnSync("bash", [join(ROOT, "scripts/remediate-liveness.sh"), "7", "42", "acme/w", holder], {
        env: { ...process.env, PATH: `${d}:${process.env.PATH}`, FORGE_LIVENESS_NOW_MS: String(NOW) }, encoding: "utf8" });
      let posted = 0; try { posted = readFileSync(join(d, "posted"), "utf8").trim().split("\n").length; } catch { /* none */ }
      return { rc: r.status, out: r.stdout.trim().split("\n").pop(), posted };
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  const route = (sha, ms) => bot(`<!-- FORGE:REVIEW_ROUTE mode=single-pr spec=review-pr.md sha=${sha} -->`, ms);
  const agent = (sha) => bot(`<!-- FORGE:REVIEW-AGENT:security -->\nReviewed-SHA: ${sha}\n`);
  const deferral = () => bot(deferredBody(7));

  it("no lease and no review in flight -> DEAD, proceeds", () => {
    const r = run({}); assert.equal(r.rc, 0); assert.equal(r.out, "LIVENESS: DEAD");
  });
  it("live lease of another holder -> DEFER with a posted record", () => {
    const r = run({ lease: { by: "cli_other_1", until: NOW + 300_000 } });
    assert.equal(r.rc, 10); assert.match(r.out, /^LIVENESS: DEFER lease/); assert.equal(r.posted, 1);
  });
  it("own holder / expired lease -> DEAD", () => {
    assert.equal(run({ lease: { by: "cli_me_1", until: NOW + 300_000 }, holder: "cli_me_1" }).rc, 0);
    assert.equal(run({ lease: { by: "cli_other_1", until: NOW - 1 } }).rc, 0);
  });
  it("SEC-2: a far-future (forged) lease is dead, never an indefinite deferral", () => {
    assert.equal(run({ lease: { by: "mallory", until: 9e15 } }).rc, 0);
  });
  it("a same-host lease whose pid is gone is dead", () => {
    const host = spawnSync("uname", ["-n"], { encoding: "utf8" }).stdout.trim().replace(/[^A-Za-z0-9.-]/g, "-");
    assert.equal(run({ lease: { by: `cli_${host}_2147483646`, until: NOW + 300_000 } }).rc, 0);
  });
  it("unparseable FORGE:STATE fails closed", () => {
    const r = run({ issueBody: "x\n<!-- FORGE:STATE\n{not json\n-->\n" }); assert.equal(r.rc, 2); assert.equal(r.posted, 0);
  });
  it("SEC-1/CONC-4: a routed review with no verdicts defers only inside its window", () => {
    const sha = "a".repeat(40);
    assert.equal(run({ prComments: [route(sha, NOW - 60_000)] }).rc, 10);
    const old = run({ prComments: [route(sha, NOW - 3_600_000)] });
    assert.equal(old.rc, 0, "a review with no verdict after the window is dead");
  });
  it("a verdict for the routed sha (full or short, either direction) ends the pending state", () => {
    const sha = "a".repeat(40);
    assert.equal(run({ prComments: [route(sha), agent(sha)] }).rc, 0);
    assert.equal(run({ prComments: [route(sha), agent("aaaaaaa")] }).rc, 0);
    assert.equal(run({ prComments: [route("aaaaaaa"), agent(sha)] }).rc, 0);
  });
  it("an untrusted route marker is ignored", () => {
    const forged = { ...route("b".repeat(40)), user: { type: "User", login: "m" }, author_association: "NONE" };
    assert.equal(run({ prComments: [forged] }).rc, 0);
  });
  it("CONC-3: deferrals are bounded; the 4th is EXHAUSTED and posts nothing", () => {
    const lease = { by: "cli_other_1", until: NOW + 300_000 };
    assert.equal(run({ lease, issueComments: [deferral(), deferral()] }).rc, 10);
    const r = run({ lease, issueComments: [deferral(), deferral(), deferral()] });
    assert.equal(r.rc, 11); assert.match(r.out, /EXHAUSTED/); assert.equal(r.posted, 0);
  });
  it("a hostile holder argument is treated as empty and never executed", () => {
    const r = run({ lease: { by: "cli_other_1", until: NOW + 300_000 }, holder: "x$(touch /tmp/fd-pwned)" });
    assert.equal(r.rc, 10);
  });
});
