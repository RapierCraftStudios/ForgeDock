// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { releaseFromCli, readReleaseConfig, openRelease, newReleaseId } from "./release.mjs";
import { reviewStep, fixStep } from "./release-review.mjs";
import { postMergeStep } from "./release-postmerge.mjs";

const DISK = [{ mount: "/", type: "ext4" }]; // CI /tmp can be tmpfs, which assertDiskPath refuses
const tmp = () => tmpDir("release-");
const REPO = "o/r", HEAD = "a".repeat(40);

/** io fake; `world` tunes the gh answers. */
function fakeIo(world = {}) {
  const calls = [], par = [], printed = [];
  const w = { lanes: [], openStaging: [], batches: [], releasePr: [{ number: 7, headRefOid: HEAD, url: "u" }], comments: [{ body: "FORGE:GATE_PASS" }], gate: "success", ...world };
  const io = {
    calls, par, printed, now: () => 1_700_000_000_000, print: (l) => printed.push(l),
    sleeps: [], ran: [], sleep: async (ms) => { io.sleeps.push(ms); },
    run: async (cmd) => { io.ran.push(cmd); return { ok: io.ran.length >= (w.artifactOkAt ?? 1) }; },
    runningLanes: async () => w.lanes,
    batches: async () => w.batches,
    setParallel: async (id, k) => { par.push([id, k]); },
    gh: async (a) => {
      calls.push(a);
      const j = a.join(" ");
      const pm = w.pm?.(a); if (pm !== undefined) return pm;
      if (a[0] === "pr" && a[1] === "list" && a.includes("--state") && a[a.indexOf("--state") + 1] === "open") return JSON.stringify(a.includes("--head") ? w.releasePr : w.openStaging);
      if (a[0] === "pr" && a[1] === "list") return JSON.stringify([]);
      if (a[0] === "pr" && a[1] === "create") return "https://github.com/o/r/pull/9";
      if (a[0] === "pr" && a[1] === "view" && j.includes("--json state,mergeCommit,headRefOid")) return JSON.stringify({ state: w.prState ?? "OPEN", mergeCommit: w.prState === "MERGED" ? { oid: "m".repeat(40) } : null, headRefOid: HEAD });
      if (j.includes("--json headRefOid")) return JSON.stringify({ headRefOid: HEAD });
      if (j.includes("--json comments")) return JSON.stringify({ comments: w.comments });
      if (a[0] === "api" && /\/commits\/[^/]+\/status$/.test(a[1])) return JSON.stringify(w.statusGate ? [{ name: "forge/deploy-gate", conclusion: w.statusGate }] : []);
      if (a[0] === "api") return JSON.stringify(w.gate ? [{ name: "forge/deploy-gate", conclusion: w.gate }] : []);
      if (a[0] === "pr" && a[1] === "merge") return "";
      throw new Error(`unexpected gh ${j}`);
    },
  };
  return io;
}
const ok = async () => ({ ok: true });

