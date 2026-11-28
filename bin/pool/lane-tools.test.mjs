// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RECIPES, hasRecipe, recipeFor, installCommands, installLaneTools, laneToolsDockerfile, laneToolsTag, laneBuildBackoffMs, resolveLaneImage, laneImageNow } from "./lane-tools.mjs";

describe("#5652 in-sandbox lane tool install", () => {
  it("installCommands strips RUN, prefixes sudo when not root, and is empty without a recipe", () => {
    assert.ok(hasRecipe("promtool") && !hasRecipe("nope"));
    assert.match(installCommands("yaml")[0], /^apt-get update/);
    assert.match(installCommands("yaml", { root: false })[0], /^sudo sh -c /);
    assert.deepEqual(installCommands("nope"), []);
  });
  it("a manifest-provided tool is skipped unpinned, but a pinned version still installs (#6147)", () => {
    assert.deepEqual(installCommands("postgresql-client"), []);
    assert.match(installCommands("postgresql-client@16").join("\n"), /postgresql-client-16/);
  });
  it("installLaneTools runs every step, and returns the stderr tail of the first failure", async () => {
    const seen = [];
    assert.deepEqual(await installLaneTools(["yaml"], { run: async (a) => { seen.push(a.command); return { rc: 0 }; } }), { ok: true });
    assert.equal(seen.length, 1);
    const bad = await installLaneTools(["promtool@2.54.1"], { run: async () => ({ rc: 3, stderr: "a\nb\n404" }) });
    assert.equal(bad.ok, false);
    assert.equal(bad.tool, "promtool@2.54.1");
    assert.match(bad.stderrTail, /404$/);
  });
  it("the image Dockerfile still uses the RUN steps", () => {
    assert.match(laneToolsDockerfile("base:1", ["postgresql-client"]), /\nRUN apt-get update/);
  });
  it("#5763 shellcheck is an unversioned apt recipe in the derived image", () => {
    assert.ok(hasRecipe("shellcheck"));
    assert.match(RECIPES.shellcheck.steps()[0], /^RUN apt-get update && apt-get install -y --no-install-recommends shellcheck /);
    assert.match(laneToolsDockerfile("base:1", ["shellcheck"]), /\nRUN apt-get update && apt-get install -y --no-install-recommends shellcheck /);
  });
  it("#5764 a binary a recipe provides resolves to it; python3 installs the unversioned python recipe", () => {
    for (const [b, r] of [["python3", "python"], ["python3.12", "python"], ["pip3", "python"], ["psql", "postgresql-client"], ["xvfb-run", "xvfb"], ["python", "python"]]) assert.equal(recipeFor(b), r, b);
    assert.ok(hasRecipe("python3") && !hasRecipe("zzcheck") && recipeFor("zzcheck") === null);
    assert.match(RECIPES.python.steps()[0], /install -y --no-install-recommends python3 python3-venv /);
    assert.match(RECIPES.python.steps("3.12")[0], /python3\.12 python3\.12-venv/);
  });
});

describe("#5749 yaml recipe", () => {
  it("#5749 yaml has a lane_tools recipe", () => {
    assert.ok(hasRecipe("yaml"));
    assert.match(installCommands("yaml")[0], /apt-get install .*python3-yaml/);
    assert.ok(hasRecipe("shellcheck"));
    assert.ok(!hasRecipe("vite") && !hasRecipe("forgedock"), "#5749: manifest/owned deps get no recipe");
  });
});

describe("#6037 image manifest tools skip the fallback installers", () => {
  it("returns [] for manifest tools and keeps commands for others", async () => {
    const { genericInstallCommands } = await import("./lane-tools.mjs");
    for (const t of ["shellcheck", "xvfb", "yq"]) assert.deepEqual(installCommands(t), [], t);
    for (const t of ["shellcheck", "yq"]) assert.deepEqual(genericInstallCommands({ kind: "command", tool: t }), [], t);
    assert.ok(installCommands("promtool").length);
    assert.match(genericInstallCommands({ kind: "command", tool: "ripgrep" })[0], /apt-get install/);
  });
  it("marks the fallbacks deprecated", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./lane-tools.mjs", import.meta.url), "utf8");
    assert.match(src, /@deprecated[^\n]*\n(export const RECIPES|export function hasRecipe)/);
    assert.ok((src.match(/@deprecated/g) ?? []).length >= 4);
  });
});

