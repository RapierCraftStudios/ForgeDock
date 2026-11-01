// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSources, runAdapter, closeSignal, normalizeSignal } from "./prodwatch-sources.mjs";

const spy = (answers) => { const calls = []; return { calls, exec: async (cmd) => { calls.push(cmd); const a = answers(cmd); return a ?? { code: 1, stdout: "" }; } }; };
const KEYS = ["id", "source", "title", "severity", "owner", "first_seen", "last_seen", "body"];

describe("parseSources", () => {
  it("infers kinds and validates", () => {
    const s = parseSources({ prod_watch: { sources: {
      m: { list: "ls", read: "cat {id}", close: "rm {id}" }, q: { run: "psql {sql}", queries: ["a.sql"] },
      a: { kind: "alertmanager", run: "am" }, p: { kind: "prometheus", run: "prom '{expr}'", queries: [{ name: "err", expr: "up == 0", threshold: 1 }] } } } });
    assert.deepEqual(s.map((x) => x.kind), ["memo", "sql", "alertmanager", "prometheus"]);
    assert.equal(s[3].queries[0].op, ">");
  });
  it("rejects unknown keys, missing commands, shell-active queries", () => {
    assert.throws(() => parseSources({ x: { list: "ls", read: "cat", write: "x" } }), /unknown key/);
    assert.throws(() => parseSources({ x: { kind: "memo", list: "ls" } }), /list and read/);
    assert.throws(() => parseSources({ x: { run: "r", queries: ["a; rm -rf /"] } }), /shell-active/);
    assert.throws(() => parseSources({ x: { kind: "prometheus", run: "r", queries: [{ expr: "up", threshold: "x" }] } }), /threshold/);
  });
});

describe("adapters", () => {
  it("memo: lists, reads, normalises, skips unsafe ids, reports read failures", async () => {
    const [src] = parseSources({ memos: { list: "LIST", read: "READ {id}" } });
    const io = spy((c) => c === "LIST" ? { code: 0, stdout: "m-1\nm-2\n$(evil)\n" } : c === "READ m-1" ? { code: 0, stdout: "# Disk full\nseverity: critical\nowner: infra\n" } : null);
    const { signals, errors } = await runAdapter(src, io);
    assert.equal(signals.length, 1);
    assert.deepEqual(Object.keys(signals[0]).slice(0, 8), KEYS);
    assert.equal(signals[0].severity, "P0"); assert.equal(signals[0].owner, "infra"); assert.equal(signals[0].title, "Disk full");
    assert.equal(errors.length, 2);
    assert.ok(!io.calls.some((c) => c.includes("evil")));
  });
  it("alertmanager: v2 alerts", async () => {
    const [src] = parseSources({ a: { kind: "alertmanager", run: "AM" } });
    const j = [{ fingerprint: "abc123", labels: { alertname: "HighErr", severity: "warning", team: "api" }, annotations: { summary: "errors up" }, startsAt: "2026-01-01T00:00:00Z" }];
    const { signals } = await runAdapter(src, spy(() => ({ code: 0, stdout: JSON.stringify(j) })));
    assert.equal(signals[0].id, "abc123"); assert.equal(signals[0].severity, "P2"); assert.equal(signals[0].owner, "api");
    assert.equal(signals[0].first_seen, "2026-01-01T00:00:00.000Z");
  });
  it("sql: one signal per row with query", async () => {
    const [src] = parseSources({ s: { run: "SQL {sql}", queries: ["slo.sql"] } });
    const io = spy(() => ({ code: 0, stdout: JSON.stringify([{ id: 7, severity: "high" }, { key: "k" }]) }));
    const { signals } = await runAdapter(src, io);
    assert.deepEqual(signals.map((s) => s.id), ["slo.sql:7", "slo.sql:k"]);
    assert.equal(signals[0].query, "slo.sql"); assert.equal(signals[0].severity, "P1");
    assert.deepEqual(io.calls, ["SQL slo.sql"]);
  });
  it("prometheus: only samples crossing the threshold", async () => {
    const [src] = parseSources({ p: { kind: "prometheus", run: "PROM {expr}", queries: [{ name: "err", expr: "rate(e)", threshold: 0.5 }] } });
    const j = { data: { result: [{ metric: { job: "a" }, value: [1, "0.9"] }, { metric: { job: "b" }, value: [1, "0.1"] }] } };
    const { signals } = await runAdapter(src, spy(() => ({ code: 0, stdout: JSON.stringify(j) })));
    assert.equal(signals.length, 1); assert.equal(signals[0].id, "err:job=a"); assert.equal(signals[0].query, "rate(e)");
  });
  it("non-JSON or failing output becomes an error, not a throw", async () => {
    const [src] = parseSources({ a: { kind: "alertmanager", run: "AM" } });
    assert.equal((await runAdapter(src, spy(() => ({ code: 0, stdout: "nope" })))).errors.length, 1);
    assert.equal((await runAdapter(src, spy(() => ({ code: 2, stdout: "" })))).errors.length, 1);
  });
  it("normalizeSignal omits query when absent and coerces severity", () => {
    const s = normalizeSignal({ id: "x", severity: "bogus" }, { name: "n" });
    assert.equal("query" in s, false); assert.equal(s.severity, "unknown"); assert.equal(s.first_seen, null);
  });
});

