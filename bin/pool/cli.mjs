#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAgent } from "./agent.mjs";
import { startRouter } from "./router.mjs";
import { dockerCli } from "./docker.mjs";
import { readSecret } from "./store.mjs";
import { call as httpCall } from "./http.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const USAGE = "usage: forgedock pool router [install] | enroll [--cpus N --mem GB --agent-url URL | --outbound] | status [--json] | pause | resume | uninstall --yes | upgrade [agent] | remove <agent>  [--config path]";
const HELP_FLAGS = ["--help", "-h"];
// Flags each verb accepts: `value` flags consume the next token, `bool` flags stand alone. Anything else dash-prefixed is rejected (#5008).
const VERB_FLAGS = {
  router: { value: ["--config"], bool: [] },
  agent: { value: ["--config"], bool: [] },
  status: { value: ["--config"], bool: ["--json"] },
  pause: { value: ["--config"], bool: [] },
  resume: { value: ["--config"], bool: [] },
  uninstall: { value: ["--config"], bool: ["--yes"] },
  upgrade: { value: ["--config"], bool: [] },
  remove: { value: ["--config"], bool: [] },
  enroll: { value: ["--config", "--cpus", "--mem", "--agent-url"], bool: ["--outbound"] },
  "install-command": { value: ["--config", "--cpus", "--mem", "--agent-url"], bool: ["--outbound"] },
  resize: { value: ["--config", "--cpus", "--mem", "--vm-cpus", "--vm-mem", "--vm-swap"], bool: ["--drain"] },
};

function rejectUnknownFlags(cmd, rest) {
  const spec = VERB_FLAGS[cmd];
  if (!spec) return;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (spec.value.includes(t)) { i++; continue; }
    if (spec.bool.includes(t)) continue;
    if (t.startsWith("-") && !/^-\d/.test(t)) throw new Error(`usage: unknown flag ${t} for 'forgedock pool ${cmd}'. ${USAGE.slice("usage: ".length)}`);
  }
}

const num = (x) => (Number.isFinite(x) ? String(Math.round(x * 10) / 10) : "-");
/** #5885: one row per host: used/borrowable/total cpus and memory, lane counts, pause state and why lanes are throttled or drained. */
export function statusTable(agents) {
  const head = ["HOST", "CPUS used/borrow/total", "MEM GB used/borrow/total", "ACTIVE", "THROTTLED", "PAUSED", "REASON"];
  const rows = agents.map((a) => {
    const name = a.name ?? a.host ?? "?";
    if (a.ok === false) return [name, "-", "-", "-", "-", "-", `unreachable${a.error ? `: ${a.error}` : ""}`];
    const used = (tot, free) => (Number.isFinite(tot) && Number.isFinite(free) ? tot - Math.max(0, free) : null);
    const borrow = (b, free) => num(b ?? free);
    const paused = a.owner_paused ? "owner" : a.paused ? (a.pending_resize ? "resize" : "yes") : "no";
    const why = [a.owner_paused ? "paused by owner" : null, a.paused && !a.owner_paused && a.pending_resize ? "draining for resize" : null,
      a.idle_gate ? `owner busy: ${a.idle_gate}` : null, a.last_drain ? `last drain ${a.last_drain.sandbox} at ${a.last_drain.at}: ${a.last_drain.reason}` : null].filter(Boolean).join("; ");
    return [name, `${num(used(a.cpus_total, a.cpus_free))}/${borrow(a.cpus_borrowable, a.cpus_free)}/${num(a.cpus_total)}`,
      `${num(used(a.mem_total_gb, a.mem_free_gb))}/${borrow(a.mem_borrowable_gb, a.mem_free_gb)}/${num(a.mem_total_gb)}`,
      String(a.active ?? "-"), String(a.throttled ?? 0), paused, why || "-"];
  });
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [head, ...rows].map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ")).join("\n");
}

