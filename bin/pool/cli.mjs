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

/** The `forgedock pool` verbs (and the `computeshare` script). Throws on usage or router errors; `deps` injects the HTTP client and config. */
export async function runPoolCli(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  const call = deps.call ?? httpCall;
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
      console.log(JSON.stringify(r.data, null, 2));
      break;
    }
    case "enroll":
    case "install-command": {
      // Prints a command carrying a one-time code (single use, expires in 30 min), never the long-lived enroll token.
      const cfg = routerConfig();
      const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "POST", "/codes", { token: cfg.forgedock_token });
      if (!r.ok) throw new Error(`router refused: HTTP ${r.status}`);
      const size = `${flag("cpus") ? `&cpus=${Number(flag("cpus"))}` : ""}${flag("mem") ? `&mem=${Number(flag("mem"))}` : ""}`;
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
      throw new Error("usage: forgedock pool router [install] | enroll [--cpus N --mem GB] | status | upgrade [agent] | remove <agent>  [--config path]");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPoolCli(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(String(err.message).startsWith("usage:") ? 2 : 1); });
}
