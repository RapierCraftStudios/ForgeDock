// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRecurrenceConfig, pathsOverlap } from "./recurrence.mjs";

describe("recurrence config (#5751; design routing cut in #6083)", () => {
  it("reads list and block-map hot areas, and nothing else", () => {
    assert.deepEqual(parseRecurrenceConfig(undefined), { hotAreas: [] });
    const r = parseRecurrenceConfig({ hot_areas: { api: "src/api/**, src/routes/**" } });
    assert.deepEqual(r.hotAreas, [{ name: "api", paths: ["src/api/**", "src/routes/**"] }]);
    assert.deepEqual(parseRecurrenceConfig({ hot_areas: [{ name: "db", paths: ["db/"] }] }).hotAreas, [{ name: "db", paths: ["db"] }]);
  });
  it("a directory overlaps the files under it", () => {
    assert.ok(pathsOverlap("src/a", "src/a/b.mjs"));
    assert.ok(!pathsOverlap("src/a", "src/ab/b.mjs"));
  });
});
