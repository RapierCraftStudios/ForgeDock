// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { openBatch } from "./batch.mjs";
import { DEFAULT_HEALTH, parseHealthConfig, rootsOf, evaluateHealth, formatAlert, runCheck, scheduleChecks, scheduleLine, runNotify, deliverAlert,
  recordRefusal, readRefusals, statusLines, REFUSAL_KEEP } from "./batch-health.mjs";

// #1 and #3 are roots; #2 depends on #1, #4 on #3.
const base = (results, extra = {}) => ({ order: [1, 2, 3, 4], deps: { 2: [1], 4: [3] }, results, running: {}, pending: [], ...extra });

describe("#5167 evaluateHealth", () => {
  it("roots are the issues with no in-batch dependency", () => {
    assert.deepEqual(rootsOf(base({})), [1, 3]);
    assert.deepEqual(rootsOf({ order: [5, 6], deps: { 6: [99] } }), [5, 6], "an out-of-batch dependency keeps a root");
  });

  it("all roots engine-error, the rest skipped: root-failed and terminal-share, with recovery commands", () => {
    const st = base({ 1: { outcome: "engine-error" }, 2: { outcome: "skipped" }, 3: { outcome: "engine-error" }, 4: { outcome: "skipped" } });
    const h = evaluateHealth(st, { batchId: "b1", repo: "o/r" });
    assert.equal(h.healthy, false);
    assert.deepEqual(h.causes.map((c) => c.code), ["root-failed", "terminal-share"]);
    assert.deepEqual(h.causes[0].issues, [1, 3]);
    assert.match(h.causes[1].detail, /4\/4 rows ended non-merged \(2 engine-error, 2 skipped\), 0 merged/);
    assert.ok(h.recovery.includes(`forgedock orchestrate --requeue b1 1 3 2 4 --reason "batch unhealthy"`), h.recovery.join("\n"));
    assert.ok(h.recovery.includes("forgedock orchestrate --cancel b1") && h.recovery.includes("forgedock status --batch b1"));
    const text = formatAlert({ batchId: "b1", checkpoint: "T+15", health: h });
    assert.match(text, /^BATCH UNHEALTHY b1 \(T\+15\)\n {2}cause: root-failed: root #1 engine-error, #3 engine-error \[#1, #3\]/);
    assert.match(text, /\n {2}recovery:\n {4}forgedock orchestrate --requeue b1 1 3 2 4/);
  });

  it("a healthy batch (running, merged, or a requeued row waiting again) has no cause", () => {
    assert.deepEqual(evaluateHealth(base({ 1: { outcome: "merged" } }, { running: { 3: {} }, pending: [2, 4] })), { healthy: true, causes: [], recovery: [] });
    assert.equal(evaluateHealth(base({ 1: { outcome: "merged" }, 2: { outcome: "merged" }, 3: { outcome: "invalid" }, 4: { outcome: "decomposed" } })).healthy, true);
    assert.equal(evaluateHealth(base({ 1: { outcome: "engine-error" } }, { running: { 1: {} } })).healthy, true, "a relaunched root is running");
    assert.equal(evaluateHealth(base({}, { phase: "setup", pending: [1, 2, 3, 4] })).healthy, true, "setup is not a stall");
  });

  it("terminal-share needs 0 merged and the configured share; root_failed: false turns that cause off", () => {
    const st = base({ 2: { outcome: "needs-human" }, 4: { outcome: "held" }, 1: { outcome: "merged" } }, { running: { 3: {} }, pending: [4] });
    assert.equal(evaluateHealth(st).healthy, true, "one merge keeps the share cause off");
    const st2 = base({ 2: { outcome: "needs-human" }, 4: { outcome: "held" } }, { running: { 1: {}, 3: {} }, pending: [4] });
    assert.deepEqual(evaluateHealth(st2).causes.map((c) => c.code), ["terminal-share"], "held counts even though it stays pending");
    assert.equal(evaluateHealth(st2, { config: { ...DEFAULT_HEALTH, terminalShare: 0.75 } }).healthy, true);
    const st3 = base({ 1: { outcome: "engine-error" } }, { running: { 3: {} }, pending: [2, 4] });
    assert.equal(evaluateHealth(st3, { config: { ...DEFAULT_HEALTH, rootFailed: false } }).healthy, true);
  });

  it("stalled: 0 running with pending, operator-held issues excepted", () => {
    const st = base({ 1: { outcome: "merged" } }, { pending: [2, 3, 4] });
    const h = evaluateHealth(st, { batchId: "b2" });
    assert.deepEqual(h.causes.map((c) => [c.code, c.issues]), [["stalled", [2, 3, 4]]]);
    assert.ok(h.recovery.includes("forgedock orchestrate --resume b2"));
    assert.equal(evaluateHealth(st, { held: [2, 3, 4] }).healthy, true);
    assert.equal(evaluateHealth({ ...st, cancelled: true }).healthy, true);
  });

  it("a refused launch is unhealthy with the merge-or-force relaunch", () => {
    const h = evaluateHealth(null, { refused: { issues: [7], message: "parallel milestone start refused: #7 depends on #9" }, repo: "o/r" });
    assert.deepEqual(h.causes.map((c) => c.code), ["refused"]);
    assert.deepEqual(h.recovery, ["merge the unmet dependencies, then: forgedock orchestrate 7 --repo o/r", `forgedock orchestrate 7 --repo o/r --force "<why the unmet dependencies are acceptable>"`]);
  });
});

describe("#5167 config", () => {
  it("defaults, and orchestrate.health.* (flattened) plus notify.command", () => {
    assert.deepEqual(parseHealthConfig(null), { ...DEFAULT_HEALTH, checksMin: [15, 60] });
    const c = parseHealthConfig({ orchestrate: { root_failed: "false", terminal_share: "0.4", stalled: "false", issue: "#12", checks_min: "[10, 30]" }, notify: { command: "curl -d @- x" } });
    assert.deepEqual(c, { rootFailed: false, terminalShare: 0.4, stalled: false, checksMin: [10, 30], issue: 12, notifyCommand: "curl -d @- x" });
    assert.equal(parseHealthConfig({ orchestrate: { terminal_share: "2" } }).terminalShare, 0.5, "out of range keeps the default");
  });
});

describe("#5167 checkpoints, alert-once and persistence", () => {
  const mkBatch = (state) => {
    const root = tmpDir("bh-"), b = openBatch(root, "b20260101-000000-1");
    mkdirSync(b.dir, { recursive: true });
    b.writePlan({ v: 1, id: b.id, argv: ["1"], created: "2026-01-01T00:00:00.000Z" });
    b.store.save(state);
    return { root, b };
  };
  const bad = base({ 1: { outcome: "engine-error" }, 2: { outcome: "skipped" }, 3: { outcome: "engine-error" }, 4: { outcome: "skipped" } });

  it("the first unhealthy check alerts; later checks and a restart do not alert again", async () => {
    const { root, b } = mkBatch(bad), alerts = [];
    const alert = async (t) => { alerts.push(t); };
    const r1 = await runCheck({ batch: b, checkpoint: "T+15", alert, now: () => Date.parse("2026-01-01T00:15:00Z") });
    const r2 = await runCheck({ batch: openBatch(root, b.id), checkpoint: "T+60", alert });
    await runCheck({ batch: b, checkpoint: "end", alert });
    assert.deepEqual([r1.alerted, r2.alerted, alerts.length], [true, false, 1]);
    const h = JSON.parse(readFileSync(join(b.dir, "health.json"), "utf8"));
    assert.equal(h.alertedAt, "2026-01-01T00:15:00.000Z");
    assert.deepEqual(Object.keys(h.checks), ["T+15", "T+60", "end"]);
    assert.match(statusLines(root, { now: Date.parse("2026-01-01T01:00:00Z") }).join("\n"), /BATCH UNHEALTHY b20260101-000000-1 \(since 2026-01-01T00:15:00.000Z\): root #1 engine-error/);
    const one = statusLines(root, { batch: b.id }).join("\n");
    assert.match(one, /UNHEALTHY since/);
    assert.match(one, /forgedock orchestrate --cancel b20260101-000000-1/);
  });

  it("a healthy check records no alert, and a throwing channel never escapes", async () => {
    const { b, root } = mkBatch(base({ 1: { outcome: "merged" } }, { running: { 3: {} }, pending: [2, 4] }));
    const r = await runCheck({ batch: b, checkpoint: "T+15", alert: async () => { throw new Error("x"); } });
    assert.equal(r.healthy, true);
    assert.equal(statusLines(root).length, 0);
    assert.match(statusLines(root, { batch: b.id })[0], /healthy at T\+15/);
    b.store.save(bad);
    const r2 = await runCheck({ batch: b, checkpoint: "T+60", alert: async () => { throw new Error("gh down"); } });
    assert.equal(r2.alerted, true);
  });

  it("scheduleChecks arms only the checkpoints health.json has not recorded, relative to created", () => {
    const { b } = mkBatch(bad);
    writeFileSync(join(b.dir, "health.json"), JSON.stringify({ checks: { "T+15": "x" } }));
    const armed = [];
    const created = Date.parse("2026-01-01T00:00:00Z");
    const s = scheduleChecks({ batch: b, created, now: () => created + 20 * 60000, setTimer: (fn, ms) => { armed.push(ms); return 1; }, clearTimer: () => armed.push("cleared"), check: () => {} });
    s.cancel();
    assert.deepEqual(armed, [40 * 60000, "cleared"]);
    assert.equal(scheduleLine("b9", created), "health checks: T+15 00:15Z, T+60 01:00Z, and at batch end; forgedock status --batch b9");
  });
});

describe("#5167 channels and refusals", () => {
  it("runNotify pipes the alert JSON and env to the shell command; failures are returned", async () => {
    const out = join(tmpDir("bh-n-"), "got");
    const ok = await runNotify(`cat > ${out}; echo "$FORGEDOCK_ALERT $FORGEDOCK_ALERT_BATCH" >> ${out}`, { batch: "b1", text: "t" });
    assert.deepEqual(ok, { ok: true });
    const got = readFileSync(out, "utf8").split("\n");
    assert.equal(JSON.parse(got[0]).batch, "b1");
    assert.equal(got[1], "BATCH_UNHEALTHY b1");
    assert.deepEqual(await runNotify("exit 3", { batch: "b1" }), { ok: false, error: "exit 3" });
    assert.equal((await runNotify("sleep 5", {}, { timeoutMs: 50 })).ok, false);
  });

  it("deliverAlert comments on the configured issue, else the epics, and reports failed channels", async () => {
    const calls = [], lines = [];
    const sink = { line: (l) => lines.push(l) };
    await deliverAlert({ text: "BATCH UNHEALTHY b1", batchId: "b1", sink, gh: async (a) => { calls.push(a[2]); }, repo: "o/r", epics: [5, 6, 5] });
    await deliverAlert({ text: "BATCH UNHEALTHY b1", batchId: "b1", sink, gh: async (a) => { calls.push(a[2]); throw new Error("403"); }, repo: "o/r", config: { ...DEFAULT_HEALTH, issue: 9, notifyCommand: "x" }, epics: [5], notify: async () => ({ ok: false, error: "exit 1" }) });
    assert.deepEqual(calls, ["5", "6", "9"]);
    assert.deepEqual(lines.filter((l) => /^health:/.test(l)), ["health: comment on #9 failed (403)", "health: notify.command failed (exit 1)"]);
  });

  it("refusals are kept under the batch root, pruned, and shown by status for a day", () => {
    const root = tmpDir("bh-r-");
    for (let i = 0; i < REFUSAL_KEEP + 3; i++) recordRefusal(root, { at: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 1000).toISOString(), issues: [7], message: `refused ${i}` });
    assert.equal(readRefusals(root, { maxAgeMs: Infinity }).length, REFUSAL_KEEP);
    const now = Date.parse("2026-01-01T01:00:00Z");
    assert.match(statusLines(root, { now }).at(-1), /^ {2}LAUNCH REFUSED 2026-01-01T00:00:22.000Z: refused 22$/);
    assert.equal(statusLines(root, { now: now + 2 * 86400000 }).length, 0);
    assert.ok(existsSync(join(root, "refusals.json")));
  });
});
