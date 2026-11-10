// Shared setup/doctor prerequisite list (#5302).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { PREREQ_IDS, checkPrereqs, formatNotReady, offerInstall } from "../prereqs.mjs";

const claudeDir = tmpDir("prereq-claude-");
mkdirSync(claudeDir, { recursive: true });
const allOk = (cmd, args) => (cmd === "git" ? "git version 2.45.0" : cmd === "yq" ? "yq 4.44.1" : "ok");
const base = { exec: allOk, nodeVersion: "22.12.0", claudeDir, platform: "linux" };

describe("checkPrereqs", () => {
  it("reports every shared prerequisite, yq included, in order", () => {
    const r = checkPrereqs(base);
    assert.deepEqual(r.map((x) => x.id), PREREQ_IDS);
    assert.ok(PREREQ_IDS.includes("yq"));
    assert.ok(r.every((x) => x.ok && !x.blocking));
  });

  it("missing yq/gh/claude are blocking with fix commands; mac/windows get an auto install", () => {
    const exec = (cmd) => { if (cmd === "git") return "git version 2"; throw new Error("ENOENT"); };
    const r = checkPrereqs({ ...base, exec, claudeDir: join(claudeDir, "absent"), platform: "darwin" });
    const blocking = r.filter((x) => x.blocking).map((x) => x.id);
    assert.deepEqual(blocking, ["claude-code", "gh", "yq"]);
    assert.deepEqual(r.find((x) => x.id === "yq").auto, ["brew", "install", "yq"]);
    assert.equal(r.find((x) => x.id === "claude-code").auto, undefined);
    const win = checkPrereqs({ ...base, exec, platform: "win32" }).find((x) => x.id === "yq");
    assert.equal(win.auto[0], "winget");
    assert.equal(checkPrereqs({ ...base, exec, platform: "linux" }).find((x) => x.id === "yq").auto, undefined);
  });

  it("installed but unauthenticated gh fails without blocking", () => {
    const exec = (cmd, args) => { if (cmd === "gh" && args[0] === "auth") throw new Error("no"); return allOk(cmd, args); };
    const gh = checkPrereqs({ ...base, exec }).find((x) => x.id === "gh");
    assert.equal(gh.ok, false);
    assert.equal(gh.blocking, false);
    assert.match(gh.fix[0], /gh auth login/);
  });

  it("old Node blocks", () => {
    assert.equal(checkPrereqs({ ...base, nodeVersion: "16.1.0" })[0].blocking, true);
  });
});

describe("formatNotReady / offerInstall", () => {
  it("lists count, commands and the re-run line", () => {
    const missing = checkPrereqs({ ...base, exec: () => { throw new Error("x"); }, platform: "darwin" }).filter((x) => x.blocking);
    const text = formatNotReady(missing);
    assert.match(text, new RegExp(`Not ready yet: ${missing.length} things to install`));
    assert.match(text, /brew install yq/);
    assert.match(text, /Re-run `npx forgedock` when done/);
    assert.match(formatNotReady(missing.slice(0, 1)), /1 thing to install/);
  });

  it("installs only with consent", async () => {
    const items = [{ id: "yq", label: "yq", auto: ["brew", "install", "yq"] }, { id: "x", label: "x" }];
    const ran = [];
    const none = await offerInstall(items, { confirmFn: async () => false, run: (a) => (ran.push(a), 0) });
    assert.deepEqual([none, ran], [[], []]);
    const yes = await offerInstall(items, { confirmFn: async () => true, run: (a) => (ran.push(a), 0) });
    assert.deepEqual(yes, ["yq"]);
    assert.deepEqual(ran, [["brew", "install", "yq"]]);
  });
});
