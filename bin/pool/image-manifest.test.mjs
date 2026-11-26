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