describe("#6187 pulled variants, backoff and error tail", () => {
  const dock = (over = {}) => { const images = new Set(); return { builds: [], pulls: [], async hasImage(r) { return images.has(r); }, async build(d, t) { this.builds.push(t); if (over.failBuild) throw Object.assign(new Error("x"), { stderr: `${"head ".repeat(600)}REAL-CAUSE` }); images.add(t); }, ...over }; };
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  it("a pulled variant skips the build, and its tag is laneToolsTag", async () => {
    const pulled = [], docker = dock({ pullVariant: async (t) => { pulled.push(t); return true; } });
    const img = await resolveLaneImage({ tools: ["xvfb"], baseImage: "pv:1", docker });
    assert.equal(img, laneToolsTag("pv:1", ["xvfb"]));
    assert.deepEqual(pulled, [img]);
    assert.equal(docker.builds.length, 0);
  });
  it("a failed pull falls back to the build, wrapped by withFallback", async () => {
    let wrapped = 0;
    const docker = dock({ pullVariant: async () => { throw new Error("404"); }, withFallback: (op) => { wrapped++; return op(); } });
    await resolveLaneImage({ tools: ["xvfb"], baseImage: "pv:2", docker, sleep: async () => {} });
    assert.equal(docker.builds.length, 1);
    assert.equal(wrapped, 1);
  });
  it("a failed build message keeps the tail, and the retry window grows 1, 2, 5, 10 min", async () => {
    assert.deepEqual([1, 2, 3, 4, 9].map(laneBuildBackoffMs), [60000, 120000, 300000, 600000, 600000]);
    let t = 0;
    const now = () => t, docker = dock({ failBuild: true }), a = { tools: ["shellcheck"], baseImage: "pv:3", docker, now, sleep: async () => {} };
    await laneImageNow(a); await settle();
    assert.match((await laneImageNow(a)).failed, /REAL-CAUSE$/);
    t += 60001; await laneImageNow(a); await settle(); // 2nd failure
    t += 60001;
    assert.ok((await laneImageNow(a)).failed, "still inside the 2 min window");
    assert.equal(docker.builds.length, 4); // 2 failures x (build + retry)
    t += 60001;
    assert.ok((await laneImageNow(a)).building);
  });
});

describe("lane image build errors and retry (#6189)", async () => {
  const { laneImageNow, resolveLaneImage } = await import("./lane-tools.mjs");
  const tools = ["shellcheck"];
  const longErr = () => Object.assign(new Error("failed"), { stderr: `Dockerfile:5\n${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\nE: apt failed` });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const mk = (build) => ({ hasImage: async () => false, build });

  it("failure message carries the tail of a long stderr", async () => {
    const docker = mk(async () => { throw longErr(); });
    await laneImageNow({ tools, baseImage: "base:tail", docker, sleep: async () => {} });
    await settle();
    const r = await laneImageNow({ tools, baseImage: "base:tail", docker, sleep: async () => {} });
    assert.match(r.failed, /E: apt failed/);
    assert.doesNotMatch(r.failed, /Dockerfile:5/);
  });
  it("retries a failed build once and yields the image", async () => {
    let calls = 0;
    const docker = mk(async () => { if (++calls === 1) throw longErr(); });
    const img = await resolveLaneImage({ tools, baseImage: "base:retry", docker, sleep: async () => {} });
    assert.equal(calls, 2);
    assert.match(img, /base|lane/);
  });
  it("a persistent failure gives build_failed after 2 calls", async () => {
    let calls = 0;
    const docker = mk(async () => { calls++; throw longErr(); });
    await assert.rejects(resolveLaneImage({ tools, baseImage: "base:fail", docker, sleep: async () => {} }), (e) => e.code === "lane_tools.build_failed" && /E: apt failed/.test(e.message));
    assert.equal(calls, 2);
  });
});
