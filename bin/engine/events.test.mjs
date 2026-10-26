// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract test for the outbound event stream (#4630, docs/EVENTS.md): changing a type, key or the signature is a breaking change.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { EVENT_TYPES, EVENT_VERSION, buildEvent, mapRunRecord, makeEventEmitter, probeEvent, regressionEvent, experimentEvent, promotedEvent, sign, webhookUrlOk, postWebhook } from "./events.mjs";

const tmp = () => tmpDir("forge-events-");
const fixed = () => new Date("2026-10-26T12:00:00Z");
const lines = (dir) => readFileSync(join(dir, "o_r.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("event contract (v1)", () => {
  it("documents exactly the named lifecycle types", () => {
    assert.deepEqual(Object.keys(EVENT_TYPES), ["lane.picked_up", "contract.frozen", "pr.opened", "pr.merged", "release.promoted", "probe.passed", "probe.failed", "regression.detected", "experiment.verdict"]);
  });

  it("every envelope has the same top-level keys and only documented data keys", () => {
    for (const [type, keys] of Object.entries(EVENT_TYPES)) {
      const data = Object.fromEntries(keys.map((k) => [k, "x"]));
      const e = buildEvent(type, { ...data, secret: "no" }, { repo: "o/r", issue: 3, pr: 4, run: "core_3_1", cost_usd: 1.23456789, wall_ms: 10.4 }, fixed());
      assert.deepEqual(Object.keys(e), ["schema", "v", "id", "type", "ts", "repo", "issue", "pr", "run", "cost_usd", "wall_ms", "data"]);
      assert.equal(e.schema, "forgedock.event"); assert.equal(e.v, EVENT_VERSION); assert.equal(e.ts, "2026-10-26T12:00:00Z");
      assert.equal(e.cost_usd, 1.234568); assert.equal(e.wall_ms, 10);
      assert.deepEqual(Object.keys(e.data), keys);
    }
    assert.equal(buildEvent("nope", {}, {}, fixed()), null);
  });

  it("maps run-log records and sums attempt cost onto pr.merged", async () => {
    const dir = tmp();
    const { emit } = makeEventEmitter({ repo: "o/r", config: { dir }, env: {}, now: fixed });
    await emit({ event: "RUN_START", run: "core_9_5", issue: 9, lane: "staging", path: "core" });
    await emit({ event: "CONTRACT_FROZEN", issue: 9, hash: "abc", requirements: 2, deferred: 1 });
    await emit({ event: "PHASE_ATTEMPT_USAGE", issue: 9, cost_usd: 5, cost_usd_delta: 0.5 });
    await emit({ event: "PHASE_ATTEMPT_USAGE", issue: 9, cost_usd: 0.25 });
    await emit({ event: "PR_OPENED", issue: 9, pr: 40 });
    await emit({ event: "RUN_TERMINAL", issue: 9, reason: "needs-human", wall_ms: 1 });
    await emit({ event: "RUN_TERMINAL", issue: 9, reason: "merged", pr: 40, wall_ms: 90000, code: "ok", milestone: "m1" });
    const got = lines(dir);
    assert.deepEqual(got.map((e) => e.type), ["lane.picked_up", "contract.frozen", "pr.opened", "pr.merged"]);
    assert.deepEqual(got[0].data, { lane: "staging", path: "core" });
    assert.equal(got[0].run, "core_9_5"); assert.equal(got[3].run, "core_9_5");
    assert.deepEqual(got[1].data, { hash: "abc", requirements: 2, deferred: 1 });
    assert.equal(got[2].pr, 40);
    assert.equal(got[3].cost_usd, 0.75); assert.equal(got[3].wall_ms, 90000); assert.equal(got[3].issue, 9);
    assert.equal(mapRunRecord({ event: "CI_PENDING_WAIT" }), null);
  });

  it("maps probe rows: only pass and fail", () => {
    assert.equal(probeEvent({ issue: 1, outcome: "awaiting-promotion" }), null);
    assert.equal(probeEvent({ issue: 1, outcome: "pass", detail: "exit 0", fix: "abc" }).type, "probe.passed");
    assert.equal(probeEvent({ issue: 1, outcome: "fail" }).type, "probe.failed");
  });
});

