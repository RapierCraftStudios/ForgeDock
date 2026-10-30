// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderContract } from "./render.mjs";
import { parseRelayCommands, relayCommandNames, relayGate, runRelayed, simpleArgv, relayPrefetchCommands, servicePending, RELAY_REFUSED_RC } from "./relay.mjs";
import { parseExecution, placeLane, providerByName } from "./execution.mjs";
import { remoteProvider } from "./sandbox-remote.mjs";
import { readRelayCaps } from "../engine-cli.mjs";

const RELAY = { prod_monitor: ["obs-psql", "obs-*"] };
const contractComment = (c) => "<!-- FORGE:CONTRACT -->\n<!-- FORGE:PLAN -->\n" + renderContract({ requirements: [], deliverables: [], ...c }, "abcdef123456");

function fakeTransport({ pending = [] } = {}) {
  const t = {
    specs: [], answers: [], pending,
    async launch(spec) { t.specs.push(spec); return { id: spec.id }; },
    async status() { return "running"; },
    async relayPending() { const p = t.pending; t.pending = []; return p; },
    async relayAnswer(id, rid, out) { t.answers.push({ id, rid, ...out }); return true; },
  };
  return t;
}

describe("#4778 relay allowlist", () => {
  it("parseRelayCommands: capability:command, exact or trailing-* glob; invalid entries ignored", () => {
    assert.deepEqual(parseRelayCommands("prod_monitor:obs-psql, prod_monitor:obs-*, Prod_Monitor:obs-psql"), RELAY);
    assert.deepEqual(parseRelayCommands(["x:/usr/bin/psql", "x:a b", "x:o*bs", "x:*", ":obs", "obs", "Bad Cap:obs", "x:**"]), {});
    assert.deepEqual(parseRelayCommands(undefined), {});
    assert.deepEqual(relayCommandNames(RELAY), ["obs-psql"]);
  });

  it("relayGate allows only allowlisted names, never paths, empty or non-string argv", () => {
    assert.deepEqual(relayGate(["obs-psql", "-c", "select 1"], RELAY), { ok: true, capability: "prod_monitor" });
    assert.equal(relayGate(["obs-logs"], RELAY).ok, true);
    for (const argv of [["rm", "-rf", "/"], ["/usr/bin/obs-psql"], ["./obs-psql"], ["obs-"], ["sops", "-d", "x"], [], "obs-psql", [1], ["obs-psql; rm"]]) {
      const g = relayGate(argv, RELAY);
      assert.equal(g.ok, false, JSON.stringify(argv));
      assert.match(g.reason, /relay: /);
    }
    assert.match(relayGate(["rm", "-rf", "/"], RELAY).reason, /^relay: rm not allowlisted$/);
    assert.equal(relayGate(["obs-psql"], {}).ok, false);
  });
});

