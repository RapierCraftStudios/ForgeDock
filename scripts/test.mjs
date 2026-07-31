#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const TEST_GLOBS = Object.freeze([
  "bin/tests/**/*.test.mjs",
  "bin/engine/**/*.test.mjs",
  "packages/protocol/test/**/*.test.mjs",
]);

/**
 * Build the environment for the ordinary test suite without allowing a
 * runtime controller marker to change the behavior under test. All other
 * inherited configuration remains available to the child process.
 */
export function createTestEnvironment(env = process.env) {
  const testEnvironment = { ...env };
  delete testEnvironment.FORGE_RUNTIME;
  return testEnvironment;
}

export function runTests({ env = process.env, spawnImpl = spawnSync } = {}) {
  const result = spawnImpl(process.execPath, ["--test", ...TEST_GLOBS], {
    env: createTestEnvironment(env),
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    console.error(`Unable to launch test suite: ${result.error.message}`);
    return 1;
  }

  return typeof result.status === "number" ? result.status : 1;
}

export function main() {
  process.exitCode = runTests();
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main();
}
