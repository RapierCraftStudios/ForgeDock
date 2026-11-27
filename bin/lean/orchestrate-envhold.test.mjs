// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5805: engine/env-caused failures are held by signature (not relaunched blindly, not ended terminal) and re-admitted on an
// engine version change, a batch env change (--set-env) or the missing tool appearing; issue-caused failures are unchanged.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { orchestrate, failureSignature, formatTable } from "./orchestrate.mjs";
import { envFingerprint } from "./batch.mjs";
import { hostMissingTools } from "./toolplace.mjs";

// A fake clock: every sleep advances it, so the batch's engine/env watch (30s) and hold window (2 min here) run instantly.
const harness = ({ script, issues = Object.keys(script).map(Number), parallel = 1, envHold = {}, store = null, onRow = () => {}, extra = {} }) => {
  let t = 1_000_000;
  const calls = [], decisions = [], updates = [];
  const p = orchestrate({ issues, parallel, readBody: async () => "", now: () => t, store, pollMs: 1000,
    sleep: async (ms) => { t += Math.max(1, Number(ms) || 0); },
    recovery: { maxAttempts: 1, mechanicalMaxAttempts: 3 },
    envHold: { maxMs: 120_000, watchMs: 30_000, ...envHold },
    runOne: async (n, _l, ctx = {}) => {
      calls.push({ n, recover: ctx.recover?.attempt ?? 0, at: t });
      t += 1000;
      const list = script[n] ?? [{ terminalReason: "merged", pr: 1 }];
      const k = calls.filter((c) => c.n === n).length - 1;
      return list[Math.min(k, list.length - 1)];
    },
    decide: (d) => decisions.push(d), onUpdate: (r) => { updates.push(r); onRow(r); }, ...extra });
  return p.then((rows) => ({ rows, calls, decisions, updates, byIssue: Object.fromEntries(rows.map((r) => [r.issue, r])) }));
};
const EE = (detail, code) => ({ terminalReason: "engine-error", detail, ...(code ? { code } : {}) });
const MERGED = { terminalReason: "merged", pr: 9 };
const miss = (tool, more = {}) => ({ terminalReason: "needs-human", code: "env.tool_missing", detail: `Environment error: the host is missing ${tool}, so validate command(s) could not run\n- env.tool_missing: probe ${Math.random()}`, ...more });
const memStore = () => { let st = null; return { load: () => (st ? JSON.parse(JSON.stringify(st)) : null), save: (s) => { st = JSON.parse(JSON.stringify(s)); }, log: () => {} }; };

