// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestParser, createPoster, baseEvent } from "./ci-emit.mjs";

const CLI = fileURLToPath(new URL("../forgedock.mjs", import.meta.url));
const ENV0 = { PATH: process.env.PATH, GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc123", GITHUB_RUN_ID: "77", GITHUB_JOB: "unit", GITHUB_REF: "refs/pull/42/merge" };

/** Fake router: records {at, body, auth}; `status` controls the reply. */
async function router(status = 202) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { got.push({ at: Date.now(), body: JSON.parse(b), auth: req.headers.authorization }); res.statusCode = status; res.end("{}"); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${srv.address().port}/ci/events`, close: () => new Promise((r) => srv.close(r)) };
}

/** Runs the real CLI; resolves {code, out(Buffer), err(Buffer), exitAt, wall}. */
function run(args, env) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    p.stdout.on("data", (c) => out.push(c));
    p.stderr.on("data", (c) => err.push(c));
    p.on("close", (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err), exitAt: Date.now(), wall: Date.now() - t0 }));
  });
}
const node = (src) => [process.execPath, "-e", src];

test("ci-step preserves exit code and stdout/stderr bytes (0, 1, 137, binary)", async () => {
  for (const code of [0, 1, 137]) {
    const src = `process.stdout.write(Buffer.from([0,255,254,10,128,0])); process.stderr.write(Buffer.from([1,2,200,201])); process.exit(${code})`;
    const r = await run(["ci-step", "--name", "bin", "--", ...node(src)], ENV0);
    assert.equal(r.code, code);
    assert.deepEqual([...r.out], [0, 255, 254, 10, 128, 0]);
    assert.deepEqual([...r.err], [1, 2, 200, 201]);
  }
});

test("ci-step posts step_started and step_failed with exit code and error lines, with bearer token", async () => {
  const rt = await router();
  const lines = [...Array(60).keys()].map((i) => `noise ${i}`).concat(["Error: boom"]);
  const r = await run(["ci-step", "--name", "build", "--", ...node(`console.log(${JSON.stringify(lines.join("\n"))}); process.exit(2)`)], { ...ENV0, FORGEDOCK_CI_EVENTS_URL: rt.url, FORGEDOCK_CI_TOKEN: "tok" });
  await rt.close();
  assert.equal(r.code, 2);
  const types = rt.got.map((g) => g.body.type).sort();
  assert.deepEqual(types, ["step_failed", "step_started"]);
  const failed = rt.got.find((g) => g.body.type === "step_failed");
  assert.equal(failed.auth, "Bearer tok");
  assert.equal(failed.body.exit_code, 2);
  assert.deepEqual(failed.body.lines, ["Error: boom"]);
  assert.equal(failed.body.step, "build");
  assert.equal(failed.body.pr, 42);
  assert.equal(failed.body.repo, "o/r");
});

test("step_failed without error-looking lines carries the last 40 lines", async () => {
  const rt = await router();
  const src = `for (let i=0;i<100;i++) console.log("line "+i); process.exit(1)`;
  await run(["ci-step", "--name", "s", "--", ...node(src)], { ...ENV0, FORGEDOCK_CI_EVENTS_URL: rt.url });
  await rt.close();
  const failed = rt.got.find((g) => g.body.type === "step_failed");
  assert.equal(failed.body.lines.length, 40);
  assert.equal(failed.body.lines[0], "line 60");
});

const PYTEST = [
  "============ FAILURES ============",
  "___ test_a ___",
  "E   assert 1 == 2",
  "tests/test_a.py:12: AssertionError",
  "___ test_b ___",
  "tests/test_b.py:30: AssertionError",
  "=========== short test summary info ===========",
  "FAILED tests/test_a.py::test_a - assert 1 == 2",
  "FAILED tests/test_b.py::TestK::test_b - AssertionError: nope",
];
const VITEST = [
  " FAIL  src/a.test.ts > suite > adds",
  "AssertionError: expected 1 to be 2",
  " ❯ src/a.test.ts:9:15",
  "    7|   it('adds', () => {",
  " FAIL  src/b.test.ts > subtracts",
  "Error: bad",
  " ❯ src/b.test.ts:21:3",
];

/** Streams `lines` one at a time with a delay, then lingers 600 ms before exiting. */
const streamer = (lines) => node(`const L=${JSON.stringify(lines)};let i=0;const t=setInterval(()=>{if(i<L.length)console.log(L[i++]);else{clearInterval(t);setTimeout(()=>process.exit(1),600)}},40)`);

for (const [name, log, want] of [
  ["pytest", PYTEST, [
    { id: "tests/test_a.py::test_a", file: "tests/test_a.py", line: 12, message: "assert 1 == 2" },
    { id: "tests/test_b.py::TestK::test_b", file: "tests/test_b.py", line: 30, message: "AssertionError: nope" },
  ]],
  ["vitest", VITEST, [
    { id: "src/a.test.ts > suite > adds", file: "src/a.test.ts", line: 9, message: "AssertionError: expected 1 to be 2" },
    { id: "src/b.test.ts > subtracts", file: "src/b.test.ts", line: 21, message: "Error: bad" },
  ]],
]) {
  test(`${name} log streams one test_failed per failing test before the process exits`, async () => {
    const rt = await router();
    const r = await run(["ci-step", "--name", name, "--", ...streamer(log)], { ...ENV0, FORGEDOCK_CI_EVENTS_URL: rt.url });
    await rt.close();
    assert.equal(r.code, 1);
    const tf = rt.got.filter((g) => g.body.type === "test_failed");
    assert.deepEqual(tf.map((g) => g.body.test), want);
    for (const g of tf) assert.ok(g.at < r.exitAt - 300, `test_failed posted ${r.exitAt - g.at} ms before exit`);
  });
}

test("parser dedupes repeated failures and flushes a vitest FAIL without a location at end", () => {
  const got = [];
  const p = createTestParser((t) => got.push(t));
  for (const l of [...PYTEST, ...PYTEST, " FAIL  x.test.ts > lonely", "Error: z"]) p.line(l);
  p.end();
  assert.equal(got.length, 3);
  assert.deepEqual(got[2], { id: "x.test.ts > lonely", file: "x.test.ts", message: "Error: z" });
});

test("router unreachable or 5xx: result unchanged, one warning, under 2 s added", async () => {
  const dead = await router(); const deadUrl = dead.url; await dead.close();
  const bad = await router(503);
  for (const url of [deadUrl, bad.url]) {
    const base = await run(["ci-step", "--name", "n", "--", ...node("console.log('x'); process.exit(3)")], ENV0);
    const r = await run(["ci-step", "--name", "n", "--", ...node("console.log('x'); process.exit(3)")], { ...ENV0, FORGEDOCK_CI_EVENTS_URL: url });
    assert.equal(r.code, 3);
    assert.equal(r.out.toString(), "x\n");
    const warns = r.err.toString().split("\n").filter((l) => l.includes("event delivery failed"));
    assert.equal(warns.length, 1);
    assert.ok(r.wall - base.wall < 2000, `added ${r.wall - base.wall} ms`);
  }
  await bad.close();
});

test("hook with env unset exits 0 and posts nothing; with env set posts the mapped event", async () => {
  const rt = await router();
  const off = await run(["ci-hook", "job-started"], ENV0);
  assert.equal(off.code, 0);
  assert.equal(off.out.length, 0);
  assert.equal(rt.got.length, 0);
  const env = { ...ENV0, FORGEDOCK_CI_EVENTS_URL: rt.url };
  assert.equal((await run(["ci-hook", "job-started"], env)).code, 0);
  assert.equal((await run(["ci-hook", "job-completed"], env)).code, 0);
  await rt.close();
  assert.deepEqual(rt.got.map((g) => g.body.type), ["job_started", "job_finished"]);
  assert.equal(rt.got[0].body.job, "unit");
  assert.equal(rt.got[0].body.pr, 42);
});

test("poster is a no-op without a URL and baseEvent parses the PR from GITHUB_REF", () => {
  assert.equal(createPoster({ env: {} }).enabled, false);
  assert.equal(baseEvent({ GITHUB_REF: "refs/heads/main" }).pr, undefined);
  assert.equal(baseEvent({ GITHUB_REF: "refs/pull/9/merge" }).pr, 9);
});

test("step_failed reaches the router within 2 s of the failure (fixture step fails at t=5 s)", async () => {
  const rt = await router();
  // Nominal 120 s sequence; only the failing step at t=5 s matters, so it is the one executed.
  const t0 = Date.now();
  const r = await run(["ci-step", "--name", "slow", "--", ...node("setTimeout(()=>{console.error('Error: late');process.exit(1)},5000)")], { ...ENV0, FORGEDOCK_CI_EVENTS_URL: rt.url });
  await rt.close();
  const failed = rt.got.find((g) => g.body.type === "step_failed");
  const latency = failed.at - (t0 + 5000);
  console.log(`# measured step_failed latency after t=5 s failure: ${latency} ms`);
  assert.ok(failed, "step_failed delivered");
  assert.ok(latency <= 2000, `latency ${latency} ms`);
  assert.equal(r.code, 1);
});
