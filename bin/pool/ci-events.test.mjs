// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_TYPES, createCiEvents, validateEvent } from "./ci-events.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const ev = (type, extra = {}) => ({ type, repo: "o/r", sha: "abc", run_id: 7, job: "unit", ts: "2026-11-15T00:00:00Z", ...extra });
const fail = (status, key) => (e) => e.status === status && (key ? e.message.includes(key) : true);

test("all 6 event types validate; optional keys are kept", () => {
  for (const t of EVENT_TYPES) assert.equal(validateEvent(ev(t)).type, t);
  const e = validateEvent(ev("test_failed", { pr: 12, step: "s", exit_code: 1, class: "code", lines: ["a"], test: { id: "t1", file: "f.py", line: 3, message: "boom" }, junk: 1 }));
  assert.deepEqual([e.pr, e.step, e.exit_code, e.class, e.lines, e.test.id, e.junk], [12, "s", 1, "code", ["a"], "t1", undefined]);
});

test("missing repo/sha/ts/run_id/job and an unknown type are 400 naming the key", () => {
  for (const k of ["repo", "sha", "ts", "run_id", "job"]) { const e = ev("step_failed"); delete e[k]; assert.throws(() => validateEvent(e), fail(400, k)); }
  assert.throws(() => validateEvent(ev("nope")), fail(400, "type"));
  assert.throws(() => validateEvent(ev("step_failed", { pr: "x" })), fail(400, "pr"));
  assert.throws(() => validateEvent(ev("step_failed", { exit_code: "1" })), fail(400, "exit_code"));
  assert.throws(() => validateEvent(null), fail(400));
});

test("more than 40 lines, a line over 500 chars, or more than 200 events is 413", () => {
  assert.throws(() => validateEvent(ev("step_failed", { lines: Array(41).fill("x") })), fail(413, "lines"));
  assert.equal(validateEvent(ev("step_failed", { lines: Array(40).fill("x".repeat(500)) })).lines.length, 40);
  assert.throws(() => validateEvent(ev("step_failed", { lines: ["x".repeat(501)] })), fail(413, "lines"));
  const s = createCiEvents({});
  assert.throws(() => s.ingest(Array(201).fill(ev("job_started"))), fail(413));
  assert.equal(s.ingest(Array(200).fill(ev("job_started"))).accepted, 200);
});

test("a bad event rejects the whole array and stores nothing", () => {
  const s = createCiEvents({});
  assert.throws(() => s.ingest([ev("job_started"), ev("step_failed", { sha: undefined })]), fail(400, "sha"));
  assert.equal(s.size(), 0);
  assert.equal(s.seq, 0);
});

test("seq is monotonic; sha and pr filters and since work", () => {
  const s = createCiEvents({});
  s.ingest([ev("job_started"), ev("step_failed", { sha: "def", pr: 5 }), ev("step_failed", { pr: 5 })]);
  const all = s.query({ repo: "o/r", sha: "abc" });
  assert.deepEqual(all.events.map((e) => e.seq), [1, 3]);
  assert.equal(all.next, 3);
  assert.deepEqual(s.query({ repo: "o/r", pr: 5 }).events.map((e) => e.sha), ["def", "abc"]);
  assert.equal(s.query({ repo: "o/r", sha: "abc" }, 1).events.length, 1);
  const none = s.query({ repo: "o/r", sha: "abc" }, 3);
  assert.deepEqual([none.events.length, none.next], [0, 3]);
  assert.equal(s.query({ repo: "other", sha: "abc" }).events.length, 0);
});

test("ring cap keeps the newest events; TTL expires old ones", () => {
  let t = 1_000_000;
  const s = createCiEvents({ cap: 5, ttlMs: 1000, now: () => t });
  for (let i = 0; i < 8; i++) s.ingest(ev("step_started", { step: `s${i}` }));
  assert.deepEqual(s.query({ repo: "o/r", sha: "abc" }).events.map((e) => e.step), ["s3", "s4", "s5", "s6", "s7"]);
  t += 1500;
  assert.equal(s.query({ repo: "o/r", sha: "abc" }).events.length, 0);
  t += 61000;
  s.query({ repo: "o/r", sha: "abc" });
  assert.equal(s.size(), 0);
});