describe("regression, experiment and promoted builders (#4632)", () => {
  it("regressionEvent: only a fail row that filed a regression issue", () => {
    assert.equal(regressionEvent({ issue: 5, outcome: "pass" }), null);
    assert.equal(regressionEvent({ issue: 5, outcome: "fail" }), null);
    const r = regressionEvent({ issue: 5, outcome: "fail", regression: 7, detail: "broke" });
    assert.equal(r.type, "regression.detected"); assert.equal(r.ctx.issue, 5);
    assert.deepEqual(r.data, { subject: "post-deploy check of #5", metric: "post_deploy_check", detail: "broke" });
  });
  it("experimentEvent: met, missed, inconclusive", () => {
    const t = (...p) => Object.fromEntries(p.map((pass, i) => [`t${i}`, { pass }]));
    assert.equal(experimentEvent({ id: "e", targets: t(true), targets_met: true }).data.verdict, "met");
    assert.equal(experimentEvent({ id: "e", targets: t(true, false), targets_met: false }).data.verdict, "missed");
    assert.equal(experimentEvent({ id: "e", targets: t(null), targets_met: false }).data.verdict, "inconclusive");
    assert.equal(experimentEvent({}), null);
  });
  it("promotedEvent needs a fix; types and keys stay pinned", () => {
    assert.equal(promotedEvent({}), null);
    assert.deepEqual(promotedEvent({ fix: "abc", default_branch: "main" }).data, { fix: "abc", default_branch: "main" });
    assert.deepEqual(EVENT_TYPES["regression.detected"], ["subject", "metric", "detail"]);
    assert.deepEqual(EVENT_TYPES["experiment.verdict"], ["experiment", "verdict", "detail"]);
  });
  it("a regression row is written to the sink", async () => {
    const dir = tmp();
    const p = regressionEvent({ issue: 5, outcome: "fail", regression: 7, detail: "d" });
    await makeEventEmitter({ repo: "o/r", config: { dir }, env: {} }).emitEvent(p.type, p.data, p.ctx);
    const ev = JSON.parse(readFileSync(join(dir, "o_r.jsonl"), "utf8"));
    assert.equal(ev.type, "regression.detected"); assert.equal(ev.issue, 5);
  });
});

describe("webhook", () => {
  const cfg = { webhookUrl: "https://hooks.example/x", secretEnv: "MY_SECRET", dir: undefined };
  it("signs `${timestamp}.${body}` with HMAC-SHA256 from the env secret", async () => {
    const calls = [];
    const fetchFn = async (url, init) => { calls.push([url, init]); return { ok: true }; };
    const { emitEvent } = makeEventEmitter({ repo: "o/r", config: { ...cfg, dir: tmp() }, env: { MY_SECRET: "s3" }, fetchFn, now: fixed });
    const ev = await emitEvent("pr.opened", {}, { issue: 1, pr: 2 });
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, cfg.webhookUrl); assert.equal(init.method, "POST");
    assert.equal(init.body, JSON.stringify(ev));
    const ts = init.headers["x-forge-timestamp"];
    assert.equal(ts, String(Math.floor(fixed().getTime() / 1000)));
    assert.equal(init.headers["x-forge-signature"], `sha256=${createHmac("sha256", "s3").update(`${ts}.${init.body}`).digest("hex")}`);
    assert.equal(init.headers["x-forge-event"], "pr.opened");
    assert.equal(sign("s3", ts, init.body), init.headers["x-forge-signature"].slice(7));
  });

  it("sends nothing without the secret, with a non-https URL, or when off", async () => {
    let n = 0;
    const fetchFn = async () => { n++; return { ok: true }; };
    for (const [config, env] of [[cfg, {}], [{ ...cfg, webhookUrl: "http://evil.example/x" }, { MY_SECRET: "s" }], [cfg, { MY_SECRET: "s", FORGE_EVENTS: "off" }]]) {
      await makeEventEmitter({ repo: "o/r", config: { ...config, dir: tmp() }, env, fetchFn }).emitEvent("pr.opened", {}, { issue: 1 });
    }
    assert.equal(n, 0);
    assert.equal(webhookUrlOk("http://localhost:3000/h"), true); assert.equal(webhookUrlOk("ftp://x"), false);
  });

  it("off writes no file; sink and webhook failures never throw", async () => {
    const dir = tmp();
    await makeEventEmitter({ repo: "o/r", config: { dir }, env: { FORGE_EVENTS: "off" } }).emitEvent("pr.opened", {}, { issue: 1 });
    assert.equal(existsSync(join(dir, "o_r.jsonl")), false);
    const boom = async () => { throw new Error("net"); };
    writeFileSync(join(dir, "f"), ""); const bad = makeEventEmitter({ repo: "o/r", config: { ...cfg, dir: join(dir, "f", "x") }, env: { MY_SECRET: "s" }, fetchFn: boom });
    assert.ok(await bad.emitEvent("pr.opened", {}, { issue: 1 }));
    await bad.emit({ event: "PR_OPENED", pr: 1, issue: 1 });
    assert.equal(await postWebhook({ type: "x" }, { url: cfg.webhookUrl, secret: "s", fetchFn: boom }), false);
  });
});
