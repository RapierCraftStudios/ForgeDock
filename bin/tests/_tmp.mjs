// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared temp-dir helper for node test suites. Not a *.test.mjs file, so the
// npm test glob does not run it.
//
// tmpDir(prefix) creates a directory under os.tmpdir() and registers it for
// removal from a single process "exit" handler. That works outside a test
// context (beforeEach, module top level) and still runs when an assertion
// fails. Cleanup runs only at process exit, so child processes spawned by a
// test can rely on the directory existing for the whole test file.
// scripts/check-test-tmp-cleanup.sh requires every test that creates a temp
// dir to go through this helper.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs = new Set();
let hooked = false;

export function cleanupAll() {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort: never fail a test run over cleanup
    }
  }
  dirs.clear();
}

export function tmpDir(prefix) {
  if (!hooked) {
    hooked = true;
    process.on("exit", cleanupAll);
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}
