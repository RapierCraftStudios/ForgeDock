// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5758: superseded lane images, the build cache and anonymous volumes are collected by the pool agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { join } from "node:path";
import { createAgent } from "../pool/agent.mjs";
import { dockerCli } from "../pool/docker.mjs";
import { versionOf, repoRoot, laneImageTag } from "../pool/version.mjs";
import { laneToolsTag, isLaneToolsTagOf } from "../pool/lane-tools.mjs";
import { tmpDir } from "./_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const running = versionOf(repoRoot).version;
const tools = (v, n = "a") => laneToolsTag(laneImageTag(v), [n]);
const HEX = "a".repeat(64);

function fakeDocker({ images = [], containers = [], volumes = [], dangling = [] } = {}) {
  const d = {
    images: new Set(images), removed: [], pruned: [], volumesRemoved: [], containers,
    hasImage: async () => true,
    listImages: async (prefix) => [...d.images].filter((t) => t.startsWith(prefix)),
    listContainerImages: async () => d.containers,
    removeImage: async (t) => { d.images.delete(t); d.removed.push(t); },
    builderPrune: async (gb) => { d.pruned.push(gb); },
    listDanglingVolumes: async () => dangling,
    listLabelled: async () => [], listVolumes: async () => volumes, removeVolume: async (v) => { d.volumesRemoved.push(v); },
    remove: async () => {}, stats: async () => ({}), inspect: async () => null,
  };
  return d;
}
function agentOf(docker, opts = {}, clock = { t: 1_000_000 }) {
  return createAgent({ name: "a1", listen: { host: "127.0.0.1", port: 7711 }, router_url: "http://router:7710", state_dir: tmpDir("cs-gc-"), allow_cpus: 4, allow_mem_gb: 8, token: "t", ...opts }, { docker, now: () => clock.t, log: quiet, live: () => ({ ok: true }), vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }) });
}
const family = (v) => [laneImageTag(v), tools(v), tools(v, "b")];

test("after two updates only the running and previous lane versions with their tools tags remain", async () => {
  const docker = fakeDocker({ images: [...family("0.0.1"), ...family("0.0.2"), ...family("0.0.3"), ...family(running)] });
  await agentOf(docker).ensureImage();
  assert.deepEqual([...docker.images].sort(), [...family("0.0.3"), ...family(running)].sort());
  assert.equal(docker.removed.length, 6);
  // keep_lane_images widens the window
  const wide = fakeDocker({ images: [...family("0.0.1"), ...family("0.0.2"), ...family("0.0.3"), ...family(running)] });
  await agentOf(wide, { keep_lane_images: 3 }).ensureImage();
  assert.equal(wide.removed.length, 3);
});

test("an image used by a running or exited container is kept", async () => {
  const docker = fakeDocker({ images: [...family("0.0.1"), ...family("0.0.2"), ...family("0.0.3"), ...family(running), "other/img:1"], containers: [laneImageTag("0.0.1"), tools("0.0.2")] });
  await agentOf(docker).ensureImage();
  assert.ok(docker.images.has(laneImageTag("0.0.1")) && docker.images.has(tools("0.0.2")));
  assert.ok(!docker.images.has(tools("0.0.1")) && !docker.images.has(laneImageTag("0.0.2")));
  assert.ok(docker.images.has("other/img:1")); // never listed under the lane prefix, never removed
  // a failing rmi (image in use by the daemon) never fails the caller
  docker.removeImage = async () => { throw Object.assign(new Error("conflict"), { stderr: "image is being used" }); };
  await assert.doesNotReject(agentOf(docker).ensureImage());
});

test("reap runs builder prune once per interval with the configured gb", async () => {
  const clock = { t: 1_000_000 };
  const docker = fakeDocker();
  const agent = agentOf(docker, { build_cache_keep_gb: 7, build_cache_interval_s: 3600 }, clock);
  await agent.reap(); await agent.reap();
  assert.deepEqual(docker.pruned, [7]);
  clock.t += 3600 * 1000 + 1;
  await agent.reap();
  assert.deepEqual(docker.pruned, [7, 7]);
  docker.builderPrune = async () => { throw new Error("boom"); };
  clock.t += 3600 * 1000 + 1;
  await assert.doesNotReject(agent.reap());
});

