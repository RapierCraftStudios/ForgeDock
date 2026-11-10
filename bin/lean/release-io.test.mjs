// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// realReleaseIo reads real batch dirs: runningLanes must use the batch's state store (it crashed with
// "Cannot read properties of undefined (reading 'load')" on any host with an unfinished batch).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpDir } from "../tests/_tmp.mjs";
import { realReleaseIo } from "./release.mjs";

function seed(root, id, repo, lanes) {
  const d = join(root, id);
  mkdirSync(join(d, "lanes"), { recursive: true });
  writeFileSync(join(d, "plan.json"), JSON.stringify({ repo }));
  writeFileSync(join(d, "state.json"), JSON.stringify({ lanes }));
  return d;
}

describe("realReleaseIo runningLanes", () => {
  it("reads unfinished batches through the state store without throwing", () => {
    const root = tmpDir("release-io");
    seed(root, "b20261110-000000-1", "o/r", { 7: { pid: 2 ** 22 + 12345 } });
    seed(root, "b20261110-000000-2", "o/other", { 8: { pid: process.pid } });
    const io = realReleaseIo({ env: { ...process.env, FORGEDOCK_BATCH_DIR: root }, print: () => {} });
    assert.deepEqual(io.runningLanes("o/r"), []);
  });

  it("reports a live lane of the repo whose result file is not written yet", async () => {
    const root = tmpDir("release-io-live");
    const d = seed(root, "b20261110-000000-3", "o/r", {});
    const marker = join(d, "lanes", "9.json");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", marker], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(join(d, "state.json"), JSON.stringify({ lanes: { 9: { pid: child.pid } } }));
      const io = realReleaseIo({ env: { ...process.env, FORGEDOCK_BATCH_DIR: root }, print: () => {} });
      assert.deepEqual(io.runningLanes("o/r"), [{ batch: "b20261110-000000-3", issue: "9" }]);
    } finally { child.kill(); }
  });
});
