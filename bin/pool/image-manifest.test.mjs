// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { loadImageManifest, manifestProvides } from "./image-manifest.mjs";

describe("#6037 image manifest", () => {
  it("resolves names and binaries of the real manifest", () => {
    const m = loadImageManifest();
    for (const t of ["shellcheck", "yq", "psql", "python3.12", "xvfb-run"]) assert.ok(manifestProvides(m, t), t);
    for (const t of ["vite", "promtool", "", undefined]) assert.ok(!manifestProvides(m, t), String(t));
  });
  it("a missing or malformed file gives an empty manifest", () => {
    const d = tmpDir("imgm");
    assert.deepEqual(loadImageManifest(join(d, "nope.json")), { tools: [] });
    assert.ok(!manifestProvides(loadImageManifest(join(d, "nope.json")), "yq"));
  });
});

describe("#6187 variant remote refs", () => {
  it("remoteVariantImage maps the local tag to ghcr and pullVariantImage retags it", async () => {
    const { remoteVariantImage, pullVariantImage, LANE_REGISTRY_IMAGE } = await import("./lane-image.mjs");
    const { laneToolsTag } = await import("./lane-tools.mjs");
    const tag = laneToolsTag("forgedock-lane:1.2.3", ["xvfb"]);
    assert.equal(remoteVariantImage("1.2.3", tag), `${LANE_REGISTRY_IMAGE}:1.2.3${tag.slice(tag.lastIndexOf("-t"))}`);
    assert.match(remoteVariantImage("1.2.3", tag), /:1\.2\.3-t[0-9a-f]{12}$/);
    const seen = [], docker = { pull: async (r) => seen.push(["pull", r]), tag: async (a, b) => seen.push(["tag", a, b]) };
    await pullVariantImage({ docker, tag, version: "1.2.3" });
    assert.deepEqual(seen, [["pull", remoteVariantImage("1.2.3", tag)], ["tag", remoteVariantImage("1.2.3", tag), tag]]);
  });
});
