// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { englishCopies, sourcePath, flatten } from "./i18n.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), JSON.stringify(t)); } };
function repo(base, lane) {
  const d = tmpDir("i18n-");
  sh(d, "init", "-q", "-b", "main");
  put(d, base); sh(d, "add", "-A"); sh(d, "commit", "-qm", "base");
  sh(d, "checkout", "-q", "-b", "lane");
  put(d, lane); sh(d, "add", "-A"); sh(d, "commit", "-qm", "lane");
  return d;
}
const copies = (d) => englishCopies({ git: async (a) => sh(d, ...a), base: "main" });

describe("i18n english copies (#4596)", () => {
  it("sourcePath maps a locale file or directory to en", () => {
    assert.equal(sourcePath("messages/ta.json"), "messages/en.json");
    assert.equal(sourcePath("locales/kn/common.json"), "locales/en/common.json");
    assert.equal(sourcePath("messages/en.json"), null);
    assert.equal(sourcePath("package.json"), null);
  });
  it("flatten reads nested string leaves", () => {
    assert.deepEqual([...flatten('{"a":{"b":"x"},"n":1}')], [["a.b", "x"]]);
    assert.equal(flatten("not json").size, 0);
  });
  it("flags added keys copied from en; ignores translated, pre-existing, short and placeholder values", async () => {
    const d = repo(
      { "messages/en.json": { old: "Old text", v: { a: "Calendar view" } }, "messages/ta.json": { old: "Old text" } },
      { "messages/en.json": { old: "Old text", v: { a: "Calendar view", b: "Go", c: "OK", d: "{{count}}", e: "Week view" } },
        "messages/ta.json": { old: "Old text", v: { a: "Calendar view", b: "Go", c: "OK", d: "{{count}}", e: "வாரக் காட்சி" } } });
    const r = await copies(d);
    assert.deepEqual(r.map((x) => `${x.path}:${x.key}`), ["messages/ta.json:v.a"]);
  });
  it("is empty without a source catalog and never throws", async () => {
    const d = repo({ "messages/ta.json": { a: "Hello there" } }, { "messages/ta.json": { a: "Hello there", b: "Hello there" } });
    assert.deepEqual(await copies(d), []);
    assert.deepEqual(await englishCopies({ git: async () => { throw new Error("x"); }, base: "main" }), []);
  });
});
