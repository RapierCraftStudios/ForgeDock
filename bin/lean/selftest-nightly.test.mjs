import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { EventEmitter } from "node:events";
import { nightlyConfig, nightlyDue, launchNightly, NIGHTLY_MARKER } from "./selftest-nightly.mjs";

const setup = (yaml) => { const cwd = tmpDir("nt-"), stateDir = tmpDir("ns-"); if (yaml) writeFileSync(join(cwd, "forge.yaml"), yaml); return { cwd, stateDir }; };
const YAML = "selftest:\n  sandbox_repo: a/b\n  nightly_interval_hours: 24\n";
const fakeIo = (open = []) => { const calls = []; return { calls, gh: async (a) => { calls.push(a); if (a[1] === "list") return JSON.stringify(open); if (a[1] === "create") return "https://github.com/o/r/issues/77\n"; return ""; } }; };

test("nightlyConfig: unset, zero and other sections are off", () => {
  assert.equal(nightlyConfig(""), null);
  assert.equal(nightlyConfig("selftest:\n  sandbox_repo: a/b\n"), null);
  assert.equal(nightlyConfig("selftest:\n  nightly_interval_hours: 0\n"), null);
  assert.equal(nightlyConfig("other:\n  nightly_interval_hours: 5\n"), null);
  assert.equal(nightlyConfig(YAML), 24);
});

test("key unset: nothing is scheduled", async () => {
  const s = setup("selftest:\n  sandbox_repo: a/b\n"); let n = 0;
  const r = await nightlyDue({ ...s, repo: "o/r", io: fakeIo(), runLive: async () => { n++; return { ok: true }; } });
  assert.equal(r.ran, false); assert.equal(n, 0);
});

test("key set: runs when due, not again within the interval", async () => {
  const s = setup(YAML); let n = 0, t = 1e13;
  const run = () => nightlyDue({ ...s, repo: "o/r", io: fakeIo(), now: () => t, runLive: async () => { n++; return { ok: true }; } });
  assert.equal((await run()).ran, true);
  t += 3600_000; assert.equal((await run()).ran, false);
  t += 24 * 3600_000; assert.equal((await run()).ran, true);
  assert.equal(n, 2);
});

test("failure files one issue naming the step; the second failure edits it", async () => {
  const s = setup(YAML); let t = 1e13;
  const io1 = fakeIo();
  const r1 = await nightlyDue({ ...s, repo: "o/r", io: io1, now: () => t, runLive: async () => ({ ok: false, step: "body", message: "lost <!-- x --> body" }) });
  assert.deepEqual([r1.action, r1.issue], ["create", 77]);
  const create = io1.calls.find((a) => a[1] === "create");
  assert.match(create.join(" "), /step body/); assert.ok(create.join(" ").includes(NIGHTLY_MARKER));
  assert.ok(!create[create.indexOf("--body") + 1].includes("<!-- x"));
  t += 25 * 3600_000;
  const io2 = fakeIo([{ number: 77, body: `x\n${NIGHTLY_MARKER}` }]);
  const r2 = await nightlyDue({ ...s, repo: "o/r", io: io2, now: () => t, runLive: async () => ({ ok: false, step: "add", message: "m" }) });
  assert.deepEqual([r2.action, r2.issue], ["edit", 77]);
  assert.ok(!io2.calls.some((a) => a[1] === "create"));
  assert.match(io2.calls.find((a) => a[1] === "edit").join(" "), /step add/);
});

test("a passing run writes no issue; a throwing harness is reported, never silent", async () => {
  const s = setup(YAML), io = fakeIo();
  await nightlyDue({ ...s, repo: "o/r", io, runLive: async () => ({ ok: true }) });
  assert.equal(io.calls.length, 0);
  const s2 = setup(YAML), io2 = fakeIo();
  const r = await nightlyDue({ ...s2, repo: "o/r", io: io2, runLive: async () => { throw new Error("boom"); } });
  assert.deepEqual([r.ran, r.ok, r.action], [true, false, "create"]);
  assert.match(io2.calls.find((a) => a[1] === "create").join(" "), /step harness/);
});

test("with launch (the daemon) the run is only started, detached: nothing is awaited or filed in-process", async () => {
  const s = setup(YAML), io = fakeIo(); let launched = 0;
  const r = await nightlyDue({ ...s, repo: "o/r", io, launch: () => { launched++; }, runLive: async () => { throw new Error("must not run"); } });
  assert.deepEqual(r, { ran: true, launched: true }); assert.equal(launched, 1); assert.equal(io.calls.length, 0);
  assert.equal((await nightlyDue({ ...s, repo: "o/r", io, launch: () => { launched++; } })).ran, false, "not again within the interval");
});

test("the schedule is per repo: one repo's run never skips another's", async () => {
  const s = setup(YAML); let n = 0; const t = 1e13;
  const run = (repo) => nightlyDue({ ...s, repo, io: fakeIo(), now: () => t, runLive: async () => { n++; return { ok: true }; } });
  assert.equal((await run("o/a")).ran, true); assert.equal((await run("o/b")).ran, true); assert.equal(n, 2);
});

test("launchNightly: detached, unref'd, and an async spawn error never escapes (it would stop schedd)", async () => {
  let args = null, unrefd = false;
  const child = new EventEmitter(); child.unref = () => { unrefd = true; };
  const c = launchNightly({ cli: "/x/forgedock.mjs", repo: "o/r", cwd: "/tmp", spawnFn: (...a) => { args = a; return child; } });
  assert.equal(c, child); assert.ok(unrefd);
  assert.deepEqual(args[1], ["/x/forgedock.mjs", "selftest", "--live", "--nightly-report", "o/r"]);
  assert.equal(args[2].detached, true); assert.equal(args[2].stdio, "ignore");
  assert.doesNotThrow(() => child.emit("error", Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" })));
  assert.equal(launchNightly({ cli: "c", repo: "o/r", spawnFn: () => { throw new Error("EMFILE"); } }), null);
});
