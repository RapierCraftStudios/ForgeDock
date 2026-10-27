// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4663: milestone sync. Real git (bare origin + clone), stub gh with a PR table; no network.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { isSyncable, syncMilestone } from "./milestonesync.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: ENV });
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
const commit = (d, m) => { sh(d, "add", "-A"); sh(d, "commit", "-qm", m); };
const MIN = 60000;

let origin, work, calls, prs, opts;
const gh = async (args) => {
  calls.push(args.join(" "));
  const a = args.join(" ");
  if (args[0] === "api" && args[1].includes("/milestones")) return JSON.stringify([{ title: "Alpha", state: opts.msState ?? "open", description: opts.desc ?? "" }]);
  if (args[0] === "api" && args[1].endsWith("/branches/milestone/alpha")) return opts.protected ? "true" : "false";
  if (args[0] === "api" && args[1].includes("/rules/branches/")) return "0";
  if (args[0] === "pr" && args[1] === "list") return JSON.stringify(prs.filter((p) => p.open));
  if (args[0] === "pr" && args[1] === "create") { prs.push({ number: prs.length + 1, open: true, body: args[args.indexOf("--body") + 1] }); return `https://github.com/o/r/pull/${prs.length}\n`; }
  if (args[0] === "pr" && args[1] === "edit") { prs.find((p) => p.number === Number(args[2])).body = args[args.indexOf("--body") + 1]; return ""; }
  if (args[0] === "pr" && args[1] === "merge") { if (a.includes("--auto") && opts.clean) throw new Error("auto-merge not allowed: clean status"); return ""; }
  throw new Error(`unexpected gh ${a}`);
};
const git = async (args, o = {}) => execFileSync("git", args, { cwd: o.cwd ?? work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: ENV });
const run = (extra = {}) => syncMilestone({ gh, git, repo: "o/r", slug: "alpha", base: "staging", reason: "batch", cfg: {}, tmp: tmpDir("msync-tmp-"), ...extra });
const moveBase = (n) => { sh(work, "checkout", "-q", "staging"); put(work, { [`f${n}.txt`]: `${n}\n` }); commit(work, `base ${n}`); sh(work, "push", "-q", "origin", "staging"); };
const remote = (...a) => sh(origin, ...a).trim();

beforeEach(() => {
  const root = tmpDir("msync-");
  origin = join(root, "origin.git"); work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "staging", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { env: ENV, stdio: "ignore" });
  sh(work, "checkout", "-q", "-b", "staging");
  put(work, { "registry.txt": "a\nb\n", "other.txt": "x\n" }); commit(work, "init"); sh(work, "push", "-q", "origin", "staging");
  sh(work, "checkout", "-q", "-b", "milestone/alpha"); put(work, { "m.txt": "m\n" }); commit(work, "m"); sh(work, "push", "-q", "origin", "milestone/alpha");
  calls = []; prs = []; opts = {};
});

