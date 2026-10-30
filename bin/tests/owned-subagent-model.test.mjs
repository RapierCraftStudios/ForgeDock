// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4843: ForgeDock owns the subagent model of the sessions it launches, whatever the operator's settings.json env says.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { makeLeanRunner, ownedModelEnv, leanSettingsFlags } from "../lean/effects.mjs";
import { readSubagentModel } from "../engine-cli.mjs";
import { explorerAgents, parseExploreConfig } from "../lean/explore.mjs";

describe("#4843 engine-owned subagent model", () => {
  it("ownedModelEnv turns the operator's force off and sets the default from config (empty when unset or invalid)", () => {
    assert.deepEqual(ownedModelEnv(), { CLAUDE_CODE_SUBAGENT_MODEL: "", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0" });
    assert.deepEqual(ownedModelEnv("sonnet"), { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0" });
    assert.equal(ownedModelEnv("bad model; rm -rf /").CLAUDE_CODE_SUBAGENT_MODEL, "");
  });

  it("every lean session carries one --settings with the owned env; the builder's explorer keeps its own model", async () => {
    const seen = [];
    const runCli = async (o) => { seen.push(o.sessionFlags); return { text: "", usage: null, costUsd: 0, durationMs: 0, turns: 0, sessionId: "s" }; };
    const run = makeLeanRunner({ runCli, subagentModel: "sonnet" });
    const base = { issue: 1, cwd: process.cwd(), prompt: "p", system: "" };
    await run({ ...base, role: "builder", rereadNudge: true, agents: explorerAgents(parseExploreConfig({ mode: "on" })) });
    await run({ ...base, role: "reviewer", readOnly: true });
    await run({ ...base, role: "grouper", noTools: true });
    for (const flags of seen) {
      assert.equal(flags.filter((f) => f === "--settings").length, 1);
      assert.deepEqual(JSON.parse(flags[flags.indexOf("--settings") + 1]).env, { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0" });
    }
    assert.equal(JSON.parse(seen[0][seen[0].indexOf("--agents") + 1]).explorer.model, "haiku", "FORCE=0 lets this win");
  });

  it("leanSettingsFlags merges the re-read hooks into the same object", () => {
    const s = JSON.parse(leanSettingsFlags({ subagentModel: null, reread: true })[1]);
    assert.equal(s.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "0");
    assert.ok(s.hooks.PostToolUse && s.hooks.PreToolUse);
  });

  it("readSubagentModel reads forge.yaml agents.subagent_model; null when absent or invalid", () => {
    const d = tmpDir("owned-model-");
    assert.equal(readSubagentModel(d), null, "no forge.yaml");
    writeFileSync(join(d, "forge.yaml"), 'agents:\n  default_model: "opus"\n  subagent_model: "sonnet"\n');
    assert.equal(readSubagentModel(d), "sonnet");
    writeFileSync(join(d, "forge.yaml"), 'agents:\n  subagent_model: "two words"\n');
    assert.equal(readSubagentModel(d), null);
  });
});
