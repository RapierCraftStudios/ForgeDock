// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Build-start reservation, versioned-dir classes and the post-renumber revalidate (#5235).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { reserveForBuild, sequenceBuildNote, revalidate } from "./seqreserve.mjs";
import { sequenceCollisions, renumberLane, snapshotLane, verifyRenumber } from "./sequence.mjs";
import { makeSequenceLeaseIo } from "./seqlease.mjs";
import { sequenceBuildRule } from "./prompts.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const gitIn = (cwd) => async (a) => sh(cwd, ...a);
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
const commit = (d, m) => { sh(d, "add", "-A"); sh(d, "commit", "-qm", m); };
const VERSIONED = "scripts/backup-contracts/v{N} -> src/version.ts=VERSION = {N}";

/** main: migrations up to 0615, backup-contracts up to v22; a lane on top of it. */
function repo() {
  const d = tmpDir("seqres-");
  sh(d, "init", "-q", "-b", "main");
  put(d, { "db/0614_z.sql": "select 0;\n", "db/0615_a.sql": "select 1;\n", "scripts/backup-contracts/v22/c.json": "{}\n", "src/version.ts": "export const VERSION = 22;\n" });
  commit(d, "init");
  return d;
}

/** An in-memory stand-in for seqlease.reserve: distinct numbers per (dir) above the floor. */
const memLease = () => { const top = new Map(); return async ({ dir, floor, count }) => { const s = Math.max(top.get(dir) ?? 0, floor); top.set(dir, s + count); return { numbers: Array.from({ length: count }, (_, i) => s + 1 + i) }; }; };

describe("reserveForBuild (#5235)", () => {
  const deliverables = [{ path: "db/0616_x.sql" }, { path: "scripts/backup-contracts/v23/c.json" }];
  it("two lanes on one branch receive distinct numbers and versions before building", async () => {
    const d = repo(), reserve = memLease(), git = gitIn(d);
    const a = await reserveForBuild({ git, base: "main", deliverables, versioned: VERSIONED, reserve });
    const b = await reserveForBuild({ git, base: "main", deliverables, versioned: VERSIONED, reserve });
    const num = (r, k) => r.find((x) => x.kind === k).numbers[0];
    assert.equal(num(a, "numbered"), 616); assert.equal(num(b, "numbered"), 617);
    assert.equal(num(a, "versioned"), 23); assert.equal(num(b, "versioned"), 24);
  });
  it("floors above the numbers other open PRs carry", async () => {
    const d = repo();
    const r = await reserveForBuild({ git: gitIn(d), base: "main", deliverables, versioned: VERSIONED, reserve: memLease(), openNumbers: async () => [616, 617], openVersions: async () => [23] });
    assert.equal(r.find((x) => x.kind === "numbered").numbers[0], 618);
    assert.equal(r.find((x) => x.kind === "versioned").numbers[0], 24);
  });
  it("is fail-open: a throwing reserve or git yields no reservation; no series, no note", async () => {
    const d = repo();
    assert.deepEqual(await reserveForBuild({ git: gitIn(d), base: "main", deliverables, reserve: async () => { throw new Error("x"); } }), []);
    assert.deepEqual(await reserveForBuild({ git: async () => { throw new Error("x"); }, base: "main", deliverables, versioned: VERSIONED, reserve: memLease() }), []);
    assert.deepEqual(await reserveForBuild({ git: gitIn(d), base: "main", deliverables: [{ path: "README.md" }], reserve: memLease() }), []);
    assert.equal(sequenceBuildRule([]), "");
  });
  it("the build note names the reserved number and version", async () => {
    const d = repo();
    const note = sequenceBuildRule(await reserveForBuild({ git: gitIn(d), base: "main", deliverables, versioned: VERSIONED, reserve: memLease() }));
    assert.match(note, /db\/: use 0616/); assert.match(note, /v23/);
  });
});

