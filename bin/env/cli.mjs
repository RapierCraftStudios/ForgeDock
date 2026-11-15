// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock env key|build|status|gc|stage|ensure` — the environment library's CLI (bin/env/env.mjs).
 *   key     the environment key of a checkout (no tool is run)
 *   build   writes the recipe and manifest for the key (Dockerfile.env for the oci store, build.sh for the local one);
 *           --apply runs the installs in the checkout and publishes to the local store (for a build container on a pool host)
 *   status  the snapshots in the local store
 *   gc      plan (default) or --apply removal by keep count and age
 *   stage   stage ready copies of a snapshot (pool host)
 *   ensure  pool-host helper: clone a ref from a bare mirror, build if missing, stage, gc
 * Nothing here runs docker.
 */
import * as nodeFs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { makeDepCache } from "../lean/depcache.mjs";
import { validateLaneTools } from "../pool/lane-tools.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";
import { ENV_PREFIX, buildLocal, describeEnv, envRoot, makeEnvStore, makeOciStore, manifestOf, readEnvSnapshots } from "./env.mjs";

const pexec = promisify(execFile);
const defaultExec = async (cmd, args, { cwd, env, timeoutMs } = {}) => String((await pexec(cmd, args, { cwd, env: { ...process.env, ...(env ?? {}) }, timeout: timeoutMs ?? 0, maxBuffer: 1 << 28 })).stdout);
const USAGE = "usage: forgedock env key|build|status|gc|stage|ensure [--wt <dir>] [--store local|oci] [--out <dir>] [--apply] [--json] [--keep <n>] [--max-age-days <n>] [--key <key>] [--count <n>] [--image <ref>] [--lane-tools a,b]";
const VALUED = ["--wt", "--store", "--out", "--keep", "--max-age-days", "--key", "--count", "--image", "--lane-tools", "--mirror", "--ref", "--repo", "--ready", "--prefix"];

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED.includes(a)) { if (argv[i + 1] === undefined) throw new Error(`usage: ${a} requires a value`); o[a.slice(2)] = argv[++i]; }
    else if (a === "--apply" || a === "--json") o[a.slice(2)] = true;
    else if (a.startsWith("--")) throw new Error(`usage: unknown flag ${a}\n${USAGE}`);
    else o._.push(a);
  }
  return o;
}
const num = (v, def) => (v !== undefined && /^\d+$/.test(String(v)) ? Number(v) : def);
const gb = (n) => (Number.isFinite(n) ? `${(n / 2 ** 30).toFixed(2)} GB` : "?");

