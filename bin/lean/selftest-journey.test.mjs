// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scrub, assertStage1, compareSnapshots, runNewUserJourney, parseCleanOutput, journeyFromCli, CASES } from "./selftest-journey.mjs";
import { selftestFromCli } from "./selftest-live.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const GOOD = {
  banner: { code: 0, output: "ForgeDock v1.2.3\n  ✖ Claude Code  not found\n  ! startup splash skipped: claude CLI not found   re-run npx forgedock after installing Claude Code\n" },
  help: { code: 0, output: "Usage: forgedock <command>\n" },
  doctor: { code: 1, output: "  ✗  gh CLI\n  ✗  Claude Code settings\n  ✔  Startup splash  not installed (forgedock-splash)\n" },
  errors: { code: 1, output: "Unknown command: nosuchcommand\n" },
  "no-splash": { code: 0, output: "  ! startup splash skipped (--no-splash)\n" },
};
const stage1Io = (over = {}, files = { "./forge.yaml": 'owner: "acme"\n' }) => ({
  pack: async () => "/x/f.tgz",
  clean: async (_t, args) => { const c = CASES.find((k) => k.args.join(" ") === args.join(" ")); return { ...(over[c.name] ?? GOOD[c.name]), files: c.name === "banner" ? files : {} }; },
});
const now = (() => { let t = 1000; return () => (t += 10); })();
let lastNoSplash = false;
const io2 = (over = {}) => ({
  now, ghAuthed: async () => true, claudeAvailable: async () => true, mkdir: async () => "/d", rm: async () => {},
  readFile: async () => (lastNoSplash ? null : JSON.stringify({ enabledPlugins: { "forgedock-splash@forgedock-local": true } })),
  cli: async (args) => (lastNoSplash = args.includes("--no-splash"), { code: 0, stdout: args.includes("--run") ? "Proceed? [y/N]\nmerged\n" : args[0] === "doctor" ? "  ✔  Startup splash  installed (forgedock-splash)\n" : args.includes("--no-splash") ? "  ! startup splash skipped (--no-splash)\n" : "  ✔ startup splash installed   turn off: x\n", stderr: "" }),
  gh: async (a) => (a[0] === "pr" ? JSON.stringify([{ number: 1, mergedAt: new Date(5000).toISOString() }]) : "[]"),
  ...over,
});
const run = (io, o = {}) => { const dir = tmpDir("jt-"); return runNewUserJourney({ repo: "o/sandbox", io, snapshotDir: dir, update: true, ...o }).then(() => runNewUserJourney({ repo: "o/sandbox", io, snapshotDir: dir, ...o, update: false })); };

describe("journey scrub", () => {
  it("removes paths, versions, ansi and timings", () => {
    assert.equal(scrub("\u001b[31mv1.2.3\u001b[0m at /tmp/x/y took 12ms  \n\n\n\nend"), "<ver> at <path> took <time>\n\nend\n");
  });
});

describe("assertStage1 (the 2026-11-10 regression classes)", () => {
  const ok = { cases: GOOD, files: { "./forge.yaml": 'owner: "acme"  # TODO(forgedock:owner) verify\n' } };
  it("passes the expected not-ready run, including deliberate # TODO flags", () => assert.deepEqual(assertStage1(ok), []));
  it("fails a false success banner", () => {
    const r = assertStage1({ ...ok, cases: { ...GOOD, banner: { code: 0, output: "✔ Claude Code  ready\n" } } });
    assert.match(r[0][1], /success wording/);
  });
  it("fails a doctor that exits 0, or never names the missing tools", () => {
    assert.ok(assertStage1({ ...ok, cases: { ...GOOD, doctor: { code: 0, output: "all good" } } }).length >= 2);
  });
  it("fails jargon errors and a CLI that did not start", () => {
    assert.match(assertStage1({ ...ok, cases: { ...GOOD, errors: { code: 1, output: "Error: ENOENT: no such file" } } })[0][1], /raw runtime/);
    assert.match(assertStage1({ ...ok, cases: { ...GOOD, help: { code: 126, output: "Permission denied" } } })[0][1], /did not start/);
  });
  it("fails placeholder config values but not installed copies", () => {
    assert.match(assertStage1({ ...ok, files: { "./forge.yaml": 'owner: "your-github-org"\n' } })[0][1], /placeholder/);
    assert.deepEqual(assertStage1({ ...ok, files: { "~/.forge/commands/x.md": "TODO your-org" } }), []);
  });
});

