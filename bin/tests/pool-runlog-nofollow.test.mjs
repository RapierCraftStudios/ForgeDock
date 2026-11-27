// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaneFile } from "../pool/agent.mjs";

test("readLaneFile reads a regular lane file but never follows a symlink a lane planted to a host file", () => {
  const dir = mkdtempSync(join(tmpdir(), "nofollow-"));
  const secret = join(dir, "agent.token"); writeFileSync(secret, "TOKEN-SECRET");
  const good = join(dir, "x__7.jsonl"); writeFileSync(good, '{"event":"ok"}\n');
  const link = join(dir, "y__7.jsonl"); symlinkSync(secret, link);
  assert.equal(readLaneFile(good), '{"event":"ok"}\n');
  assert.equal(readLaneFile(link), "");
  assert.equal(readLaneFile(join(dir, "missing")), "");
  assert.equal(readLaneFile(dir), "", "a directory is not a regular file");
});