test("dangling anonymous volumes are removed and named volumes kept", async () => {
  const docker = fakeDocker({ dangling: [HEX, "cs-work-x", "my-data"] });
  await agentOf(docker).reap();
  assert.deepEqual(docker.volumesRemoved, [HEX]);
});

test("docker helpers list remove and prune with bounded timeouts", async () => {
  const dir = tmpDir("cs-gc-bin-"), log = join(dir, "argv.log"), bin = join(dir, "docker");
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${log}"\ncase "$1" in images) printf 'forgedock-lane:1.0.0\\nforgedock-lane:<none>\\nother:1\\n';; ps) printf 'a:1\\n';; volume) printf 'v1\\n';; esac\n`);
  chmodSync(bin, 0o755);
  const old = process.env.PATH; process.env.PATH = `${dir}:${old}`;
  try {
    assert.deepEqual(await dockerCli.listImages("forgedock-lane:"), ["forgedock-lane:1.0.0"]);
    await dockerCli.removeImage("forgedock-lane:1.0.0");
    assert.deepEqual(await dockerCli.listContainerImages(), ["a:1"]);
    await dockerCli.builderPrune(12);
    assert.deepEqual(await dockerCli.listDanglingVolumes(), ["v1"]);
  } finally { process.env.PATH = old; }
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.ok(calls.includes("rmi forgedock-lane:1.0.0") && calls.includes("builder prune -f --keep-storage 12gb") && calls.includes("volume ls -q --filter dangling=true") && calls.includes("ps -a --format {{.Image}}"));
});

test("tools tag helper groups variants with their base tag", () => {
  const base = laneImageTag("1.2.3");
  assert.ok(isLaneToolsTagOf(base, base) && isLaneToolsTagOf(laneToolsTag(base, ["x"]), base));
  assert.ok(!isLaneToolsTagOf(laneToolsTag(laneImageTag("1.2.30"), ["x"]), base));
  assert.ok(!isLaneToolsTagOf(`${base}-tnothex`, base));
});

/** A code tree the agent can run from: package.json plus the two hashed dirs (versionOf reads them). */
function codeTree(dir, version) {
  mkdirSync(join(dir, "bin", "pool"), { recursive: true }); mkdirSync(join(dir, "pool", "image"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "pool", "image", "Dockerfile"), `FROM scratch # ${version}\n`);
}
/** Drives a real selfUpdate (POST /admin/update); only the bundle download and process exit are replaced. */
async function updateTo(from, to, images) {
  const work = tmpDir("cs-gc-upd-"), root = join(work, "code"), src = join(work, "src");
  codeTree(root, from); codeTree(src, to);
  const tgz = join(work, "bundle.tgz"); execFileSync("tar", ["-czf", tgz, "-C", src, "."]);
  const docker = fakeDocker({ images });
  docker.build = async (_dir, tag) => { for (const t of [tag, laneToolsTag(tag, ["a"]), laneToolsTag(tag, ["b"])]) docker.images.add(t); };
  const agent = agentOf(docker, { code_root: root });
  const oldFetch = globalThis.fetch, oldExit = process.exit;
  const exited = new Promise((resolve) => { process.exit = () => resolve(); });
  globalThis.fetch = async () => new Response(readFileSync(tgz));
  try {
    const req = Object.assign(Readable.from([]), { method: "POST", url: "/admin/update", headers: { authorization: "Bearer t" }, socket: { remoteAddress: "127.0.0.1" } });
    await agent.handle(req, { writeHead() {}, setHeader() {}, write() {}, end() {} });
    await exited;
  } finally { globalThis.fetch = oldFetch; process.exit = oldExit; }
  return docker;
}

test("selfUpdate keeps the new image and the running one and drops older versions with their tools tags", async () => {
  const docker = await updateTo("0.0.4", "0.0.5", [...family("0.0.2"), ...family("0.0.3"), ...family("0.0.4")]);
  assert.deepEqual([...docker.images].sort(), [...family("0.0.4"), ...family("0.0.5")].sort());
});

test("selfUpdate never removes the image it just built, even when it is older than the kept versions", async () => {
  const docker = await updateTo("0.0.4", "0.0.1", [...family("0.0.2"), ...family("0.0.3"), ...family("0.0.4")]);
  assert.ok(docker.images.has(laneImageTag("0.0.1")), "rollback image survives the prune");
  assert.ok(docker.images.has(laneImageTag("0.0.4")), "running image survives");
});