/** @returns {Promise<number>} exit code */
export async function envFromCli(argv, { fs = nodeFs, exec = defaultExec, out = (s) => process.stdout.write(`${s}\n`), env = process.env, cwd = process.cwd(), now = () => Date.now() } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const sub = o._[0];
  const wt = resolve(cwd, o.wt ?? ".");
  let yaml = "";
  try { yaml = String(fs.readFileSync(join(wt, "forge.yaml"))); } catch { /* no config: defaults */ }
  const cfg = readEnvSnapshots(yaml);
  let yamlTools = [];
  try { yamlTools = validateLaneTools(parseForgeYaml(yaml)?.execution?.lane_tools).tools; } catch { /* none */ }
  const laneTools = o["lane-tools"] !== undefined ? validateLaneTools(o["lane-tools"]).tools : yamlTools;
  const deps = makeDepCache({ exec, fs, now, env });
  const store = makeEnvStore({ root: envRoot(env), fs, now, linkTree: deps.linkTree, readOnly: deps.readOnly });
  const kind = o.store ?? cfg.store;
  const image = o.image ?? (kind === "oci" ? cfg.baseImage ?? "" : env.FORGE_ENV_IMAGE ?? "");
  const describe = (dir = wt) => describeEnv({ wt: dir, deps, fs, laneTools, image });
  const git = async (dir, args) => { try { return (await exec("git", args, { cwd: dir, timeoutMs: 60000 })).trim(); } catch { return null; } };
  const maxAgeMs = num(o["max-age-days"], cfg.maxAgeDays) * 86400000, keep = num(o.keep, cfg.keep);

  switch (sub) {
    case "key": {
      const d = await describe();
      out(o.json ? JSON.stringify({ key: d.key, ecosystems: d.components.map((c) => ({ eco: c.eco, dir: c.dir, lock: c.lock })), skipped: d.skipped, pins: d.pins, lane_tools: d.laneTools, image: d.image, platform: d.platform }) : d.key);
      return d.components.length ? 0 : 1;
    }
    case "build": {
      const d = await describe();
      if (!d.components.length) { process.stderr.write("env build: no lockfile the environment library can install\n"); return 1; }
      const commit = await git(wt, ["rev-parse", "HEAD"]);
      if (o.apply) {
        if (kind !== "local") { process.stderr.write("env build --apply: only the local store is built here; the oci image is built on the pool host from Dockerfile.env\n"); return 2; }
        const r = await buildLocal({ wt, deps, store, desc: d, fs, exec, repo: o.repo ?? null, ref: o.ref ?? null, commit });
        out(o.json ? JSON.stringify(r) : `env ${r.key}: ${r.status}${r.reason ? ` (${r.reason})` : ""}${r.manifest ? ` ${r.manifest.files} files, ${gb(r.manifest.size_bytes)}` : ""}`);
        return r.status === "failed" ? 1 : 0;
      }
      const dir = resolve(cwd, o.out ?? join(".forge", "env", d.key));
      fs.mkdirSync(dir, { recursive: true });
      let recipe;
      if (kind === "oci") {
        try { recipe = makeOciStore({ image: cfg.image, baseImage: cfg.baseImage }).recipe({ desc: d, existing: (f) => fs.existsSync(join(wt, f)), repo: o.repo ?? null, commit }); }
        catch (e) { process.stderr.write(`env build: ${e.message}\n`); return 2; }
        fs.writeFileSync(join(dir, "Dockerfile.env"), recipe.dockerfile);
        fs.writeFileSync(join(dir, "manifest.json"), JSON.stringify(recipe.manifest, null, 2) + "\n");
        fs.writeFileSync(join(dir, "build.sh"), `#!/usr/bin/env bash\n# Run on a build host from the repo root (not inside a job).\nset -euo pipefail\ndocker build -f ${JSON.stringify(join(dir, "Dockerfile.env"))} -t ${recipe.ref} .\ndocker push ${recipe.ref}\n`, { mode: 0o755 });
      } else {
        const man = { v: 1, key: d.key, prefix: ENV_PREFIX, trees: d.components.flatMap((c) => c.trees), ...manifestOf(d, { repo: o.repo ?? null, commit }) };
        fs.writeFileSync(join(dir, "manifest.json"), JSON.stringify(man, null, 2) + "\n");
        fs.writeFileSync(join(dir, "build.sh"), `#!/usr/bin/env bash\n# Run in a build container on the pool host (not inside a job), with the checkout at ${ENV_PREFIX} and the env store mounted.\nset -euo pipefail\ncd ${ENV_PREFIX}\nforgedock env build --apply\nforgedock env stage --key ${d.key} --count ${cfg.ready}\n`, { mode: 0o755 });
      }
      out(o.json ? JSON.stringify({ key: d.key, store: kind, out: dir, ...(recipe ? { ref: recipe.ref } : {}) }) : `env ${d.key}: ${kind} recipe written to ${dir}${recipe ? ` (image ${recipe.ref})` : ""}`);
      return 0;
    }
    case "status": {
      const list = store.list();
      if (o.json) { out(JSON.stringify({ root: store.root, enabled: cfg.enabled, store: cfg.store, snapshots: list })); return 0; }
      out(`env store ${store.root} (env.snapshots.enabled: ${cfg.enabled}, store: ${cfg.store})`);
      if (!list.length) out("no snapshots");
      for (const s of list) out(`${s.key}  ${s.repo ?? "-"}  ${s.ecosystems.join("+") || "-"}  ${gb(s.size_bytes)}  ${s.files ?? "?"} files  ready ${s.ready}  created ${new Date(s.created).toISOString()}  commit ${String(s.commit ?? "-").slice(0, 12)}`);
      return 0;
    }
    case "gc": {
      const r = store.gc({ keep, maxAgeMs, apply: Boolean(o.apply) });
      if (o.json) out(JSON.stringify(r));
      else { for (const x of r.remove) out(`${o.apply ? (r.removed.includes(x.key) ? "removed" : "kept (busy)") : "would remove"} ${x.key} (${x.reason})`); if (!r.remove.length) out("nothing to remove"); }
      return 0;
    }
    case "stage": {
      const key = o.key ?? (await describe()).key;
      if (!store.has(key)) { process.stderr.write(`env stage: no snapshot ${key} in ${store.root}\n`); return 1; }
      const added = store.stage({ key, count: num(o.count, cfg.ready) });
      out(o.json ? JSON.stringify({ key, added }) : `env ${key}: staged ${added}`);
      return 0;
    }
    case "ensure": {
      // Pool-host helper (bin/pool/agent.mjs envEnsureArgs). A missing mirror or a failed install leaves lanes on today's path.
      const prefix = o.prefix ?? ENV_PREFIX;
      if (!o.mirror || !fs.existsSync(o.mirror)) { out(`env ensure: mirror ${o.mirror ?? "(none)"} not ready`); return 0; }
      if (fs.existsSync(prefix)) { process.stderr.write(`env ensure: ${prefix} already exists (run in a fresh build container)\n`); return 1; }
      try { await exec("git", ["clone", "--quiet", "--shared", ...(o.ref ? ["--branch", o.ref] : []), o.mirror, prefix], { timeoutMs: 10 * 60000 }); }
      catch (e) { process.stderr.write(`env ensure: clone failed: ${String(e.stderr || e.message).slice(0, 300)}\n`); return 1; }
      const d = await describe(prefix);
      const r = await buildLocal({ wt: prefix, deps, store, desc: d, fs, exec, repo: o.repo ?? null, ref: o.ref ?? null, commit: await git(prefix, ["rev-parse", "HEAD"]) });
      const staged = r.status === "failed" ? 0 : store.stage({ key: d.key, count: num(o.ready, cfg.ready) });
      const g = store.gc({ keep, maxAgeMs, apply: true });
      out(JSON.stringify({ key: d.key, status: r.status, ...(r.reason ? { reason: r.reason } : {}), staged, removed: g.removed }));
      return r.status === "failed" ? 1 : 0;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}
