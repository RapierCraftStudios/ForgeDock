// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveProjectDeps, projectLayerTag, isProjectLayerTagOf, projectLayerDockerfile, projectLayerImageNow, pendingBuild } from "./project-layer.mjs";
import { laneToolsTag } from "./lane-tools.mjs";

const fakeFs = (files) => ({
  existsSync: (p) => p in files || Object.keys(files).some((k) => k.startsWith(`${p}/`)),
  readFileSync: (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
  readdirSync: (p) => { const s = new Set(Object.keys(files).filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1).split("/")[0])); if (!s.size) throw new Error("ENOENT"); return [...s]; },
});
const W = "/w";
const repo = (extra = {}) => fakeFs({ [`${W}/package-lock.json`]: "lock1", [`${W}/package.json`]: "{}", ...extra });

describe("#6038 project layer", () => {
  it("same lockfile gives the same tag; a changed lockfile a new one", () => {
    const a = deriveProjectDeps(W, repo()), b = deriveProjectDeps(W, repo()), c = deriveProjectDeps(W, repo({ [`${W}/package-lock.json`]: "lock2" }));
    assert.equal(a.hash, b.hash);
    assert.notEqual(a.hash, c.hash);
    assert.match(projectLayerTag("img:1", a.hash), /^img:1-p[0-9a-f]{12}$/);
    assert.deepEqual(a.ecosystems, ["npm"]);
  });
  it("derives runtime versions from .nvmrc, .tool-versions, .python-version and setup-python/setup-node", () => {
    assert.equal(deriveProjectDeps(W, repo({ [`${W}/.nvmrc`]: "v20.11.1\n" })).node, "20.11.1");
    assert.equal(deriveProjectDeps(W, repo({ [`${W}/.tool-versions`]: "nodejs 22.3.0\n" })).node, "22.3.0");
    assert.equal(deriveProjectDeps(W, repo({ [`${W}/.github/workflows/ci.yml`]: "with:\n  node-version: '18'\n" })).node, "18");
    const py = (extra) => deriveProjectDeps(W, fakeFs({ [`${W}/uv.lock`]: "x", ...extra }));
    assert.equal(py({ [`${W}/.python-version`]: "3.12.2\n" }).python, "3.12");
    assert.equal(py({ [`${W}/.github/workflows/ci.yml`]: "python-version: \"3.11\"\n" }).python, "3.11");
    assert.equal(py({ [`${W}/.tool-versions`]: "python 3.10.4\n" }).python, "3.10");
    assert.notEqual(deriveProjectDeps(W, repo()).hash, deriveProjectDeps(W, repo({ [`${W}/.nvmrc`]: "20" })).hash);
  });
  it("no lockfile means no hash; tag ownership does not collide with lane_tools tags", () => {
    assert.equal(deriveProjectDeps(W, fakeFs({})).hash, null);
    const t = laneToolsTag("img:1", ["shellcheck"]);
    assert.ok(isProjectLayerTagOf(projectLayerTag("img:1", "ab".repeat(8)), "img:1"));
    assert.ok(isProjectLayerTagOf(projectLayerTag(t, "ab".repeat(8)), "img:1"));
    assert.ok(!isProjectLayerTagOf(t, "img:1") && !isProjectLayerTagOf("img:1", "img:1") && !isProjectLayerTagOf("img:1-pzz", "img:1"));
  });
  it("Dockerfile is FROM base with the frozen install", () => {
    const df = projectLayerDockerfile("img:1", deriveProjectDeps(W, repo({ [`${W}/.nvmrc`]: "20" })));
    assert.match(df, /^FROM img:1\n/);
    assert.match(df, /RUN 'npm' 'ci'/);
    assert.match(df, /n '20'/);
  });
  it("an existing tag is reused without a build", async () => {
    const deps = deriveProjectDeps(W, repo()), tag = projectLayerTag("img:2", deps.hash);
    let built = 0;
    const docker = { hasImage: async (t) => t === tag, build: async () => { built++; } };
    assert.deepEqual(await projectLayerImageNow({ deps, baseImage: "img:2", docker }), { image: tag });
    assert.equal(built, 0);
  });
  it("concurrent launches share one background build and run the base meanwhile", async () => {
    const deps = deriveProjectDeps(W, repo({ [`${W}/package-lock.json`]: "conc" })), tag = projectLayerTag("img:3", deps.hash);
    let built = 0, release; const gate = new Promise((r) => { release = r; });
    const docker = { hasImage: async () => false, build: async () => { built++; await gate; } };
    const [a, b] = await Promise.all([1, 2].map(() => projectLayerImageNow({ deps, baseImage: "img:3", docker })));
    assert.equal(a.image, "img:3"); assert.ok(a.building && b.building);
    release(); await pendingBuild(tag);
    assert.equal(built, 1);
  });
  it("a failed build falls back to base and is not retried within the window", async () => {
    const deps = deriveProjectDeps(W, repo({ [`${W}/package-lock.json`]: "fail" })), tag = projectLayerTag("img:4", deps.hash);
    let built = 0; let t = 1000;
    const docker = { hasImage: async () => false, build: async () => { built++; throw new Error("boom"); } };
    await projectLayerImageNow({ deps, baseImage: "img:4", docker, now: () => t });
    await pendingBuild(tag);
    const r = await projectLayerImageNow({ deps, baseImage: "img:4", docker, now: () => t });
    assert.equal(r.image, "img:4"); assert.match(r.failed, /boom/);
    assert.equal(built, 1);
  });
});