test("NDJSON is written, rotates on a new UTC day, and a restart reloads and resumes seq", () => {
  const dir = tmpDir("ci-ev-");
  let t = Date.parse("2026-11-15T10:00:00Z");
  const a = createCiEvents({ dir, now: () => t });
  a.ingest([ev("job_started"), ev("step_failed")]);
  const [f] = readdirSync(dir);
  assert.match(f, /^o_r-[0-9a-f]{8}\.ndjson$/);
  assert.equal(readFileSync(join(dir, f), "utf8").trim().split("\n").length, 2);
  t = Date.parse("2026-11-16T01:00:00Z");
  a.ingest(ev("job_finished"));
  assert.ok(readdirSync(dir).some((n) => /\.2026-11-15\.ndjson$/.test(n)), "yesterday's file rotated");
  assert.equal(readFileSync(join(dir, f), "utf8").trim().split("\n").length, 1);
  t += 3600000;
  const b = createCiEvents({ dir, now: () => t });
  assert.equal(b.seq, 3);
  assert.deepEqual(b.query({ repo: "o/r", sha: "abc" }, 1).events.map((e) => e.type), ["step_failed", "job_finished"]);
  assert.equal(b.ingest(ev("job_started")).seq, 4);
  t += 25 * 3600000; // past the TTL
  assert.equal(createCiEvents({ dir, now: () => t }).size(), 0);
});

test("a restart ignores a torn trailing line", () => {
  const dir = tmpDir("ci-ev-");
  createCiEvents({ dir }).ingest(ev("job_started"));
  appendFileSync(join(dir, readdirSync(dir)[0]), '{"seq":2,"rec');
  const b = createCiEvents({ dir });
  assert.deepEqual([b.size(), b.seq], [1, 1]);
});

test("long-poll wakes within 200 ms of a matching POST and ignores non-matching ones", async () => {
  const s = createCiEvents({});
  const t0 = performance.now();
  const p = s.wait({ repo: "o/r", sha: "abc" }, 0, 30);
  setTimeout(() => { s.ingest(ev("step_failed", { sha: "zzz" })); s.ingest(ev("step_failed")); }, 20);
  const r = await p;
  assert.ok(performance.now() - t0 < 200);
  assert.deepEqual([r.events.length, r.events[0].sha, r.next], [1, "abc", 2]);
  const empty = await s.wait({ repo: "o/r", sha: "abc" }, 2, 0.05);
  assert.deepEqual([empty.events.length, empty.next], [0, 2]);
  assert.equal((await s.wait({ repo: "o/r", sha: "abc" }, 0, 30)).events.length, 1, "existing events return at once");
});

test("bench: 10000 events ingest at 2000+/s with under 50 MB RSS growth", () => {
  const s = createCiEvents({ dir: tmpDir("ci-ev-") });
  const batch = (i) => Array.from({ length: 200 }, (_, j) => ev("test_failed", { sha: `sha${(i + j) % 5}`, lines: ["AssertionError: x".repeat(4)], test: { id: `t${i}-${j}`, file: "a.py", line: 1, message: "m" } }));
  const rss0 = process.memoryUsage().rss, t0 = performance.now();
  for (let i = 0; i < 50; i++) s.ingest(batch(i));
  const secs = (performance.now() - t0) / 1000, rate = 10000 / secs, grow = (process.memoryUsage().rss - rss0) / 1048576;
  console.log(`# ci-events bench: ${rate.toFixed(0)} events/s, rss +${grow.toFixed(1)} MB`);
  assert.equal(s.seq, 10000);
  assert.ok(rate >= 2000, `${rate} events/s`);
  assert.ok(grow < 50, `rss +${grow} MB`);
});
