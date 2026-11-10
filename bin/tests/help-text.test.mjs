// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TAGLINE } from "../brand.mjs";
import { topLevelHelp, fullHelp, EVERYDAY_COMMANDS, USER_ERRORS } from "../help-text.mjs";
import { renderLogo, getLogoTagline } from "../tui.mjs";

const DENY = [/\blean\b/i, /schedd/i, /\blease\b/i, /core path/i, /exit(?: code)? \d+/i, /--set-max-remote/];
const scan = (text) => DENY.filter((re) => re.test(text)).map(String);

describe("top-level help (#5303)", () => {
  const text = topLevelHelp({ width: 100 });
  it("fits one screen: <= 40 lines, <= 100 columns", () => {
    const lines = text.split("\n");
    assert.ok(lines.length <= 40, `${lines.length} lines`);
    assert.ok(lines.every((l) => l.length <= 100));
  });
  it("lists at most 10 everyday commands, the expected ones", () => {
    assert.ok(EVERYDAY_COMMANDS.length <= 10);
    const names = EVERYDAY_COMMANDS.map(([c]) => c.split(" ")[0]);
    assert.deepEqual(names, ["setup", "run-issue", "orchestrate", "watch", "status", "release", "stats", "doctor", "guide", "uninstall"]);
    assert.match(text, /help --all/);
  });
  it("contains no engine-internal term", () => assert.deepEqual(scan(text), []));
  it("shows the shared tagline", () => assert.ok(text.includes(TAGLINE)));
});

describe("user-facing errors (#5303)", () => {
  for (const [key, msg] of Object.entries(USER_ERRORS)) {
    it(`${key} has no engine-internal term and names a fix`, () => {
      assert.deepEqual(scan(msg), []);
      assert.match(msg, /--|Run /);
    });
  }
});

describe("help --all", () => {
  it("descriptions carry no engine-internal term (command names stay literal)", async () => {
    const { FULL_COMMAND_GROUPS } = await import("../help-text.mjs");
    for (const [, rows] of FULL_COMMAND_GROUPS) for (const [cmd, desc] of rows) assert.deepEqual(scan(desc.replace(/--wait-lease/g, "")), [], cmd);
  });
  const text = fullHelp({ width: 100 });
  it("keeps every command, grouped by purpose", () => {
    for (const w of ["Set up", "Run work", "Release", "fix-close-reasons", "schedd", "review-staging", "doctor --lanes"]) assert.ok(text.includes(w), w);
  });
});

describe("one tagline (#5303)", () => {
  it("package.json description, banner and default logo come from TAGLINE", () => {
    assert.equal(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).description, TAGLINE);
    assert.equal(getLogoTagline(""), TAGLINE);
    assert.equal(getLogoTagline("install"), TAGLINE);
    assert.ok(readFileSync(new URL("../../README.md", import.meta.url), "utf8").includes(TAGLINE), "README tagline");
    assert.ok(renderLogo({ context: "install" }).includes(TAGLINE));
  });
});
