// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test sandboxes (#5450): throwaway service containers (database, cache, API) a lane's validate commands need. A frozen
 * validate entry declares `env: [name, ...]`; each name is a forge.yaml `verify.sandboxes` entry. Nothing is created for a
 * lane whose contract names no env. Each lane gets its own containers (`forge-sbx-<lane>-<name>`, ephemeral loopback ports,
 * forgedock.* labels), registered in the lane ledger as kind `container` BEFORE they exist, so teardown and `forgedock gc`
 * reclaim them after a crash. A name no entry defines, or a host without Docker, is a typed `unavailable` result the lane
 * ends on, never a skip. Each sandbox exports `SANDBOX_<NAME>_URL` (a `fixtures:` entry exports `SANDBOX_<NAME>_DIR`).
 * All I/O is injected: `docker(args) -> stdout` (throws on failure), `exec({command, env}) -> {rc}`, `sleep(ms)`.
 */
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dockerLabels, makeLedger, safeSegment } from "./ledger.mjs";

const NAME_RE = /^[a-z][a-z0-9_-]*$/;
const KNOWN = { postgres: { port: 5432, env: ["POSTGRES_PASSWORD=sandbox"], url: (p) => `postgresql://postgres:sandbox@127.0.0.1:${p}/postgres`, ready: ["pg_isready", "-U", "postgres"] }, redis: { port: 6379, url: (p) => `redis://127.0.0.1:${p}`, ready: ["redis-cli", "ping"] } };
const envName = (n) => `SANDBOX_${n.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

/** Split on `sep` outside quotes and brackets. */
function splitTop(s, sep) {
  const out = []; let depth = 0, q = null, cur = "";
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/s, "$2");
/** `{ image: postgres:16, needs: [a, b] }` (the one-line form readYamlMap returns) or an object -> plain object. */
function flowMap(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  const s = str(raw).replace(/^\{(.*)\}$/s, "$1");
  const o = {};
  for (const part of splitTop(s, ",")) {
    const i = part.indexOf(":");
    if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    o[k] = v.startsWith("[") ? splitTop(v.replace(/^\[(.*)\]$/s, "$1"), ",").map(unquote).filter(Boolean) : unquote(v);
  }
  return o;
}

/** forge.yaml `verify.sandboxes` -> `{name: {image|compose+service|fixtures, needs[], init, ttl, for, port, ready}}`; invalid entries dropped. */
export function parseSandboxes(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, v] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) continue;
    const s = flowMap(v);
    const image = str(s.image), compose = str(s.compose), service = str(s.service), fixtures = str(s.fixtures);
    if (!(image || (compose && service) || fixtures)) continue;
    const needs = (Array.isArray(s.needs) ? s.needs : str(s.needs).split(",")).map((x) => str(x)).filter(Boolean);
    const port = Number(str(s.port));
    out[name] = { ...(image ? { image } : {}), ...(compose && service ? { compose, service } : {}), ...(fixtures ? { fixtures } : {}), needs, ...(str(s.init) ? { init: str(s.init) } : {}),
      ...(str(s.ttl) ? { ttl: str(s.ttl) } : {}), ...(str(s.for) ? { for: str(s.for) } : {}), ...(Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}), ...(str(s.ready) ? { ready: str(s.ready) } : {}) };
  }
  return out;
}

/** The env names a frozen contract's validate entries declare (unique, in order); [] when none. */
export function envNamesOf(contract) {
  const names = [];
  for (const v of Array.isArray(contract?.validate) ? contract.validate : []) {
    const e = Array.isArray(v?.env) ? v.env : typeof v?.env === "string" ? v.env.split(",") : [];
    for (const n of e) { const x = str(n); if (x && !names.includes(x)) names.push(x); }
  }
  return names;
}

/** Names plus their `needs` closure in start order; `missing` lists names no entry defines. */
export function planNeeds(names, specs) {
  const order = [], missing = [], seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (!specs[n]) { if (!missing.includes(n)) missing.push(n); return; }
    for (const d of specs[n].needs) visit(d);
    order.push(n);
  };
  names.forEach(visit);
  return { order, missing };
}

/** One FORGE:SANDBOX trajectory line: what was created, how long it lived, what it cost (local docker: 0). */
export const sandboxLine = ({ name, kind, ms, cost_usd = 0, id = null }) => `FORGE:SANDBOX ${JSON.stringify({ name, kind, ms, cost_usd, ...(id ? { id } : {}) })}`;

/**
 * Provision `names` for one lane. Returns `{ok:true, env, created, lines, down}` or `{ok:false, reason, detail}` (reason `unknown_env`,
 * `no_docker` or `failed`; already-created containers are removed first). No names: returns at once, no provider call.
 * `ledger` ({register, release}) gets each container before it is created. `cache` (a Set) skips repeated image checks in a batch.
 */
export async function provisionSandboxes({ names, specs, lane, docker, exec, ledger = null, labels = [], cwd = process.cwd(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), cache = new Set() }) {
  const empty = { ok: true, env: {}, created: [], lines: [], down: async () => true };
  if (!names?.length) return empty;
  const { order, missing } = planNeeds(names, specs ?? {});
  if (missing.length) return { ok: false, reason: "unknown_env", detail: `validate env ${missing.join(", ")} has no verify.sandboxes entry in forge.yaml` };
  if (order.some((n) => specs[n].image || specs[n].compose)) {
    try { await docker(["version", "--format", "{{.Server.Version}}"]); } catch (e) { return { ok: false, reason: "no_docker", detail: `docker is unavailable on this host (${str(e?.message).split("\n")[0].slice(0, 160)}); the lane must be placed where it runs` }; }
  }
  const env = {}, created = [], lines = [], lab = labels.flatMap((l) => ["--label", l]);
  const prefix = `forge-sbx-${safeSegment(lane)}`;
  const urls = {};
  const down = async () => {
    let ok = true;
    for (const c of [...created].reverse()) {
      try { await docker(c.compose ? ["compose", "-p", c.id, "-f", c.compose, "down", "-v"] : ["rm", "-f", "-v", c.id]); ledger?.release("container", c.id); }
      catch (e) { if (!/No such container/i.test(str(e?.message))) ok = false; else ledger?.release("container", c.id); }
    }
    created.length = 0;
    return ok;
  };
  try {
    for (const name of order) {
      const s = specs[name], t0 = now(), known = KNOWN[name] ?? KNOWN[str(s.image).split(":")[0].split("/").pop()] ?? {};
      if (s.fixtures && !s.image && !s.compose) { env[`${envName(name)}_DIR`] = resolve(cwd, s.fixtures); lines.push(sandboxLine({ name, kind: "fixtures", ms: 0 })); continue; }
      const id = `${prefix}-${name}`;
      let url;
      if (s.image) {
        const port = s.port ?? known.port;
        if (!cache.has(s.image)) { try { await docker(["image", "inspect", s.image]); } catch { await docker(["pull", s.image]); } cache.add(s.image); }
        ledger?.register("container", id, { sandbox: name });
        await docker(["rm", "-f", "-v", id]).catch(() => {}); // a leftover of a crashed run under the same lane name
        created.push({ id });
        await docker(["run", "-d", "--rm", "--name", id, ...lab, ...(port ? ["-p", `127.0.0.1::${port}`] : []), ...(known.env ?? []).flatMap((e) => ["-e", e]), s.image]);
        let hostPort = null;
        if (port) { const m = /:(\d+)\s*$/m.exec(await docker(["port", id, `${port}/tcp`])); hostPort = m ? Number(m[1]) : null; }
        const probe = s.ready ? s.ready.split(/\s+/) : known.ready;
        for (let i = 0; probe; i++) {
          try { await docker(["exec", id, ...probe]); break; } catch { if (i >= 30) throw new Error(`${name} not ready after 30 tries`); await sleep(1000); }
        }
        url = known.url && hostPort ? known.url(hostPort) : hostPort ? `tcp://127.0.0.1:${hostPort}` : "";
      } else {
        const proj = `${prefix}-${name}`;
        ledger?.register("container", proj, { sandbox: name, compose: s.compose });
        created.push({ id: proj, compose: s.compose });
        await docker(["compose", "-p", proj, "-f", s.compose, "up", "-d", "--wait", s.service]);
        url = "";
      }
      urls[name] = url;
      env[`${envName(name)}_URL`] = url;
      if (s.init) {
        const r = await exec({ command: s.init, env: { ...env, SANDBOX_URL: url } });
        if (r?.rc !== 0) throw new Error(`init of ${name} failed (exit ${r?.rc ?? "?"})`);
      }
      lines.push(sandboxLine({ name, kind: s.image ? "container" : "compose", ms: now() - t0, id }));
    }
  } catch (e) {
    await down();
    return { ok: false, reason: "failed", detail: `sandbox ${names.join(", ")} could not start: ${str(e?.message).split("\n")[0].slice(0, 200)}` };
  }
  return { ok: true, env, created, lines, down };
}