describe("release job (#5211)", () => {
  const promote = async (world, { opts = {}, config = {} } = {}) => {
    const io = fakeIo(world), root = tmp(), id = newReleaseId();
    // Real preflight/release-pr/promotion, with review/fixes/post-merge replaced by no-ops.
    const mod = await import("./release.mjs");
    const out = await mod.runRelease({ io, repo: REPO, root, mounts: DISK, id, opts, config, branches: { staging: "staging", default: "main" }, steps: mod.withStubs({ review: ok, fixes: ok, "post-merge": ok }) });
    return { io, out, root, id };
  };

  it("R3: stops at GATE_PASS without --merge / auto_merge and prints the command; never merges", async () => {
    const { io, out } = await promote({});
    assert.equal(out.status, "stopped");
    assert.ok(io.printed.some((l) => l.includes(`gh pr merge 7 --repo ${REPO} --merge --match-head-commit ${HEAD}`)));
    assert.ok(!io.calls.some((a) => a[0] === "pr" && a[1] === "merge"));
  });

  it("R3: --merge merges with --match-head-commit when forge/deploy-gate is success", async () => {
    const { io, out } = await promote({}, { opts: { merge: true } });
    assert.equal(out.status, "done");
    assert.ok(io.calls.some((a) => a[1] === "merge" && a.includes("--match-head-commit") && a.includes(HEAD)));
  });

  it("R3: release.auto_merge merges too; a non-success deploy-gate does not", async () => {
    const a = await promote({}, { config: { autoMerge: true } });
    assert.equal(a.out.status, "done");
    for (const gate of ["pending", "failure", null]) {
      const b = await promote({ gate }, { opts: { merge: true } });
      assert.equal(b.out.status, "stopped", String(gate));
      assert.ok(!b.io.calls.some((c) => c[1] === "merge"));
    }
  });

  it("forge/deploy-gate posted as a commit status (gate-marker-check.yml) counts: no check run, status success -> merges", async () => {
    const ok = await promote({ gate: null, statusGate: "success" }, { opts: { merge: true } });
    assert.equal(ok.out.status, "done");
    assert.ok(ok.io.calls.some((a) => a[1] === "merge" && a.includes("--match-head-commit")));
    const pend = await promote({ gate: null, statusGate: "pending" }, { opts: { merge: true } });
    assert.equal(pend.out.status, "stopped");
  });

  it("#5266: a release PR merged by hand moves to post-merge with the merge sha, without the opt-in stop", async () => {
    const io = fakeIo({ prState: "MERGED" }), root = tmp(), id = newReleaseId();
    const mod = await import("./release.mjs");
    let seen = null;
    const out = await mod.runRelease({ io, repo: REPO, root, mounts: DISK, id, opts: {}, config: {}, branches: { staging: "staging", default: "main" }, steps: mod.withStubs({ review: ok, fixes: ok, "post-merge": async (c) => { seen = c.state.steps.promotion.result; return {}; } }) });
    assert.equal(out.status, "done");
    assert.equal(seen.alreadyMerged, true);
    assert.equal(seen.mergeCommit, "m".repeat(40));
  });

  it("#5266: --merge resume on an already-merged PR does not call gh pr merge", async () => {
    const { io, out } = await promote({ prState: "MERGED" }, { opts: { merge: true } });
    assert.equal(out.status, "done");
    assert.ok(!io.calls.some((a) => a[0] === "pr" && a[1] === "merge"));
  });

  it("#5266: a release PR closed without merging stops", async () => {
    const { io, out } = await promote({ prState: "CLOSED" }, { opts: { merge: true } });
    assert.equal(out.status, "stopped");
    assert.ok(!io.calls.some((a) => a[0] === "pr" && a[1] === "merge"));
  });

  it("R3: no GATE_PASS marker never merges", async () => {
    const { io, out } = await promote({ comments: [{ body: "FORGE:GATE_FAILURE" }] }, { opts: { merge: true } });
    assert.equal(out.status, "stopped");
    assert.ok(!io.calls.some((c) => c[1] === "merge"));
  });

  it("preflight refuses while a lane runs; nothing is held", async () => {
    const { io, out } = await promote({ lanes: [{ batch: "b1", issue: 3 }], batches: [{ id: "b1", k: 4 }] });
    assert.equal(out.status, "refused");
    assert.match(out.reason, /b1#3/);
    assert.deepEqual(io.par, []);
  });

  it("preflight refuses while PRs to the staging branch are open", async () => {
    const { io, out } = await promote({ openStaging: [{ number: 12 }], batches: [{ id: "b1", k: 4 }] });
    assert.equal(out.status, "refused");
    assert.match(out.reason, /#12/);
    assert.deepEqual(io.par, []);
  });

  it("preflight holds batches at K=1 and restores the previous K at the end", async () => {
    const { io, out, root, id } = await promote({ batches: [{ id: "b1", k: 4 }, { id: "b2", k: 2 }] });
    assert.equal(out.status, "stopped");
    assert.deepEqual(io.par, [["b1", 1], ["b2", 1], ["b1", 4], ["b2", 2]]);
    assert.ok(openRelease(root, id).load().held.every((h) => h.restored));
  });

  it("release PR: reuses an open one; otherwise creates it with the bundle list", async () => {
    const a = await promote({});
    assert.ok(!a.io.calls.some((c) => c[1] === "create"));
    const b = await promote({ releasePr: [] });
    const create = b.io.calls.find((c) => c[1] === "create");
    assert.ok(create && create.includes("--head") && create.includes("staging") && create.includes("main"));
  });

  it("R5: a killed job resumes from the last completed step", async () => {
    const io = fakeIo(), root = tmp(), id = newReleaseId();
    const mod = await import("./release.mjs");
    const ran = [];
    const rec = (n, fn) => async (ctx) => { ran.push(n); return fn(ctx); };
    const base = mod.withStubs({ review: ok, fixes: ok, "post-merge": ok });
    const kill = async () => { throw new Error("killed"); };
    const first = { ...base, preflight: rec("preflight", base.preflight), "release-pr": rec("release-pr", base["release-pr"]), review: kill };
    await assert.rejects(() => mod.runRelease({ io, repo: REPO, root, mounts: DISK, id, opts: { merge: true }, config: {}, branches: {}, steps: first }), /killed/);
    const st = openRelease(root, id).load();
    assert.deepEqual(Object.keys(st.steps), ["preflight", "release-pr"]);
    const second = { ...base, preflight: rec("preflight2", base.preflight), "release-pr": rec("release-pr2", base["release-pr"]) };
    const out = await mod.runRelease({ io, repo: REPO, root, mounts: DISK, id, opts: { merge: true }, config: {}, branches: {}, steps: second });
    assert.equal(out.status, "done");
    assert.deepEqual(ran, ["preflight", "release-pr"]); // preflight/release-pr not run again
  });

  it("unfinished steps return a blocked result that names the manual path; the job exits blocked", async () => {
    for (const r of [await reviewStep({}), await fixStep({})]) { assert.equal(r.blocked, true); assert.match(r.reason, /manual path/); }
    const io = fakeIo(), root = tmp();
    io.review = { pre: async () => ({ code: 1, data: null, lines: ["stopped"] }) }; // the review step runs against a seam, never a real repo
    const out = await (await import("./release.mjs")).runRelease({ io, repo: REPO, root, mounts: DISK, id: newReleaseId(), opts: {}, config: {}, branches: {} });
    assert.equal(out.status, "blocked");
    assert.equal(out.step, "review");
  });

  it("state is written atomically under FORGEDOCK_RELEASE_DIR and is private", async () => {
    const root = tmp(), id = newReleaseId();
    openRelease(root, id, DISK).save({ v: 1 });
    assert.deepEqual(JSON.parse(readFileSync(join(root, id, "state.json"), "utf8")), { v: 1 });
    assert.ok(!existsSync(join(root, id, `state.json.tmp-${process.pid}`)));
    assert.throws(() => openRelease(root, "../x"), /invalid release id/);
  });

  it("readReleaseConfig reads auto_merge / artifact_check / version_sync", () => {
    assert.deepEqual(readReleaseConfig("release:\n  auto_merge: true\n  artifact_check: npm view x\n  version_sync: true\n"), { autoMerge: true, artifactCheck: "npm view x", versionSync: true, publishWorkflow: null });
    assert.deepEqual(readReleaseConfig(""), { autoMerge: false, artifactCheck: null, versionSync: false, publishWorkflow: null });
    assert.equal(readReleaseConfig("release:\n  publish_workflow: pub.yml\n").publishWorkflow, "pub.yml");
  });

  it("CLI: rejects unknown options and exits 3 on a blocked step, naming the resume command", async () => {
    const root = tmp(), io = fakeIo();
    await assert.rejects(() => releaseFromCli(["--bogus"], { io, env: { FORGEDOCK_RELEASE_DIR: root }, cwd: root, mounts: DISK }), /unknown option/);
    const code = await releaseFromCli(["--repo", REPO], { io, env: { FORGEDOCK_RELEASE_DIR: root }, cwd: root, mounts: DISK });
    assert.equal(code, 3);
    assert.ok(io.printed.some((l) => /forgedock release --resume r\d/.test(l)));
  });
});

describe("release post-merge step (#5213)", () => {
  const SHA = "b".repeat(40);
  const PKG = Buffer.from(JSON.stringify({ version: "1.2.3" })).toString("base64");
  /** gh answers for the post-merge calls; `o` tunes them. */
  const pmWorld = (o = {}) => {
    const st = { runs: o.runs ?? [[{ databaseId: 5, status: "completed", conclusion: "success" }]], runCalls: 0, dispatched: 0, syncPrs: o.syncPrs ?? [], created: 0 };
    return {
      st,
      pm: (a) => {
        const j = a.join(" ");
        if (a[0] === "pr" && a[1] === "view" && j.includes("mergeCommit")) return JSON.stringify({ state: o.prState ?? "MERGED", mergeCommit: { oid: SHA } });
        if (a[0] === "run" && a[1] === "list") { assert.ok(j.includes(`--commit ${SHA}`) && j.includes(`--workflow ${o.wf ?? "publish.yml"}`)); const r = st.runs[Math.min(st.runCalls++, st.runs.length - 1)]; return JSON.stringify(r); }
        if (a[0] === "workflow" && a[1] === "run") { st.dispatched++; assert.ok(a.includes("main")); return ""; }
        if (a[0] === "api" && j.includes("contents/package.json")) return PKG;
        if (a[0] === "api" && j.includes("branches/chore/sync-version-1.2.3")) { if (o.noBranch) throw new Error("404"); return "x"; }
        if (a[0] === "pr" && a[1] === "list" && j.includes("chore/sync-version")) return JSON.stringify(st.syncPrs);
        if (a[0] === "pr" && a[1] === "create") { st.created++; assert.ok(a.includes("staging") && a.includes("chore/sync-version-1.2.3")); return "https://github.com/o/r/pull/30"; }
        if (a[0] === "pr" && a[1] === "view" && j.includes("statusCheckRollup")) return JSON.stringify({ state: "OPEN", headRefOid: "c".repeat(40), statusCheckRollup: o.checks ?? [{ conclusion: "SUCCESS" }] });
        if (a[0] === "pr" && a[1] === "merge" && Number(a[2]) >= 30) return "";
        return undefined;
      },
    };
  };
  const run = (o = {}, config = {}) => {
    const w = pmWorld(o), io = fakeIo({ pm: w.pm, ...o });
    const ctx = { io, repo: REPO, def: "main", staging: "staging", config: { postMerge: { publishPolls: 2, runPolls: 2, branchPolls: 2, checkPolls: 2, artifactTries: 3 }, ...config }, state: { steps: { "release-pr": { result: { pr: 7 } } } } };
    return postMergeStep(ctx).then((out) => ({ out, io, st: w.st }));
  };

  it("R1: a publish run for the merge commit is confirmed; nothing is dispatched", async () => {
    const { out, st } = await run();
    assert.equal(out.published, true);
    assert.equal(out.run, 5);
    assert.equal(st.dispatched, 0);
  });

  it("R2: no run appears -> one is dispatched on the default branch, then awaited", async () => {
    const { out, st } = await run({ runs: [[], [], [{ databaseId: 8, status: "completed", conclusion: "success" }]] });
    assert.equal(out.published, true);
    assert.equal(out.dispatched, true);
    assert.equal(st.dispatched, 1);
  });

  it("R2: a custom release.publish_workflow is used", async () => {
    const { out } = await run({ wf: "pub.yml" }, { publishWorkflow: "pub.yml" });
    assert.equal(out.published, true);
  });

  it("blocked when no run appears even after the dispatch, or the run fails or never finishes", async () => {
    const a = await run({ runs: [[]] });
    assert.equal(a.out.blocked, true); assert.equal(a.st.dispatched, 1);
    const b = await run({ runs: [[{ databaseId: 1, status: "completed", conclusion: "failure" }]] });
    assert.match(b.out.reason, /failure/);
    const c = await run({ runs: [[{ databaseId: 1, status: "in_progress", conclusion: null }]] });
    assert.match(c.out.reason, /did not finish/);
  });

  it("stopped (not blocked) while the release PR is not merged", async () => {
    const { out, st } = await run({ prState: "OPEN" });
    assert.equal(out.stopped, true);
    assert.equal(st.runCalls, 0);
  });

  it("R3: artifact_check is polled with exponential backoff until it passes; exhausting it blocks", async () => {
    const a = await run({ artifactOkAt: 3 }, { artifactCheck: "npm view x@1" });
    assert.equal(a.out.artifact, true);
    assert.deepEqual(a.io.ran, ["npm view x@1", "npm view x@1", "npm view x@1"]);
    assert.deepEqual(a.io.sleeps.slice(-2), [5000, 10000]);
    const b = await run({ artifactOkAt: 99 }, { artifactCheck: "npm view x@1" });
    assert.equal(b.out.blocked, true);
    assert.match(b.out.reason, /artifact_check/);
  });

  it("R4: version_sync opens the sync PR to staging and merges it with --match-head-commit when green", async () => {
    const { out, st, io } = await run({}, { versionSync: true });
    assert.equal(st.created, 1);
    assert.equal(out.sync.merged, true);
    assert.ok(io.calls.some((a) => a[1] === "merge" && a.includes("30") && a.includes("--match-head-commit") && a.includes("c".repeat(40))));
  });

  it("version_sync reuses an open sync PR, skips a merged one, and never merges red or check-less PRs", async () => {
    const open = await run({ syncPrs: [{ number: 31, state: "OPEN" }] }, { versionSync: true });
    assert.equal(open.st.created, 0);
    assert.ok(open.io.calls.some((a) => a[1] === "merge" && a.includes("31")));
    const merged = await run({ syncPrs: [{ number: 32, state: "MERGED" }] }, { versionSync: true });
    assert.equal(merged.out.sync.merged, true);
    assert.ok(!merged.io.calls.some((a) => a[1] === "merge"));
    for (const checks of [[], [{ conclusion: "FAILURE" }], [{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS", state: "PENDING" }]]) {
      const r = await run({ syncPrs: [{ number: 33, state: "OPEN" }], checks }, { versionSync: true });
      assert.equal(r.out.blocked, true, JSON.stringify(checks));
      assert.ok(!r.io.calls.some((a) => a[1] === "merge"));
    }
    const nb = await run({ noBranch: true }, { versionSync: true });
    assert.equal(nb.out.blocked, true);
  });

  it("R1: through the job, a blocked post-merge is retried on resume and finishes once the run exists", async () => {
    const mod = await import("./release.mjs");
    const root = tmp(), id = newReleaseId();
    const world = (runs) => pmWorld({ runs });
    const go = async (runs) => {
      const io = fakeIo({ pm: world(runs).pm });
      const config = { postMerge: { publishPolls: 1, runPolls: 1 } };
      return mod.runRelease({ io, repo: REPO, root, mounts: DISK, id, opts: { merge: true }, config, branches: { staging: "staging", default: "main" }, steps: mod.withStubs({ review: ok, fixes: ok }) });
    };
    assert.equal((await go([[{ databaseId: 1, status: "completed", conclusion: "failure" }]])).status, "blocked");
    assert.equal((await go([[{ databaseId: 2, status: "completed", conclusion: "success" }]])).status, "done");
  });
});

describe("snapshot releases (#5276)", () => {
  const S = "5".repeat(40), F = "f".repeat(40);
  /** git fake for a clean cut and an unmodified chain; `revList` is what `rev-list snapshot..head` answers. */
  const gitFake = (revList = "") => (a) => {
    if (a[0] === "rev-parse" && a[1].startsWith("refs/remotes/")) return `${S}\n`;
    if (a[0] === "rev-list") return revList;
    return "";
  };
  const snapWorld = (extra = {}) => ({
    releasePr: [], git: gitFake(), lanes: [{ batch: "b1", issue: 7 }], openStaging: [{ number: 5 }], batches: [{ id: "b1", k: 20 }],
    pm: (a) => (a[1] === "view" && a.includes("body") ? JSON.stringify({ body: "" }) : a[1] === "edit" ? "" : undefined), ...extra,
  });
  const go = async (world, config = { mode: "snapshot" }, opts = { merge: true }) => {
    const io = fakeIo(world);
    if (world.git) io.git = world.git;
    const mod = await import("./release.mjs");
    const out = await mod.runRelease({ io, repo: REPO, root: tmp(), mounts: DISK, id: newReleaseId(), opts, config, branches: { staging: "staging", default: "main" }, steps: mod.withStubs({ review: ok, fixes: ok, "post-merge": ok }) });
    return { io, out };
  };

  it("readReleaseConfig reads mode / branch_pattern / fix_mode only when set; unknown values fall back", () => {
    assert.deepEqual(readReleaseConfig("release:\n  mode: snapshot\n  branch_pattern: \"rel/{date}-{n}\"\n  fix_mode: recut\n"), { autoMerge: false, artifactCheck: null, versionSync: false, publishWorkflow: null, mode: "snapshot", branchPattern: "rel/{date}-{n}", fixMode: "recut" });
    assert.deepEqual(readReleaseConfig("release:\n  mode: weird\n  fix_mode: nope\n").mode, "freeze");
    assert.equal(readReleaseConfig("release:\n  fix_mode: nope\n").fixMode, "cherry-pick");
    assert.equal("mode" in readReleaseConfig(""), false);
  });

  it("R1/R6: with lanes running and PRs open on staging, the cut refuses nothing, leaves every K alone and opens release/<id> -> main", async () => {
    const { io, out } = await go(snapWorld());
    assert.equal(out.status, "done");
    assert.deepEqual(io.par, [], "no batch K was set (no hold, no restore)");
    const create = io.calls.find((a) => a[1] === "create");
    assert.equal(create[create.indexOf("--head") + 1], "release/20231114-1");
    assert.equal(create[create.indexOf("--base") + 1], "main");
    assert.ok(!io.calls.some((a) => (a[1] === "create" || a.includes("open")) && a[a.indexOf("--head") + 1] === "staging"), "staging is never the PR head");
  });

  it("R8: promotion still merges with --match-head-commit", async () => {
    const { io } = await go(snapWorld());
    assert.ok(io.calls.some((a) => a[1] === "merge" && a.includes("--merge") && a.includes("--match-head-commit") && a.includes(HEAD)));
  });

  it("R3: a commit on the release branch that is not a recorded cherry-pick stops promotion; nothing is merged", async () => {
    const { io, out } = await go(snapWorld({ git: gitFake(`${F} ${S}\n`) }));
    assert.equal(out.status, "stopped");
    assert.match(out.reason, /not snapshot \+ recorded cherry-picks: 1 commit\(s\)/);
    assert.ok(!io.calls.some((a) => a[1] === "merge"));
  });

  it("R11: a release branch already in flight refuses the cut", async () => {
    const world = snapWorld({ git: (a) => (a[0] === "ls-remote" ? `${S}\trefs/heads/release/20231114-1\n` : "") });
    const { out } = await go(world);
    assert.equal(out.status, "refused");
    assert.match(out.reason, /already in flight/);
  });

  it("R4: freeze mode (and no mode) keeps the refusal on running lanes, the K=1 hold and staging as PR head", async () => {
    for (const config of [{ mode: "freeze" }, {}]) {
      const { io, out } = await go({ lanes: [{ batch: "b1", issue: 7 }] }, config);
      assert.equal(out.status, "refused");
      assert.match(out.reason, /lanes of o\/r are running/);
    }
    const { io, out } = await go({ batches: [{ id: "b1", k: 20 }], releasePr: [] }, { mode: "freeze" });
    assert.equal(out.status, "done");
    assert.deepEqual(io.par, [["b1", 1], ["b1", 20]]);
    const create = io.calls.find((a) => a[1] === "create");
    assert.equal(create[create.indexOf("--head") + 1], "staging");
  });

  it("R10: `release verify <sha>` exits 0 for a head that is the snapshot, 1 for a PR without a record", async () => {
    const rec = { v: 1, snapshot: S, picks: [] };
    const mk = (body) => { const io = fakeIo({ pm: (a) => (a[0] === "api" ? JSON.stringify([{ number: 9, body }]) : undefined) }); io.git = gitFake(); io.git = ((g) => (a, o) => (a[0] === "rev-parse" && !a[1].startsWith("refs/") ? `${S}\n` : g(a, o)))(io.git); return io; };
    const good = mk(`x\n<!-- FORGE:RELEASE ${JSON.stringify(rec)} -->`);
    assert.equal(await releaseFromCli(["verify", S.slice(0, 12), "--repo", REPO], { io: good, cwd: tmp() }), 0);
    assert.ok(good.printed.some((l) => /: ok \(snapshot \+ 0 cherry-pick/.test(l)));
    const bad = mk("no record");
    assert.equal(await releaseFromCli(["verify", S, "--repo", REPO], { io: bad, cwd: tmp() }), 1);
    await assert.rejects(releaseFromCli(["verify"], { io: bad, cwd: tmp() }), /needs a commit sha/);
  });

  it("R9: post-merge deletes release/<id> after a snapshot release, and touches no branch otherwise", async () => {
    const pm = (a) => (a[1] === "view" ? JSON.stringify({ state: "MERGED", mergeCommit: { oid: "b".repeat(40) } }) : a[0] === "run" ? JSON.stringify([{ databaseId: 5, status: "completed", conclusion: "success" }]) : undefined);
    const step = async (release) => {
      const io = fakeIo({ pm }), pushes = [];
      io.git = (a) => { pushes.push(a); return ""; };
      const out = await postMergeStep({ io, repo: REPO, def: "main", staging: "staging", config: {}, state: { release, steps: { "release-pr": { result: { pr: 7 } } } } });
      return { out, pushes };
    };
    const snap = await step({ branch: "release/20231114-1" });
    assert.equal(snap.out.published, true);
    assert.deepEqual(snap.pushes, [["push", "--quiet", "origin", "--delete", "release/20231114-1"]]);
    assert.deepEqual((await step(undefined)).pushes, []);
  });
});
