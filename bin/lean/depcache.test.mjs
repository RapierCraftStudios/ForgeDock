// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** #4220 shared dependency cache: JS (pnpm/npm) and Python (uv/poetry) fixture repos, fake installers (no real tools). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, lstatSync, readlinkSync, readdirSync, symlinkSync, rmSync, renameSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { join, dirname, relative } from "node:path";
import { makeDepCache } from "./depcache.mjs";
import { prepareToolchain } from "./toolchain.mjs";

const scratch = () => tmpDir("fd-depcache-");
const put = (p, text, mode) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, mode ? { mode } : undefined); };
/** Replace a file the way package managers do (tmp + rename), never writing into the existing inode. */
const replace = (p, text) => { put(`${p}.new`, text); renameSync(`${p}.new`, p); };

const FIXTURES = {
  pnpm(wt, lock = "lockfileVersion: 9\nlodash: 4.17.21\n") {
    put(join(wt, "package.json"), '{"name":"web","private":true}');
    put(join(wt, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    put(join(wt, "packages/a/package.json"), '{"name":"a"}');
    put(join(wt, "pnpm-lock.yaml"), lock);
  },
  npm(wt, lock = '{"lockfileVersion":3,"packages":{"node_modules/left-pad":{"version":"1.3.0"}}}') {
    put(join(wt, "package.json"), '{"name":"app"}');
    put(join(wt, "package-lock.json"), lock);
  },
  uv(wt, lock = 'version = 1\n[[package]]\nname = "requests"\nversion = "2.32.0"\n') {
    put(join(wt, "pyproject.toml"), '[project]\nname = "proj"\nversion = "0.1.0"\n');
    put(join(wt, "uv.lock"), lock);
  },
  poetry(wt, lock = '[[package]]\nname = "requests"\nversion = "2.32.0"\n') {
    put(join(wt, "pyproject.toml"), '[tool.poetry]\nname = "proj"\nversion = "0.1.0"\n');
    put(join(wt, "poetry.lock"), lock);
  },
};
const LOCKFILE = { pnpm: "pnpm-lock.yaml", npm: "package-lock.json", uv: "uv.lock", poetry: "poetry.lock" };

/** Fake package managers: write what a real install leaves behind, including the absolute paths that need rewriting. */
function fakeExec({ failInstall = false, installDelayMs = 0 } = {}) {
  const calls = [];
  const venv = (cwd, lock) => {
    const v = join(cwd, ".venv");
    if (!existsSync(join(v, "pyvenv.cfg"))) put(join(v, "pyvenv.cfg"), "home = /usr/bin\n");
    // Satisfied dependencies are left alone (a warm sync over a complete venv); only missing files are written.
    const once = (p, text, mode) => { if (!existsSync(p)) put(p, text, mode); };
    once(join(v, "lib/python3.12/site-packages/requests/__init__.py"), `# ${lock.length}\n`);
    once(join(v, "bin/pytest"), `#!${v}/bin/python\nimport pytest\n`, 0o755);
    once(join(v, "bin/activate"), `VIRTUAL_ENV='${v}'\n`);
    if (!existsSync(join(v, "bin/python"))) symlinkSync("/usr/bin/python3", join(v, "bin/python"));
    replace(join(v, "lib/python3.12/site-packages/_proj.pth"), `${cwd}/src\n`); // editable project: per worktree
  };
  const exec = async (cmd, args, { cwd } = {}) => {
    calls.push({ cmd, args: [...args], cwd });
    if (cmd === "git" && args[0] === "ls-files") {
      const out = [];
      const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === "package.json") out.push(relative(cwd, p)); } };
      walk(cwd);
      return out.join("\0");
    }
    if (args[0] === "--version") return cmd === "node" ? "v22.1.0\n" : "Python 3.12.3\n";
    const full = (cmd === "pnpm" && args.includes("--frozen-lockfile") && !args.includes("--offline")) || (cmd === "npm" && args[0] === "ci")
      || (cmd === "uv" && args[0] === "venv") || (cmd === "poetry" && !existsSync(join(cwd, ".venv")));
    if (full && installDelayMs) await new Promise((r) => setTimeout(r, installDelayMs));
    if (full && failInstall) { put(join(cwd, cmd === "uv" || cmd === "poetry" ? ".venv/partial" : "node_modules/partial"), "x"); throw Object.assign(new Error("install failed"), { stderr: "ERR_PNPM_FROZEN_LOCKFILE" }); }
    if (cmd === "pnpm") {
      if (args.includes("--offline")) return ""; // warm repair pass: nothing to do
      const lock = readFileSync(join(cwd, "pnpm-lock.yaml"), "utf8");
      put(join(cwd, "node_modules/.pnpm/lodash@4/node_modules/lodash/index.js"), `module.exports = ${JSON.stringify(lock)};\n`);
      symlinkSync(".pnpm/lodash@4/node_modules/lodash", join(cwd, "node_modules/lodash"));
      put(join(cwd, "node_modules/.bin/lodash"), `#!/bin/sh\nexport NODE_PATH="${cwd}/node_modules/.pnpm/node_modules"\nexec node "$basedir/../lodash/cli.js"\n`, 0o755);
      put(join(cwd, "node_modules/.modules.yaml"), "layoutVersion: 5\n");
      mkdirSync(join(cwd, "packages/a/node_modules"), { recursive: true });
      symlinkSync("../../../node_modules/.pnpm/lodash@4/node_modules/lodash", join(cwd, "packages/a/node_modules/lodash"));
      return "";
    }
    if (cmd === "npm") {
      put(join(cwd, "node_modules/left-pad/index.js"), `// ${readFileSync(join(cwd, "package-lock.json"), "utf8").length}\n`);
      put(join(cwd, "node_modules/left-pad/cli.js"), "#!/usr/bin/env node\n", 0o755);
      mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
      symlinkSync("../left-pad/cli.js", join(cwd, "node_modules/.bin/left-pad"));
      return "";
    }
    if (cmd === "yarn") {
      put(join(cwd, "node_modules/left-pad/index.js"), `// ${readFileSync(join(cwd, "yarn.lock"), "utf8").length}\n`);
      return "";
    }
    if (cmd === "uv" && args[0] === "venv") { put(join(cwd, ".venv/pyvenv.cfg"), "home = /usr/bin\nrelocatable = true\n"); return ""; }
    if (cmd === "uv" || cmd === "poetry") { venv(cwd, readFileSync(join(cwd, cmd === "uv" ? "uv.lock" : "poetry.lock"), "utf8")); return ""; }
    throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
  };
  return { exec, calls, installs: () => calls.filter((c) => c.cmd !== "git" && c.args[0] !== "--version") };
}

