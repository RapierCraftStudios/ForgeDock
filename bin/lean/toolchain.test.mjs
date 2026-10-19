// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpDir } from "../tests/_tmp.mjs";
import { detectPins, parsePackageManager, nodeSatisfies, nodeWarning, shimScripts, prepareToolchain, toolchainEnv } from "./toolchain.mjs";

const tmp = (p) => tmpDir(p);
const repo = (files) => {
  const d = tmp("tc-repo-");
  for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), typeof t === "string" ? t : JSON.stringify(t));
  return d;
};
const exe = (dir, name, body) => { mkdirSync(dir, { recursive: true }); const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
/**
 * A host whose PATH has pnpm 11.0.0 and a fake corepack/npx that print the requested version for `--version`
 * (`corepack pnpm@X --version`, `npx -y -p pnpm@X pnpm --version`) without any network.
 */
const fakeHost = ({ corepack = true } = {}) => {
  const d = tmp("tc-host-");
  exe(d, "pnpm", 'echo 11.0.0');
  const pick = 'for a in "$@"; do case "$a" in pnpm@*) v="${a#pnpm@}";; esac; done; for a in "$@"; do [ "$a" = "--version" ] && { echo "$v"; exit 0; }; done; exit 0';
  if (corepack) exe(d, "corepack", pick);
  exe(d, "npx", pick);
  return d;
};
const sysPath = process.env.PATH ?? "";

describe("toolchain pins (#4163)", () => {
  it("parsePackageManager accepts pm@x.y.z (with a +sha suffix) and nothing else", () => {
    assert.deepEqual(parsePackageManager("pnpm@10.4.1+sha512.abc"), { name: "pnpm", version: "10.4.1" });
    assert.deepEqual(parsePackageManager("yarn@4.1.0"), { name: "yarn", version: "4.1.0" });
    for (const bad of ["pnpm@10", "bun@1.0.0", "pnpm@latest", "pnpm@1.0.0;rm -rf /", "", null]) assert.equal(parsePackageManager(bad), null, String(bad));
  });

  it("detects packageManager and node pins in priority order", async () => {
    const d = repo({ "package.json": { packageManager: "pnpm@10.4.1", engines: { node: ">=18" } }, ".nvmrc": "20.11.0\n", ".node-version": "22\n" });
    const p = await detectPins(d);
    assert.deepEqual(p.packageManager, { name: "pnpm", version: "10.4.1", source: "package.json packageManager" });
    assert.deepEqual(p.node, { spec: "20.11.0", source: ".nvmrc" });
    const e = await detectPins(repo({ "package.json": { engines: { node: "^20" } } }));
    assert.deepEqual(e.node, { spec: "^20", source: "package.json engines.node" });
    assert.equal(e.packageManager, null);
    const tv = await detectPins(repo({ ".tool-versions": "# pins\nnodejs 20.1.0\npnpm 9.1.0\n" }));
    assert.deepEqual(tv.packageManager, { name: "pnpm", version: "9.1.0", source: ".tool-versions" });
    assert.deepEqual(tv.node, { spec: "20.1.0", source: ".tool-versions" });
  });

  it("forge.yaml env.toolchain overrides the pm pin; off disables detection; junk is a note", async () => {
    const d = repo({ "package.json": { packageManager: "pnpm@10.4.1" }, ".nvmrc": "20" });
    assert.deepEqual((await detectPins(d, { override: "pnpm@9.0.0" })).packageManager, { name: "pnpm", version: "9.0.0", source: "forge.yaml env.toolchain" });
    const off = await detectPins(d, { override: "off" });
    assert.equal(off.packageManager, null); assert.equal(off.node, null);
    const junk = await detectPins(d, { override: "pnpm" });
    assert.equal(junk.packageManager.version, "10.4.1");
    assert.match(junk.notes[0], /env\.toolchain "pnpm" is not/);
  });

  it("nodeSatisfies covers exact, partial, x, caret, tilde, comparators and ||", () => {
    const t = [["20", "v20.11.0", true], ["20", "v22.1.0", false], ["20.11", "v20.11.4", true], ["20.x", "v20.0.0", true], ["^20.5", "v20.4.0", false],
      ["^20.5", "v20.9.0", true], ["~20.5.1", "v20.6.0", false], [">=18", "v26.7.0", true], [">=18 <21", "v22.0.0", false], ["18 || 20", "v20.1.0", true],
      ["< 20", "v20.0.0", false], ["<=20", "v20.9.9", true], [">20", "v20.9.9", false], [">20", "v21.0.0", true], ["v20.11.0", "v20.11.0", true]];
    for (const [spec, v, want] of t) assert.equal(nodeSatisfies(spec, v), want, `${spec} vs ${v}`);
    assert.equal(nodeSatisfies("18 - 20", "v19.0.0"), true);
    assert.equal(nodeSatisfies("18 - 20", "v21.0.0"), false);
    assert.equal(nodeSatisfies("hydrogen", "v19.0.0"), null);
  });

  it("an unsatisfied node pin yields a clear warning; a satisfied or alias pin yields none", () => {
    assert.match(nodeWarning({ spec: "18.19.0", source: ".nvmrc" }, "v26.7.0"), /host node v26\.7\.0 does not satisfy the \.nvmrc pin "18\.19\.0"/);
    assert.equal(nodeWarning({ spec: ">=18", source: "package.json engines.node" }, "v26.7.0"), null);
    assert.equal(nodeWarning({ spec: "lts/iron", source: ".nvmrc" }, "v26.7.0"), null);
    assert.match(nodeWarning({ spec: "iron-ish", source: ".nvmrc" }, "v26.7.0"), /cannot evaluate/);
  });

  it("shims: corepack first, npx fallback, yarn berry via @yarnpkg/cli-dist, values quoted", () => {
    const pm = { name: "pnpm", version: "10.4.1" };
    assert.match(shimScripts(pm, { corepack: "/h/corepack", npx: "/h/npx" }).pnpm, /exec '\/h\/corepack' 'pnpm@10\.4\.1' "\$@"/);
    assert.match(shimScripts(pm, { corepack: "/h/corepack" }).pnpx, /'pnpm@10\.4\.1' dlx "\$@"/);
    assert.match(shimScripts(pm, { npx: "/h/npx" }).pnpm, /exec '\/h\/npx' -y -p 'pnpm@10\.4\.1' pnpm "\$@"/);
    assert.match(shimScripts({ name: "yarn", version: "4.1.0" }, { npx: "/h/npx" }).yarn, /-p '@yarnpkg\/cli-dist@4\.1\.0' yarn/);
    assert.match(shimScripts({ name: "yarn", version: "1.22.19" }, { npx: "/h/npx" }).yarn, /-p 'yarn@1\.22\.19' yarn/);
    const npm = shimScripts({ name: "npm", version: "10.2.0" }, { corepack: "/h/c", npx: "/h/npx" });
    assert.deepEqual(Object.keys(npm), ["npm", "npx"]);
    assert.match(npm.npx, /exec '\/h\/npx' -y -p 'npm@10\.2\.0' npx "\$@"/);
    assert.deepEqual(shimScripts(pm, {}), {});
  });

  for (const corepack of [true, false]) {
    it(`R1: with packageManager pnpm@10.4.1 and pnpm 11 on PATH, runner/validate/hook shells resolve pnpm --version to 10.4.1 (${corepack ? "corepack" : "npx"})`, async () => {
      const host = fakeHost({ corepack });
      const basePath = `${host}${delimiter}${sysPath}`;
      assert.equal(execFileSync("sh", ["-c", "pnpm --version"], { env: { ...process.env, PATH: basePath } }).toString().trim(), "11.0.0", "the host pnpm is the wrong one");
      const d = repo({ "package.json": { name: "x", packageManager: "pnpm@10.4.1+sha512.ff" } });
      const binDir = join(tmp("tc-run-"), "toolchain", "bin");
      const tc = await prepareToolchain({ dir: d, binDir, basePath, hostNode: () => "v20.0.0" });
      assert.ok(tc.env && tc.env.PATH.startsWith(binDir + delimiter), "shim dir first on PATH");
      assert.equal(tc.summary, "pnpm@10.4.1 (package.json packageManager)");
      const env = { ...process.env, ...tc.env };
      // runner: the claude CLI child gets this env (bin/runner.mjs applies `env` last); its Bash tool shells inherit it.
      assert.equal(execFileSync("bash", ["-lc", "pnpm --version"], { env, cwd: d }).toString().trim(), "10.4.1", "runner shell");
      // validate: a validate command is a shell command in the worktree.
      assert.equal(execFileSync("sh", ["-c", "cd . && pnpm --version"], { env, cwd: d }).toString().trim(), "10.4.1", "validate command");
      // hooks: git runs pre-commit / commit-msg hooks with the committing shell's PATH.
      const git = (a) => execFileSync("git", a, { env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, cwd: d }).toString();
      git(["init", "-q"]);
      exe(join(d, ".git", "hooks"), "pre-commit", `pnpm --version > "${join(d, "pre.out")}"`);
      exe(join(d, ".git", "hooks"), "commit-msg", `pnpm --version > "${join(d, "msg.out")}"`);
      git(["add", "package.json"]);
      git(["commit", "-q", "-m", "x"]);
      assert.equal(readFileSync(join(d, "pre.out"), "utf8").trim(), "10.4.1", "pre-commit hook");
      assert.equal(readFileSync(join(d, "msg.out"), "utf8").trim(), "10.4.1", "commit-msg hook");
    });
  }

  it("R2: a node pin the host does not satisfy produces a warning (and no shim without a pm pin)", async () => {
    const binDir = join(tmp("tc-run-"), "bin");
    const tc = await prepareToolchain({ dir: repo({ ".nvmrc": "18.19.0" }), binDir, hostNode: () => "v26.7.0" });
    assert.match(tc.warning, /does not satisfy the \.nvmrc pin "18\.19\.0"/);
    assert.equal(tc.env, null); assert.equal(existsSync(binDir), false);
  });

  it("R4: a repo without pins gets nothing: no env, no shim dir, no warning, no notes", async () => {
    const binDir = join(tmp("tc-run-"), "bin");
    for (const files of [{}, { "package.json": { name: "x", scripts: { test: "node --test" } } }]) {
      const tc = await prepareToolchain({ dir: repo(files), binDir, hostNode: () => { throw new Error("must not probe node"); } });
      assert.equal(tc.env, null); assert.equal(tc.summary, null); assert.equal(tc.warning, null);
      assert.deepEqual(tc.shims, []); assert.deepEqual(tc.notes, []);
      assert.equal(existsSync(binDir), false);
    }
  });

  it("toolchainEnv prepends the shim dir", () => {
    assert.deepEqual(toolchainEnv("/s", "/a:/b"), { PATH: `/s${delimiter}/a:/b`, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_ENABLE_STRICT: "0" });
  });
});
