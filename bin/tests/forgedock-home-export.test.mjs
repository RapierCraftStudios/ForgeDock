// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withForgedockHome } from "../runner.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("FORGEDOCK_HOME export to phase children (forge#3778)", () => {
  it("defaults to the package root, which carries the shared helpers", () => {
    const env = withForgedockHome({});
    assert.equal(env.FORGEDOCK_HOME, PKG_ROOT);
    assert.ok(existsSync(join(env.FORGEDOCK_HOME, "scripts", "lib", "forge-resolve.sh")));
  });
  it("never overrides a value the operator set", () => {
    assert.equal(withForgedockHome({ FORGEDOCK_HOME: "/opt/forge" }).FORGEDOCK_HOME, "/opt/forge");
  });
});