/** path -> {ino, content} for every regular file, symlink target for links: a byte- and inode-exact picture of a tree. */
function snapshotOf(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name), r = relative(dir, p);
      if (e.isSymbolicLink()) out[r] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else { const s = statSync(p); out[r] = `${s.ino}:${s.mode.toString(8)}:${readFileSync(p, "utf8")}`; }
    }
  };
  walk(dir);
  return out;
}
const snapDirs = (root, eco) => {
  const out = [];
  for (const rk of existsSync(root) ? readdirSync(root) : []) {
    if (rk === "stores") continue;
    for (const n of readdirSync(join(root, rk))) if (new RegExp(`^${eco}-[0-9a-f]{16}$`).test(n)) out.push(join(root, rk, n));
  }
  return out;
};
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const setup = (eco, o = {}) => {
  const base = scratch(), root = join(base, "cache");
  const f = fakeExec(o);
  const cache = makeDepCache({ root, exec: f.exec, env: {}, pollMs: 5, lockWaitMs: o.lockWaitMs ?? 5000, ...(o.cache ?? {}) });
  const lane = (name, lock) => { const wt = join(base, "wt", name); mkdirSync(wt, { recursive: true }); FIXTURES[eco](wt, lock); return wt; };
  return { base, root, f, cache, lane };
};

