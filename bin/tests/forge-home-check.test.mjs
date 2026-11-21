// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// Stale FORGE_HOME detection (#5796).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { assessForgeHome, isProblem, describe as describeFh, readUserForgeHomeWin, clearUserForgeHomeWin } from "../forge-home-check.mjs";

const CLI = resolve(import.meta.dirname, "../forgedock.mjs");

describe("assessForgeHome", () => {
  let root, src, persisted, old, other;
  before(() => {
    root = tmpDir("fh-");
    src = join(root, "src"); persisted = join(root, ".forge"); old = join(root, "old"); other = join(root, "other");
    for (const d of [src, persisted, old, other]) mkdirSync(d, { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "forgedock", version: "1.61.2" }));
    writeFileSync(join(persisted, "version"), "1.61.2\n");
    writeFileSync(join(old, "package.json"), JSON.stringify({ name: "forgedock", version: "1.6.0" }));
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "something-else", version: "1.61.2" }));
  });
  const a = (value) => assessForgeHome({ value, sourceDir: src, sourceVersion: "1.61.2", persistedHome: persisted });

  it("unset is fine", () => assert.equal(a(undefined).state, "unset"));
  it("the running install or ~/.forge is current", () => {
    assert.equal(a(src).state, "current");
    assert.equal(a(persisted).state, "current");
  });
  it("an old checkout is stale, with its version", () => {
    assert.deepEqual(a(old), { state: "stale", version: "1.6.0" });
    assert.ok(isProblem(a(old)));
    assert.match(describeFh(a(old), old, "1.61.2"), /v1\.6\.0.*v1\.61\.2/);
  });
  it("a missing path or a non-ForgeDock tree is a problem", () => {
    assert.equal(a(join(root, "nope")).state, "missing");
    assert.equal(a(other).state, "not-forgedock");
    assert.ok(isProblem(a(join(root, "nope"))) && isProblem(a(other)));
  });
  it("another checkout on the same version is not a problem", () => {
    const same = join(root, "same"); mkdirSync(same);
    writeFileSync(join(same, "package.json"), JSON.stringify({ name: "forgedock", version: "1.61.2" }));
    assert.equal(a(same).state, "same-version");
    assert.ok(!isProblem(a(same)));
  });
});

describe("Windows user-environment helpers", () => {
  it("parses reg query output", () => {
    const run = () => ({ status: 0, stdout: "\r\nHKEY_CURRENT_USER\\Environment\r\n    FORGE_HOME    REG_SZ    C:\\Users\\me\\ForgeDock-CLI\r\n\r\n" });
    assert.equal(readUserForgeHomeWin({ run }), "C:\\Users\\me\\ForgeDock-CLI");
  });
  it("returns null when the value is absent", () => {
    assert.equal(readUserForgeHomeWin({ run: () => ({ status: 1, stdout: "" }) }), null);
  });
  it("clear deletes the value via reg and reports success", () => {
    const calls = [];
    const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: "" }; };
    assert.equal(clearUserForgeHomeWin({ run }), true);
    assert.deepEqual(calls[0], ["reg", "delete", "HKCU\\Environment", "/v", "FORGE_HOME", "/f"]);
    assert.equal(clearUserForgeHomeWin({ run: () => ({ status: 1 }) }), false);
  });
});

describe("doctor surfaces a stale FORGE_HOME by default (no --verbose)", () => {
  let home, cwd, old;
  before(() => {
    home = tmpDir("fh-doctor-home-"); cwd = tmpDir("fh-doctor-cwd-"); old = tmpDir("fh-old-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(old, "package.json"), JSON.stringify({ name: "forgedock", version: "0.0.1" }));
  });
  const doctor = (forgeHome) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
    delete env.FORGE_HOME; delete env.CLAUDE_CONFIG_DIR;
    if (forgeHome) env.FORGE_HOME = forgeHome;
    const r = spawnSync(process.execPath, [CLI, "doctor"], { env, cwd, encoding: "utf8", timeout: 60000 });
    return (r.stdout ?? "") + (r.stderr ?? "");
  };

  it("warns on an old checkout instead of passing it", () => {
    const out = doctor(old);
    assert.match(out, /⚠\s+Stale FORGE_HOME/);
    assert.match(out, /v0\.0\.1/);
    assert.doesNotMatch(out, /✔\s+FORGE_HOME env var/);
  });
  it("warns on a path that does not exist", () => {
    assert.match(doctor(join(old, "gone")), /⚠\s+Stale FORGE_HOME[\s\S]*does not exist/);
  });
  it("says nothing about staleness when unset", () => {
    assert.doesNotMatch(doctor(undefined), /Stale FORGE_HOME/);
  });
});