describe("splash assertions (#5312 R17)", () => {
  const ok = { cases: GOOD, files: {} };
  const msgs = (cases) => assertStage1({ ...ok, cases: { ...GOOD, ...cases } }).map((b) => b[1]).join("|");
  it("stage 1 passes with the skip lines and fails when they are missing or an install is reported", () => {
    assert.deepEqual(assertStage1(ok), []);
    assert.match(msgs({ banner: { code: 0, output: "ForgeDock\n" } }), /never printed the splash skip line/);
    assert.match(msgs({ banner: { code: 0, output: "startup splash skipped: claude CLI not found\nstartup splash installed" } }), /reported installed/);
    assert.match(msgs({ "no-splash": { code: 0, output: "nothing" } }), /did not report the skip/);
    assert.match(msgs({ "no-splash": { code: 0, output: "startup splash skipped (--no-splash)\nstartup splash installed" } }), /still installed/);
    assert.deepEqual(msgs({ banner: { code: 1, output: "Not ready yet" }, "no-splash": { code: 1, output: "Not ready yet" } }), "");
    assert.match(msgs({ banner: { code: 1, output: "Not ready yet" }, "no-splash": { code: 0, output: "x" } }), /exited 0|did not report/);
    assert.match(msgs({ doctor: { code: 1, output: "gh claude" } }), /splash state/);
  });
  it("stage 2 asserts the install at user scope, doctor's state and the --no-splash skip", async () => {
    const homes = [], envs = [];
    const base = io2({ mkdir: async () => { const h = `/h${homes.length}`; homes.push(h); return h; }, cli: async (args, o = {}) => { envs.push(o.env?.HOME); return io2().cli(args, o); } });
    let r = await run({ ...stage1Io(), ...base });
    assert.equal(r.ok, true, r.message);
    assert.ok(envs.includes("/h1") && envs.includes("/h2"), "setup runs under throwaway homes");
    const bad = async (over) => run({ ...stage1Io(), ...io2(over) });
    r = await bad({ readFile: async () => JSON.stringify({ enabledPlugins: {} }) });
    assert.equal(r.step, "splash");
    assert.match(r.message, /not enabled at user scope/);
    r = await bad({ cli: async (a) => ({ code: 0, stdout: a[0] === "doctor" ? "nothing" : "startup splash installed", stderr: "" }) });
    assert.match(r.message, /doctor does not report/);
    r = await bad({ cli: async (a) => ({ code: 0, stdout: a.includes("--no-splash") ? "startup splash installed" : a[0] === "doctor" ? "Startup splash  installed" : "startup splash installed", stderr: "" }) });
    assert.match(r.message, /--no-splash did not report/);
    r = await bad({ cli: async () => ({ code: 0, stdout: "ok", stderr: "" }) });
    assert.match(r.message, /did not report the splash installed/);
  });
  it("removes the throwaway homes", async () => {
    const removed = [];
    await run({ ...stage1Io(), ...io2({ rm: async (d) => removed.push(d) }) });
    assert.ok(removed.length >= 3);
  });
});

describe("snapshots", () => {
  it("a missing snapshot fails naming the update flag; a changed one names the line", () => {
    const dir = tmpDir("jt-");
    const res = { cases: GOOD, files: {} };
    assert.throws(() => compareSnapshots(res, { dir }), /--update-snapshots/);
    compareSnapshots(res, { dir, update: true });
    assert.equal(readFileSync(join(dir, "help.txt"), "utf8"), "Usage: forgedock <command>\n");
    assert.doesNotThrow(() => compareSnapshots(res, { dir }));
    assert.throws(() => compareSnapshots({ cases: { ...GOOD, help: { code: 0, output: "Usage: forgedock <cmd>\n" } }, files: {} }, { dir }), /help\.txt changed at line 1/);
  });
});

