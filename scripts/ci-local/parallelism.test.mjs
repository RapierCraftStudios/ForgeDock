// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scrubbedEnv, capParallel } from "./lib.mjs";

describe("ci-local host parallelism (#4182)", () => {
  it("scrubbedEnv passes FORGE_HOST_PARALLELISM through and still drops secrets", () => {
    const keep = { FORGE_HOST_PARALLELISM: process.env.FORGE_HOST_PARALLELISM, FD_TEST_API_TOKEN: process.env.FD_TEST_API_TOKEN, FORGE_OTHER_SETTING: process.env.FORGE_OTHER_SETTING };
    process.env.FORGE_HOST_PARALLELISM = "2"; process.env.FD_TEST_API_TOKEN = "s3cret"; process.env.FORGE_OTHER_SETTING = "x";
    try {
      const env = scrubbedEnv({});
      assert.equal(env.FORGE_HOST_PARALLELISM, "2");
      assert.equal(env.FD_TEST_API_TOKEN, undefined);
      assert.equal(env.FORGE_OTHER_SETTING, undefined, "other FORGE_* settings stay out");
    } finally {
      for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it("capParallel caps slots/job parallelism at a positive FORGE_HOST_PARALLELISM, else leaves them alone", () => {
    assert.equal(capParallel(4, { FORGE_HOST_PARALLELISM: "2" }), 2);
    assert.equal(capParallel(1, { FORGE_HOST_PARALLELISM: "2" }), 1);
    assert.equal(capParallel(4, {}), 4);
    for (const bad of ["0", "abc", "-1", "", " "]) assert.equal(capParallel(4, { FORGE_HOST_PARALLELISM: bad }), 4, JSON.stringify(bad));
  });
});
