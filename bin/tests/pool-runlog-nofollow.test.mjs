// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./_tmp.mjs";
import { writeFileSync, symlinkSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readLaneFile, openLaneFile } from "../pool/agent.mjs";

test("readLaneFile reads a regular lane file but never follows a symlink a lane planted to a host file", () => {
  const dir = tmpDir("nofollow-");
  const secret = join(dir, "agent.token"); writeFileSync(secret, "TOKEN-SECRET");
  const good = join(dir, "x__7.jsonl"); writeFileSync(good, '{"event":"ok"}\n');
  const link = join(dir, "y__7.jsonl"); symlinkSync(secret, link);
  assert.equal(readLaneFile(good), '{"event":"ok"}\n');
  assert.equal(readLaneFile(link), "");
  assert.equal(readLaneFile(join(dir, "missing")), "");
  assert.equal(readLaneFile(dir), "", "a directory is not a regular file");
});

test("openLaneFile refuses a FIFO without blocking and a symlink, and opens a regular file", { skip: process.platform === "win32" }, () => {
  const dir = tmpDir("nofollow-fifo-");
  const fifo = join(dir, "lane.log"); execFileSync("mkfifo", [fifo]);
  assert.equal(openLaneFile(fifo), null);
  const secret = join(dir, "s"); writeFileSync(secret, "x"); const link = join(dir, "l"); symlinkSync(secret, link);
  assert.equal(openLaneFile(link), null);
  const fd = openLaneFile(secret); assert.notEqual(fd, null); closeSync(fd);
});
