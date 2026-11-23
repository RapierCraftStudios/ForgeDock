// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Environment library (bin/env): key, store, claim planning, GC, OCI recipe, config switch. Fixture repos with fake installers (no real tools, no docker). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { makeDepCache } from "../lean/depcache.mjs";
import { ENV_PREFIX, buildLocal, computeKey, describeEnv, laneEnvFor, makeEnvStore, makeOciStore, ociRecipe, planClaim, planGc, proxyEnv, readEnvSnapshots } from "../env/env.mjs";
import { envFromCli } from "../env/cli.mjs";
import { envEnsureArgs, createAgent } from "../pool/agent.mjs";
import { validateForgeYaml } from "../config-schema.mjs";

const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const FIXTURES = {
  pnpm(wt) { put(join(wt, "package.json"), '{"name":"shop","packageManager":"pnpm@10.4.1"}'); put(join(wt, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"); put(join(wt, "packages/a/package.json"), '{"name":"a"}'); put(join(wt, "pnpm-lock.yaml"), "lockfileVersion: 9\n"); },
  npm(wt) { put(join(wt, "package.json"), '{"name":"app"}'); put(join(wt, "package-lock.json"), '{"lockfileVersion":3}'); },
  yarn(wt) { put(join(wt, "package.json"), '{"name":"app"}'); put(join(wt, "yarn.lock"), "# yarn lockfile v1\n"); },
  uv(wt) { put(join(wt, "pyproject.toml"), '[project]\nname = "svc"\nversion = "0.1.0"\n'); put(join(wt, "uv.lock"), "version = 1\n"); },
  poetry(wt) { put(join(wt, "pyproject.toml"), '[tool.poetry]\nname = "svc"\n'); put(join(wt, "poetry.lock"), "# poetry\n"); },
  /** A JS root with a Python service one level down. */
  mixed(wt) { FIXTURES.npm(wt); put(join(wt, "services/api/pyproject.toml"), '[project]\nname = "api"\nversion = "0.1.0"\n'); put(join(wt, "services/api/uv.lock"), "version = 1\n"); },
};
/** Fake installers: write the tree the real tool would, count the calls. */
function fakeExec(calls = []) {
  return async (cmd, args, { cwd } = {}) => {
    calls.push([cmd, ...args].join(" "));
    if (args[0] === "--version") return cmd === "node" ? "v22.0.0" : "Python 3.12.1";
    if (cmd === "git") throw new Error("not a git checkout");
    if (["pnpm", "npm", "yarn"].includes(cmd)) {
      const marker = { pnpm: ".modules.yaml", npm: ".package-lock.json", yarn: ".yarn-integrity" }[cmd];
      put(join(cwd, "node_modules", marker), "state\n");
      put(join(cwd, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
      put(join(cwd, "node_modules/.bin/tool"), `#!/bin/sh\nexec node ${cwd}/node_modules/left-pad/index.js\n`);
    } else if (cmd === "uv" && args[0] === "sync" || cmd === "poetry" && args[0] === "install") {
      put(join(cwd, ".venv/pyvenv.cfg"), "home = /usr/bin\n");
      put(join(cwd, ".venv/bin/python"), "#!/bin/sh\n");
      put(join(cwd, ".venv/lib/site.pth"), `${cwd}/src\n`);
    }
    return "";
  };
}
const world = (fixture = "npm") => {
  const base = tmpDir("fd-env-");
  const wt = join(base, "build"), root = join(base, "store"), calls = [];
  mkdirSync(wt, { recursive: true });
  FIXTURES[fixture](wt);
  const deps = makeDepCache({ root: join(base, "depcache"), exec: fakeExec(calls), env: {} });
  const store = makeEnvStore({ root, linkTree: deps.linkTree, readOnly: deps.readOnly });
  return { base, wt, root, calls, deps, store };
};
const lane = (w, name, fixture) => { const d = join(w.base, name); mkdirSync(d, { recursive: true }); FIXTURES[fixture](d); return d; };

describe("env key", () => {
  it("is stable, and changes with any lockfile, pin, lane tool, image or platform", () => {
    const base = { components: [{ eco: "npm", dir: ".", files: [{ path: "package-lock.json", sha: "a" }, { path: "package.json", sha: "b" }] }], pins: [{ path: ".nvmrc", sha: "n" }], laneTools: ["xvfb", "python@3.12"], image: "lane:1" };
    const k = computeKey(base);
    assert.match(k, /^[0-9a-f]{16}$/);
    assert.equal(computeKey({ ...base, laneTools: ["python@3.12", "xvfb"], components: [{ ...base.components[0], files: [...base.components[0].files].reverse() }] }), k, "order never matters");
    const variants = [
      { ...base, components: [{ ...base.components[0], files: [{ path: "package-lock.json", sha: "CHANGED" }, { path: "package.json", sha: "b" }] }] },
      { ...base, pins: [{ path: ".nvmrc", sha: "other" }] }, { ...base, pins: [] }, { ...base, laneTools: ["xvfb"] },
      { ...base, image: "lane:2" }, { ...base, platform: "linux-arm64" }, { ...base, components: [{ ...base.components[0], dir: "web" }] },
    ];
    assert.equal(new Set([k, ...variants.map(computeKey)]).size, variants.length + 1);
  });
  for (const [fixture, eco, tree] of [["pnpm", "pnpm", "node_modules"], ["npm", "npm", "node_modules"], ["yarn", "yarn", "node_modules"], ["uv", "uv", ".venv"], ["poetry", "poetry", ".venv"]]) {
    it(`describes a ${fixture} repo through depcache's detection, running no tool`, async () => {
      const w = world(fixture);
      const d = await describeEnv({ wt: w.wt, deps: w.deps });
      assert.deepEqual(d.components.map((c) => c.eco), [eco]);
      assert.ok(d.components[0].trees.includes(tree));
      assert.ok(d.components[0].inputs.includes(d.components[0].lock));
      assert.deepEqual(w.calls.filter((c) => !c.startsWith("git ")), [], "no install, no version probe");
      assert.equal((await describeEnv({ wt: w.wt, deps: w.deps })).key, d.key);
      fs.appendFileSync(join(w.wt, d.components[0].lock), "\n# changed\n");
      assert.notEqual((await describeEnv({ wt: w.wt, deps: w.deps })).key, d.key);
    });
  }
  it("covers nested ecosystems and toolchain pin files", async () => {
    const w = world("mixed");
    const d = await describeEnv({ wt: w.wt, deps: w.deps });
    assert.deepEqual(d.components.map((c) => `${c.eco}@${c.dir}`), ["npm@.", "uv@services/api"]);
    assert.ok(d.components[1].trees.includes("services/api/.venv"));
    put(join(w.wt, ".nvmrc"), "22\n");
    const pinned = await describeEnv({ wt: w.wt, deps: w.deps });
    assert.notEqual(pinned.key, d.key);
    assert.deepEqual(pinned.pins, { ".nvmrc": "22" });
  });
});

describe("env local store", () => {
  it("builds once, stages, and a lane claims by rename with no per-file work", async () => {
    const w = world("mixed");
    const desc = await describeEnv({ wt: w.wt, deps: w.deps });
    const built = await buildLocal({ wt: w.wt, deps: w.deps, store: w.store, desc, repo: "acme/shop", ref: "staging", commit: "c0ffee" });
    assert.equal(built.status, "built");
    const man = w.store.manifest(desc.key);
    assert.deepEqual(man.trees.sort(), ["node_modules", "services/api/.venv"]);
    assert.deepEqual([man.key, man.repo, man.commit, man.prefix], [desc.key, "acme/shop", "c0ffee", w.wt]);
    assert.ok(man.size_bytes > 0 && man.files >= 6 && man.created > 0);
    assert.deepEqual(man.ecosystems.map((e) => e.eco), ["npm", "uv"]);
    assert.equal(man.toolchain.resolved.node, undefined, "no exec passed: nothing probed");
    assert.equal((await buildLocal({ wt: w.wt, deps: w.deps, store: w.store, desc })).status, "exists", "a second build is a no-op");
    assert.equal(w.store.stage({ key: desc.key, count: 2 }), 2);
    assert.equal(w.store.stage({ key: desc.key, count: 2 }), 0);

    // The lane: same lock set, another path. Count file-level calls during the claim.
    const wt = lane(w, "lane-1", "mixed");
    const counted = { link: 0, copy: 0, rename: 0 };
    const cfs = { ...fs, linkSync: (...a) => { counted.link++; return fs.linkSync(...a); }, copyFileSync: (...a) => { counted.copy++; return fs.copyFileSync(...a); }, renameSync: (...a) => { counted.rename++; return fs.renameSync(...a); } };
    const laneDeps = makeDepCache({ root: join(w.base, "depcache"), exec: fakeExec(), fs: cfs, env: {} });
    const laneStore = makeEnvStore({ root: w.root, fs: cfs, linkTree: laneDeps.linkTree, readOnly: laneDeps.readOnly });
    assert.equal(laneStore.claim({ key: desc.key, wt, prefix: null }), null, "another path and no alias: refused, nothing changed");
    assert.equal(existsSync(join(wt, "node_modules")), false);
    // The prefix the trees were built at is aliased to the lane worktree.
    const store2 = makeEnvStore({ root: w.root, fs: cfs, linkTree: laneDeps.linkTree, readOnly: laneDeps.readOnly });
    const manPrefix = man.prefix;
    fs.renameSync(w.wt, w.wt + "-gone"); // the build dir is gone, as in a discarded build container
    const got = store2.claim({ key: desc.key, wt, prefix: manPrefix });
    assert.equal(got.mode, "rename");
    assert.deepEqual(counted, { link: 0, copy: 0, rename: 3 }, "one rename to take the staged copy, one per tree");
    assert.equal(readlinkSync(manPrefix), wt, "the build prefix resolves to the lane worktree");
    assert.equal(readFileSync(join(manPrefix, "node_modules/left-pad/index.js"), "utf8"), "module.exports = 1;\n");
    assert.match(readFileSync(join(wt, "node_modules/.bin/tool"), "utf8"), new RegExp(`${manPrefix}/node_modules`), "baked absolute paths are untouched and valid through the alias");
    assert.ok(existsSync(join(wt, "services/api/.venv/bin/python")));
    assert.equal(w.store.list()[0].ready, 1);
    assert.equal(store2.claim({ key: desc.key, wt, prefix: manPrefix }), null, "trees already in the worktree: never overwritten");
  });

  it("a staged copy is claimed once; with none staged the trees are hardlinked", async () => {
    const w = world("npm");
    const desc = await describeEnv({ wt: w.wt, deps: w.deps });
    await buildLocal({ wt: w.wt, deps: w.deps, store: w.store, desc });
    w.store.stage({ key: desc.key, count: 1 });
    assert.equal(w.store.claim({ key: desc.key, wt: w.wt }), null, "the build worktree still has its trees");
    fs.rmSync(join(w.wt, "node_modules"), { recursive: true });
    assert.equal(w.store.claim({ key: desc.key, wt: w.wt }).mode, "rename");
    fs.rmSync(join(w.wt, "node_modules"), { recursive: true });
    const second = w.store.claim({ key: desc.key, wt: w.wt });
    assert.equal(second.mode, "link", "no staged copy left");
    const master = join(w.store.locate(desc.key), "tree/node_modules/left-pad/index.js");
    assert.equal(statSync(join(w.wt, "node_modules/left-pad/index.js")).ino, statSync(master).ino);
    assert.equal(statSync(master).mode & 0o222, 0, "store files are read-only");
    assert.notEqual(statSync(join(w.wt, "node_modules/.package-lock.json")).ino, statSync(join(w.store.locate(desc.key), "tree/node_modules/.package-lock.json")).ino, "package-manager state is a private writable copy");
  });

  it("a failed install publishes nothing", async () => {
    const w = world("npm");
    const deps = makeDepCache({ root: join(w.base, "dc"), env: {}, exec: async (cmd, args) => { if (args[0] === "--version") return "v22"; if (cmd === "git") throw new Error("no git"); throw Object.assign(new Error("boom"), { stderr: "npm ERR! network" }); } });
    const desc = await describeEnv({ wt: w.wt, deps });
    const r = await buildLocal({ wt: w.wt, deps, store: w.store, desc });
    assert.equal(r.status, "failed");
    assert.match(r.reason, /network/);
    assert.deepEqual(w.store.list(), []);
    assert.equal(w.store.claim({ key: desc.key, wt: w.wt }), null);
  });

  it("planClaim: rename only on one filesystem with a staged copy", () => {
    assert.deepEqual(planClaim({ storeDev: 5, worktreeDev: 5, ready: 2 }), { mode: "rename", reason: null });
    assert.equal(planClaim({ storeDev: 5, worktreeDev: 5, ready: 0 }).mode, "link");
    assert.equal(planClaim({ storeDev: 5, worktreeDev: 6, ready: 2 }).mode, "copy");
    assert.equal(planClaim({ storeDev: undefined, worktreeDev: undefined, ready: 2 }).mode, "copy", "an unknown device is never assumed equal");
  });

  it("planGc keeps the newest per repo, then drops by count and age", () => {
    const D = 86400000, now = 100 * D;
    const list = [
      { key: "a1", repo: "acme/a", lastUsed: now - 1 * D }, { key: "a2", repo: "acme/a", lastUsed: now - 2 * D }, { key: "a3", repo: "acme/a", lastUsed: now - 3 * D },
      { key: "b1", repo: "acme/b", lastUsed: now - 60 * D }, { key: "b2", repo: "acme/b", lastUsed: now - 70 * D },
    ];
    assert.deepEqual(planGc(list, { keep: 2, maxAgeMs: 14 * D, now }).map((r) => r.key).sort(), ["a3", "b2"]);
    assert.deepEqual(planGc(list, { keep: 1, maxAgeMs: 14 * D, now }).map((r) => r.key).sort(), ["a2", "a3", "b2"]);
    assert.deepEqual(planGc(list, { keep: 5, maxAgeMs: 365 * D, now }), []);
    assert.equal(planGc(list, { keep: 5, maxAgeMs: 14 * D, now }).find((r) => r.key === "b1"), undefined, "a repo's newest snapshot always stays");
  });

  it("gc is a dry run unless applied", async () => {
    const w = world("npm");
    let t = 1e12;
    const store = makeEnvStore({ root: w.root, now: () => t, linkTree: w.deps.linkTree, readOnly: w.deps.readOnly });
    const keys = [];
    for (let i = 0; i < 3; i++) {
      t += 1000;
      fs.appendFileSync(join(w.wt, "package-lock.json"), `\n${i}`);
      const desc = await describeEnv({ wt: w.wt, deps: w.deps });
      fs.rmSync(join(w.wt, "node_modules"), { recursive: true, force: true });
      assert.equal((await buildLocal({ wt: w.wt, deps: w.deps, store, desc, repo: "acme/shop" })).status, "built");
      keys.push(desc.key);
    }
    assert.deepEqual(store.gc({ keep: 2 }).removed, []);
    assert.equal(store.list().length, 3);
    assert.deepEqual(store.gc({ keep: 2, apply: true }).removed, [keys[0]]);
    assert.deepEqual(store.list().map((s) => s.key).sort(), [keys[1], keys[2]].sort());
  });
});

describe("env switch in depcache.prepare", () => {
  const run = async (envOn) => {
    const w = world("npm");
    const desc = await describeEnv({ wt: w.wt, deps: w.deps });
    await buildLocal({ wt: w.wt, deps: w.deps, store: w.store, desc });
    w.store.stage({ key: desc.key, count: 1 });
    const prefix = w.wt;
    fs.renameSync(w.wt, `${w.wt}-gone`);
    const wt = lane(w, "lane", "npm"), calls = [];
    const deps = makeDepCache({ root: join(w.base, "depcache-lane"), exec: fakeExec(calls), env: envOn ? { FORGE_ENV_SNAPSHOTS: "1", FORGE_ENV_ROOT: w.root, FORGE_ENV_PREFIX: prefix } : { FORGE_ENV_ROOT: w.root, FORGE_ENV_PREFIX: prefix } });
    return { res: await deps.prepare({ wt, repoKey: "acme/shop" }), calls, desc, w, wt, prefix };
  };
  it("off: the snapshot is ignored and depcache installs exactly as before", async () => {
    const { res, calls, w, prefix } = await run(false);
    assert.deepEqual(res.map((r) => [r.status, r.eco, r.published, r.reason, r.dir]), [["miss-installed", "npm", true, null, "."]]);
    assert.deepEqual(Object.keys(res[0]).sort(), ["dir", "eco", "key", "ms", "published", "reason", "status"]);
    assert.ok(calls.includes("npm ci --no-audit --no-fund"));
    assert.equal(w.store.list()[0].ready, 1, "the staged copy is untouched");
    assert.throws(() => lstatSync(prefix), "no alias is created");
  });
  it("on: a matching snapshot is claimed and no installer runs", async () => {
    const { res, calls, desc, wt } = await run(true);
    assert.deepEqual(res.map((r) => [r.status, r.eco, r.key, r.reason]), [["hit", "npm", desc.key, "env snapshot (rename)"]]);
    assert.equal(calls.some((c) => c.startsWith("npm ")), false);
    assert.ok(existsSync(join(wt, "node_modules/left-pad/index.js")));
  });
  it("on, but the lane changed its lockfile: a miss is today's install", async () => {
    const w = world("npm");
    const desc = await describeEnv({ wt: w.wt, deps: w.deps });
    await buildLocal({ wt: w.wt, deps: w.deps, store: w.store, desc });
    const wt = lane(w, "lane", "npm"), calls = [];
    fs.appendFileSync(join(wt, "package-lock.json"), "\n");
    const deps = makeDepCache({ root: join(w.base, "depcache-lane"), exec: fakeExec(calls), env: { FORGE_ENV_SNAPSHOTS: "1", FORGE_ENV_ROOT: w.root, FORGE_ENV_PREFIX: w.wt } });
    const res = await deps.prepare({ wt, repoKey: "acme/shop" });
    assert.equal(res[0].status, "miss-installed");
    assert.ok(calls.includes("npm ci --no-audit --no-fund"));
  });
});

describe("env config", () => {
  const ON = "env:\n  toolchain: off\n  snapshots:\n    enabled: true\n    store: oci\n    keep: 5\n    max_age_days: 30\n    ready: 4\n    base_image: ghcr.io/acme/ci-base:1\n    image: ghcr.io/acme/shop-env\n  proxies:\n    npm: http://pool-host:4873/\n    pypi: http://pool-host:3141/root/pypi/+simple\n    apt: http://pool-host:3142\n    git: http://pool-host:9418\nexecution:\n  mode: remote\n";
  it("is off by default and reads every key", () => {
    for (const text of ["", "env:\n  toolchain: off\n", "env:\n  snapshots:\n    enabled: false\n", "env:\n  snapshots:\n    keep: 9\n"]) {
      assert.equal(readEnvSnapshots(text).enabled, false);
      assert.deepEqual(laneEnvFor(readEnvSnapshots(text), ["xvfb"]), {}, "off adds nothing to the lane env");
    }
    const c = readEnvSnapshots(ON);
    assert.deepEqual(c, { enabled: true, store: "oci", keep: 5, maxAgeDays: 30, ready: 4, baseImage: "ghcr.io/acme/ci-base:1", image: "ghcr.io/acme/shop-env",
      proxies: { npm: "http://pool-host:4873", pypi: "http://pool-host:3141/root/pypi/+simple", apt: "http://pool-host:3142", git: "http://pool-host:9418" } });
    assert.deepEqual(readEnvSnapshots("env:\n  snapshots:\n    enabled: true\n    keep: 0\n    store: s3\n"), { enabled: true, store: "local", keep: 3, maxAgeDays: 14, ready: 2, baseImage: null, image: null, proxies: {} });
    assert.deepEqual(readEnvSnapshots("env:\n  proxies:\n    npm: \"file:///etc; rm -rf\"\n").proxies, {}, "only http(s)/git URLs without shell characters");
  });
  it("lane env and proxy env", () => {
    const e = laneEnvFor(readEnvSnapshots(ON), ["xvfb", "python@3.12"]);
    assert.equal(e.FORGE_ENV_SNAPSHOTS, "1");
    assert.equal(e.FORGE_ENV_ROOT, "/cache/env");
    assert.equal(e.FORGE_ENV_PREFIX, ENV_PREFIX);
    assert.equal(e.FORGE_ENV_LANE_TOOLS, "python@3.12,xvfb");
    assert.equal(e.npm_config_registry, "http://pool-host:4873/");
    assert.equal(e.PIP_INDEX_URL, "http://pool-host:3141/root/pypi/+simple");
    assert.equal(e.PIP_TRUSTED_HOST, "pool-host");
    assert.equal(e.FORGE_APT_PROXY, "http://pool-host:3142");
    assert.deepEqual(proxyEnv({}), {});
    assert.deepEqual(proxyEnv({ npm: "https://npm.internal" }), { npm_config_registry: "https://npm.internal/", YARN_NPM_REGISTRY_SERVER: "https://npm.internal" });
  });
  it("the schema accepts the documented keys and rejects others", () => {
    assert.deepEqual(validateForgeYaml(ON).filter((f) => f.key.startsWith("env")), []);
    const bad = validateForgeYaml("env:\n  snapshots:\n    enabled: yes\n    stor: oci\n  proxies:\n    cargo: http://x\n").map((f) => `${f.code}:${f.key}`).sort();
    assert.deepEqual(bad, ["unknown-key:env.proxies.cargo", "unknown-key:env.snapshots.stor", "wrong-type:env.snapshots.enabled"]);
  });
});

describe("env oci recipe", () => {
  it("generates a Dockerfile from the base image, lane tools and frozen installs at the fixed prefix", async () => {
    const w = world("mixed");
    put(join(w.wt, ".nvmrc"), "22\n");
    const desc = await describeEnv({ wt: w.wt, deps: w.deps, laneTools: ["xvfb"], image: "ghcr.io/acme/ci-base:1" });
    const r = makeOciStore({ image: "ghcr.io/acme/shop-env", baseImage: "ghcr.io/acme/ci-base:1" }).recipe({ desc, existing: (f) => existsSync(join(w.wt, f)), commit: "c0ffee" });
    assert.equal(r.ref, `ghcr.io/acme/shop-env:${desc.key}`);
    const lines = r.dockerfile.split("\n");
    assert.equal(lines[1], "FROM ghcr.io/acme/ci-base:1");
    assert.ok(lines.some((l) => /apt-get install .*xvfb/.test(l)));
    assert.ok(lines.includes(`WORKDIR ${ENV_PREFIX}`));
    assert.ok(lines.includes('COPY [".nvmrc","./"]'));
    assert.ok(lines.includes('COPY ["package-lock.json","package.json","./"]'));
    assert.ok(lines.includes('COPY ["services/api/uv.lock","services/api/pyproject.toml","services/api/"]'));
    assert.ok(lines.includes("RUN npm ci --no-audit --no-fund"));
    assert.ok(lines.includes("RUN cd services/api && uv venv --relocatable .venv && uv sync --frozen --no-install-project"));
    assert.ok(lines.includes(`LABEL io.forgedock.env.key=${desc.key}`));
    assert.equal(r.dockerfile.includes(".npmrc"), false, "absent optional inputs are not copied");
    assert.deepEqual([r.manifest.key, r.manifest.prefix, r.manifest.commit], [desc.key, ENV_PREFIX, "c0ffee"]);
    assert.deepEqual(r.build.slice(0, 2), ["docker", "build"]);
    assert.throws(() => ociRecipe({ desc, image: "x/y" }), /base_image is required/);
    assert.throws(() => ociRecipe({ desc, baseImage: "a; rm -rf /", image: "x/y" }), /plain image references/);
    assert.throws(() => ociRecipe({ desc: { ...desc, laneTools: ["nope"] }, baseImage: "a", image: "x/y" }), /no lane_tools recipe/);
  });
});

describe("forgedock env CLI", () => {
  const cli = async (w, argv, env = {}) => { const lines = []; const code = await envFromCli(argv, { exec: fakeExec(w.calls), out: (s) => lines.push(s), env: { FORGE_ENV_ROOT: w.root, ...env }, cwd: w.wt }); return { code, lines }; };
  it("key, build (recipe only), build --apply, stage, status, gc", async () => {
    const w = world("pnpm");
    const k = await cli(w, ["key"]);
    assert.equal(k.code, 0);
    assert.match(k.lines[0], /^[0-9a-f]{16}$/);
    const j = JSON.parse((await cli(w, ["key", "--json", "--lane-tools", "xvfb"])).lines[0]);
    assert.notEqual(j.key, k.lines[0]);
    assert.deepEqual(j.ecosystems, [{ eco: "pnpm", dir: ".", lock: "pnpm-lock.yaml" }]);
    assert.equal((await cli(w, ["build"])).code, 0);
    const out = join(w.wt, ".forge/env", k.lines[0]);
    assert.deepEqual(readdirSync(out).sort(), ["build.sh", "manifest.json"]);
    assert.equal(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).key, k.lines[0]);
    assert.equal(w.calls.some((c) => c.startsWith("pnpm ") || c.startsWith("docker ")), false, "a plain build runs no installer and no docker");
    assert.deepEqual(JSON.parse((await cli(w, ["status", "--json"])).lines[0]).snapshots, []);
    assert.equal((await cli(w, ["build", "--store", "oci"])).code, 2, "oci needs base_image and image");
    put(join(w.wt, "forge.yaml"), "env:\n  snapshots:\n    enabled: true\n    store: oci\n    base_image: ghcr.io/acme/ci-base:1\n    image: ghcr.io/acme/shop-env\n");
    const oci = JSON.parse((await cli(w, ["build", "--json", "--out", join(w.base, "recipe")])).lines[0]);
    assert.match(oci.ref, /^ghcr\.io\/acme\/shop-env:[0-9a-f]{16}$/);
    assert.match(readFileSync(join(w.base, "recipe/Dockerfile.env"), "utf8"), /RUN pnpm install --frozen-lockfile/);
    assert.equal(w.calls.some((c) => c.startsWith("docker ")), false);
    fs.rmSync(join(w.wt, "forge.yaml"));
    assert.equal((await cli(w, ["build", "--apply"])).code, 0);
    assert.ok(w.calls.includes("pnpm install --frozen-lockfile"));
    assert.match((await cli(w, ["stage", "--count", "2"])).lines[0], /staged 2/);
    const st = JSON.parse((await cli(w, ["status", "--json"])).lines[0]);
    assert.deepEqual(st.snapshots.map((s) => [s.key, s.ready, s.ecosystems]), [[k.lines[0], 2, ["pnpm"]]]);
    assert.match((await cli(w, ["gc"])).lines[0], /nothing to remove/);
    assert.equal((await cli(w, ["nope"])).code, 2);
    assert.equal((await cli(w, ["gc", "--bogus"])).code, 2);
  });
});

describe("pool agent env snapshot helper", () => {
  it("envEnsureArgs keeps the store on the lane's cache volume and runs outside the lane", () => {
    const a = envEnsureArgs({ volume: "cs-cache-acme_shop", image: "lane:1-tabc", slug: "acme/shop", ref: "staging", laneTools: ["xvfb", "python@3.12"], snapshots: { ready: 3, keep: 4, max_age_days: 7 }, net: ["--dns", "1.1.1.1"] });
    assert.ok(a.join(" ").includes("-v cs-cache-acme_shop:/cache"));
    assert.ok(a.includes("FORGE_ENV_ROOT=/cache/env") && a.includes("FORGE_ENV_IMAGE=lane:1-tabc"));
    assert.equal(a[a.indexOf("--name") + 1], "cs-envbuild-acme_shop");
    assert.equal(a.includes("computeshare=1"), false, "not a sandbox: the orphan reaper leaves it alone");
    const tail = a.slice(a.indexOf("lane:1-tabc", a.indexOf("--entrypoint")));
    assert.deepEqual(tail, ["lane:1-tabc", "env", "ensure", "--mirror", "/cache/git/acme_shop.git", "--ref", "staging", "--repo", "acme/shop", "--ready", "3", "--keep", "4", "--max-age-days", "7", "--lane-tools", "python@3.12,xvfb"]);
  });
  const agentWorld = () => {
    const runs = [];
    const docker = { async run(args) { runs.push(args); return "id"; }, async inspect() { return { running: true }; }, async remove() {}, async listLabelled() { return []; }, async listVolumes() { return []; }, async removeVolume() {}, async hasImage() { return true; }, async stats() { return {}; }, async removeWorkDir() {}, async pruneWorkDirs() {}, async wipe() {} };
    let t = 1e12;
    const agent = createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: tmpDir("fd-env-agent-"), allow_cpus: 8, allow_mem_gb: 16, token: "t", image: "lane:1" }, { docker, now: () => t, log: {}, live: () => ({ ok: true }), vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }) });
    return { agent, runs, tick: (ms) => { t += ms; } };
  };
  const spec = (id, extra = {}) => ({ id, command: ["true"], repo: { slug: "acme/shop", url: "https://example.invalid/acme/shop.git", ref: "staging" }, ...extra });
  it("off: launch args and env are unchanged and no helper starts", async () => {
    const w = agentWorld();
    await w.agent.launch({ spec: spec("l1"), cpus: 1, mem_gb: 1 });
    await new Promise((r) => setImmediate(r));
    assert.equal(w.runs.length, 1);
    assert.equal(w.runs[0].join(" ").includes("FORGE_ENV"), false);
  });
  it("on: one helper per cache volume per gap, never blocking or failing the launch", async () => {
    const w = agentWorld();
    const on = { env_snapshots: { enabled: true, ready: 2, keep: 3, max_age_days: 14 } };
    const r = await w.agent.launch({ spec: spec("l1", on), cpus: 1, mem_gb: 1 });
    assert.equal(r.status, 201);
    await new Promise((res) => setImmediate(res));
    assert.equal(w.runs.length, 2);
    assert.equal(w.runs[0].includes("lane:1") && w.runs[0].includes("true"), true, "the lane container first");
    assert.equal(w.runs[1][w.runs[1].indexOf("--name") + 1], "cs-envbuild-acme-shop");
    assert.ok(w.runs[1].join(" ").includes("-v cs-cache-acme-shop:/cache"), "same volume as the lane's /cache and /cache/work");
    await w.agent.launch({ spec: spec("l2", on), cpus: 1, mem_gb: 1 });
    await new Promise((res) => setImmediate(res));
    assert.equal(w.runs.length, 3, "second launch inside the gap: lane only");
    w.tick(6 * 60000);
    await w.agent.launch({ spec: spec("l3", on), cpus: 1, mem_gb: 1 });
    await new Promise((res) => setImmediate(res));
    assert.equal(w.runs.length, 5);
  });
});
