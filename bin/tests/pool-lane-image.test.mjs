// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6166: the agent pulls the published lane image, builds only when the pull fails, retries IPv6 dial errors with IPv4 pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgent } from "../pool/agent.mjs";
import { versionOf, repoRoot, laneImageTag, laneBuildArgs } from "../pool/version.mjs";
import { provideLaneImage, withIpv4Fallback, remoteLaneImage, RECIPE_LABEL, IPV6_DIAL_RE } from "../pool/lane-image.mjs";
import { tmpDir } from "./_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const { version, image: recipe } = versionOf(repoRoot);
const local = laneImageTag(version);
const remote = remoteLaneImage(version);
const v6 = Object.assign(new Error("pull failed"), { stderr: "dial tcp [2600:1f18::1]:443: connect: cannot assign requested address" });

function fake({ pull, label = recipe } = {}) {
  const d = { have: new Set(), pulls: [], tags: [], builds: [], removed: [] };
  d.hasImage = async (t) => d.have.has(t);
  d.pull = async (r) => { d.pulls.push(r); if (pull) await pull(d.pulls.length); d.have.add(r); };
  d.imageLabel = async (r, l) => (l === RECIPE_LABEL && d.have.has(r) ? label : "");
  d.tag = async (s, t) => { d.tags.push([s, t]); d.have.add(t); };
  d.removeImage = async (t) => { d.have.delete(t); d.removed.push(t); };
  d.build = async (dir, tag, args) => { d.builds.push({ tag, args }); d.have.add(tag); };
  d.listImages = async () => []; d.listContainerImages = async () => []; d.builderPrune = async () => {}; d.listDanglingVolumes = async () => [];
  d.listLabelled = async () => []; d.listVolumes = async () => []; d.remove = async () => {}; d.stats = async () => ({}); d.inspect = async () => null;
  return d;
}
const agentOf = (docker) => createAgent({ state_dir: tmpDir("lane-pull-"), allow_cpus: 2, allow_mem_gb: 4, router_url: "http://x" }, { docker, log: quiet, vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }) });

test("pull succeeds: the image is retagged locally and nothing is built", async () => {
  const d = fake();
  await agentOf(d).ensureImage();
  assert.deepEqual(d.pulls, [remote]);
  assert.deepEqual(d.tags, [[remote, local]]);
  assert.equal(d.builds.length, 0);
});

test("pull fails: falls back to the local build, labelled with the recipe hash", async () => {
  const d = fake({ pull: async () => { throw new Error("denied: not found"); } });
  await agentOf(d).ensureImage();
  assert.deepEqual(d.builds, [{ tag: local, args: laneBuildArgs(version, recipe) }]);
  assert.equal(d.builds[0].args.FORGEDOCK_RECIPE, recipe);
});

test("a pulled image with a different recipe hash is rejected, removed and built locally", async () => {
  const d = fake({ label: "deadbeef0000" });
  await agentOf(d).ensureImage();
  assert.deepEqual(d.removed, [remote]);
  assert.equal(d.tags.length, 0);
  assert.equal(d.builds.length, 1);
});

test("an image already present is neither pulled nor built", async () => {
  const d = fake(); d.have.add(local);
  assert.equal(await provideLaneImage({ docker: d, image: local, version, recipe, build: async () => { throw new Error("no"); } }), "present");
  assert.equal(d.pulls.length, 0);
});

test("a custom image name is never pulled", async () => {
  const d = fake(); let built = 0;
  assert.equal(await provideLaneImage({ docker: d, image: "mine:1", version, recipe, publishable: false, build: async () => { built++; } }), "built");
  assert.equal(d.pulls.length, 0); assert.equal(built, 1);
});

test("an IPv6 dial error retries the pull under IPv4 pins, which are removed afterwards", async () => {
  const hosts = join(tmpDir("hosts-"), "hosts");
  writeFileSync(hosts, "127.0.0.1 localhost\n");
  const seen = [];
  const d = fake({ pull: async (n) => { if (n === 1) throw v6; seen.push(readFileSync(hosts, "utf8")); } });
  const how = await provideLaneImage({ docker: d, image: local, version, recipe, build: async () => { throw new Error("must not build"); }, pinOpts: { file: hosts, resolve: async (h) => ["192.0.2.7"] } });
  assert.equal(how, "pulled");
  assert.equal(d.pulls.length, 2);
  assert.match(seen[0], /192\.0\.2\.7 ghcr\.io # forgedock-ipv4-pin/);
  assert.match(seen[0], /192\.0\.2\.7 registry-1\.docker\.io/);
  assert.equal(readFileSync(hosts, "utf8"), "127.0.0.1 localhost\n");
});

test("the IPv4 retry also wraps the build, and a non-IPv6 error is not retried", async () => {
  const hosts = join(tmpDir("hosts-"), "hosts");
  writeFileSync(hosts, "127.0.0.1 localhost\n");
  const pinOpts = { file: hosts, resolve: async () => ["192.0.2.7"] };
  let n = 0;
  await withIpv4Fallback(async () => { if (n++ === 0) throw Object.assign(new Error("x"), { stderr: "connect: network is unreachable" }); }, pinOpts);
  assert.equal(n, 2);
  let m = 0;
  await assert.rejects(withIpv4Fallback(async () => { m++; throw new Error("exit code 1"); }, pinOpts), /exit code 1/);
  assert.equal(m, 1);
  assert.match("dial tcp [2600:1f18::1]:443: connect: cannot assign requested address", IPV6_DIAL_RE);
});

test("a host that cannot write /etc/hosts reports the original IPv6 error", async () => {
  await assert.rejects(withIpv4Fallback(async () => { throw v6; }, { file: "/nonexistent-dir/hosts", resolve: async () => ["192.0.2.7"] }), /pull failed/);
});