describe("syncMilestone (#4663)", () => {
  it("protected branch: one sync PR with auto-merge, the milestone branch is not pushed", async () => {
    opts.protected = true; moveBase(1);
    const before = remote("rev-parse", "milestone/alpha");
    const r = await run();
    assert.equal(r.status, "pr-created");
    assert.equal(remote("rev-parse", "milestone/alpha"), before);
    assert.match(remote("log", "--format=%s", "sync/milestone-alpha"), /base 1/);
    assert.ok(calls.some((c) => c.startsWith("pr create") && c.includes("--head sync/milestone-alpha") && c.includes("--base milestone/alpha")));
    assert.ok(calls.some((c) => c.startsWith("pr merge 1") && c.includes("--auto")));
  });

  it("protected CLEAN PR: falls back to a direct merge when auto-merge is refused", async () => {
    opts.protected = true; opts.clean = true; moveBase(1);
    assert.equal((await run()).status, "pr-created");
    assert.ok(calls.some((c) => c.startsWith("pr merge 1") && !c.includes("--auto")));
  });

  it("a fast-moving base produces one sync PR, never closed or reopened", async () => {
    opts.protected = true;
    moveBase(1); assert.equal((await run({ now: 0 })).status, "pr-created");
    const outcomes = [];
    for (let i = 2; i <= 5; i++) { moveBase(i); outcomes.push((await run({ now: i * MIN })).status); }
    assert.deepEqual(outcomes, ["debounced", "debounced", "debounced", "debounced"]);
    assert.equal((await run({ now: 5 * MIN })).status, "debounced");
    const r = await run({ now: 11 * MIN });
    assert.equal(r.status, "pr-updated");
    assert.equal(r.pr, 1);
    assert.match(remote("log", "--format=%s", "sync/milestone-alpha"), /base 5/);
    assert.equal(calls.filter((c) => c.startsWith("pr create")).length, 1);
    assert.equal(calls.filter((c) => /^pr (close|reopen)/.test(c)).length, 0);
    assert.equal(prs.length, 1);
    assert.equal((await run({ now: 30 * MIN })).status, "unchanged");
  });

  it("a ship sync is not debounced", async () => {
    opts.protected = true;
    moveBase(1); await run({ now: 0 }); moveBase(2);
    assert.equal((await run({ now: MIN, reason: "ship" })).status, "pr-updated");
  });

  it("refuses an unstated or unknown reason", async () => {
    moveBase(1);
    assert.equal((await run({ reason: "base-moved" })).status, "refused");
  });

  it("never syncs a shipped, deployed or closed milestone", async () => {
    moveBase(1);
    for (const o of [{ desc: '<!-- FORGE:LIFECYCLE {"v":1,"state":"shipped:staging"} -->' }, { desc: '<!-- FORGE:LIFECYCLE {"v":1,"state":"deployed:default"} -->' }, { msState: "closed" }]) {
      opts = o; calls = [];
      assert.equal((await run()).status, "shipped");
      assert.ok(!calls.some((c) => c.startsWith("pr ")));
    }
    assert.equal(isSyncable({ state: "open", description: '<!-- FORGE:LIFECYCLE {"v":1,"state":"building"} -->' }), true);
    assert.equal(isSyncable({ state: "open", description: '<!-- FORGE:LIFECYCLE {"v":1,"state":"shipped:staging"} -->' }), false);
  });

  it("unprotected branch: a plain push to the milestone branch, no PR", async () => {
    moveBase(1);
    assert.equal((await run()).status, "synced");
    assert.match(remote("log", "--format=%s", "milestone/alpha"), /base 1/);
    assert.ok(!calls.some((c) => c.startsWith("pr ")));
  });

  it("up to date: nothing to do", async () => {
    assert.equal((await run()).status, "up-to-date");
  });

  it("append-only registry conflicts are resolved with the base-merge resolver", async () => {
    sh(work, "checkout", "-q", "milestone/alpha"); put(work, { "registry.txt": "a\nb\nmilestone-row\n" }); commit(work, "reg m"); sh(work, "push", "-q", "origin", "milestone/alpha");
    sh(work, "checkout", "-q", "staging"); put(work, { "registry.txt": "a\nb\nbase-row\n" }); commit(work, "reg base"); sh(work, "push", "-q", "origin", "staging");
    const r = await run({ cfg: { unionGlobs: ["registry.txt"] } });
    assert.equal(r.status, "synced");
    const text = remote("show", "milestone/alpha:registry.txt");
    assert.ok(text.includes("milestone-row") && text.includes("base-row"));
  });

  it("a conflict outside the resolver globs leaves the branch untouched", async () => {
    sh(work, "checkout", "-q", "milestone/alpha"); put(work, { "other.txt": "m\n" }); commit(work, "o m"); sh(work, "push", "-q", "origin", "milestone/alpha");
    sh(work, "checkout", "-q", "staging"); put(work, { "other.txt": "b\n" }); commit(work, "o b"); sh(work, "push", "-q", "origin", "staging");
    const before = remote("rev-parse", "milestone/alpha");
    const r = await run({ cfg: { unionGlobs: ["registry.txt"] } });
    assert.equal(r.status, "conflict");
    assert.deepEqual(r.paths, ["other.txt"]);
    assert.equal(remote("rev-parse", "milestone/alpha"), before);
  });
});
