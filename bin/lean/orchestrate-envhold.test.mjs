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
      calls.push({ n, recover: ctx.recover?.attempt ?? 0 });
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
  });
});