describe("depcache (#4220): shared dependency installs keyed by lock hash", () => {
  for (const eco of ["pnpm", "npm", "uv", "poetry"]) {
    it(`${eco}: a miss installs once and publishes; a lane on the same lock hardlinks it and runs no install`, async () => {
      const { root, f, cache, lane } = setup(eco);
      const a = lane("lean-1");
      const [ra] = await cache.prepare({ wt: a, repoKey: "repo-1" });
      assert.equal(ra.status, "miss-installed", JSON.stringify(ra));
      assert.equal(ra.published, true);
      assert.equal(ra.eco, eco);
      const [snap] = snapDirs(root, eco);
      assert.ok(snap && existsSync(join(snap, "manifest.json")));
      const fullInstalls = f.installs().length;
      assert.ok(fullInstalls >= 1);

      const b = lane("lean-2");
      const [rb] = await cache.prepare({ wt: b, repoKey: "repo-1" });
      assert.equal(rb.status, "hit", JSON.stringify(rb));
      assert.equal(rb.key, ra.key);
      const after = f.installs().slice(fullInstalls);
      // ≈ 0 install: only the warm repair pass (pnpm --offline / uv sync / poetry install over a complete venv), never a full install.
      for (const c of after) assert.ok(!(c.cmd === "npm" && c.args[0] === "ci") && !(c.cmd === "pnpm" && !c.args.includes("--offline")) && !(c.cmd === "uv" && c.args[0] === "venv"), `full install on a hit: ${c.cmd} ${c.args.join(" ")}`);
      if (eco === "npm") assert.equal(after.length, 0, "npm has no repair pass");

      if (eco === "pnpm" || eco === "npm") {
        const file = eco === "pnpm" ? "node_modules/.pnpm/lodash@4/node_modules/lodash/index.js" : "node_modules/left-pad/index.js";
        assert.equal(statSync(join(b, file)).ino, statSync(join(snap, file)).ino, "node_modules files are hardlinks of the snapshot");
        assert.equal(statSync(join(b, file)).ino, statSync(join(a, file)).ino);
        if (eco === "pnpm") {
          assert.equal(readlinkSync(join(b, "node_modules/lodash")), ".pnpm/lodash@4/node_modules/lodash");
          assert.ok(lstatSync(join(b, "packages/a/node_modules/lodash")).isSymbolicLink(), "workspace member node_modules are materialized too");
          const shim = readFileSync(join(b, "node_modules/.bin/lodash"), "utf8");
          assert.ok(shim.includes(`${b}/node_modules/.pnpm`) && !shim.includes(`${a}/`), ".bin shims point at this lane");
          assert.notEqual(statSync(join(b, "node_modules/.bin/lodash")).ino, statSync(join(snap, "node_modules/.bin/lodash")).ino);
        }
      } else {
        const sp = ".venv/lib/python3.12/site-packages/requests/__init__.py";
        assert.equal(statSync(join(b, sp)).ino, statSync(join(snap, sp)).ino, "venv files are hardlinks of the snapshot");
        assert.equal(readFileSync(join(b, ".venv/bin/pytest"), "utf8").split("\n")[0], `#!${b}/.venv/bin/python`, "console scripts point at this lane's venv");
        assert.ok(readFileSync(join(b, ".venv/bin/activate"), "utf8").includes(`'${b}/.venv'`));
        assert.equal(readlinkSync(join(b, ".venv/bin/python")), "/usr/bin/python3");
        assert.equal(readFileSync(join(b, ".venv/lib/python3.12/site-packages/_proj.pth"), "utf8"), `${b}/src\n`, "the repair pass reinstalls the project for this lane");
        assert.ok(after.length >= 1, "repair pass ran");
      }
    });
  }

  it("REGRESSION: a lane whose lockfile changed gets its own install and never corrupts the shared snapshot", async () => {
    for (const eco of ["pnpm", "uv"]) {
      const { root, f, cache, lane } = setup(eco);
      const a = lane("lean-1");
      const [ra] = await cache.prepare({ wt: a, repoKey: "r" });
      const b = lane("lean-2");
      assert.equal((await cache.prepare({ wt: b, repoKey: "r" }))[0].status, "hit");
      const [snapA] = snapDirs(root, eco);
      const before = snapshotOf(snapA);

      const n = f.installs().length;
      const c = lane("lean-3", eco === "pnpm" ? "lockfileVersion: 9\nlodash: 4.17.22\n" : 'version = 1\n[[package]]\nname = "requests"\nversion = "2.33.0"\n');
      const [rc] = await cache.prepare({ wt: c, repoKey: "r" });
      assert.equal(rc.status, "miss-installed", JSON.stringify(rc));
      assert.notEqual(rc.key, ra.key, "a changed lockfile is a different key");
      assert.ok(f.installs().slice(n).some((x) => (x.cmd === "pnpm" && !x.args.includes("--offline")) || (x.cmd === "uv" && x.args[0] === "venv")), "own full install");
      assert.equal(snapDirs(root, eco).length, 2);

      // A lane writing in place into a linked file fails instead of changing the shared inode.
      const linked = eco === "pnpm" ? join(b, "node_modules/.pnpm/lodash@4/node_modules/lodash/index.js") : join(b, ".venv/lib/python3.12/site-packages/requests/__init__.py");
      if (!isRoot) assert.throws(() => writeFileSync(linked, "corrupted"), (e) => e.code === "EACCES");
      // Package-manager style replacement and deleting a lane's tree only unlink that lane's links.
      replace(linked, "lane B's own copy");
      rmSync(join(b, eco === "pnpm" ? "node_modules" : ".venv"), { recursive: true, force: true });
      rmSync(join(a, eco === "pnpm" ? "node_modules" : ".venv"), { recursive: true, force: true });
      assert.deepEqual(snapshotOf(snapA), before, "snapshot A is byte- and inode-identical");

      const d = lane("lean-4");
      assert.equal((await cache.prepare({ wt: d, repoKey: "r" }))[0].status, "hit", "the original lock still hits");
    }
  });

  it("concurrent lanes on one key: one install, one snapshot, no tmp left; a dead holder's lock is taken over", async () => {
    const { root, f, cache, lane } = setup("npm", { installDelayMs: 60 });
    const lanes = ["l1", "l2", "l3"].map((n) => lane(n));
    const rs = (await Promise.all(lanes.map((wt) => cache.prepare({ wt, repoKey: "r" })))).map((x) => x[0]);
    assert.equal(f.calls.filter((c) => c.cmd === "npm" && c.args[0] === "ci").length, 1);
    assert.deepEqual(rs.map((r) => r.status).sort(), ["hit", "hit", "miss-installed"]);
    for (const wt of lanes) assert.ok(existsSync(join(wt, "node_modules/left-pad/index.js")));
    const names = readdirSync(join(root, "r"));
    assert.equal(names.filter((n) => /^npm-[0-9a-f]{16}$/.test(n)).length, 1);
    assert.equal(names.filter((n) => /\.tmp-|\.lock$/.test(n)).length, 0, names.join(","));

    const s2 = setup("npm", { cache: { alive: () => false } });
    const wt = s2.lane("x");
    const key = (await makeDepCache({ root: join(s2.base, "probe"), exec: s2.f.exec, env: {} }).prepare({ wt: s2.lane("probe"), repoKey: "r" }))[0].key;
    put(join(s2.root, "r", `npm-${key}.lock`), JSON.stringify({ host: (await import("node:os")).hostname(), pid: 999999, created: Date.now() }));
    const [r] = await s2.cache.prepare({ wt, repoKey: "r" });
    assert.equal(r.status, "miss-installed");
    assert.equal(r.published, true, "the stale lock was replaced");
  });

  it("a failed install, a missing tool or another filesystem leaves no snapshot and no partial tree", async () => {
    const s = setup("pnpm", { failInstall: true });
    const wt = s.lane("x");
    const [r] = await s.cache.prepare({ wt, repoKey: "r" });
    assert.equal(r.status, "failed");
    assert.match(r.reason, /install failed/);
    assert.ok(!existsSync(join(wt, "node_modules")));
    assert.equal(snapDirs(s.root, "pnpm").length, 0);

    const s2 = setup("npm");
    const exdev = { ...fs, linkSync: () => { throw Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" }); } };
    const c2 = makeDepCache({ root: s2.root, exec: s2.f.exec, env: {}, fs: exdev });
    const wt2 = s2.lane("y");
    const [r2] = await c2.prepare({ wt: wt2, repoKey: "r" });
    assert.equal(r2.status, "miss-installed");
    assert.equal(r2.published, false);
    assert.match(r2.reason, /EXDEV/);
    assert.ok(existsSync(join(wt2, "node_modules/left-pad/index.js")), "the lane keeps its own install");
    assert.equal(snapDirs(s2.root, "npm").length, 0);
    assert.deepEqual(readdirSync(join(s2.root, "r")), [], "no tmp or lock left");
    // A published snapshot that cannot be linked (EXDEV) is skipped and leaves nothing half-linked.
    await s2.cache.prepare({ wt: s2.lane("z"), repoKey: "r" });
    const wt3 = s2.lane("w");
    const [r3] = await c2.prepare({ wt: wt3, repoKey: "r" });
    assert.equal(r3.status, "skipped");
    assert.ok(!existsSync(join(wt3, "node_modules")));

    const s4 = setup("npm");
    const c4 = makeDepCache({ root: s4.root, exec: async (cmd, args) => { if (cmd === "git" || args[0] === "--version") return s4.f.exec(cmd, args, { cwd: s4.base }); throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }); }, env: {} });
    const [r4] = await c4.prepare({ wt: s4.lane("v"), repoKey: "r" });
    assert.equal(r4.status, "failed");
    assert.match(r4.reason, /tool not found/);
  });

  it("no lockfile, yarn Plug'n'Play, an existing node_modules and FORGE_DEPCACHE=0 are skipped untouched", async () => {
    const s = setup("npm");
    const empty = join(s.base, "empty"); mkdirSync(empty);
    assert.deepEqual((await s.cache.prepare({ wt: empty, repoKey: "r" })).map((r) => [r.status, r.reason]), [["skipped", "no lockfile"]]);
    const y = join(s.base, "yarn"); put(join(y, "package.json"), "{}"); put(join(y, "yarn.lock"), "# yarn"); put(join(y, ".yarnrc.yml"), "yarnPath: x\n");
    assert.equal((await s.cache.prepare({ wt: y, repoKey: "r" }))[0].status, "skipped");
    const pre = s.lane("pre"); put(join(pre, "node_modules/keep.js"), "mine");
    const [r] = await s.cache.prepare({ wt: pre, repoKey: "r" });
    assert.equal(r.status, "skipped");
    assert.equal(readFileSync(join(pre, "node_modules/keep.js"), "utf8"), "mine");
    const off = makeDepCache({ root: s.root, exec: s.f.exec, env: { FORGE_DEPCACHE: "0" } });
    assert.equal((await off.prepare({ wt: s.lane("off"), repoKey: "r" }))[0].status, "skipped");
    assert.deepEqual(off.env(), {});
    assert.equal(s.f.installs().length, 0);
    const e = s.cache.env();
    for (const k of ["npm_config_store_dir", "npm_config_cache", "UV_CACHE_DIR", "POETRY_CACHE_DIR", "PIP_CACHE_DIR"]) assert.ok(e[k].startsWith(join(s.root, "stores")), k);
  });

  it("prune removes unused unlocked snapshots, dead publishers' tmp dirs and dead locks; keeps fresh or locked ones", async () => {
    let clock = Date.now();
    const s = setup("npm", { cache: { now: () => clock } });
    await s.cache.prepare({ wt: s.lane("a"), repoKey: "r" });
    await s.cache.prepare({ wt: s.lane("b", '{"lockfileVersion":3,"other":1}'), repoKey: "r" });
    const [old, fresh] = snapDirs(s.root, "npm");
    clock += 8 * 24 * 3600 * 1000;
    writeFileSync(join(fresh, "last-used"), String(clock));
    put(`${old}.tmp-999999`, "x");
    const alive = (pid) => pid === process.pid;
    const pruner = makeDepCache({ root: s.root, exec: s.f.exec, env: {}, now: () => clock, alive });
    writeFileSync(`${fresh}.lock`, JSON.stringify({ host: (await import("node:os")).hostname(), pid: process.pid, created: clock }));
    const removed = await pruner.prune();
    assert.ok(!existsSync(old), "old snapshot removed (read-only files and all)");
    assert.ok(existsSync(fresh), "recently used snapshot kept");
    assert.ok(!existsSync(`${old}.tmp-999999`));
    assert.equal(removed.length, 2);
    // A locked old snapshot is kept: someone is materializing or publishing it.
    clock += 8 * 24 * 3600 * 1000;
    writeFileSync(`${fresh}.lock`, JSON.stringify({ host: (await import("node:os")).hostname(), pid: process.pid, created: clock }));
    assert.deepEqual(await pruner.prune(), []);
    assert.ok(existsSync(fresh));
    rmSync(`${fresh}.lock`);
    assert.equal((await pruner.prune()).length, 1);
    assert.ok(!existsSync(fresh));
  });
});

