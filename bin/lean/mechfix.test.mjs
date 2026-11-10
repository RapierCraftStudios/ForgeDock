// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { insertIntoList, applyEnumerating, renamedExport, renameDuplicates } from "./mechfix.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const tmp = () => tmpDir("mechfix-");

describe("#5348 enumerating list insertion", () => {
  it("appends to a one-per-line list, copying quote, indent and the trailing comma", () => {
    const src = `const names = [\n  "alpha",\n  "beta",\n  "gamma",\n];\n`;
    const r = insertIntoList(src, 3, ["delta"]);
    assert.deepEqual(r.inserted, ["delta"]);
    assert.equal(r.text, `const names = [\n  "alpha",\n  "beta",\n  "gamma",\n  "delta",\n];\n`);
  });
  it("appends to a one-line list without a trailing comma", () => {
    const r = insertIntoList(`assert.deepEqual(keys, ['a1', 'b2', 'c3']);\n`, 1, ["d4", "e5"]);
    assert.equal(r.text, `assert.deepEqual(keys, ['a1', 'b2', 'c3', 'd4', 'e5']);\n`);
  });
  it("leaves a name already listed, and a list that is not all string literals, alone", () => {
    assert.deepEqual(insertIntoList(`x(["aa", "bb", "cc"]);\n`, 1, ["bb"]).inserted, []);
    assert.deepEqual(insertIntoList(`x(["aa", bb, "cc"]);\n`, 1, ["dd"]).inserted, []);
    assert.deepEqual(insertIntoList(`x(["aa"]);\n`, 1, ["dd"]).inserted, [], "one element is not a sibling list");
  });
  it("applyEnumerating edits the test file and reports what it could not place", () => {
    const cwd = tmp();
    fs.writeFileSync(join(cwd, "a.test.mjs"), `const L = ["one", "two", "three"];\nconst M = ["x1", "x2", "x3"];\n`);
    const missing = [
      { symbol: "four", module: "m", test: "a.test.mjs", line: 1 },
      { symbol: "x4", module: "n", test: "a.test.mjs", line: 2 },
      { symbol: "gone", module: "m", test: "missing.test.mjs", line: 1 },
    ];
    const r = applyEnumerating({ missing, cwd });
    assert.deepEqual(r.applied.map((m) => m.symbol).sort(), ["four", "x4"]);
    assert.deepEqual(r.remaining.map((m) => m.symbol), ["gone"]);
    assert.equal(fs.readFileSync(join(cwd, "a.test.mjs"), "utf8"), `const L = ["one", "two", "three", "four"];\nconst M = ["x1", "x2", "x3", "x4"];\n`);
  });
  it("a failed write moves only that test's rows to remaining, not another test's applied rows", () => {
    const cwd = tmp();
    fs.writeFileSync(join(cwd, "a.test.mjs"), `const L = ["one", "two", "three"];\n`);
    fs.writeFileSync(join(cwd, "b.test.mjs"), `const M = ["x1", "x2", "x3"];\nconst N = [a, b];\n`);
    const missing = [
      { symbol: "four", module: "m", test: "a.test.mjs", line: 1 },
      { symbol: "x4", module: "n", test: "b.test.mjs", line: 1 },
      { symbol: "nope", module: "o", test: "b.test.mjs", line: 2 },
    ];
    const fsx = { ...fs, writeFileSync: (f, t) => { if (String(f).endsWith("b.test.mjs")) throw new Error("EROFS"); return fs.writeFileSync(f, t); } };
    const r = applyEnumerating({ missing, cwd, fsx });
    assert.deepEqual(r.applied.map((m) => m.symbol), ["four"]);
    assert.deepEqual(r.remaining.map((m) => m.symbol).sort(), ["nope", "x4"]);
  });
});

describe("#5348 duplicate export rename", () => {
  it("names the export after its app, cased like the symbol", () => {
    assert.equal(renamedExport("Button", "apps/web/ui.ts"), "UiButton");
    assert.equal(renamedExport("loadAll", "apps/web/index.ts"), "webLoadAll");
  });
  const world = (files) => {
    const cwd = tmp();
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(join(cwd, f, ".."), { recursive: true }); fs.writeFileSync(join(cwd, f), text); }
    const git = async (a) => {
      const name = a[a.indexOf("-e") + 1];
      const hit = Object.entries(files).filter(([, t]) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(fs.readFileSync(join(cwd, ...[Object.keys(files).find((k) => files[k] === t)]), "utf8"))).map(([f]) => f);
      if (!hit.length) throw new Error("exit 1");
      return hit.join("\n");
    };
    return { cwd, git };
  };
  it("renames an export only its declaring file mentions", async () => {
    const { cwd, git } = world({ "app/ui.ts": `export const Button = 1;\nexport const y = Button + 1;\n`, "app/other.ts": `export const Button = 2;\n` });
    const r = await renameDuplicates({ dups: [{ symbol: "Button", path: "app/ui.ts", others: ["app/other.ts"] }], cwd, git });
    assert.equal(r.applied.length, 1); assert.equal(r.remaining.length, 0);
    assert.equal(fs.readFileSync(join(cwd, "app/ui.ts"), "utf8"), `export const UiButton = 1;\nexport const y = UiButton + 1;\n`);
    assert.equal(fs.readFileSync(join(cwd, "app/other.ts"), "utf8"), `export const Button = 2;\n`);
  });
  it("leaves it for a session when another file references the name, or it is used as a property", async () => {
    let w = world({ "app/ui.ts": `export const Button = 1;\n`, "app/use.ts": `import { Button } from "./ui";\n` });
    let r = await renameDuplicates({ dups: [{ symbol: "Button", path: "app/ui.ts", others: ["app/other.ts"] }], cwd: w.cwd, git: w.git });
    assert.equal(r.applied.length, 0); assert.equal(r.remaining.length, 1);
    w = world({ "app/ui.ts": `export const Button = 1;\nexport const map = { Button: 2 };\n` });
    r = await renameDuplicates({ dups: [{ symbol: "Button", path: "app/ui.ts", others: ["x.ts"] }], cwd: w.cwd, git: w.git });
    assert.equal(r.remaining.length, 1);
    assert.match(fs.readFileSync(join(w.cwd, "app/ui.ts"), "utf8"), /export const Button = 1/);
  });
});
