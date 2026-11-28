// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6166: the agent pulls the published lane image, builds only when the pull fails, retries IPv6 dial errors with IPv4 pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgent } from "../pool/agent.mjs";
import { versionOf, repoRoot, laneImageTag, laneBuildArgs } from "../pool/version.mjs";
import { provideLaneImage, withIpv4Fallback, fetchLaneDigest, laneDigestUrl, LANE_REGISTRY_IMAGE, RECIPE_LABEL, IPV6_DIAL_RE } from "../pool/lane-image.mjs";
import { ensureDaemonDns, DNS_FAIL_RE } from "../pool/docker-dns.mjs";
import { tmpDir } from "./_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const { version, image: recipe } = versionOf(repoRoot);
const local = laneImageTag(version);
const DIG = `sha256:${"a".repeat(64)}`;
const remote = `${LANE_REGISTRY_IMAGE}@${DIG}`;
const v6 = Object.assign(new Error("pull failed"), { stderr: "dial tcp [2600:1f18::1]:443: connect: cannot assign requested address" });

function fake({ pull, label = recipe, digests = [remote] } = {}) {
  const d = { have: new Set(), pulls: [], tags: [], builds: [], removed: [] };
  d.hasImage = async (t) => d.have.has(t);
  d.pull = async (r) => { d.pulls.push(r); if (pull) await pull(d.pulls.length); d.have.add(r); };
  d.imageLabel = async (r, l) => (l === RECIPE_LABEL && d.have.has(r) ? label : "");
  d.imageRepoDigests = async (r) => (d.have.has(r) ? digests : []);
  d.tag = async (s, t) => { d.tags.push([s, t]); d.have.add(t); };
  d.removeImage = async (t) => { d.have.delete(t); d.removed.push(t); };
  d.build = async (dir, tag, args) => { d.builds.push({ tag, args }); d.have.add(tag); };
  d.listImages = async () => []; d.listContainerImages = async () => []; d.builderPrune = async () => {}; d.listDanglingVolumes = async () => [];
  d.listLabelled = async () => []; d.listVolumes = async () => []; d.remove = async () => {}; d.stats = async () => ({}); d.inspect = async () => null;
  return d;
}
const agentOf = (docker, fetchDigest = async () => ({ digest: DIG, recipe })) => createAgent({ state_dir: tmpDir("lane-pull-"), allow_cpus: 2, allow_mem_gb: 4, router_url: "http://x" }, { docker, fetchDigest, log: quiet, vm: () => ({ cpus: 64, mem_gb: 256, swap_gb: 0 }) });

test("pull succeeds: the image is retagged locally and nothing is built", async () => {
  const d = fake();
  await agentOf(d).ensureImage();
  assert.deepEqual(d.pulls, [remote]);
  assert.deepEqual(d.tags, [[remote, local]]);
  assert.equal(d.builds.length, 0);
});