describe("depcache (#4347): installs and repairs run with the lane toolchain env", () => {
  const PMS = new Set(["pnpm", "pnpx", "yarn", "npm", "npx"]);
  /** A host with no global package manager: pm commands resolve only when PATH starts with the toolchain shim dir. */
  const shimOnlyExec = (f, binDir) => {
    const seen = [];
    const exec = async (cmd, args, o = {}) => {
      if (PMS.has(cmd)) {
        seen.push({ cmd, args: [...args], env: o.env });
        if (!String(o.env?.PATH ?? "").startsWith(binDir)) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
      }
      return f.exec(cmd, args, o);
    };
    return { exec, seen };
  };
  /** The real toolchain step: corepack on the host PATH, no global pm; shims recorded, not written. */
  const laneToolchain = async (wt, binDir) => {
    const tc = await prepareToolchain({ dir: wt, binDir, basePath: "/host/bin", find: (n) => (n === "corepack" ? "/host/bin/corepack" : null),
      writeShim: async () => {}, mkdirp: async () => {}, hostNode: () => "v22.1.0" });
    assert.ok(tc.env, "a packageManager pin yields a toolchain env");
    return tc.env;
  };

  it("#4347 a packageManager-pinned pnpm repo with no host pnpm installs and repairs through the lane toolchain env", async () => {
    const base = scratch(), root = join(base, "cache"), binDir = join(base, "toolchain", "bin");
    const f = fakeExec(), x = shimOnlyExec(f, binDir);
    const cache = makeDepCache({ root, exec: x.exec, env: {}, pollMs: 5 });
    const lane = (name) => { const wt = join(base, "wt", name); FIXTURES.pnpm(wt); put(join(wt, "package.json"), '{"name":"web","private":true,"packageManager":"pnpm@9.12.0"}'); return wt; };
    const a = lane("a");
    const env = await laneToolchain(a, binDir);
    const [r1] = await cache.prepare({ wt: a, repoKey: "r", env });
    assert.equal(r1.status, "miss-installed", r1.reason);
    assert.ok(existsSync(join(a, "node_modules/lodash/index.js")));
    const [r2] = await cache.prepare({ wt: lane("b"), repoKey: "r", env });
    assert.equal(r2.status, "hit", r2.reason);
    assert.deepEqual(x.seen.map((c) => [c.cmd, c.args.includes("--offline")]), [["pnpm", false], ["pnpm", true]], "install then repair");
    for (const c of x.seen) {
      assert.ok(c.env.PATH.startsWith(`${binDir}:`), "the shim dir leads PATH");
      assert.equal(c.env.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0");
      assert.equal(c.env.npm_config_store_dir, join(root, "stores", "pnpm-store"), "the store env stays");
    }
    // Without the toolchain env (the toolchain step failed or wrote no shim) it is the host PATH, as before.
    const [r3] = await makeDepCache({ root: join(base, "cache2"), exec: x.exec, env: {} }).prepare({ wt: lane("c"), repoKey: "r" });
    assert.equal(r3.status, "failed");
    assert.match(r3.reason, /tool not found: spawn pnpm ENOENT/);
  });

  it("#4347 a pinned yarn (node-modules linker) repo installs through the shim env", async () => {
    const base = scratch(), binDir = join(base, "toolchain", "bin");
    const x = shimOnlyExec(fakeExec(), binDir);
    const wt = join(base, "wt", "y");
    put(join(wt, "package.json"), '{"name":"app","packageManager":"yarn@4.5.0"}');
    put(join(wt, "yarn.lock"), "__metadata:\n  version: 8\n");
    put(join(wt, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    const env = await laneToolchain(wt, binDir);
    const [r] = await makeDepCache({ root: join(base, "cache"), exec: x.exec, env: {} }).prepare({ wt, repoKey: "r", env });
    assert.equal(r.status, "miss-installed", r.reason);
    assert.deepEqual(x.seen.map((c) => [c.cmd, c.args]), [["yarn", ["install", "--immutable"]]]);
    assert.ok(x.seen[0].env.PATH.startsWith(`${binDir}:`));
  });

  it("#4347 a plain npm repo without pins passes exactly the store env, as before; store keys win over the lane env", async () => {
    const s = setup("npm");
    const [r] = await s.cache.prepare({ wt: s.lane("plain"), repoKey: "r" });
    assert.equal(r.status, "miss-installed", r.reason);
    const inst = s.f.calls.filter((c) => c.cmd === "npm");
    assert.equal(inst.length, 1);
    const seen = [];
    const cache = makeDepCache({ root: join(s.base, "cache2"), exec: async (cmd, args, o = {}) => { if (cmd === "npm") seen.push(o); return s.f.exec(cmd, args, o); }, env: {} });
    await cache.prepare({ wt: s.lane("plain2"), repoKey: "r" });
    assert.deepEqual(seen[0].env, cache.env(), "no lane env: only the store env");
    await cache.prepare({ wt: s.lane("pinned"), repoKey: "r2", env: { PATH: "/shim:/host", npm_config_cache: "/lane/should-not-win" } });
    assert.equal(seen[1].env.PATH, "/shim:/host");
    assert.equal(seen[1].env.npm_config_cache, cache.env().npm_config_cache);
  });
});
