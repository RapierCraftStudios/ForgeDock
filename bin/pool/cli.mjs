#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAgent } from "./agent.mjs";
import { startRouter } from "./router.mjs";
import { dockerCli } from "./docker.mjs";
import { readSecret } from "./store.mjs";
import { call } from "./http.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : dflt; };
const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));

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
    const cfg = routerConfig();
    startRouter(cfg);
    console.log(`computeshare router on ${cfg.listen.host}:${cfg.listen.port} (public ${cfg.public_url})`);
    break;
  }
  case "agent": {
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
  case "install-command": {
    // Prints a command carrying a one-time code (single use, expires in 30 min), never the long-lived enroll token.
    const cfg = routerConfig();
    const r = await call(`http://${cfg.listen.host}:${cfg.listen.port}`, "POST", "/codes", { token: cfg.forgedock_token });
    if (!r.ok) { console.error(`router refused: HTTP ${r.status}`); process.exit(1); }
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
  default:
    console.error("usage: computeshare router|agent|status|install-command|upgrade [agent] [--config path]; install-command [--cpus N --mem GB]");
    process.exit(2);
}