/** The `forgedock pool` verbs (and the `computeshare` script). Throws on usage or router errors; `deps` injects the HTTP client and config. */
export async function runPoolCli(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  const call = deps.call ?? httpCall;
  // Help never reaches the router or starts a service (#5008).
  if (HELP_FLAGS.includes(cmd) || cmd === "help" || rest.some((x) => HELP_FLAGS.includes(x))) { console.log(USAGE); return; }
  rejectUnknownFlags(cmd, rest);
  const flag = (name, dflt) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : dflt; };

  function routerConfig() {
    const path = flag("config", process.env.COMPUTESHARE_CONFIG ?? join(homedir(), ".config/computeshare/router.json"));
    const c = loadJson(path);
    const base = dirname(path);
    return { ...c, repo_root: c.repo_root ?? repoRoot, state_dir: c.state_dir ?? join(base, "state"), forgedock_token: readSecret(c.forgedock_token_file ?? join(base, "forgedock.token")), enroll_token: readSecret(c.enroll_token_file ?? join(base, "enroll.token")) };
  }

  function agentConfig() {
    const path = flag("config", process.env.COMPUTESHARE_CONFIG ?? "/etc/computeshare/agent.json");
    const c = loadJson(path);
    return { ...c, config_path: path, token: readSecret(c.token_file ?? join(dirname(path), "agent.token")) };
  }

  switch (cmd) {
    case "router": {
      if (rest[0] === "install") {
        // The systemd --user unit (Restart=always), same as install-router.sh; the foreground form is its ExecStart.
        const r = (deps.spawn ?? spawnSync)("bash", [join(repoRoot, "pool", "install", "install-router.sh")], { stdio: "inherit" });
        if (r.status !== 0) throw new Error(`install-router.sh exited ${r.status}`);
        break;
      }
      process.title = "forgedock-pool-router"; // distinctive name for OOM-killer avoid lists and ps (#4673)
      const cfg = routerConfig();
      (deps.startRouter ?? startRouter)(cfg);
      console.log(`computeshare router on ${cfg.listen.host}:${cfg.listen.port} (public ${cfg.public_url})`);
      break;
    }
    case "agent": {
      process.title = "forgedock-pool-agent";
      const cfg = agentConfig();
      startAgent(cfg, { docker: dockerCli });
      console.log(`computeshare agent ${cfg.name} on ${cfg.listen.host}:${cfg.listen.port}: ${cfg.allow_cpus} cpus, ${cfg.allow_mem_gb} GB reserved for lanes`);
      break;
    }
    case "status": {
      const cfg = routerConfig();
      const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "GET", "/agents", { token: cfg.forgedock_token });
      if (rest.includes("--json")) console.log(JSON.stringify(r.data, null, 2));
      else if (!r.ok) throw new Error(`router refused: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      else console.log(statusTable(r.data?.agents ?? []));
      for (const a of r.data?.agents ?? []) if (a.transport) console.log(`${a.name}: transport ${a.transport}`); // #5882
      break;
    }
    case "pause":
    case "resume": {
      // #5885: the host owner stops (or restarts) new lanes on this box; running lanes finish. Loopback to the local agent, not via the router.
      const cfg = agentConfig();
      const host = !cfg.listen?.host || cfg.listen.host === "0.0.0.0" ? "127.0.0.1" : cfg.listen.host;
      const r = await call(`http://${host}:${cfg.listen.port}`, "POST", `/${cmd}`, { token: cfg.token, timeoutMs: 10000 });
      if (!r.ok) throw new Error(`agent refused ${cmd}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      console.log(cmd === "pause" ? `${cfg.name ?? "agent"}: paused; no new lanes start here (${r.data?.active ?? 0} running lane(s) finish). Undo with \`forgedock pool resume\`.` : `${cfg.name ?? "agent"}: resumed; lanes may start here again.`);
      break;
    }
    case "uninstall": {
      // #5885: the owner removes this box's agent. Destructive, so it needs --yes; running lanes are not waited for.
      const win = (deps.platform ?? process.platform) === "win32";
      const run = deps.spawn ?? spawnSync;
      if (!rest.includes("--yes")) { console.log(win ? "would run pool/install/uninstall-agent.ps1 (removes the keep-alive task, firewall rules and the computeshare WSL distro)" : "would stop and disable computeshare-agent, delete its systemd unit and /etc/computeshare"); console.log("re-run with --yes to proceed"); break; }
      const steps = win
        ? [["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repoRoot, "pool", "install", "uninstall-agent.ps1")]]]
        : [["systemctl", ["disable", "--now", "computeshare-agent"]], ["rm", ["-f", "/etc/systemd/system/computeshare-agent.service"]], ["systemctl", ["daemon-reload"]], ["rm", ["-rf", flag("config") ? dirname(flag("config")) : "/etc/computeshare"]]];
      for (const [bin, args] of steps) { const r = run(bin, args, { stdio: "inherit" }); if (r.status !== 0) throw new Error(`${bin} ${args[0]} exited ${r.status}`); }
      console.log("agent uninstalled from this box. Remove it from the router with: forgedock pool remove <agent>");
      break;
    }
    case "enroll":
    case "install-command": {
      // Prints a command carrying a one-time code (single use, expires in 30 min), never the long-lived enroll token.
      const cfg = routerConfig();
      const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "POST", "/codes", { token: cfg.forgedock_token });
      if (!r.ok) throw new Error(`router refused: HTTP ${r.status}`);
      const size = `${flag("cpus") ? `&cpus=${Number(flag("cpus"))}` : ""}${flag("mem") ? `&mem=${Number(flag("mem"))}` : ""}`;
      if (rest.includes("--outbound")) { // #5882: the agent dials this router; no agent URL, no inbound port
        console.log(`OUTBOUND=1 pool/install/install-agent-linux.sh --router '${cfg.public_url}' --token '${r.data.code}'${flag("cpus") ? ` --cpus ${Number(flag("cpus"))}` : ""}${flag("mem") ? ` --mem ${Number(flag("mem"))}` : ""}`);
        console.error(`(one-time code, expires ${r.data.expires_at}; outbound-only: the agent polls ${cfg.public_url})`);
        break;
      }
      const agentUrl = flag("agent-url"); // #5856: a host reachable only through an SSH tunnel (no Tailscale) enrolls with its tunnel URL
      if (agentUrl) {
        let u; try { u = new URL(agentUrl); } catch { u = null; }
        if (!u || !["http:", "https:"].includes(u.protocol)) throw new Error("--agent-url must be an http(s) URL, e.g. http://127.0.0.1:7711");
        console.log(`AGENT_URL='${u.origin}' pool/install/install-agent-linux.sh --router '${cfg.public_url}' --token '${r.data.code}'${flag("cpus") ? ` --cpus ${Number(flag("cpus"))}` : ""}${flag("mem") ? ` --mem ${Number(flag("mem"))}` : ""}`);
        console.error(`(one-time code, expires ${r.data.expires_at}; the router reaches the agent at ${u.origin})`);
        break;
      }
      console.log(`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '${cfg.public_url}/bootstrap/install.ps1?token=${r.data.code}${size}' | iex"`);
      console.error(`(one-time code, expires ${r.data.expires_at})`);
      break;
    }
    case "resize": {
      // computeshare resize <agent> --cpus N --mem GB [--vm-cpus N --vm-mem GB]: change a host's lane allowance remotely.
      const cfg = routerConfig();
      const name = rest.find((x) => !x.startsWith("--") && !/^\d+$/.test(x));
      const body = { cpus: Number(flag("cpus")), mem_gb: Number(flag("mem")), vm_cpus: Number(flag("vm-cpus", flag("cpus"))), vm_mem_gb: Number(flag("vm-mem", Number(flag("mem")) + 2)), drain: rest.includes("--drain"), ...(flag("vm-swap") ? { vm_swap_gb: Number(flag("vm-swap")) } : {}) };
      const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "POST", `/agents/${encodeURIComponent(name)}/resize`, { body, token: cfg.forgedock_token, timeoutMs: 30000 });
      console.log(`${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      break;
    }
    case "upgrade": {
      // Push the current code (and lane image, when its recipe changed) to one agent or all of them.
      const cfg = routerConfig();
      const base = `http://${cfg.listen.host}:${cfg.listen.port}`;
      const only = rest.find((x) => !x.startsWith("--") && x !== flag("config"));
      const list = (await call(base, "GET", "/agents", { token: cfg.forgedock_token })).data?.agents ?? [];
      for (const a of list.filter((x) => !only || x.name === only)) {
        const r = await call(base, "POST", `/agents/${encodeURIComponent(a.name)}/upgrade`, { token: cfg.forgedock_token, timeoutMs: 30000 });
        console.log(`${a.name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      }
      break;
    }
    case "remove": {
      const name = rest.find((x) => !x.startsWith("--") && x !== flag("config"));
      if (!name) throw new Error("usage: forgedock pool remove <agent>");
      const cfg = routerConfig();
      const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "DELETE", `/agents/${encodeURIComponent(name)}`, { token: cfg.forgedock_token, timeoutMs: 30000 });
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      console.log(`${name}: removed`);
      break;
    }
    default:
      throw new Error(USAGE);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPoolCli(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(String(err.message).startsWith("usage:") ? 2 : 1); });
}
