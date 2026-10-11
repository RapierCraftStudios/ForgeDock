// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// remediate.md M0 liveness step: a dead run's partial markers must not be read as a live run, and a
// deferral to a genuinely live run must not burn the engine's retry budget or add needs-human.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES, remediationLeaseLive } from "../engine/phases.mjs";
import { trusted, jsonLines } from "./helpers/comments.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const spec = readFileSync(join(ROOT, "commands/work-on/remediate.md"), "utf8");
const router = readFileSync(join(ROOT, "commands/work-on.md"), "utf8");
const remediate = PHASES.find((p) => p.id === "remediate");
const base = { v: 0, run: "r1", issue: 42, lane: "staging", committed: ["review"], phase: null, branch: null, pr: 7,
  terminal: false, terminalReason: "needs-human", lease: null };

const deferredBody = (by, until) =>
  `<!-- FORGE:REMEDIATION_DEFERRED -->\n## Remediation Deferred\n\npr=7\nlease_by=${by}\nlease_until=${until}\nreview_pending=false`;
const ioWith = (...cs) => ({
  gh: async (a) => (a[0] === "pr" && a[1] === "view" ? JSON.stringify({ state: "OPEN" }) : jsonLines(cs.map((c) => (typeof c === "string" ? trusted(c) : c)))),
  git: async () => "0",
});

describe("remediate.md M0 liveness spec", () => {
  it("reads the FORGE:STATE lease and compares against the dispatching holder", () => {
    assert.match(spec, /lease\.until > now/);
    assert.match(spec, /--lease-holder/);
    assert.match(spec, /\$l\.by != \$h/);
  });
  it("defers with deferred-live-run, posts a deferral record, and adds no needs-human", () => {
    assert.match(spec, /deferred-live-run/);
    assert.match(spec, /<!-- FORGE:REMEDIATION_DEFERRED -->/);
    assert.match(spec, /except a `deferred-live-run:` exit/);
    const defer = spec.slice(spec.indexOf("**Defer** (`DEFER=true`)"), spec.indexOf("**Dead** (`DEFER=false`)"));
    assert.match(defer, /Delete no comment, push nothing, add no `needs-human`/);
  });
  it("liveness runs before the partial-comment deletion and the COMPLETE guard is intact", () => {
    assert.ok(spec.indexOf("**Liveness step") < spec.indexOf("for _id in $PARTIAL_PR_COMMENT_IDS"));
    assert.match(spec, /If `REMEDIATION_COMPLETE_N` is at least 1[^\n]*EXIT `REMEDIATE_RESULT: status: ALREADY_DONE`/);
    assert.match(spec, /Single-attempt semantics/);
  });
  it("fails closed on an unreadable lease or reviewer list", () => {
    assert.match(spec, /github-unavailable: FORGE:STATE block unparseable/);
    assert.match(spec, /github-unavailable: reviewer comments unreadable/);
  });
  it("concurrent-run guard: the defer exit precedes M1, so a deferred run never pushes", () => {
    assert.ok(spec.indexOf("**Defer** (`DEFER=true`)") < spec.indexOf("## Phase M1"));
    assert.match(spec, /two live remediations on one PR can never both push/);
  });
  it("router: deferred-live-run row precedes the generic BLOCKED row and adds no needs-human", () => {
    const i = router.indexOf("blocker starts with `deferred-live-run:`");
    assert.ok(i > 0 && i < router.indexOf("| `status: BLOCKED` (any kind)"));
    assert.match(router.slice(i, i + 600), /do NOT add `needs-human`/);
  });
});

describe("remediationLeaseLive", () => {
  const now = 1_000_000;
  it("live: unexpired lease held by another holder", () => assert.equal(remediationLeaseLive({ by: "cli_a_1", until: now + 5 }, "cli_b_2", now), true));
  it("own holder is never another live run", () => assert.equal(remediationLeaseLive({ by: "cli_b_2", until: now + 5 }, "cli_b_2", now), false));
  it("expired lease is dead", () => assert.equal(remediationLeaseLive({ by: "cli_a_1", until: now - 1 }, "cli_b_2", now), false));
  it("absent or malformed lease is dead", () => {
    assert.equal(remediationLeaseLive(null, "x", now), false);
    assert.equal(remediationLeaseLive({ by: "a" }, "x", now), false);
    assert.equal(remediationLeaseLive({ until: now + 5 }, "x", now), false);
  });
});

describe("remediate.detectOutcome deferral", () => {
  it("live lease deferral -> non-failing blocked/deferred, not retried", async () => {
    const o = await remediate.detectOutcome(base, ioWith(deferredBody("cli_other_9", Date.now() + 600_000)));
    assert.equal(o.status, "blocked");
    assert.equal(o.reason, "deferred");
    assert.equal(o.retryable, false);
  });
  it("expired lease deferral -> normal failed attempt", async () => {
    const o = await remediate.detectOutcome(base, ioWith(deferredBody("cli_other_9", Date.now() - 1000)));
    assert.equal(o.status, "failed");
  });
  it("record with no lease (none/0) -> normal failed attempt", async () => {
    const o = await remediate.detectOutcome(base, ioWith(deferredBody("none", 0)));
    assert.equal(o.status, "failed");
  });
  it("untrusted or quoted deferral never defers", async () => {
    const untrusted = { body: deferredBody("cli_o_1", Date.now() + 600_000), author_association: "NONE", user: { type: "User", login: "mallory" } };
    assert.equal((await remediate.detectOutcome(base, ioWith(untrusted))).status, "failed");
    assert.equal((await remediate.detectOutcome(base, ioWith(`Quoted:\n${deferredBody("cli_o_1", Date.now() + 600_000)}`))).status, "failed");
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