test("#6184: after the retag the ghcr tag is dropped so the prune can free the image; a failing rmi does not fail the pull", async () => {
  const d = fake();
  await agentOf(d).ensureImage();
  assert.deepEqual(d.removed, [remote]);
  assert.equal(d.have.has(local), true);
  const e = fake(); e.removeImage = async () => { throw new Error("rmi boom"); };
  assert.equal(await provideLaneImage({ docker: e, image: local, version: "9.9.9", recipe, digest: DIG, build: async () => {} }), "pulled");
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

test("a pull ref is repo@digest and the image's RepoDigests must contain it", async () => {
  const d = fake();
  await agentOf(d).ensureImage();
  assert.match(d.pulls[0], /^ghcr\.io\/rapiercraftstudios\/forgedock-lane@sha256:[0-9a-f]{64}$/);
  assert.equal(d.builds.length, 0);
});

test("a digest mismatch removes the pulled image and builds locally", async () => {
  const d = fake({ digests: [`${LANE_REGISTRY_IMAGE}@sha256:${"b".repeat(64)}`] });
  await agentOf(d).ensureImage();
  assert.deepEqual(d.removed, [remote]);
  assert.equal(d.tags.length, 0);
  assert.equal(d.builds.length, 1);
});

test("no known digest: nothing is pulled (the self-set label is not trusted) and the image is built", async () => {
  const d = fake();
  await agentOf(d, async () => null).ensureImage();
  assert.equal(d.pulls.length, 0);
  assert.equal(d.builds.length, 1);
  let built = 0;
  assert.equal(await provideLaneImage({ docker: d, image: local + "x", version, recipe, build: async () => { built++; } }), "built");
  assert.equal(d.pulls.length, 0); assert.equal(built, 1);
});

test("fetchLaneDigest parses the release manifest and returns null on any error", async () => {
  const ok = (body, status = 200) => async (url) => { ok.url = url; return { ok: status === 200, json: async () => body }; };
  const f = ok({ version, recipe, digest: DIG });
  assert.deepEqual(await fetchLaneDigest(version, { fetch: f }), { digest: DIG, recipe });
  assert.equal(ok.url, laneDigestUrl(version));
  assert.equal(await fetchLaneDigest(version, { fetch: ok({}, 404) }), null);
  assert.equal(await fetchLaneDigest(version, { fetch: ok({ version, recipe, digest: "latest" }) }), null);
  assert.equal(await fetchLaneDigest(version, { fetch: ok({ version: "0.0.0", recipe, digest: DIG }) }), null);
  assert.equal(await fetchLaneDigest(version, { fetch: async () => { throw new Error("offline"); } }), null);
});

test("every docker/* and setup-node action in the lane workflows is pinned to a 40-hex SHA", () => {
  for (const f of ["publish.yml", "lane-image.yml"]) {
    const uses = [...readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8").matchAll(/uses:\s*((?:docker\/|actions\/setup-node)\S*)/g)].map((m) => m[1]);
    assert.ok(uses.length >= 4, `${f}: found ${uses.length} actions`);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${f}: ${u}`);
  }
});

test("an image already present is neither pulled nor built", async () => {
  const d = fake(); d.have.add(local);
  assert.equal(await provideLaneImage({ docker: d, image: local, version, recipe, digest: DIG, build: async () => { throw new Error("no"); } }), "present");
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
  const how = await provideLaneImage({ docker: d, image: local, version, recipe, digest: DIG, build: async () => { throw new Error("must not build"); }, pinOpts: { file: hosts, resolve: async (h) => ["192.0.2.7"] } });
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

// #6195: dockerd's resolver fails (WSL proxy) -> daemon.json dns, restart only when idle, retry once.
const dnsErr = Object.assign(new Error("pull failed"), { stderr: "Get https://ghcr.io/v2/: dial tcp: lookup ghcr.io on 10.255.255.254:53: no such host" });
const dnsOpts = (file, { idle = true, restarts = [] } = {}) => ({ ensureDns: () => ensureDaemonDns({ file, idle: () => idle, restart: async () => { restarts.push(1); } }) });

test("a docker DNS error writes daemon.json dns, restarts docker once when idle and retries the pull", async () => {
  const file = join(tmpDir("dd-"), "daemon.json");
  writeFileSync(file, JSON.stringify({ "log-driver": "json-file" }));
  const restarts = [];
  const d = fake({ pull: async (n) => { if (n === 1) throw dnsErr; } });
  const how = await provideLaneImage({ docker: d, image: local, version, recipe, digest: DIG, build: async () => { throw new Error("must not build"); }, pinOpts: dnsOpts(file, { restarts }) });
  assert.equal(how, "pulled");
  assert.equal(d.pulls.length, 2);
  assert.equal(restarts.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "log-driver": "json-file", dns: ["1.1.1.1", "8.8.8.8"] });
});

test("a docker DNS error while sandboxes run writes dns but does not restart; the original error surfaces", async () => {
  const file = join(tmpDir("dd-"), "daemon.json");
  const restarts = [];
  await assert.rejects(withIpv4Fallback(async () => { throw dnsErr; }, dnsOpts(file, { idle: false, restarts })), /pull failed/);
  assert.equal(restarts.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).dns, ["1.1.1.1", "8.8.8.8"]);
});

test("an existing daemon.json dns is left alone and other keys are kept", async () => {
  const file = join(tmpDir("dd-"), "daemon.json");
  const before = JSON.stringify({ dns: ["9.9.9.9"], x: 1 });
  writeFileSync(file, before);
  const restarts = [];
  assert.deepEqual(await ensureDaemonDns({ file, idle: () => true, restart: async () => { restarts.push(1); } }), { changed: false, restarted: false });
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(restarts.length, 0);
});

test("a non-DNS error is not intercepted by the DNS repair", async () => {
  const file = join(tmpDir("dd-"), "daemon.json");
  let n = 0;
  await assert.rejects(withIpv4Fallback(async () => { n++; throw new Error("denied: not found"); }, dnsOpts(file)), /denied/);
  assert.equal(n, 1);
  assert.throws(() => readFileSync(file), /ENOENT/);
  assert.doesNotMatch("lookup of the thing failed: no such host", DNS_FAIL_RE);
  assert.match("lookup ghcr.io on 10.255.255.254:53: server misbehaving", DNS_FAIL_RE);
});
