// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6193: the lane-image workflow's version check must validate the whole input, not line by line, before it reaches GITHUB_ENV.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../pool/version.mjs";
import { tmpDir } from "./_tmp.mjs";

const yml = readFileSync(join(repoRoot, ".github/workflows/lane-image.yml"), "utf8");
const m = yml.match(/- name: Validate version\n[\s\S]*?run: \|\n((?: {10}.*\n)+)/);
assert.ok(m, "Validate version step found");
const script = m[1].replace(/^ {10}/gm, "");

function run(version) {
  const dir = tmpDir("lane-image-");
  const env = join(dir, "env");
  writeFileSync(env, "");
  const r = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH, VERSION: version, GITHUB_ENV: env }, encoding: "utf8" });
  return { status: r.status, env: readFileSync(env, "utf8") };
}

test("a plain X.Y.Z is accepted and written as one VERSION line", () => {
  const r = run("1.2.3");
  assert.equal(r.status, 0);
  assert.equal(r.env, "VERSION=1.2.3\n");
});

for (const bad of ["1.2.3\nFOO=bar", "1.2.3\n", "x\n1.2.3", "1.2.3\r", "1.2", "v1.2.3", ""]) {
  test(`rejected without touching GITHUB_ENV: ${JSON.stringify(bad)}`, () => {
    const r = run(bad);
    assert.notEqual(r.status, 0);
    assert.equal(r.env, "");
  });
}
