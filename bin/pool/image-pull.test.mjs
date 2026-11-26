// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6036: the pool pulls the published lane image before building; the release workflow publishes it; telemetry reports it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAgent } from "./agent.mjs";
import { lanePublishedRef, laneImageTag } from "./version.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const quiet = { info() {}, warn() {}, error() {} };
function fixture({ present = false, pullFails = false, cfg = {} } = {}) {
  const calls = [];
  const docker = {
    async hasImage(r) { calls.push(["has", r]); return present; },
    async pull(r) { calls.push(["pull", r]); if (pullFails) throw new Error("denied"); },
    async tag(a, b) { calls.push(["tag", a, b]); },
    async build(dir, ref) { calls.push(["build", ref]); },
  };
  const agent = createAgent({ state_dir: tmpDir("cs-imgpull-"), name: "a", ...cfg }, { docker, log: quiet });
  return { agent, calls, kinds: () => calls.map((c) => c[0]) };
}
const version = () => fixture().agent.imageInfo.version;

test("lanePublishedRef is <repo>:<version> and honours the repo override", () => {
  assert.match(lanePublishedRef("1.2.3"), /^ghcr\.io\/[^:]+\/forgedock-lane:1\.2\.3$/);
  assert.equal(lanePublishedRef("1.2.3", "r.io/x/y"), "r.io/x/y:1.2.3");
  assert.equal(laneImageTag("1.2.3"), "forgedock-lane:1.2.3");
});

test("present image: no pull, no build", async () => {
  const f = fixture({ present: true });
  await f.agent.ensureImage();
  assert.ok(!f.kinds().includes("pull") && !f.kinds().includes("build"));
  assert.equal(f.agent.imageInfo.source, "present");
});

test("pull success: tagged locally, not built", async () => {
  const f = fixture();
  await f.agent.ensureImage();
  const v = f.agent.imageInfo.version;
  assert.deepEqual(f.calls.filter((c) => c[0] === "tag"), [["tag", lanePublishedRef(v), laneImageTag(v)]]);
  assert.ok(!f.kinds().includes("build"));
  assert.equal(f.agent.imageInfo.source, "pulled");
});

test("pull failure falls back to a build", async () => {
  const f = fixture({ pullFails: true });
  await f.agent.ensureImage();
  assert.ok(f.kinds().includes("build"));
  assert.equal(f.agent.imageInfo.source, "built");
});

test("explicit cfg.image skips the pull", async () => {
  const f = fixture({ cfg: { image: "my/img:1" } });
  await f.agent.ensureImage();
  assert.ok(!f.kinds().includes("pull"));
  assert.deepEqual(f.calls.find((c) => c[0] === "build"), ["build", "my/img:1"]);
});

test("capacity reports image_version and image_source", async () => {
  const f = fixture();
  await f.agent.ensureImage();
  const c = f.agent.capacity();
  assert.equal(c.image_version, f.agent.imageInfo.version);
  assert.equal(c.image_source, "pulled");
  assert.ok(version());
});

test("publish.yml pushes the image tagged with $VERSION after npm publish, gated by SKIP_PUBLISH", () => {
  const y = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(y, /docker push "\$REPO:\$VERSION"/);
  const i = y.indexOf("Build and push lane image");
  assert.ok(i > y.indexOf("Publish to GitHub Packages"));
  assert.match(y.slice(i, i + 200), /SKIP_PUBLISH != 'true'/);
});
