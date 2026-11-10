// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolMisses, lackedTools } from "./toolplace.mjs";

const C = { validate: [{ id: "V3", command: "promtool check rules alerts.yml" }, { id: "V1", command: "node --test a.test.mjs" }] };

describe("remote tool placement (#5331)", () => {
  it("a missing command on the remote target is reported with its validate ids", () => {
    const r = toolMisses([{ ids: ["V3"], tool: "promtool", kind: "command" }, { ids: ["V1"], tool: "FOO", kind: "env-var" }]);
    assert.deepEqual(r, { tools: ["promtool"], ids: ["V3"] });
  });
  it("nothing missing stays remote", () => {
    assert.deepEqual(toolMisses([]), { tools: [], ids: [] });
    assert.deepEqual(toolMisses(undefined), { tools: [], ids: [] });
  });
  it("a frozen contract naming a tool the remote is known to lack is flagged; others are not", () => {
    assert.deepEqual(lackedTools(C, ["promtool"]), { tools: ["promtool"], ids: ["V3"] });
    assert.deepEqual(lackedTools(C, new Set(["docker"])), { tools: [], ids: [] });
    assert.deepEqual(lackedTools(C, []), { tools: [], ids: [] });
    assert.deepEqual(lackedTools(null, ["promtool"]), { tools: [], ids: [] });
  });
});
