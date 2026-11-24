import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { natPinRules, natPinScript, natPinUnit, bridgeSubnets, ensureNatPin, netState } from "../pool/health.mjs";
import { createAgent, wslNetworkFixup } from "../pool/agent.mjs";
import { poolFromCli } from "../engine-cli.mjs";
import { tmpDir } from "./_tmp.mjs";

const WSL = () => "5.15.0-microsoft-standard-WSL2";
/** Fake sysctl/iptables/docker/wslinfo: `have` is the set of iptables rules already present, `log` records every call. */
function fake({ range = "1024 5000", mode = "mirrored", have = new Set() } = {}) {
  const log = [];
  const run = (cmd, args) => {
    log.push([cmd, ...args].join(" "));
    if (cmd === "sysctl") return `${range}\n`;
    if (cmd === "wslinfo") return mode === null ? null : `${mode}\n`;
    if (cmd === "docker" && args[1] === "ls") return "aaaaaaaaaaaa1111\nbbbbbbbbbbbb2222\n";
    if (cmd === "docker" && args[1] === "inspect") return args[4].startsWith("aaaa") ? "bridge||172.17.0.0/16 \n" : "work|br-custom|10.9.0.0/24 fd00::/64 \n";
    if (cmd === "iptables") {
      const key = args.filter((a) => !["-C", "-I", "1"].includes(a)).join(" ");
      if (args[2] === "-C") return have.has(key) ? "" : null;
      have.add(key); return "";
    }
    return null;
  };
  return { run, log, have };
}

describe("WSL mirrored NAT pin (#5923)", () => {
  it("rules per subnet and proto from the sysctl range", () => {
    const r = natPinRules([1024, 5000], [{ subnet: "172.17.0.0/16", bridge: "docker0" }, { subnet: "10.9.0.0/24", bridge: "br-custom" }]);
    assert.equal(r.length, 4);
    assert.equal(r[0].join(" "), "-t nat -I POSTROUTING 1 -s 172.17.0.0/16 ! -o docker0 -p tcp -j MASQUERADE --to-ports 1024-5000");
    assert.ok(r[3].join(" ").includes("-s 10.9.0.0/24 ! -o br-custom -p udp"));
    const f = fake();
    assert.deepEqual(bridgeSubnets({ run: f.run }), [{ subnet: "172.17.0.0/16", bridge: "docker0" }, { subnet: "10.9.0.0/24", bridge: "br-custom" }]);
  });
  it("ensureNatPin is idempotent: a -C hit skips -I", () => {
    const f = fake();
    assert.equal(ensureNatPin({ run: f.run, osrelease: WSL }).applied, 4);
    f.log.length = 0;
    assert.equal(ensureNatPin({ run: f.run, osrelease: WSL }).applied, 0);
    assert.ok(!f.log.some((l) => /iptables -t nat -I/.test(l)));
  });
  it("is a no-op off WSL, when not mirrored, and with the default range", () => {
    assert.equal(ensureNatPin({ run: fake().run, osrelease: () => "6.1.0-generic" }), null);
    assert.equal(ensureNatPin({ run: fake({ mode: "nat", range: "32768 60999" }).run, osrelease: WSL }), null);
    assert.equal(ensureNatPin({ run: fake({ mode: null, range: "32768 60999" }).run, osrelease: WSL }), null);
    assert.equal(ensureNatPin({ run: fake({ mode: null }).run, osrelease: WSL }).applied, 4); // no wslinfo: narrow range implies mirrored
  });
  it("script and unit carry the docker.service ordering and match what install-agent.sh embeds", () => {
    const u = natPinUnit();
    for (const k of ["After=docker.service", "PartOf=docker.service", "WantedBy=docker.service", "Type=oneshot", "RemainAfterExit=yes"]) assert.ok(u.includes(k), k);
    const sh = readFileSync(new URL("../../pool/install/install-agent.sh", import.meta.url), "utf8");
    const body = (tag) => new RegExp(`<<'${tag}'\\n([\\s\\S]*?)${tag}\\n`).exec(sh)?.[1];
    assert.equal(body("CS_NAT_SCRIPT"), natPinScript());
    assert.equal(body("CS_NAT_UNIT"), u);
    assert.match(natPinScript(), /iptables -t nat -C[\s\S]*iptables -t nat -I POSTROUTING 1/);
  });
  it("netState: degraded when mirrored without the pin, healthy with it, not degraded off WSL", () => {
    const f = fake();
    assert.deepEqual(netState({ run: f.run, osrelease: WSL }), { mirrored: true, port_range: "1024-5000", nat_pin: false, degraded: true });
    ensureNatPin({ run: f.run, osrelease: WSL });
    assert.deepEqual(netState({ run: f.run, osrelease: WSL }), { mirrored: true, port_range: "1024-5000", nat_pin: true, degraded: false });
    assert.equal(netState({ run: f.run, osrelease: () => "6.1.0" }).degraded, false);
    assert.equal(netState({ run: fake({ mode: "nat" }).run, osrelease: WSL }).degraded, false);
  });
  it("wslNetworkFixup re-pins on agent start", async () => {
    const calls = [];
    await wslNetworkFixup({ run: async () => ({ stdout: "default via x" }), pin: () => { calls.push(1); return null; } });
    // off WSL the fixup returns before pinning; on WSL it pins exactly once
    assert.ok(calls.length <= 1);
  });
  it("the agent status body (/health data) carries net and keeps its existing fields", () => {
    const dir = tmpDir("cs-net-"); mkdirSync(dir, { recursive: true });
    const docker = { run: async () => "", list: async () => [], ps: async () => [] };
    const state = { mirrored: true, port_range: "1024-5000", nat_pin: false, degraded: true };
    const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://r:7710", state_dir: dir, allow_cpus: 2, allow_mem_gb: 4, lease_ttl_s: 600, token: "t" }, { docker, log: { info() {}, warn() {}, error() {} }, live: () => ({ ok: true }), vm: () => ({ cpus: 8, mem_gb: 16, swap_gb: 0 }), net: () => state });
    const c = agent.capacity();
    assert.deepEqual(c.net, state);
    assert.equal(typeof c.cpus_free, "number"); assert.equal(c.host, "a1");
  });
  it("pool status prints the net line and DEGRADED for a mirrored agent without the pin", async () => {
    const dir = tmpDir("pool-nat-"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forgedock.token"), "T\n"); writeFileSync(join(dir, "enroll.token"), "E\n");
    const config = join(dir, "router.json");
    writeFileSync(config, JSON.stringify({ listen: { host: "100.1.2.3", port: 7710 }, public_url: "http://100.1.2.3:7710", enroll_token_file: join(dir, "enroll.token") }));
    const agents = [{ name: "legion", net: { mirrored: true, port_range: "1024-5000", nat_pin: false, degraded: true } }, { name: "ok", net: { mirrored: true, port_range: "1024-5000", nat_pin: true, degraded: false } }, { name: "plain" }];
    const out = []; const log = console.log; console.log = (...a) => out.push(a.join(" "));
    try { await poolFromCli(["status", "--config", config], { poolDeps: { call: async () => ({ ok: true, status: 200, data: { agents } }) } }); } finally { console.log = log; }
    const text = out.join("\n");
    assert.match(text, /legion: net mirrored, port range 1024-5000, NAT pin MISSING DEGRADED/);
    assert.match(text, /ok: net mirrored, port range 1024-5000, NAT pin present$/m);
    assert.ok(!/plain: net/.test(text));
  });
});
