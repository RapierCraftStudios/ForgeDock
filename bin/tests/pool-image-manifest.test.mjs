// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "pool", "image");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
// Fold line continuations so each RUN is one line.
const lines = readFileSync(join(dir, "Dockerfile"), "utf8").replace(/\\\n/g, " ").split("\n");
const has = (re) => lines.some((l) => re.test(l));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const CHECKS = {
  apt: (e) => has(new RegExp(`apt-get install .*(^|\\s)${esc(e.package)}(\\s|$)`)),
  npm: (e) => has(new RegExp(`npm install -g .*"?${esc(e.package)}[@" ]`)),
  "uv-tool": (e) => has(new RegExp(`uv tool install "${esc(e.package)}`)),
  "uv-python": (e) => has(new RegExp(`uv python install(.*\\s)?${esc(e.package)}(\\s|$)`)),
  playwright: (e) => has(new RegExp(`playwright\\S* install .*${esc(e.package)}`)),
  download: (e) => has(new RegExp(esc(e.marker))),
};

describe("pool/image/manifest.json", () => {
  it("lists the toolchain the issue requires", () => {
    const names = manifest.tools.map((t) => t.name);
    for (const n of ["shellcheck", "yq", "xvfb", "postgresql-client", "redis-tools", "python3.11", "python3.12", "python3.13", "playwright-chromium"]) assert.ok(names.includes(n), n);
  });
  it("has unique names and a binary per entry", () => {
    const names = manifest.tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const t of manifest.tools) assert.ok(t.binary && CHECKS[t.kind], `${t.name}: binary/kind`);
  });
  for (const e of manifest.tools) {
    it(`Dockerfile installs ${e.name}`, () => assert.ok(CHECKS[e.kind](e), `${e.name} (${e.kind}) not installed by Dockerfile`));
  }
});
