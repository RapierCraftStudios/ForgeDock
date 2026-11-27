// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { laneConfigEnv, hostPoetryConfigProblem } from "./hostconfig.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

describe("laneConfigEnv (#5917)", () => {
  it("points every tool config into the lane dir, not HOME; nothing without a dir", () => {
    const dir = tmpDir("hc-dir-"), home = tmpDir("hc-home-");
    const e = laneConfigEnv({ dir, hostHome: home, env: {} });
    for (const k of ["POETRY_CONFIG_DIR", "npm_config_userconfig", "PIP_CONFIG_FILE", "UV_CONFIG_FILE", "GIT_CONFIG_GLOBAL"]) {
      assert.ok(e[k].startsWith(join(dir, "hostconfig")), k);
      assert.ok(!e[k].startsWith(home), k);
    }
    assert.deepEqual(laneConfigEnv({}), {});
  });
  it("a poetry-style writer honouring POETRY_CONFIG_DIR leaves the host config.toml byte-identical (R5)", () => {
    const dir = tmpDir("hc-dir-"), home = tmpDir("hc-home-");
    const hostCfg = join(home, ".config", "pypoetry"); mkdirSync(hostCfg, { recursive: true });
    writeFileSync(join(hostCfg, "config.toml"), "[virtualenvs]\ncreate = true\n");
    const before = readFileSync(join(hostCfg, "config.toml"));
    const e = laneConfigEnv({ dir, hostHome: home, env: {} });
    const r = spawnSync(process.execPath, ["-e", `const fs=require("fs"),p=require("path");const d=process.env.POETRY_CONFIG_DIR||p.join(process.env.HOME,".config/pypoetry");fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"config.toml"),"[virtualenvs]\\ncreate = false\\n")`], { env: { ...process.env, HOME: home, ...e } });
    assert.equal(r.status, 0);
    assert.ok(readFileSync(join(hostCfg, "config.toml")).equals(before));
    assert.match(readFileSync(join(e.POETRY_CONFIG_DIR, "config.toml"), "utf8"), /create = false/);
  });
  it("git config --global writes the lane file, leaves ~/.gitconfig alone, still reads its user.name", () => {
    const dir = tmpDir("hc-dir-"), home = tmpDir("hc-home-");
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Host Person\n");
    const before = readFileSync(join(home, ".gitconfig"));
    const e = laneConfigEnv({ dir, hostHome: home, env: {} });
    const env = { ...process.env, HOME: home, ...e }, g = (...a) => spawnSync("git", a, { env, encoding: "utf8" });
    assert.equal(g("config", "--global", "core.foo", "bar").status, 0);
    assert.ok(readFileSync(join(home, ".gitconfig")).equals(before));
    assert.equal(g("config", "user.name").stdout.trim(), "Host Person");
    assert.equal(g("config", "--global", "--get", "core.foo").stdout.trim(), "bar");
  });
  it("no host gitconfig: an empty lane file", () => {
    const dir = tmpDir("hc-dir-");
    const e = laneConfigEnv({ dir, hostHome: tmpDir("hc-home-"), env: {} });
    assert.equal(readFileSync(e.GIT_CONFIG_GLOBAL, "utf8"), "");
  });
});

describe("hostPoetryConfigProblem (#5917)", () => {
  const home = (toml) => { const h = tmpDir("hc-home-"); if (toml != null) { mkdirSync(join(h, ".config", "pypoetry"), { recursive: true }); writeFileSync(join(h, ".config", "pypoetry", "config.toml"), toml); } return h; };
  const run = (toml, env = {}) => hostPoetryConfigProblem({ env, home: home(toml) });
  it("flags virtualenvs.create=false (table and dotted forms)", () => {
    assert.match(run("[virtualenvs]\ncreate = false\n").detail, /virtualenvs\.create = false/);
    assert.ok(run("virtualenvs.create = false\n"));
  });
  it("passes create=true, other tables' create, and a missing file", () => {
    assert.equal(run("[virtualenvs]\ncreate = true\n"), null);
    assert.equal(run("[other]\ncreate = false\n"), null);
    assert.equal(run(null), null);
  });
  it("honours POETRY_CONFIG_DIR", () => {
    const d = tmpDir("hc-pcd-"); writeFileSync(join(d, "config.toml"), "[virtualenvs]\ncreate = false\n");
    assert.ok(run(null, { POETRY_CONFIG_DIR: d }));
    assert.ok(!existsSync(join(d, "nope")));
  });
});
