// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-repo lane images (#5650): registry, validation, tag, build/reuse, agent launch and warm pool use.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RECIPES, parseLaneTool, validateLaneTools, checkRecipes, laneToolsTag, laneToolsDockerfile, resolveLaneImage } from "../pool/lane-tools.mjs";
import { createAgent } from "../pool/agent.mjs";
import { tmpDir } from "./_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
function fakeDocker({ have = [], failBuild = false, hang = false } = {}) {
  const images = new Set(have), containers = new Map();
  return { builds: [], runs: [],
    async hasImage(ref) { return images.has(ref); },
    async build(dir, tag) { this.builds.push({ dir, tag, dockerfile: readFileSync(`${dir}/Dockerfile`, "utf8") }); if (hang) return new Promise(() => {}); if (failBuild) throw Object.assign(new Error("boom"), { stderr: "apt failed" }); images.add(tag); return tag; },
    async run(args) { this.runs.push(args); containers.set(args[args.indexOf("--name") + 1], { running: true, exitCode: 0, startedAt: "", finishedAt: "" }); return "cid"; },
    async inspect(n) { return containers.get(n) ?? null; }, async remove() {}, async listLabelled() { return []; }, async wipe() {}, async listVolumes() { return []; }, async removeVolume() {} };
}
const spec = (id, extra = {}) => ({ id, issue: 7, repo: { slug: "o/r", url: "u", ref: "main" }, env: {}, command: ["true"], ...extra });
const agentWith = (docker) => createAgent({ name: "a", listen: { host: "127.0.0.1", port: 7712 }, router_url: "http://r:1", state_dir: tmpDir("lt-"), allow_cpus: 8, allow_mem_gb: 16, token: "t" }, { docker, log: quiet, live: () => ({ ok: true }) });
const SIZE = { cpus: 2, mem_gb: 3 };

describe("lane_tools validation", () => {
  it("accepts name and name@version, sorts and dedupes", () => {
    assert.deepEqual(validateLaneTools(["promtool@2.54.1", "playwright", "promtool@2.54.1"]), { tools: ["playwright", "promtool@2.54.1"], errors: [] });
    assert.deepEqual(parseLaneTool("python@3.12"), { name: "python", version: "3.12" });
  });
  it("rejects metacharacters and empty names, naming the entry", () => {
    const { tools, errors } = validateLaneTools(["ok", "a;rm -rf /", "$(x)", "", "a b", "@1"]);
    assert.deepEqual(tools, ["ok"]);
    assert.equal(errors.length, 5);
    assert.ok(errors[0].includes("a;rm -rf /"));
  });
});

describe("recipes and tag", () => {
  it("unknown tool fails fast naming the tool and known recipes; nothing is built", async () => {
    const docker = fakeDocker();
    await assert.rejects(resolveLaneImage({ tools: ["nosuch"], baseImage: "b:1", docker }), (e) => e.code === "lane_tools.unknown_recipe" && e.message.includes("nosuch") && Object.keys(RECIPES).every((n) => e.message.includes(n)));
    assert.equal(docker.builds.length, 0);
    assert.throws(() => checkRecipes(["nosuch@1"]), /nosuch/);
  });
  it("same list gives the same tag, a different list or base a different one", () => {
    const t = laneToolsTag("b:1", ["a", "b"]);
    assert.equal(laneToolsTag("b:1", ["b", "a"]), t);
    assert.notEqual(laneToolsTag("b:1", ["a"]), t);
    assert.notEqual(laneToolsTag("b:2", ["a", "b"]), t);
  });
  it("no tool names appear outside the registry module", () => {
    for (const f of ["agent.mjs", "warm.mjs", "router.mjs"]) { const src = readFileSync(new URL(`../pool/${f}`, import.meta.url), "utf8"); for (const n of Object.keys(RECIPES)) assert.ok(!src.includes(`"${n}"`), `${f} mentions ${n}`); }
  });
});

describe("resolveLaneImage", () => {
  it("no tools: the base image, no docker calls", async () => {
    const docker = fakeDocker();
    assert.equal(await resolveLaneImage({ tools: [], baseImage: "b:1", docker }), "b:1");
    assert.equal(docker.builds.length, 0);
  });
  it("missing: builds FROM the base with the recipes; present: reused without a build", async () => {
    const docker = fakeDocker();
    const tag = await resolveLaneImage({ tools: ["promtool@2.54.1"], baseImage: "b:1", docker });
    assert.equal(tag, laneToolsTag("b:1", ["promtool@2.54.1"]));
    assert.equal(docker.builds.length, 1);
    assert.match(docker.builds[0].dockerfile, /^FROM b:1\n/);
    assert.match(docker.builds[0].dockerfile, /promtool/);
    assert.equal(await resolveLaneImage({ tools: ["promtool@2.54.1"], baseImage: "b:1", docker }), tag);
    assert.equal(docker.builds.length, 1);
    assert.ok(laneToolsDockerfile("b:1", ["postgresql-client"]).includes("postgresql-client"));
  });
  it("a failed build is a typed error", async () => {
    await assert.rejects(resolveLaneImage({ tools: ["playwright"], baseImage: "b:1", docker: fakeDocker({ failBuild: true }) }), (e) => e.code === "lane_tools.build_failed" && /apt failed/.test(e.message));
  });
  it("a hung build times out with a typed error", async () => {
    await assert.rejects(resolveLaneImage({ tools: ["playwright"], baseImage: "b:1", docker: fakeDocker({ hang: true }), buildTimeoutMs: 20 }), (e) => e.code === "lane_tools.build_failed" && /timed out/.test(e.message));
  });
});

describe("agent launch and warm pool", () => {
  it("lane_tools: cold start runs the per-repo image", async () => {
    const docker = fakeDocker(), agent = agentWith(docker);
    const r = await agent.launch({ spec: spec("lane-1", { lane_tools: ["promtool@2.54.1"] }), ...SIZE });
    assert.equal(r.body.state, "running");
    const run = docker.runs.find((a) => a.includes("cs-lane-1"));
    assert.match(run[run.length - 2], /-t[0-9a-f]{12}$/);
    assert.equal(docker.builds.length, 1);
  });
  it("without lane_tools the image and tag are unchanged (no build)", async () => {
    const docker = fakeDocker(), agent = agentWith(docker);
    await agent.launch({ spec: spec("lane-2"), ...SIZE });
    const run = docker.runs.find((a) => a.includes("cs-lane-2"));
    assert.match(run[run.length - 2], /^forgedock-lane:[^-]+(-[A-Za-z0-9.]+)?$/);
    assert.ok(!/-t[0-9a-f]{12}$/.test(run[run.length - 2]));
    assert.equal(docker.builds.length, 0);
  });
  it("an unknown recipe fails the launch with the error recorded, no build", async () => {
    const docker = fakeDocker(), agent = agentWith(docker);
    const r = await agent.launch({ spec: spec("lane-3", { lane_tools: ["nosuch"] }), ...SIZE });
    assert.equal(r.body.state, "exited");
    assert.match(r.body.error, /nosuch/);
    assert.equal(docker.builds.length, 0);
  });
  it("warm sandboxes launch with the per-repo image", async () => {
    const docker = fakeDocker(), agent = agentWith(docker);
    await agent.launch({ spec: spec("lane-4", { lane_tools: ["playwright"], warm: 1 }), ...SIZE });
    await agent.warm.replenish();
    const warmRun = docker.runs.find((a) => a.some((x) => String(x).includes("warm-")));
    assert.ok(warmRun, "a warm sandbox was started");
    assert.match(warmRun[warmRun.length - 2], /-t[0-9a-f]{12}$/);
  });
});
