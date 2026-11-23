import { tmpDir } from "./_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { poolFromCli } from "../engine-cli.mjs";

function setup() {
  const dir = tmpDir("pool-cli-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "forgedock.token"), "FD-SECRET\n");
  writeFileSync(join(dir, "enroll.token"), "ENROLL-SECRET\n");
  const config = join(dir, "router.json");
  writeFileSync(config, JSON.stringify({ listen: { host: "100.1.2.3", port: 7710 }, public_url: "http://100.1.2.3:7710", enroll_token_file: join(dir, "enroll.token") }));
  const calls = [];
  const reply = (r) => async (base, method, path, o) => { calls.push({ base, method, path, token: o?.token }); return typeof r === "function" ? r(method, path) : r; };
  return { config, calls, reply };
}
const run = async (argv, s, r) => {
  const out = [], err = [];
  const log = console.log, error = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  try { await poolFromCli([...argv, "--config", s.config], { poolDeps: { call: s.reply(r) } }); } finally { console.log = log; console.error = error; }
  return { out: out.join("\n"), err: err.join("\n") };
};

describe("forgedock pool (#4544)", () => {
  it("enroll prints the one-time code command and never a long-lived token", async () => {
    const s = setup();
    const { out, err } = await run(["enroll", "--cpus", "4"], s, { ok: true, status: 200, data: { code: "ONECODE", expires_at: "soon" } });
    assert.deepEqual([s.calls[0].method, s.calls[0].path, s.calls[0].token], ["POST", "/codes", "FD-SECRET"]);
    assert.match(out, /install\.ps1\?token=ONECODE&cpus=4/);
    assert.doesNotMatch(out + err, /ENROLL-SECRET|FD-SECRET/);
  });
  it("status lists agents; upgrade targets one agent", async () => {
    const s = setup();
    const { out } = await run(["status"], s, { ok: true, status: 200, data: { agents: [{ name: "a1" }] } });
    assert.match(out, /a1/);
    await run(["upgrade", "a1"], s, { ok: true, status: 200, data: { agents: [{ name: "a1" }, { name: "a2" }] } });
    const ups = s.calls.filter((c) => c.method === "POST");
    assert.deepEqual(ups.map((c) => c.path), ["/agents/a1/upgrade"]);
  });
  describe("upgrade guard (#5726)", () => {
    const agents = (active) => ({ ok: true, status: 200, data: { agents: [{ name: "a1", active }] } });
    const runDeps = async (argv, s, r, deps) => {
      const log = console.log; console.log = () => {};
      try { await poolFromCli([...argv, "--config", s.config], { poolDeps: { call: s.reply(r), ...deps } }); } finally { console.log = log; }
    };
    it("pool upgrade refuses while sandboxes are active", async () => {
      const s = setup();
      await assert.rejects(run(["upgrade", "a1"], s, agents(2)), /2 active sandbox/);
      assert.deepEqual(s.calls.filter((c) => c.method === "POST"), []);
    });
    it("pool upgrade --wait polls until idle then upgrades, and times out", async () => {
      const s = setup(); let polls = 0, t = 0;
      const deps = { sleep: async (ms) => { t += ms; }, now: () => t, pollMs: 1000 };
      await runDeps(["upgrade", "a1", "--wait"], s, (m, path) => (m === "GET" ? agents(++polls < 3 ? 1 : 0) : { ok: true, status: 200, data: {} }), deps);
      assert.equal(polls, 3);
      assert.deepEqual(s.calls.filter((c) => c.method === "POST").map((c) => c.path), ["/agents/a1/upgrade"]);
      const s2 = setup(); t = 0;
      await assert.rejects(runDeps(["upgrade", "a1", "--wait", "--timeout", "3"], s2, agents(1), deps), /after 3s/);
      assert.deepEqual(s2.calls.filter((c) => c.method === "POST"), []);
    });
    it("pool upgrade --now posts force:true; idle or unreported active upgrades as before", async () => {
      const s = setup(); const bodies = [];
      const reply = async (base, method, path, o) => { if (method === "POST") bodies.push(o.body); return agents(3); };
      await poolFromCli(["upgrade", "a1", "--now", "--config", s.config], { poolDeps: { call: reply } });
      assert.deepEqual(bodies, [{ force: true }]);
      for (const a of [0, undefined]) { const s3 = setup(); await runDeps(["upgrade", "a1"], s3, agents(a)); assert.equal(s3.calls.filter((c) => c.method === "POST").length, 1); }
    });
    it("a router 409 fails naming the active count", async () => {
      const s = setup();
      await assert.rejects(run(["upgrade", "a1"], s, (m) => (m === "GET" ? agents(undefined) : { ok: false, status: 409, data: { active: 4 } })), /4 active sandbox/);
    });
  });
  it("remove deletes the named agent; needs a name; surfaces router errors", async () => {
    const s = setup();
    const { out } = await run(["remove", "a1"], s, { ok: true, status: 200, data: {} });
    assert.deepEqual([s.calls[0].method, s.calls[0].path], ["DELETE", "/agents/a1"]);
    assert.match(out, /removed/);
    await assert.rejects(run(["remove"], s, {}), /usage: forgedock pool remove/);
    await assert.rejects(run(["remove", "zz"], s, { ok: false, status: 404, data: { error: "no" } }), /HTTP 404/);
  });
  it("pool upgrade --help prints usage and sends no request", async () => {
    for (const argv of [["upgrade", "--help"], ["upgrade", "-h"], ["remove", "--help"], ["resize", "-h"], ["enroll", "--help"], ["--help"]]) {
      const s = setup();
      const { out } = await run(argv, s, { ok: true, status: 200, data: { agents: [{ name: "a1" }] } });
      assert.match(out, /^usage: forgedock pool/, argv.join(" "));
      assert.equal(s.calls.length, 0, argv.join(" "));
    }
  });
  it("unknown flags on pool verbs are rejected before any request", async () => {
    for (const argv of [["upgrade", "--bogus"], ["remove", "a1", "--force"], ["resize", "a1", "--cpuz", "2"], ["enroll", "--nope"]]) {
      const s = setup();
      await assert.rejects(run(argv, s, { ok: true, status: 200, data: { agents: [{ name: "a1" }] } }), /usage: unknown flag/, argv.join(" "));
      assert.equal(s.calls.length, 0, argv.join(" "));
    }
    const s = setup();
    await run(["resize", "a1", "--cpus", "2", "--mem", "4", "--drain"], s, { ok: true, status: 200, data: {} });
    assert.equal(s.calls[0].path, "/agents/a1/resize");
  });
  it("an unknown verb is a usage error", async () => {
    await assert.rejects(poolFromCli(["bogus"], { poolDeps: {} }), /usage: forgedock pool/);
  });
});