describe("runNewUserJourney", () => {
  it("passes both stages and records time to first merge and the prompts", async () => {
    const r = await run({ ...stage1Io(), ...io2() });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.prompts[0], "Proceed? [y/N]");
    assert.ok(r.ttfmMs > 0);
  });
  it("fails stage 1 on a wording regression against the snapshot", async () => {
    const dir = tmpDir("jt-");
    await runNewUserJourney({ repo: "o/s", io: { ...stage1Io(), ...io2() }, snapshotDir: dir, update: true });
    const r = await runNewUserJourney({ repo: "o/s", io: { ...stage1Io({ help: { code: 0, output: "Usage: forgedock <thing>\n" } }), ...io2() }, snapshotDir: dir });
    assert.equal(r.ok, false);
    assert.match(r.message, /help\.txt changed/);
    assert.equal(r.step, "snapshot");
  });
  it("fails on a false success banner before stage 2 starts", async () => {
    let cli = 0;
    const r = await run({ ...stage1Io({ banner: { code: 0, output: "setup complete\n" } }), ...io2({ cli: async () => { cli++; return { code: 0, stdout: "", stderr: "" }; } }) });
    assert.equal(r.step, "banner");
    assert.equal(cli, 0);
  });
  it("skips stage 2 with a note when gh is unauthenticated", async () => {
    const r = await run({ ...stage1Io(), ...io2({ ghAuthed: async () => false }) });
    assert.equal(r.ok, true);
    assert.match(r.notes.join("\n"), /stage 2: skipped \(gh/);
  });
  it("names the step when doctor is not green, and still cleans up", async () => {
    const removed = [], closed = [];
    const r = await run({ ...stage1Io(), ...io2({
      rm: async (d) => removed.push(d),
      cli: async (args) => (args[0] === "doctor" ? { code: 1, stdout: "", stderr: "gh missing" } : { code: 0, stdout: "", stderr: "" }),
      gh: async (a) => { if (a[1] === "close" || a[0] === "issue" && a[1] === "close") closed.push(a[2]); return a[0] === "issue" && a[1] === "list" ? JSON.stringify([{ number: 7, createdAt: new Date(9e12).toISOString() }]) : "[]"; },
    }) });
    assert.equal(r.step, "doctor");
    assert.ok(removed.length > 0 && removed.every((d) => d === "/d"));
    assert.ok(closed.length > 0 && closed.every((n) => n === "7"));
  });
  it("fails when no PR merged after the journey started", async () => {
    const r = await run({ ...stage1Io(), ...io2({ gh: async () => "[]" }) });
    assert.equal(r.step, "first-merge");
  });
});

describe("clean output parsing and the CLI", () => {
  it("parses the exit code and files", () => {
    const p = parseCleanOutput("hello\n\n@@RC 3\n@@FILE ./a\nx\ny\n@@END\n");
    assert.deepEqual(p, { code: 3, output: "hello\n", files: { "./a": "x\ny" } });
    assert.throws(() => parseCleanOutput("nothing"), /no exit marker/);
  });
  it("selftest --journey routes here, refuses the project repo and posts the marker", async () => {
    await assert.rejects(selftestFromCli(["--journey"], { cwd: "/nonexistent", print: () => {}, io: {} }), /no sandbox repo/);
    const calls = [], out = [], head = "c".repeat(40), dir = tmpDir("jt-");
    const gh = async (a) => { calls.push(a); return a[0] === "pr" && a[1] === "view" ? head : a[0] === "pr" ? JSON.stringify([]) : "[]"; };
    const io = { ...stage1Io(), ...io2({ gh }) };
    await runNewUserJourney({ repo: "o/s", io, snapshotDir: dir, update: true });
    const r = await journeyFromCli(["--journey", "--repo", "o/sandbox", "--pr", "9", "--release-repo", "o/rel"], { cwd: "/nonexistent", print: (l) => out.push(l), io, snapshotDir: dir });
    assert.equal(r.ok, false);
    assert.equal(r.step, "first-merge");
    assert.match(calls.at(-1).at(-1), new RegExp(`^<!-- FORGE:JOURNEY result=fail sha=${head} step=first-merge ttfm=na -->`));
    assert.match(out.join("\n"), /FAILED at step first-merge/);
    await assert.rejects(journeyFromCli(["--journey", "--repo", "o/rel", "--pr", "9", "--release-repo", "o/rel"], { cwd: "/nonexistent", print: () => {}, io }), /release repo/);
  });
});