describe("#5805 engine-error signatures", () => {
  it("failureSignature normalises pids, ids, times and paths' numbers; the code is part of it", () => {
    const a = failureSignature(undefined, "lane pid 4242 exited without a result; see /x/run-1a2b3c4d5e/log 2026-11-21T08:58:42.387Z\nstack");
    const b = failureSignature(undefined, "lane pid 77 exited without a result; see /x/run-9f8e7d6c5b/log 2026-11-21T09:00:00Z\nother");
    assert.equal(a, b);
    assert.notEqual(failureSignature("engine.crash", "x"), failureSignature(undefined, "x"));
    assert.notEqual(failureSignature(undefined, "ENOENT: no such file C:\\a"), failureSignature(undefined, "EACCES: denied"));
  });

  it("a relaunch that hits the same engine-error is held (not terminal); another issue with that signature is held without a relaunch", async () => {
    const boom = (pid) => EE(`spawn failed: bad path segment (pid ${pid})`);
    let added = [];
    const r = await harness({ script: { 1: [boom(1), boom(2)], 2: [boom(3)] }, issues: [1], envHold: { version: () => "1.0.0" },
      extra: { getAdded: () => added }, onRow: (row) => { if (row.issue === 1 && row.outcome === "held") added = [2]; } });
    assert.deepEqual(r.calls.map((c) => c.n), [1, 1, 2], "issue 1 relaunched once; issue 2 (same signature, added later) never relaunched");
    for (const n of [1, 2]) {
      assert.equal(r.byIssue[n].outcome, "held");
      assert.equal(r.byIssue[n].envHold.kind, "engine");
      assert.equal(r.byIssue[n].envHold.version, "1.0.0");
      assert.match(r.byIssue[n].detail, /^waiting on engine\/env change: .*re-admitted on an engine upgrade/);
      assert.match(r.byIssue[n].detail.split("\n")[0], /no engine\/env change within/, "the hold window ended the batch, the row stays held (resumable)");
    }
    assert.match(formatTable(r.rows).split("\n")[2], /^#1 +held \(waiting on engine\/env change: .*\) +- /, "one report line per row");
    assert.ok(r.decisions.some((d) => d.issue === 1 && /^held: waiting on engine\/env change/.test(d.what)));
  });

  it("a relaunch that fails with a different message keeps the current behaviour: final engine-error", async () => {
    const r = await harness({ script: { 1: [EE("first failure"), EE("a different failure")] }, envHold: { version: () => "1.0.0" } });
    assert.deepEqual(r.calls.map((c) => c.n), [1, 1]);
    assert.equal(r.byIssue[1].outcome, "engine-error");
  });

  it("without envHold (module default) a repeated engine-error still ends engine-error after one relaunch", async () => {
    const r = await harness({ script: { 1: [EE("same"), EE("same")] }, envHold: undefined, extra: { envHold: null } });
    assert.equal(r.byIssue[1].outcome, "engine-error");
    assert.equal(r.calls.length, 2);
  });
});

describe("#5805 re-admission of held issues, no --requeue", () => {
  const heldNow = (r, n) => r.issue === n && r.outcome === "held" && r.envHold;
  it("an engine version change (reinstall/upgrade) re-admits the held issue and its dependent", async () => {
    let v = "1.0.0";
    const r = await harness({ script: { 1: [EE("boom"), EE("boom"), MERGED] }, issues: [1, 2], extra: { readBody: async (n) => (n === 2 ? "Depends on #1" : "") },
      envHold: { version: () => v }, onRow: (row) => { if (heldNow(row, 1)) v = "1.0.1"; } });
    assert.deepEqual(r.calls.map((c) => c.n), [1, 1, 1, 2]);
    assert.equal(r.byIssue[1].outcome, "merged");
    assert.equal(r.byIssue[2].outcome, "merged");
    assert.ok(r.updates.some((u) => u.issue === 1 && u.outcome === "readmitted" && /engine version changed v1\.0\.0 → v1\.0\.1/.test(u.detail)));
  });

  it("a dependent waits held behind the held root and is released with it", async () => {
    let v = "1.0.0", seen = 0;
    const r = await harness({ script: { 1: [EE("boom"), EE("boom"), MERGED] }, issues: [1, 2], extra: { readBody: async (n) => (n === 2 ? "Depends on #1" : "") },
      envHold: { version: () => v }, onRow: (row) => { if (row.issue === 2 && row.outcome === "held" && row.root === 1) { seen++; v = "1.0.1"; } } });
    assert.equal(seen, 1, "issue 2 was held behind #1, not skipped");
    assert.equal(r.byIssue[2].outcome, "merged");
  });

  it("a batch env change (--set-env) re-admits the held issue", async () => {
    let fp = envFingerprint({ A: "1" });
    const r = await harness({ script: { 1: [EE("boom"), EE("boom"), MERGED] }, envHold: { version: () => "1.0.0", envFingerprint: () => fp },
      onRow: (row) => { if (heldNow(row, 1)) fp = envFingerprint({ A: "2" }); } });
    assert.equal(r.byIssue[1].outcome, "merged");
    assert.equal(r.calls.length, 3);
    assert.ok(r.updates.some((u) => u.outcome === "readmitted" && /batch env changed \(--set-env\)/.test(u.detail)));
  });

  it("a resumed batch on a new engine version re-admits a hold an earlier run ended with", async () => {
    const store = memStore();
    const a = await harness({ script: { 1: [EE("boom")] }, store, envHold: { version: () => "1.0.0" } });
    assert.equal(a.byIssue[1].outcome, "held");
    const b = await harness({ script: { 1: [MERGED] }, store, envHold: { version: () => "1.1.0" } });
    assert.equal(b.byIssue[1].outcome, "merged");
    assert.ok(b.updates.some((u) => u.outcome === "readmitted" && /v1\.0\.0 → v1\.1\.0/.test(u.detail)));
  });
});

describe("#5805 env.tool_missing is not recovered while the host lacks the tool", () => {
  const remote = (first) => ({ max: 2, isRemote: () => true, place: () => ({ where: first, reason: "test" }), admit: () => ({ ok: true }), onBudget: "stop", costPerMinute: 0 });
  it("a host run that lacked the tool is held, not re-run, until the probe finds it; then re-admitted", async () => {
    let lacks = ["pytest"], probes = 0;
    const r = await harness({ script: { 7: [miss("pytest"), MERGED] }, extra: { remote: remote("local") },
      envHold: { version: () => "1.0.0", missingTools: async (t) => { probes++; if (probes >= 2) lacks = []; return t.filter((x) => lacks.includes(x)); } } });
    assert.deepEqual(r.calls.map((c) => c.n), [7, 7]);
    assert.equal(r.byIssue[7].outcome, "merged");
    assert.ok(r.updates.some((u) => u.issue === 7 && u.outcome === "held" && u.envHold?.kind === "tool" && /the host that ran it lacks pytest/.test(u.detail)));
    assert.ok(r.updates.some((u) => u.outcome === "readmitted" && /pytest now found on the host/.test(u.detail)));
  });

  it("a host recovery is not launched while the probe still misses the tool (the remote retry already used)", async () => {
    const r = await harness({ script: { 7: [miss("pytest", { placement: { where: "remote" } }), miss("ruff", { placement: { where: "remote" } })] }, extra: { remote: remote("remote") },
      envHold: { version: () => "1.0.0", missingTools: async (t) => t } });
    assert.deepEqual(r.calls.map((c) => c.recover), [0, 1], "no host recovery lane while ruff is missing on the host");
    assert.equal(r.byIssue[7].outcome, "held");
    assert.deepEqual(r.byIssue[7].envHold.tools, ["ruff"]);
  });

  it("a probe that finds the tool re-admits once: the same miss again waits for an engine or env change (no loop)", async () => {
    const r = await harness({ script: { 7: [miss("pytest")] }, extra: { remote: remote("local") }, envHold: { version: () => "1.0.0", missingTools: async () => [] } });
    assert.equal(r.calls.length, 2);
    assert.equal(r.byIssue[7].outcome, "held");
  });
});

describe("#5805 issue-caused failures keep their behaviour", () => {
  const NH = (code, more = {}) => ({ terminalReason: "needs-human", code, detail: `ended ${code}`, ...more });
  it("ci.red still recovers in the batch; builder.blocked still ends needs-human", async () => {
    const a = await harness({ script: { 1: [NH("ci.red", { pr: 5 }), MERGED] }, envHold: { version: () => "1.0.0", missingTools: async (t) => t } });
    assert.deepEqual(a.calls.map((c) => c.recover), [0, 1]);
    assert.equal(a.byIssue[1].outcome, "merged");
    const b = await harness({ script: { 2: [NH("builder.blocked")] }, envHold: { version: () => "1.0.0" } });
    assert.equal(b.calls.length, 1);
    assert.equal(b.byIssue[2].outcome, "needs-human");
    assert.equal(b.byIssue[2].envHold, undefined);
  });
});

describe("#5805 probes", () => {
  it("hostMissingTools finds executables on the PATH it is given", () => {
    const dir = tmpDir("envhold-");
    mkdirSync(join(dir, "sub"));
    if (process.platform === "win32") writeFileSync(join(dir, "mytool.cmd"), "");
    else writeFileSync(join(dir, "mytool"), "#!/bin/sh\n", { mode: 0o755 });
    assert.deepEqual(hostMissingTools(["mytool", "nope-tool", "sub"], { path: dir }), ["nope-tool", "sub"]);
  });
  it("envFingerprint is order-independent and changes with a value", () => {
    assert.equal(envFingerprint({ A: "1", B: "2" }), envFingerprint({ B: "2", A: "1" }));
    assert.notEqual(envFingerprint({ A: "1" }), envFingerprint({ A: "2" }));
    assert.equal(envFingerprint(undefined), envFingerprint({}));
  });
});

describe("#5755 one env issue per signature", () => {
  const seam = (closed = () => false) => {
    const calls = [];
    return { calls, ensure: async (a) => { calls.push(a); return 900; }, isClosed: async () => closed() };
  };
  const timeout = (extra = {}) => ({ terminalReason: "needs-human", code: "env.validate_timeout", detail: "validate V1 timed out after 900s on host 1234", ...extra });

  it("two issues with the same env signature share one env issue and are held, never needs-human", async () => {
    const e = seam();
    const { byIssue, calls } = await harness({ script: { 1: [miss("html2text")], 2: [miss("html2text")] }, envHold: null, extra: { envIssue: e } });
    assert.equal(byIssue[1].outcome, "held");
    assert.equal(byIssue[2].outcome, "held");
    assert.equal(byIssue[1].envHold.envIssue, 900);
    assert.deepEqual(e.calls.map((c) => c.sig), ["env.tool_missing|html2text", "env.tool_missing|html2text"]);
    assert.deepEqual(e.calls[1].issues, [1, 2]);
    assert.equal(calls.length, 2, "no recovery lane is launched");
  });

  it("after 2 issues hit a signature a pending issue whose body names the tool is not admitted", async () => {
    const e = seam();
    const bodies = { 3: "needs html2text to validate", 4: "unrelated" };
    const { byIssue, calls } = await harness({ script: { 1: [miss("html2text")], 2: [miss("html2text")], 3: [MERGED], 4: [MERGED] }, envHold: null, extra: { envIssue: e, readBody: async (n) => bodies[n] ?? "" } });
    assert.equal(byIssue[3].outcome, "held");
    assert.equal(byIssue[3].envHold.envIssue, 900);
    assert.equal(byIssue[4].outcome, "merged");
    assert.equal(calls.some((c) => c.n === 3), false);
  });

  it("env.validate_timeout and env.capability_remote are held on an env issue, not needs-human", async () => {
    const e = seam();
    const { byIssue } = await harness({ script: { 1: [timeout()], 2: [{ terminalReason: "needs-human", code: "env.capability_remote", detail: "capability sops is host-only" }] }, envHold: null, extra: { envIssue: e } });
    assert.equal(byIssue[1].outcome, "held");
    assert.equal(byIssue[2].outcome, "held");
  });

  it("held issues are requeued when the env issue closes", async () => {
    let closed = false;
    const e = seam(() => closed);
    const { byIssue } = await harness({ script: { 1: [miss("html2text"), MERGED] }, envHold: null,
      onRow: (r) => { if (r.issue === 1 && r.outcome === "held") closed = true; }, extra: { envIssue: e } });
    assert.equal(byIssue[1].outcome, "merged");
  });

  it("#6123 an env issue that is closed but the gap persists re-admits with exponential backoff (15m, 1h, 4h), not every watch", async () => {
    const e = seam(() => true); // closed from the start, the tool is still missing: every re-admit re-parks on the same signature
    const { calls, byIssue } = await harness({ script: { 1: [miss("html2text"), miss("html2text"), miss("html2text"), miss("html2text"), miss("html2text"), MERGED] },
      envHold: { maxMs: 5 * 3600_000, watchMs: 300_000 }, extra: { envIssue: e } });
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    assert.equal(calls.length, 6);
    assert.equal(byIssue[1].outcome, "merged");
    // gap 0 is the first re-admit (a fresh env issue closure); each later one waits 15m, 1h, 4h, 4h
    assert.ok(gaps[0] < 15 * 60_000);
    assert.ok(gaps[1] >= 15 * 60_000 && gaps[1] < 3600_000, String(gaps));
    assert.ok(gaps[2] >= 3600_000 && gaps[2] < 4 * 3600_000, String(gaps));
    assert.ok(gaps[3] >= 4 * 3600_000 && gaps[4] >= 4 * 3600_000, String(gaps));
  });

  it("without the seam the env.validate_timeout flow is unchanged (needs-human)", async () => {
    const { byIssue } = await harness({ script: { 1: [timeout()] }, envHold: null });
    assert.notEqual(byIssue[1].outcome, "held");
  });

  it("after 2 issues hit a non-tool signature a pending issue whose contract names its path is not admitted", async () => {
    const e = seam();
    const t = (d) => ({ terminalReason: "needs-human", code: "env.validate_timeout", detail: d });
    const bodies = { 3: "validate runs shared/html2text/build.sh", 4: "unrelated" };
    const { byIssue } = await harness({ script: { 1: [t("validate timed out running shared/html2text/build.sh")], 2: [t("validate timed out running shared/html2text/build.sh")], 3: [MERGED], 4: [MERGED] },
      envHold: null, extra: { envIssue: e, readBody: async (n) => bodies[n] ?? "" } });
    assert.equal(byIssue[3].outcome, "held");
    assert.equal(byIssue[4].outcome, "merged");
  });

  it("an env park on a security issue escalates: not held, not parked into remediation-queue", async () => {
    const e = seam();
    const relabels = [];
    const { byIssue } = await harness({ script: { 1: [miss("html2text")] }, envHold: null,
      extra: { envIssue: e, issueLabels: async () => ["security"], relabelNeedsHuman: async (a) => { relabels.push(a); return true; } } });
    assert.equal(byIssue[1].outcome, "needs-human");
    assert.match(byIssue[1].detail, /Security issue escalated/);
    assert.equal(relabels.some((a) => a.parked), false, "no parked/remediation-queue relabel");
    assert.equal(relabels.some((a) => !a.parked && /Security issue escalated/.test(a.evidence)), true, "needs-human label applied");
  });

  it("when the env issue cannot be filed the env.* failure is still held, never needs-human", async () => {
    const e = { ensure: async () => { throw new Error("gh down"); }, isClosed: async () => false };
    const { byIssue } = await harness({ script: { 1: [miss("html2text")] }, envHold: null, extra: { envIssue: e } });
    assert.equal(byIssue[1].outcome, "held");
    assert.equal(byIssue[1].envHold.envIssue, undefined);
  });
});

describe("#5859 agent restart: correlated sandbox loss is sandbox.lost, not engine-error", () => {
  const LOST = (n, agent = "legion") => ({ terminalReason: "engine-error", detail: `sandbox fake-${n} exited without a result`, lostWithoutResult: true, agent });
  const BREAKER = { errors: 3, window_min: 10 };

  it("agent restart: 20 lanes lost on one agent are sandbox.lost, not engine-errors", async () => {
    const issues = Array.from({ length: 20 }, (_, i) => i + 1);
    const script = Object.fromEntries(issues.map((n) => [n, [LOST(n), MERGED]]));
    const store = memStore(), logged = [];
    store.log = (ev) => logged.push(ev);
    let probes = 0; // the agent is still booting for its first two probes, then reports a fresh boot
    const r = await harness({ script, issues, parallel: 20, store, envHold: undefined,
      extra: { envHold: null, breaker: BREAKER, remote: { agentHealthy: async () => ++probes > 2 } } });
    assert.ok(!r.updates.some((u) => u.outcome === "breaker"), "the breaker never trips");
    const lost = r.updates.filter((u) => u.code === "sandbox.lost");
    assert.deepEqual([...new Set(lost.map((u) => u.issue))].sort((a, b) => a - b), issues, "all 20 requeued with sandbox.lost");
    for (const n of issues) assert.equal(r.byIssue[n].outcome, "merged", `#${n} admitted again once the agent is healthy`);
    assert.equal(r.calls.length, 40, "each lane relaunched exactly once");
    const st = store.load();
    assert.deepEqual(st.engineErrors, {}, "relaunch counters unchanged");
    assert.deepEqual(st.errorTimes, [], "nothing counted by the breaker");
    assert.equal(st.breaker, null);
    const ev = logged.filter((e) => e.event === "agent.restarted");
    assert.equal(ev.length, 1, "one batch-level event");
    assert.equal(ev[0].requeued, 20);
    assert.match(ev[0].detail, /^agent legion restarted at \d{4}-.*Z; 20 lanes requeued$/);
    assert.equal(r.updates.filter((u) => u.event === "agent.restarted").length, 1);
    assert.equal(st.agentRestarts.length, 1);
    assert.equal(st.agentRestarts[0].requeued, 20);
    assert.ok(probes >= 3, "admission waited for the agent's healthy probe");
  });

  // #5967 R5/R8: a host-memory OOM restart of the agent VM ends N sandboxes together; the VM-restart class is sandbox.lost (not a second pool.vm_restart code).
  it("N sandboxes ending together on an agent VM restart are sandbox.lost deferrals, no breaker trip (#5967)", async () => {
    const issues = [1, 2, 3, 4, 5];
    const script = Object.fromEntries(issues.map((n) => [n, [LOST(n), MERGED]]));
    const store = memStore();
    let probes = 0;
    const r = await harness({ script, issues, parallel: 5, store, envHold: undefined,
      extra: { envHold: null, breaker: BREAKER, remote: { agentHealthy: async () => ++probes > 1 } } });
    assert.ok(!r.updates.some((u) => u.outcome === "breaker"));
    assert.deepEqual([...new Set(r.updates.filter((u) => u.code === "sandbox.lost").map((u) => u.issue))].sort((x, y) => x - y), issues);
    assert.ok(!r.updates.some((u) => u.code === "engine-error"));
    const st = store.load();
    assert.deepEqual(st.errorTimes, []);
    assert.equal(st.breaker, null);
    for (const n of issues) assert.equal(r.byIssue[n].outcome, "merged");
  });

  // #5988: three sandboxes destroyed for max lifetime together are one batch-level event; the breaker stays closed and each lane is requeued.
  it("3 sandboxes destroyed for max lifetime within 30 s: no breaker trip, lanes requeued, reported once (#5988)", async () => {
    const MAXLIFE = (n) => ({ ...LOST(n), detail: `sandbox fake-${n} destroyed: max lifetime reached` });
    const issues = [1, 2, 3], script = Object.fromEntries(issues.map((n) => [n, [MAXLIFE(n), MERGED]]));
    const store = memStore(), logged = [];
    store.log = (ev) => logged.push(ev);
    const r = await harness({ script, issues, parallel: 3, store, envHold: undefined, extra: { envHold: null, breaker: BREAKER, remote: { agentHealthy: async () => true } } });
    assert.ok(!r.updates.some((u) => u.outcome === "breaker"), "the breaker never trips");
    for (const n of issues) assert.equal(r.byIssue[n].outcome, "merged", `#${n} requeued and relaunched`);
    const st = store.load();
    assert.deepEqual(st.errorTimes, []);
    assert.equal(st.breaker, null);
    assert.equal(logged.filter((e) => e.event === "agent.restarted").length, 1, "one batch-level event");
    assert.equal(st.agentRestarts[0].requeued, 3);
  });

  it("agent restart: failure after healthy is an ordinary engine-error", async () => {
    const store = memStore();
    const r = await harness({ script: { 1: [LOST(1), LOST(1), MERGED], 2: [LOST(2), MERGED], 3: [LOST(3), MERGED] }, issues: [1, 2, 3], parallel: 3, store,
      envHold: undefined, extra: { envHold: null, breaker: { errors: 5, window_min: 10 } } });
    assert.deepEqual(r.calls.filter((c) => c.n === 1).length, 3, "#1: sandbox.lost requeue, then the ordinary single relaunch");
    assert.ok(r.updates.some((u) => u.issue === 1 && /^relaunching once: sandbox fake-1/.test(u.detail ?? "")));
    const st = store.load();
    assert.deepEqual(st.engineErrors, { 1: 1 });
    assert.equal(st.errorTimes.length, 1, "the second loss of #1 counts toward the breaker");
    for (const n of [1, 2, 3]) assert.equal(r.byIssue[n].outcome, "merged");
  });

  it("two unrelated sandbox exits stay engine-errors", async () => {
    const store = memStore();
    const r = await harness({ script: { 1: [LOST(1), MERGED], 2: [LOST(2, "box2"), MERGED], 3: [LOST(3), MERGED] }, issues: [1, 2, 3], parallel: 3, store,
      envHold: undefined, extra: { envHold: null, breaker: { errors: 5, window_min: 10 } } });
    // #1 and #3 share an agent (2 < 3), #2 is on another: no restart
    assert.ok(!r.updates.some((u) => u.code === "sandbox.lost" || u.event === "agent.restarted"));
    const st = store.load();
    assert.deepEqual(st.engineErrors, { 1: 1, 2: 1, 3: 1 });
    assert.equal(st.errorTimes.length, 3, "each counts toward the breaker as today");
    assert.equal(st.agentRestarts, undefined);
  });

  it("two lost lanes with a 3-error breaker still trip it", async () => {
    const r = await harness({ script: { 1: [LOST(1), EE("real bug")], 2: [LOST(2, "box2"), EE("real bug 2")] }, issues: [1, 2], parallel: 2,
      envHold: undefined, extra: { envHold: null, breaker: { errors: 2, window_min: 10 } } });
    assert.ok(r.updates.some((u) => u.outcome === "breaker"));
  });
});

describe("#5988: breaker scoped by signature and agent", () => {
  it("12 sandbox.exited engine-errors on one agent quarantine only that agent; other agents keep admitting", async () => {
    const issues = [...Array.from({ length: 12 }, (_, i) => i + 1), 50], quarantined = [], reseeds = [];
    const sick = (n) => ({ terminalReason: "engine-error", code: "sandbox.exited", detail: `sandbox.exited before a result (run ${n})`, agent: "vm-a" });
    const script = Object.fromEntries(issues.slice(0, 12).map((n) => [n, [sick(n), MERGED]]));
    const r = await harness({ script, issues, parallel: 1, envHold: undefined,
      extra: { envHold: null, breaker: { errors: 3, window_min: 10 }, quarantineAgent: (q) => quarantined.push(q), reseedCache: (q) => reseeds.push(q) } });
    assert.deepEqual(quarantined.map((q) => q.agent), ["vm-a"], "that agent only, once");
    assert.equal(reseeds.length, 1, "the cache is reseeded once");
    assert.ok(!r.updates.some((u) => u.outcome === "breaker"), "the batch breaker never trips");
    assert.equal(r.byIssue[50].outcome, "merged", "unaffected work keeps admitting");
    assert.ok(r.updates.some((u) => u.outcome === "agent-quarantine"));
  });

  it("without placement callbacks the agent is still quarantined in-batch: its lanes are requeued, the breaker stays closed", async () => {
    const sick = (n) => ({ terminalReason: "engine-error", code: "sandbox.exited", detail: `sandbox.exited (run ${n})`, agent: "vm-a" });
    const r = await harness({ script: { 1: [sick(1), MERGED], 2: [sick(2), MERGED], 3: [sick(3), MERGED], 4: [sick(4), MERGED] }, issues: [1, 2, 3, 4, 50], parallel: 1, envHold: undefined,
      extra: { envHold: null, breaker: { errors: 3, window_min: 10 } } });
    assert.ok(r.updates.some((u) => u.outcome === "agent-quarantine"));
    assert.ok(!r.updates.some((u) => u.outcome === "breaker"));
    assert.equal(r.byIssue[50].outcome, "merged");
  });

  it("a persistently sick agent without placement callbacks cannot loop forever: the batch breaker counts it after bounded requeues", async () => {
    const sick = (n) => ({ terminalReason: "engine-error", code: "sandbox.exited", detail: `sandbox.exited (run ${n})`, agent: "vm-a" });
    const r = await harness({ script: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, [sick(n)]])), issues: [1, 2, 3, 4, 5], parallel: 1, envHold: undefined,
      extra: { envHold: null, breaker: { errors: 3, window_min: 10 } } });
    assert.ok(r.updates.some((u) => u.outcome === "breaker"), "bounded: the batch breaker trips");
  });
});