describe("read-only enforcement", () => {
  it("runAdapter never executes close for any kind", async () => {
    const srcs = parseSources({
      m: { list: "LIST", read: "READ {id}", close: "CLOSE {id}" }, s: { run: "RUN {sql}", queries: ["a.sql"], close: "CLOSE2" },
      a: { kind: "alertmanager", run: "AM", close: "CLOSE3" } });
    const io = spy((c) => ({ code: 0, stdout: c === "LIST" ? "m1" : "[]" }));
    for (const s of srcs) await runAdapter(s, io);
    assert.ok(io.calls.length >= 3);
    assert.ok(io.calls.every((c) => !c.startsWith("CLOSE")), io.calls.join("|"));
  });
});

describe("closeSignal", () => {
  const [src] = parseSources({ m: { list: "ls", read: "cat {id}", close: "CLOSE {id} --issue {issue} --reason {reason}" } });
  const sig = { id: "m-1" };
  it("audits before exec and runs the declared close", async () => {
    const log = [];
    const io = { exec: async (c) => { log.push(c); return { code: 0, stdout: "" }; }, audit: async (r) => { log.push(r.event); }, now: () => 0 };
    const r = await closeSignal(src, sig, { issue: 12, reason: "fixed in #12", audit: { by: "prodwatch" } }, io);
    assert.equal(r.ok, true);
    assert.deepEqual(log, ["close", "CLOSE m-1 --issue 12 --reason fixed in #12", "close_result"]);
  });
  it("refuses without audit record, sink, close command, or with unsafe input; never execs", async () => {
    const calls = [];
    const io = { exec: async (c) => { calls.push(c); return { code: 0 }; }, audit: async () => {} };
    await assert.rejects(closeSignal(src, sig, { issue: 1, reason: "r" }, io), /audit record/);
    await assert.rejects(closeSignal(src, sig, { issue: 1, reason: "r", audit: { by: "x" } }, { exec: io.exec }), /io.audit/);
    await assert.rejects(closeSignal({ name: "n" }, sig, { issue: 1, reason: "r", audit: { by: "x" } }, io), /no close/);
    await assert.rejects(closeSignal(src, { id: "a;b" }, { issue: 1, reason: "r", audit: { by: "x" } }, io), /unsafe/);
    await assert.rejects(closeSignal(src, sig, { issue: 1, reason: "r; rm", audit: { by: "x" } }, io), /reason/);
    await assert.rejects(closeSignal(src, sig, { issue: "1 2", reason: "r", audit: { by: "x" } }, io), /issue/);
    assert.deepEqual(calls, []);
  });
  it("a failing audit sink aborts the close", async () => {
    const calls = [];
    const io = { exec: async (c) => { calls.push(c); return { code: 0 }; }, audit: async () => { throw new Error("disk"); } };
    await assert.rejects(closeSignal(src, sig, { issue: 1, reason: "r", audit: { by: "x" } }, io), /disk/);
    assert.deepEqual(calls, []);
  });
});
