import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nightlyConfig, nightlyDue, NIGHTLY_MARKER } from "./selftest-nightly.mjs";

const setup = (yaml) => { const cwd = mkdtempSync(join(tmpdir(), "nt-")), stateDir = mkdtempSync(join(tmpdir(), "ns-")); if (yaml) writeFileSync(join(cwd, "forge.yaml"), yaml); return { cwd, stateDir }; };
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

test("a passing run writes no issue; a throwing harness never throws", async () => {
  const s = setup(YAML), io = fakeIo();
  await nightlyDue({ ...s, repo: "o/r", io, runLive: async () => ({ ok: true }) });
  assert.equal(io.calls.length, 0);
  const s2 = setup(YAML);
  assert.deepEqual(await nightlyDue({ ...s2, repo: "o/r", io, runLive: async () => { throw new Error("boom"); } }), { ran: false });
});