describe("#4778 runRelayed", () => {
  it("execFile with shell:false, the cap and timeout; secrets redacted", async () => {
    let seen;
    const execFileFn = (cmd, args, opts, cb) => { seen = { cmd, args, opts }; cb(null, "row tok-SECRET-1\n", "warn"); };
    const out = await runRelayed(["obs-psql", "-c", "select 1; drop table x"], { secrets: ["tok-SECRET-1"], execFileFn });
    assert.deepEqual(out, { rc: 0, stdout: "row [redacted]\n", stderr: "warn" });
    assert.deepEqual([seen.cmd, seen.args], ["obs-psql", ["-c", "select 1; drop table x"]]);
    assert.equal(seen.opts.shell, false); assert.equal(seen.opts.timeout, 120000); assert.equal(seen.opts.maxBuffer, 1 << 20);
  });

  it("maps missing command, timeout, cap and exit codes; a real child runs with no shell", async () => {
    const fail = (err, so = "", se = "") => (c, a, o, cb) => cb(Object.assign(new Error("x"), err), so, se);
    assert.equal((await runRelayed(["obs-x"], { execFileFn: fail({ code: "ENOENT" }) })).rc, 127);
    assert.equal((await runRelayed(["obs-x"], { execFileFn: fail({ killed: true }) })).rc, 124);
    const big = await runRelayed(["obs-x"], { execFileFn: fail({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) });
    assert.equal(big.truncated, true);
    assert.equal((await runRelayed(["obs-x"], { execFileFn: fail({ code: 3 }, "", "boom") })).rc, 3);
    assert.equal((await runRelayed(["obs-x"], { execFileFn: () => { throw new Error("spawn"); } })).rc, 1);
    const real = await runRelayed(["echo", "a;b", "$HOME"]);
    assert.deepEqual([real.rc, real.stdout], [0, "a;b $HOME\n"]);
  });
});

describe("#4778 pre-fetch", () => {
  it("simpleArgv splits one simple command, else null", () => {
    assert.deepEqual(simpleArgv(`obs-psql -c 'select 1;' "a b" c\\ d`), ["obs-psql", "-c", "select 1;", "a b", "c d"]);
    for (const c of ["obs-psql | head", "obs-psql; rm x", "obs-psql && x", "obs-psql > f", "obs-psql $X", "obs-psql `x`", 'obs-psql "$X"', "a\nb", "obs-psql 'open", ""]) assert.equal(simpleArgv(c), null, c);
  });

  it("relayPrefetchCommands: the last contract's simple, allowlisted validate/repro commands", () => {
    const comments = [
      { body: contractComment({ validate: [{ id: "V1", command: "obs-psql -c old" }] }) },
      { body: "unrelated" },
      { body: contractComment({ validate: [{ id: "V1", command: "obs-psql -c 'select 1'" }, { id: "V2", command: "node --test a.mjs" }, { id: "V3", command: "obs-psql -c x | head" }, { id: "V4", command: "obs-psql -c 'select 1'" }], repro_test: { command: "obs-logs api" } }) },
    ];
    assert.deepEqual(relayPrefetchCommands({ comments }, RELAY), [{ argv: ["obs-psql", "-c", "select 1"] }, { argv: ["obs-logs", "api"] }]);
    assert.deepEqual(relayPrefetchCommands({ comments }, {}), []);
    assert.deepEqual(relayPrefetchCommands({ comments: [] }, RELAY), []);
  });
});

describe("#4778 servicePending", () => {
  it("runs allowlisted requests, refuses the rest without running them (rc 126), swallows errors", async () => {
    const t = fakeTransport({ pending: [{ rid: "r1", argv: ["obs-psql", "-c", "select 1"] }, { rid: "r2", argv: ["rm", "-rf", "/"] }, { rid: "", argv: ["obs-psql"] }] });
    const ran = [];
    const n = await servicePending({ transport: t, id: "s1", relay: RELAY, run: async (argv) => { ran.push(argv); return { rc: 0, stdout: "1\n", stderr: "" }; } });
    assert.equal(n, 2);
    assert.deepEqual(ran, [["obs-psql", "-c", "select 1"]]);
    assert.deepEqual(t.answers, [{ id: "s1", rid: "r1", rc: 0, stdout: "1\n", stderr: "" }, { id: "s1", rid: "r2", rc: RELAY_REFUSED_RC, stdout: "", stderr: "relay: rm not allowlisted" }]);
    assert.equal(await servicePending({ transport: { relayPending: async () => { throw new Error("down"); }, relayAnswer: async () => {} }, id: "s1", relay: RELAY }), 0);
    assert.equal(await servicePending({ transport: {}, id: "s1", relay: RELAY }), 0);
    const bad = { relayPending: async () => [{ rid: "r", argv: ["obs-psql"] }], relayAnswer: async () => { throw new Error("502"); } };
    assert.equal(await servicePending({ transport: bad, id: "s1", relay: RELAY, run: async () => ({ rc: 0, stdout: "", stderr: "" }) }), 0);
  });
});

describe("#4778 provider and config", () => {
  it("parseExecution reads relay_commands; without it the output is unchanged", () => {
    assert.deepEqual(parseExecution({ mode: "remote", relay_commands: ["prod_monitor:obs-psql", "bad cap:x"] }).relay, { prod_monitor: ["obs-psql"] });
    assert.equal("relay" in parseExecution({ mode: "remote" }), false);
    assert.equal("relay" in parseExecution({ mode: "remote", relay_commands: "x:/bin/sh" }), false);
  });

  it("remote provider exposes relays, so placeLane places a relayed need remote; others stay local", () => {
    const exec = parseExecution({ mode: "remote", max_remote: "2", provider: "remote", endpoint: "http://r", relay_commands: "prod_monitor:obs-psql" });
    const p = providerByName("remote", { batch: { id: "b" }, repo: "o/r", exec, env: {}, transport: fakeTransport() });
    assert.deepEqual(p.relays, ["prod_monitor"]);
    assert.equal(placeLane({ exec, needs: ["prod_monitor"], relays: p.relays }).where, "remote");
    assert.deepEqual(placeLane({ exec, needs: ["sops"], relays: p.relays }), placeLane({ exec, needs: ["sops"] }));
    assert.match(placeLane({ exec, needs: ["sops"], relays: p.relays }).reason, /host capability: sops/);
    const noRelay = { ...fakeTransport() }; delete noRelay.relayPending;
    assert.deepEqual(providerByName("remote", { batch: { id: "b" }, repo: "o/r", exec, env: {}, transport: noRelay }).relays, []);
  });

  it("start ships relay env and the pre-fetch, never a host secret; status services the relay without changing its result", async () => {
    const t = fakeTransport();
    const ran = [];
    const relayRun = async (argv, { secrets }) => { ran.push(argv); return { rc: 0, stdout: `out ${secrets.includes("host-secret-xyz") ? "known" : "?"} host-secret-xyz`, stderr: "" }; };
    const p = remoteProvider({ batch: { id: "b" }, repo: "o/r", transport: t, env: { FD_TOKEN: "host-secret-xyz" }, gitIdentity: () => null, relayRun,
      settings: { secrets: ["FD_TOKEN"], relay: RELAY, prefetch: (n) => (n === 7 ? [{ argv: ["obs-psql", "-c", "select 1"] }, { argv: ["obs-big"] }] : []) } });
    const h = await p.start({ issue: 7, args: [] });
    const env = t.specs[0].env;
    assert.equal(env.CS_RELAY_COMMANDS, "obs-psql"); assert.equal(env.CS_RELAY_CAPS, "prod_monitor");
    const pre = JSON.parse(Buffer.from(env.CS_RELAY_PREFETCH_B64, "base64").toString());
    assert.deepEqual(pre.map((x) => x.argv), [["obs-psql", "-c", "select 1"], ["obs-big"]]);
    const leak = Object.entries(env).filter(([k, v]) => k.startsWith("CS_RELAY") && String(v).includes("host-secret-xyz"));
    assert.deepEqual(leak, []);
    assert.ok(!Buffer.from(env.CS_RELAY_PREFETCH_B64, "base64").toString().includes("host-secret-xyz"));
    // an entry past the 96 KB cap is dropped
    const tb = fakeTransport();
    await remoteProvider({ batch: { id: "b" }, repo: "o/r", transport: tb, env: {}, gitIdentity: () => null, relayRun: async () => ({ rc: 0, stdout: "x".repeat(200 * 1024), stderr: "" }),
      settings: { relay: RELAY, prefetch: () => [{ argv: ["obs-big"] }] } }).start({ issue: 1, args: [] });
    assert.equal("CS_RELAY_PREFETCH_B64" in tb.specs[0].env, false);
    t.pending = [{ rid: "r1", argv: ["obs-psql"] }, { rid: "r2", argv: ["cat", "/etc/shadow"] }];
    assert.equal(await p.status(h), "running");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(t.answers.map((a) => [a.rid, a.rc]), [["r1", 0], ["r2", RELAY_REFUSED_RC]]);
    assert.ok(!ran.some((a) => a[0] === "cat"));
    const throwing = fakeTransport(); throwing.relayPending = async () => { throw new Error("router down"); };
    const q = remoteProvider({ batch: { id: "b" }, repo: "o/r", transport: throwing, env: {}, gitIdentity: () => null, settings: { relay: RELAY } });
    assert.equal(await q.status(await q.start({ issue: 2, args: [] })), "running");
    const plain = fakeTransport();
    await remoteProvider({ batch: { id: "b" }, repo: "o/r", transport: plain, env: {}, gitIdentity: () => null }).start({ issue: 3, args: [] });
    assert.deepEqual(Object.keys(plain.specs[0].env).filter((k) => k.startsWith("CS_RELAY")), []);
  });

  it("readRelayCaps parses CS_RELAY_CAPS", () => {
    assert.deepEqual(readRelayCaps({ CS_RELAY_CAPS: "prod_monitor, Bad Cap ,prod_monitor,obs" }), { relayCaps: ["prod_monitor", "obs"] });
    assert.deepEqual(readRelayCaps({}), {});
  });
});
