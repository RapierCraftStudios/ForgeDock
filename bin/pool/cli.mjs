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
import { agentsLeftBehind, leftBehindLine } from "./version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const USAGE = "usage: forgedock pool router [install] | enroll [--cpus N --mem GB --agent-url URL | --outbound | --one-liner] | status [--json] [--account A] | link <user_code> [--account A] | policy <agent> [--cpus N --mem GB --idle-only --pause --resume-policy] | limit <agent> --lanes N|none | pause | resume | uninstall [--yes] | upgrade [agent] [--wait [--timeout S] | --now] | remove <agent>  [--config path]";
const HELP_FLAGS = ["--help", "-h"];
// Flags each verb accepts: `value` flags consume the next token, `bool` flags stand alone. Anything else dash-prefixed is rejected (#5008).
const VERB_FLAGS = {
  router: { value: ["--config"], bool: [] },
  agent: { value: ["--config"], bool: [] },
  status: { value: ["--config", "--account"], bool: ["--json"] },
  link: { value: ["--config", "--account"], bool: [] },
  policy: { value: ["--config", "--cpus", "--mem"], bool: ["--idle-only", "--no-idle-only", "--pause", "--resume-policy"] },
  pause: { value: ["--config"], bool: [] },
  resume: { value: ["--config"], bool: [] },
  uninstall: { value: [], bool: ["--yes"] },
  upgrade: { value: ["--config", "--timeout"], bool: ["--now", "--wait"] },
  remove: { value: ["--config"], bool: [] },
  limit: { value: ["--config", "--lanes"], bool: [] },
  enroll: { value: ["--config", "--cpus", "--mem", "--agent-url"], bool: ["--outbound", "--one-liner"] },
  "install-command": { value: ["--config", "--cpus", "--mem", "--agent-url"], bool: ["--outbound", "--one-liner"] },
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

/** #6008: sandboxes kept for adopt across the batches under `root` (issue, batch, age, phase): lanes no live dispatcher awaits. */
export async function keptRows(root, { now = Date.now() } = {}) {
  try {
    const B = await import("../lean/batch.mjs"), out = [];
    for (const id of B.listBatches(root)) {
      const b = B.openBatch(root, id), last = b.lastProgressMs();
      const live = !b.readReport() && last !== null && now - last <= 10 * 60000;
      for (const k of b.keptSandboxes(live)) out.push({ batch: id, ...k });
    }
    return out;
  } catch { return []; }
}
export const keptLines = (rows) => rows.length ? [`kept sandboxes (${rows.length}):`, ...rows.map((k) => `  #${k.issue} batch ${k.batch} age ${Math.round((k.ageMs ?? 0) / 60000)}m phase ${k.phase ?? "?"}`)] : [];
const num = (x) => (Number.isFinite(x) ? String(Math.round(x * 10) / 10) : "-");
/** #5885: one row per host: used/borrowable/total cpus and memory, lane counts, pause state and why lanes are throttled or drained. */
export function statusTable(agents) {
  const withAccount = agents.some((a) => a.account); // #5886: the column appears only when an agent has an account
  const withEngine = agents.some((a) => a.engine_version); // the ENGINE column appears only when an agent reports its lane engine
  const head = ["HOST", ...(withAccount ? ["ACCOUNT"] : []), "CPUS used/borrow/total", "MEM GB used/borrow/total", "ACTIVE", "THROTTLED", "PAUSED", ...(withEngine ? ["ENGINE"] : []), "REASON"];
  const rows = agents.map((a) => {
    const name = a.name ?? a.host ?? "?";
    const acct = withAccount ? [a.account ?? "-"] : [];
    if (a.ok === false) return [name, ...acct, "-", "-", "-", "-", ...(withEngine ? ["-"] : []), "-", `unreachable${a.error ? `: ${a.error}` : ""}`];
    const used = (tot, free) => (Number.isFinite(tot) && Number.isFinite(free) ? tot - Math.max(0, free) : null);
    const borrow = (b, free) => num(b ?? free);
    const paused = a.owner_paused ? "owner" : a.paused ? (a.pending_resize ? "resize" : "yes") : "no";
    const why = [a.owner_paused ? "paused by owner" : null, a.paused && !a.owner_paused && a.pending_resize ? "draining for resize" : null,
      Number.isInteger(a.lane_target) ? `lane target ${a.lane_target}/${a.lane_ceiling ?? "-"}` : null, a.draining && !a.owner_paused && !a.pending_resize ? `draining: ${a.draining_reason ?? "yes"}` : null,
      a.idle_gate ? `owner busy: ${a.idle_gate}` : null, a.last_drain ? `last drain ${a.last_drain.sandbox} at ${a.last_drain.at}: ${a.last_drain.reason}` : null].filter(Boolean).join("; ");
    return [name, ...acct, `${num(used(a.cpus_total, a.cpus_free))}/${borrow(a.cpus_borrowable, a.cpus_free)}/${num(a.cpus_total)}`,
      `${num(used(a.mem_total_gb, a.mem_free_gb))}/${borrow(a.mem_borrowable_gb, a.mem_free_gb)}/${num(a.mem_total_gb)}`,
      String(a.active ?? "-"), String(a.throttled ?? 0), paused, ...(withEngine ? [a.engine_version ? `${a.engine_version}${a.engine_skew ? " SKEW" : ""}` : "-"] : []), why || "-"];
  });
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [head, ...rows].map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ")).join("\n");
}

/** The `forgedock pool` verbs (and the `computeshare` script). Throws on usage or router errors; `deps` injects the HTTP client and config. */
/** #5901: one line per agent cache volume with each repo's depcache size, from the router's /agents view. */
export function depcacheLines(agents) {
  const out = [];
  for (const a of agents ?? []) for (const [vol, v] of Object.entries(a.cache_volumes ?? {})) {
    const repos = Object.entries(v.depcache_gb ?? {}).map(([k, gb]) => `${k} ${gb} GB`).join(", ");
    if (repos) out.push(`${a.name} ${vol}: depcache ${repos}`);
  }
  return out;
}

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
      const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "GET", `/agents${flag("account") ? `?account=${encodeURIComponent(flag("account"))}` : ""}`, { token: cfg.forgedock_token });
      const kept = await keptRows((await import("../lean/batch.mjs")).batchRoot());
      if (rest.includes("--json")) console.log(JSON.stringify(r.data && typeof r.data === "object" && !Array.isArray(r.data) && kept.length ? { ...r.data, kept_sandboxes: kept } : r.data, null, 2));
      else if (!r.ok) throw new Error(`router refused: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      else console.log(statusTable(r.data?.agents ?? []));
      if (!rest.includes("--json") && r.ok) for (const l of depcacheLines(r.data?.agents)) console.log(l); // #5901
      if (!rest.includes("--json")) for (const l of keptLines(kept)) console.log(l); // #6008
      // #5735: lane sandboxes used/ceiling per agent, and the lane total across all batches
      for (const a of Array.isArray(r.data?.agents) ? r.data.agents : []) if (a?.lanes) console.log(`${a.name}: lanes ${a.lanes.used}/${a.lanes.ceiling ?? "-"}`);
      if (Number.isInteger(r.data?.remote_lanes)) console.log(`remote lanes across batches: ${r.data.remote_lanes}`);
      for (const a of r.data?.agents ?? []) {
        if (a.transport) console.log(`${a.name}: transport ${a.transport}`); // #5882
        const n = a.net; // #5923
        if (n?.mirrored) console.log(`${a.name}: net mirrored, port range ${n.port_range ?? "?"}, NAT pin ${n.nat_pin ? "present" : "MISSING"}${n.degraded ? " DEGRADED" : ""}`);
        if (Number.isFinite(a.host_mem_free_gb)) console.error(`${a.name}: host_mem_free_gb ${a.host_mem_free_gb}${Array.isArray(a.vmmem) && a.vmmem.length ? `, other VMs: ${a.vmmem.map((v) => `${v.name} ${v.gb} GB`).join(", ")}` : ""}${a.host_mem_low ? " WARNING: host memory below the floor, new sandboxes are refused" : ""}`); // #5967
        if (!Number.isFinite(a.host_disk_free_gb)) continue;
        console.error(`${a.name}: host_disk_free_gb ${a.host_disk_free_gb}${Number.isFinite(a.host_disk_growth_gb_per_h) ? `, growth ${a.host_disk_growth_gb_per_h} GB/h` : ""}${a.disk_warning ? ` WARNING: ${a.disk_warning}` : ""}`);
      }
      break;
    }
    case "link": {
      // #5886: approve the user code a box printed (`install ... --device`), binding it to an account; the box then enrolls itself.
      const code = rest.find((x) => !x.startsWith("--") && x !== flag("config") && x !== flag("account"));
      if (!code) throw new Error("usage: forgedock pool link <user_code> [--account A]");
      const cfg = routerConfig();
      const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "POST", "/device/approve", { body: { user_code: code, ...(flag("account") ? { account: flag("account") } : {}) }, token: cfg.forgedock_token });
      if (!r.ok) throw new Error(`router refused: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      console.log(`linked ${code} to account ${r.data.account}; the box enrolls on its next poll`);
      break;
    }
    case "policy": {
      // #5886: a per-box policy the router stores and pushes; the box owner's own pause is never cleared by it.
      const name = rest.find((x) => !x.startsWith("--") && x !== flag("config") && x !== flag("cpus") && x !== flag("mem"));
      if (!name) throw new Error("usage: forgedock pool policy <agent> [--cpus N --mem GB --idle-only --pause]");
      const body = { ...(flag("cpus") ? { cpus: Number(flag("cpus")) } : {}), ...(flag("mem") ? { mem_gb: Number(flag("mem")) } : {}),
        ...(rest.includes("--idle-only") ? { idle_only: true } : rest.includes("--no-idle-only") ? { idle_only: false } : {}),
        ...(rest.includes("--pause") ? { paused: true } : rest.includes("--resume-policy") ? { paused: false } : {}) };
      if (!Object.keys(body).length) throw new Error("usage: forgedock pool policy <agent> [--cpus N --mem GB --idle-only --pause]");
      const cfg = routerConfig();
      const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "PUT", `/agents/${encodeURIComponent(name)}/policy`, { body, token: cfg.forgedock_token, timeoutMs: 30000 });
      if (!r.ok && r.status !== 202) throw new Error(`${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      console.log(`${name}: policy ${JSON.stringify(r.data?.policy ?? body)}${r.data?.pushed === false ? " (stored; the box is unreachable, it is re-pushed when it returns)" : ""}`);
      break;
    }
    case "limit": {
      // #5735: forgedock pool limit <agent> --lanes N|none: the agent's lane sandbox ceiling across all batches.
      const name = rest.find((x, i) => !x.startsWith("--") && !["--lanes", "--config"].includes(rest[i - 1]));
      const v = flag("lanes");
      if (!name || v === undefined) throw new Error("usage: forgedock pool limit <agent> --lanes N|none");
      if (v !== "none" && !/^\d+$/.test(v)) throw new Error("usage: --lanes must be a non-negative integer or none");
      const max_lanes = v === "none" ? null : parseInt(v, 10);
      const cfg = routerConfig();
      const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "POST", `/agents/${encodeURIComponent(name)}/limit`, { body: { max_lanes }, token: cfg.forgedock_token, timeoutMs: 30000 });
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      console.log(`${name}: max_lanes ${max_lanes ?? "none"}`);
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
      // The shipped per-OS scripts (#5883) own the teardown at fixed install paths; no path from the command line reaches a delete, and
      // without --yes the script's own --dry-run is the preview, so what is shown is what --yes does.
      const platform = deps.platform ?? process.platform;
      const run = deps.spawn ?? spawnSync;
      const dir = join(repoRoot, "pool", "install");
      const dry = !rest.includes("--yes");
      const steps = platform === "win32"
        ? (dry ? [] : [["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dir, "uninstall-agent.ps1")]]])
        : [["bash", [join(dir, platform === "darwin" ? "uninstall-agent-macos.sh" : "uninstall-agent-linux.sh"), ...(dry ? ["--dry-run"] : [])]]];
      if (dry && platform === "win32") console.log("would run pool/install/uninstall-agent.ps1 (removes the keep-alive task, firewall rules and the computeshare WSL distro)");
      for (const [bin, args] of steps) { const r = run(bin, args, { stdio: "inherit" }); if (r.status !== 0) throw new Error(`${bin} ${args[0]} exited ${r.status}`); }
      if (dry) { console.log("re-run with --yes to proceed"); break; }
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
      const sizeFlags = `${flag("cpus") ? ` --cpus ${Number(flag("cpus"))}` : ""}${flag("mem") ? ` --mem ${Number(flag("mem"))}` : ""}`;
      if (rest.includes("--outbound") || rest.includes("--one-liner")) { // #5883: Linux/macOS one command, served by GET /install (always outbound)
        console.log(`curl -fsSL '${cfg.public_url}/install' | sh -s -- --code '${r.data.code}'${sizeFlags}`);
        console.error("(run as root: as a sudo user, write `| sudo sh -s -- ...`)");
        if (!rest.includes("--outbound")) {
          console.error(`(one-time code, expires ${r.data.expires_at}; outbound-only: the agent polls ${cfg.public_url}; uninstall: curl -fsSL '${cfg.public_url}/install' | sh -s -- --uninstall)`);
          break;
        }
        console.error("(or, from a ForgeDock checkout on Linux:)");
      }
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
      const only = rest.find((x) => !x.startsWith("--") && x !== flag("config") && x !== flag("timeout"));
      const now = rest.includes("--now"), wait = rest.includes("--wait");
      const timeoutS = flag("timeout") === undefined ? 1800 : Number(flag("timeout"));
      if (!Number.isFinite(timeoutS) || timeoutS < 0) throw new Error("usage: --timeout takes a number of seconds");
      const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
      const clock = deps.now ?? Date.now;
      const agentsNow = async () => (await call(base, "GET", "/agents", { token: cfg.forgedock_token })).data?.agents ?? [];
      const list = await agentsNow();
      for (const a of list.filter((x) => !only || x.name === only)) {
        // The pool host is shared: upgrading restarts the agent under live sandboxes, so refuse unless asked (--wait drains, --now forces).
        let active = a.active;
        if (Number(active) > 0 && wait && !now) {
          const deadline = clock() + timeoutS * 1000;
          while (Number(active) > 0) {
            if (clock() >= deadline) throw new Error(`${a.name}: still ${active} active sandbox(es) after ${timeoutS}s; not upgraded`);
            await sleep(deps.pollMs ?? 10000);
            active = (await agentsNow()).find((x) => x.name === a.name)?.active;
          }
        } else if (Number(active) > 0 && !now) {
          throw new Error(`${a.name}: ${active} active sandbox(es) on this shared host; not upgraded. Use --wait to wait for idle, or --now to force.`);
        }
        const r = await call(base, "POST", `/agents/${encodeURIComponent(a.name)}/upgrade`, { body: now ? { force: true } : undefined, token: cfg.forgedock_token, timeoutMs: 30000 });
        if (r.status === 409) throw new Error(`${a.name}: ${r.data?.active ?? "some"} active sandbox(es); not upgraded (HTTP 409)`);
        console.log(`${a.name}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
      }
      // R5: name the agents still on an older engine once the pushes are done (an agent restarts asynchronously, so this can lag briefly).
      const behind = deps.leftBehind ? await deps.leftBehind(base, cfg) : deps.call ? [] : await (async () => { // a custom `call` seam is a fixture without /status
        const get = (p) => httpCall(base, "GET", p, { token: cfg.forgedock_token }).catch(() => null);
        const target = (await get("/version"))?.data?.version;
        return agentsLeftBehind((await get("/status"))?.data?.agents, target).map((r) => ({ ...r, target }));
      })();
      if (behind.length) console.log(leftBehindLine(behind, behind[0].target));
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
