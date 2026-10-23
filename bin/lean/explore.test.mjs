// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseExploreConfig, explorerAgents, explorePlanRule, exploreBuildRule, EXPLORER_PROMPT, DEFAULT_EXPLORE_MODEL } from "./explore.mjs";
import { makeLeanRunner } from "./effects.mjs";
import { readExplore } from "../engine-cli.mjs";

describe("explorer subagent config (#4391)", () => {
  it("parses on|off with a default haiku model; anything else is off, an invalid model is the default", () => {
    assert.deepEqual(parseExploreConfig(), { mode: "off", model: DEFAULT_EXPLORE_MODEL });
    assert.deepEqual(parseExploreConfig({ mode: " ON " }), { mode: "on", model: "haiku" });
    assert.deepEqual(parseExploreConfig({ mode: "maybe", model: "sonnet" }), { mode: "off", model: "sonnet" });
    assert.equal(parseExploreConfig({ mode: "on", model: "x; rm -rf /" }).model, "haiku");
  });

  it("off yields no agents and empty rules; on yields a read-only explorer with the bounded digest format", () => {
    const off = parseExploreConfig({ mode: "off" });
    assert.equal(explorerAgents(off), null);
    assert.equal(explorePlanRule(off), "");
    assert.equal(exploreBuildRule(off), "");
    const on = parseExploreConfig({ mode: "on", model: "sonnet" });
    const a = explorerAgents(on).explorer;
    assert.equal(a.model, "sonnet");
    assert.deepEqual(a.tools, ["Read", "Grep", "Glob", "Bash"]);
    assert.ok(a.description && a.prompt === EXPLORER_PROMPT);
    for (const h of ["### Files", "### Call sites", "### Tests to extend", "### Conventions to match"]) assert.ok(EXPLORER_PROMPT.includes(h), h);
    assert.match(EXPLORER_PROMPT, /read-only[\s\S]*at most 60 lines/);
    for (const r of [explorePlanRule(on), exploreBuildRule(on)]) assert.match(r, /subagent_type "explorer"[\s\S]*Open a file yourself only to edit it or to verify a digest claim\./);
  });

  it("makeLeanRunner passes --agents <json> only when agents are given (argv unchanged otherwise)", async () => {
    const seen = [];
    const runCli = async (o) => { seen.push(o.sessionFlags); return { text: "", usage: null, costUsd: 0, durationMs: 0, turns: 0, sessionId: "s" }; };
    const base = { role: "builder", issue: 1, cwd: process.cwd(), prompt: "p", system: "" };
    const agents = explorerAgents(parseExploreConfig({ mode: "on" }));
    await makeLeanRunner({ runCli })({ ...base });
    await makeLeanRunner({ runCli })({ ...base, agents });
    const [plain, withAgents] = seen;
    assert.ok(!plain.includes("--agents"));
    const i = withAgents.indexOf("--agents");
    assert.deepEqual(withAgents.slice(0, i), plain);
    assert.deepEqual(JSON.parse(withAgents[i + 1]), agents);
  });

  it("readExplore reads forge.yaml lean.explore / lean.explore_model; absent or invalid is undefined", () => {
    const d = tmpDir("explore-yaml-");
    assert.equal(readExplore(d), undefined, "no forge.yaml");
    writeFileSync(join(d, "forge.yaml"), "engine:\n  explore: on\n");
    assert.equal(readExplore(d), undefined, "another section's key");
    writeFileSync(join(d, "forge.yaml"), "lean:\n  explore: maybe\n");
    assert.equal(readExplore(d), undefined);
    writeFileSync(join(d, "forge.yaml"), "lean:\n  explore: on  # A/B arm\n  explore_model: claude-sonnet-5-5\n");
    assert.deepEqual(readExplore(d), { mode: "on", model: "claude-sonnet-5-5" });
    writeFileSync(join(d, "forge.yaml"), "lean:\n  explore: off\n");
    assert.deepEqual(readExplore(d), { mode: "off" });
  });
});
