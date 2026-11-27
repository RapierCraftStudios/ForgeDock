// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RECIPES, hasRecipe, recipeFor, installCommands, installLaneTools, laneToolsDockerfile } from "./lane-tools.mjs";

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
