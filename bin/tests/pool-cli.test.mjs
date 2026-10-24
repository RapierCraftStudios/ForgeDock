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
  it("remove deletes the named agent; needs a name; surfaces router errors", async () => {
    const s = setup();
    const { out } = await run(["remove", "a1"], s, { ok: true, status: 200, data: {} });
    assert.deepEqual([s.calls[0].method, s.calls[0].path], ["DELETE", "/agents/a1"]);
    assert.match(out, /removed/);
    await assert.rejects(run(["remove"], s, {}), /usage: forgedock pool remove/);
    await assert.rejects(run(["remove", "zz"], s, { ok: false, status: 404, data: { error: "no" } }), /HTTP 404/);
  });
  it("an unknown verb is a usage error", async () => {
    await assert.rejects(poolFromCli(["bogus"], { poolDeps: {} }), /usage: forgedock pool/);
  });
});