/**
 * `forgedock sandbox up <name>... | down | ls` (operators): the lane flow under batch `sandbox`, lane `operator`. `up` prints the
 * exported env, `down` removes what the ledger lists, `ls` lists it. Returns the exit code.
 */
export async function sandboxFromCli(args, { cwd = process.cwd(), specs, out = (t) => process.stdout.write(`${t}\n`), docker = null, exec = null, ledger = null, now = () => Date.now() } = {}) {
  const [verb, ...names] = args;
  const px = promisify(execFile);
  const dk = docker ?? (async (a) => (await px("docker", a, { maxBuffer: 10 * 1024 * 1024, timeout: 300000 })).stdout);
  const run = exec ?? (async ({ command, env }) => { try { await px("bash", ["-c", command], { cwd, env: { ...process.env, ...env }, timeout: 600000 }); return { rc: 0 }; } catch (e) { return { rc: Number(e?.code) || 1 }; } });
  const led = ledger ?? makeLedger({ batch: "sandbox", lane: "operator", owner: "forgedock-cli", issue: 0, ttlMs: 24 * 3600 * 1000 });
  if (verb === "ls") { for (const e of led.entries("container")) out(`${e.value}${e.sandbox ? `  (${e.sandbox})` : ""}`); return 0; }
  if (verb === "down") {
    let rc = 0;
    for (const e of led.entries("container")) {
      try { await dk(e.compose ? ["compose", "-p", String(e.value), "-f", e.compose, "down", "-v"] : ["rm", "-f", "-v", String(e.value)]); led.release("container", e.value); out(`removed ${e.value}`); }
      catch (err) { if (/No such container/i.test(String(err?.message))) led.release("container", e.value); else { rc = 1; out(`could not remove ${e.value}`); } }
    }
    led.remove();
    return rc;
  }
  if (verb !== "up" || !names.length) { out("usage: forgedock sandbox up <name>... | down | ls"); return 2; }
  const { readVerify } = specs ? { readVerify: null } : await import("../engine-cli.mjs");
  const all = specs ?? readVerify(cwd)?.sandboxes ?? {};
  const r = await provisionSandboxes({ names, specs: all, lane: "operator", docker: dk, exec: run, ledger: led, labels: dockerLabels({ batch: "sandbox", lane: "operator", issue: 0, expires: now() + 24 * 3600 * 1000 }), cwd, now });
  if (!r.ok) { out(`sandbox ${r.reason}: ${r.detail}`); return 1; }
  for (const [k, v] of Object.entries(r.env)) out(`${k}=${v}`);
  for (const l of r.lines) out(l);
  return 0;
}
