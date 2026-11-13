// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasRecipe, installCommands, installLaneTools, laneToolsDockerfile } from "./lane-tools.mjs";

describe("#5652 in-sandbox lane tool install", () => {
  it("installCommands strips RUN, prefixes sudo when not root, and is empty without a recipe", () => {
    assert.ok(hasRecipe("promtool") && !hasRecipe("nope"));
    assert.match(installCommands("postgresql-client")[0], /^apt-get update/);
    assert.match(installCommands("postgresql-client", { root: false })[0], /^sudo sh -c /);
    assert.deepEqual(installCommands("nope"), []);
  });
  it("installLaneTools runs every step, and returns the stderr tail of the first failure", async () => {
    const seen = [];
    assert.deepEqual(await installLaneTools(["postgresql-client"], { run: async (a) => { seen.push(a.command); return { rc: 0 }; } }), { ok: true });
    assert.equal(seen.length, 1);
    const bad = await installLaneTools(["promtool@2.54.1"], { run: async () => ({ rc: 3, stderr: "a\nb\n404" }) });
    assert.equal(bad.ok, false);
    assert.equal(bad.tool, "promtool@2.54.1");
    assert.match(bad.stderrTail, /404$/);
  });
  it("the image Dockerfile still uses the RUN steps", () => {
    assert.match(laneToolsDockerfile("base:1", ["postgresql-client"]), /\nRUN apt-get update/);
  });
});
