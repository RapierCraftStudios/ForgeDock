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
  const reply = (r) => async (base, method, path, o) => { calls.push({ base, method, path, token: o?.token, body: o?.body }); return typeof r === "function" ? r(method, path) : r; };
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
  it("limit sets an agent's lane ceiling; none clears it; bad input sends no request (#5735)", async () => {
    let s = setup();
    const { out } = await run(["limit", "a1", "--lanes", "2"], s, { ok: true, status: 200, data: { name: "a1", max_lanes: 2 } });
    assert.deepEqual([s.calls[0].method, s.calls[0].path, s.calls[0].body], ["POST", "/agents/a1/limit", { max_lanes: 2 }]);
    assert.match(out, /a1: max_lanes 2/);
    s = setup();
    const r2 = await run(["limit", "a1", "--lanes", "none"], s, { ok: true, status: 200, data: {} });
    assert.deepEqual(s.calls[0].body, { max_lanes: null });
    assert.match(r2.out, /a1: max_lanes none/);
    for (const argv of [["limit", "a1", "--lanes", "x"], ["limit", "a1", "--lanes", "1.5"], ["limit", "--lanes", "2"], ["limit", "a1"]]) {
      s = setup();
      await assert.rejects(run(argv, s, { ok: true, status: 200, data: {} }), /usage:/, argv.join(" "));
      assert.equal(s.calls.length, 0, argv.join(" "));
    }
    await assert.rejects(run(["limit", "zz", "--lanes", "1"], setup(), { ok: false, status: 404, data: { error: "unknown agent" } }), /HTTP 404/);
  });
  it("status prints lanes used/ceiling per agent and the cross-batch lane total (#5735)", async () => {
    const s = setup();
    const { out } = await run(["status"], s, { ok: true, status: 200, data: { agents: [{ name: "a1", lanes: { used: 1, ceiling: 2 } }, { name: "a2", lanes: { used: 3, ceiling: null } }], sandboxes: {}, remote_lanes: 4 } });
    assert.match(out, /"agents"/, "the /agents JSON is still printed");
    assert.match(out, /^a1: lanes 1\/2$/m);
    assert.match(out, /^a2: lanes 3\/-$/m);
    assert.match(out, /^remote lanes across batches: 4$/m);
  });
  it("an unknown verb is a usage error", async () => {
    await assert.rejects(poolFromCli(["bogus"], { poolDeps: {} }), /usage: forgedock pool/);
  });
});
