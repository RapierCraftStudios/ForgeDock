import { tmpDir } from "./_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
  it("status prints host_disk_free_gb, growth GB/h and the warning per agent on stderr, JSON stays on stdout (#5891 R11/R12)", async () => {
    const s = setup();
    const agents = [{ name: "a1", host_disk_free_gb: 42.5, host_disk_growth_gb_per_h: 30, disk_warning: "host drive full in ~1.4 h" }, { name: "a2" }];
    const { out, err } = await run(["status", "--json"], s, { ok: true, status: 200, data: { agents } });
    assert.equal(JSON.parse(out).agents.length, 2);
    assert.match(err, /a1: host_disk_free_gb 42\.5, growth 30 GB\/h WARNING: host drive full in ~1\.4 h/);
    assert.doesNotMatch(err, /a2/);
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
  it("status renders a per-host table of used/borrowable capacity and the throttle/drain reason; --json stays raw (#5885)", async () => {
    const s = setup();
    const data = { agents: [
      { name: "legion", ok: true, transport: "outbound", cpus_total: 12, cpus_free: 8, cpus_borrowable: 8, mem_total_gb: 20, mem_free_gb: 14, mem_borrowable_gb: 14, active: 2, throttled: 1, paused: false, owner_paused: false, idle_only: true,
        idle_gate: "owner load 0.90/core (> 0.5)", last_drain: { reason: "owner busy: owner load 0.90/core (> 0.5)", at: "2026-11-24T10:00:00.000Z", sandbox: "b7" } },
      { name: "box2", ok: true, cpus_total: 4, cpus_free: 4, mem_total_gb: 8, mem_free_gb: 8, active: 0, paused: true, owner_paused: true },
      { name: "gone", ok: false, error: "HTTP 502" },
    ], sandboxes: {} };
    const { out } = await run(["status"], s, { ok: true, status: 200, data });
    assert.deepEqual([s.calls[0].method, s.calls[0].path, s.calls[0].token], ["GET", "/agents", "FD-SECRET"]);
    assert.match(out, /^HOST\s+CPUS used\/borrow\/total\s+MEM GB used\/borrow\/total\s+ACTIVE\s+THROTTLED\s+PAUSED\s+REASON/);
    const row = (n) => out.split("\n").find((l) => l.startsWith(n));
    assert.match(row("legion"), /^legion\s+4\/8\/12\s+6\/14\/20\s+2\s+1\s+no\s+owner busy: owner load 0\.90\/core \(> 0\.5\); last drain b7 at 2026-11-24T10:00:00\.000Z: owner busy/);
    assert.match(row("box2"), /0\/4\/4\s+0\/8\/8\s+0\s+0\s+owner\s+paused by owner/);
    assert.match(row("gone"), /unreachable: HTTP 502/);
    assert.match(out, /legion: transport outbound/);
    assert.doesNotMatch(out, /"agents"/);
    const raw = await run(["status", "--json"], s, { ok: true, status: 200, data });
    assert.deepEqual(JSON.parse(raw.out.split("\nlegion: transport")[0]), data);
    await assert.rejects(run(["status", "--jsn"], s, { ok: true, status: 200, data }), /usage: unknown flag/);
  });
  it("pause and resume call the local agent on loopback with its token, not the router (#5885)", async () => {
    const s = setup();
    const dir = dirname(s.config);
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ name: "legion", listen: { host: "0.0.0.0", port: 7711 } }));
    writeFileSync(join(dir, "agent.token"), "AGENT-SECRET\n");
    const as = { ...s, config: join(dir, "agent.json") };
    const p = await run(["pause"], as, { ok: true, status: 200, data: { ok: true, owner_paused: true, active: 1 } });
    const r = await run(["resume"], as, { ok: true, status: 200, data: { ok: true, owner_paused: false, active: 1 } });
    assert.deepEqual(s.calls.map((c) => [c.base, c.method, c.path, c.token]), [["http://127.0.0.1:7711", "POST", "/pause", "AGENT-SECRET"], ["http://127.0.0.1:7711", "POST", "/resume", "AGENT-SECRET"]]);
    assert.match(p.out, /legion: paused; .*1 running lane/);
    assert.match(r.out, /legion: resumed/);
    await assert.rejects(run(["pause"], as, { ok: false, status: 401, data: { error: "unauthorized" } }), /agent refused pause: HTTP 401/);
    await assert.rejects(run(["pause", "--force"], as, {}), /usage: unknown flag/);
  });
  it("uninstall needs --yes, then stops the unit and removes its files (#5885)", async () => {
    const s = setup();
    const seen = [];
    const spawn = (bin, args) => { seen.push([bin, ...args].join(" ")); return { status: 0 }; };
    const run2 = async (argv, deps) => { const out = []; const log = console.log; console.log = (...a) => out.push(a.join(" ")); try { await poolFromCli([...argv, "--config", s.config], { poolDeps: deps }); } finally { console.log = log; } return out.join("\n"); };
    const dry = await run2(["uninstall"], { spawn, platform: "linux" });
    assert.deepEqual(seen, []);
    assert.match(dry, /would stop and disable computeshare-agent[\s\S]*--yes/);
    const out = await run2(["uninstall", "--yes"], { spawn, platform: "linux" });
    assert.match(seen[0], /^systemctl disable --now computeshare-agent$/);
    assert.equal(seen.length, 4);
    assert.match(out, /agent uninstalled/);
    seen.length = 0;
    await run2(["uninstall", "--yes"], { spawn, platform: "win32" });
    assert.match(seen[0], /^powershell .*uninstall-agent\.ps1$/);
    await assert.rejects(run2(["uninstall", "--yes"], { spawn: () => ({ status: 1 }), platform: "linux" }), /exited 1/);
    await assert.rejects(run2(["uninstall", "--force"], {}), /usage: unknown flag/);
  });
  it("an unknown verb is a usage error", async () => {
    await assert.rejects(poolFromCli(["bogus"], { poolDeps: {} }), /usage: forgedock pool/);
  });
});