describe("versioned class collisions and renumber (#5235)", () => {
  /** The AlterLab replay: lane adds 0616 + v23; a sibling merges the same into main. */
  function replay() {
    const d = repo();
    sh(d, "checkout", "-qb", "lane");
    put(d, { "db/0616_lane.sql": "select 2;\n", "scripts/backup-contracts/v23/c.json": '{"lane":1}\n', "src/version.ts": "export const VERSION = 23;\n" });
    commit(d, "lane");
    sh(d, "checkout", "-q", "main");
    put(d, { "db/0616_sibling.sql": "select 3;\n", "scripts/backup-contracts/v23/c.json": '{"sib":1}\n', "src/version.ts": "export const VERSION = 23;\n" });
    commit(d, "sibling");
    sh(d, "checkout", "-q", "lane");
    return d;
  }
  it("detects the lane's v23 colliding with the base's", async () => {
    const d = replay();
    const cols = await sequenceCollisions({ git: gitIn(d), base: "main", versioned: VERSIONED });
    assert.ok(cols.some((c) => /v23/.test(c.lane)), JSON.stringify(cols));
  });
  it("0616/v23 replay: renumbered deterministically, companion rewritten, collisions gone", async () => {
    const d = replay();
    const r = await renumberLane({ git: gitIn(d), base: "main", cwd: d, versioned: VERSIONED, reserve: null });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(existsSync(join(d, "scripts/backup-contracts/v24/c.json")));
    assert.equal(readFileSync(join(d, "scripts/backup-contracts/v23/c.json"), "utf8"), '{"sib":1}\n');
    assert.equal(readFileSync(join(d, "scripts/backup-contracts/v24/c.json"), "utf8"), '{"lane":1}\n');
    assert.match(readFileSync(join(d, "src/version.ts"), "utf8"), /VERSION = 24/);
    assert.ok(existsSync(join(d, "db/0617_lane.sql")));
    assert.deepEqual(await sequenceCollisions({ git: gitIn(d), base: "main", versioned: VERSIONED }), []);
  });
  it("e2e: the hand-off gate (check, snapshot, renumber, verify) passes on the replay, so no needs-human", async () => {
    const d = replay(), git = gitIn(d);
    assert.ok((await sequenceCollisions({ git, base: "main", versioned: VERSIONED })).length >= 2);
    const before = await snapshotLane({ git, base: "main" });
    const r = await renumberLane({ git, base: "main", cwd: d, versioned: VERSIONED, reserve: null });
    assert.ok(r.ok && r.moves.length >= 2, JSON.stringify(r));
    const v = await verifyRenumber({ git, base: "main", before, moves: r.moves.filter((m) => !m.versioned), versioned: VERSIONED });
    assert.ok(v.ok, JSON.stringify(v));
  });
  it("without versioned config nothing versioned is touched", async () => {
    const d = replay();
    const cols = await sequenceCollisions({ git: gitIn(d), base: "main" });
    assert.ok(!cols.some((c) => /v23/.test(c.lane)));
  });
});

describe("seqlease-backed reservation (#5235)", () => {
  it("the real lease hands two lanes distinct numbers", async () => {
    const d = repo(), lease = makeSequenceLeaseIo(), repoName = `t/${Date.now()}-${process.pid}`;
    const mk = (issue) => reserveForBuild({ git: gitIn(d), base: "main", deliverables: [{ path: "db/0616_x.sql" }], reserve: (x) => lease.reserve({ repo: repoName, lane: "main", issue, ...x }) });
    const [a, b] = [await mk(1), await mk(2)];
    assert.notEqual(a[0]?.numbers[0], b[0]?.numbers[0]);
    assert.ok(a[0].numbers[0] >= 616);
    await lease.unreserve?.({ repo: repoName, lane: "main", issue: 1 }); await lease.unreserve?.({ repo: repoName, lane: "main", issue: 2 });
  });
});

describe("revalidate after a renumber (#5235)", () => {
  it("reruns every validate and returns the failures", async () => {
    const ran = [];
    const bad = await revalidate({ validates: [{ id: "V1", command: "a" }, { id: "V2", command: "b" }, { id: "V3" }], runOne: async (v) => { ran.push(v.id); return v.id === "V2" ? { rc: 1, output: "boom" } : { rc: 0, output: "" }; } });
    assert.deepEqual(ran, ["V1", "V2"]);
    assert.deepEqual(bad, [{ id: "V2", rc: 1, output: "boom" }]);
  });
  it("a throwing runner counts as a failure", async () => {
    const bad = await revalidate({ validates: [{ id: "V1", command: "a" }], runOne: async () => { throw new Error("x"); } });
    assert.equal(bad[0].rc, 127);
  });
});
