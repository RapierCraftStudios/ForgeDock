// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseFromCli, readReleaseConfig, openRelease, newReleaseId } from "./release.mjs";
import { reviewStep, fixStep } from "./release-review.mjs";
import { postMergeStep } from "./release-postmerge.mjs";

const tmp = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), "release-"));
const REPO = "o/r", HEAD = "a".repeat(40);

/** io fake; `world` tunes the gh answers. */
function fakeIo(world = {}) {
  const calls = [], par = [], printed = [];
  const w = { lanes: [], openStaging: [], batches: [], releasePr: [{ number: 7, headRefOid: HEAD, url: "u" }], comments: [{ body: "FORGE:GATE_PASS" }], gate: "success", ...world };
  const io = {
    calls, par, printed, now: () => 1_700_000_000_000, print: (l) => printed.push(l),
    runningLanes: async () => w.lanes,
    batches: async () => w.batches,
    setParallel: async (id, k) => { par.push([id, k]); },
    gh: async (a) => {
      calls.push(a);
      const j = a.join(" ");
      if (a[0] === "pr" && a[1] === "list" && a.includes("--state") && a[a.indexOf("--state") + 1] === "open") return JSON.stringify(a.includes("--head") ? w.releasePr : w.openStaging);
      if (a[0] === "pr" && a[1] === "list") return JSON.stringify([]);
      if (a[0] === "pr" && a[1] === "create") return "https://github.com/o/r/pull/9";
      if (j.includes("--json headRefOid")) return JSON.stringify({ headRefOid: HEAD });
      if (j.includes("--json comments")) return JSON.stringify({ comments: w.comments });
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
    const out = await mod.runRelease({ io, repo: REPO, root, id, opts, config, branches: { staging: "staging", default: "main" }, steps: mod.withStubs({ review: ok, fixes: ok, "post-merge": ok }) });
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
    await assert.rejects(() => mod.runRelease({ io, repo: REPO, root, id, opts: { merge: true }, config: {}, branches: {}, steps: first }), /killed/);
    const st = openRelease(root, id).load();
    assert.deepEqual(Object.keys(st.steps), ["preflight", "release-pr"]);
    const second = { ...base, preflight: rec("preflight2", base.preflight), "release-pr": rec("release-pr2", base["release-pr"]) };
    const out = await mod.runRelease({ io, repo: REPO, root, id, opts: { merge: true }, config: {}, branches: {}, steps: second });
    assert.equal(out.status, "done");
    assert.deepEqual(ran, ["preflight", "release-pr"]); // preflight/release-pr not run again
  });

  it("stubs return a blocked result that names the manual path; the job exits blocked", async () => {
    for (const r of [await reviewStep({}), await fixStep({}), await postMergeStep({})]) { assert.equal(r.blocked, true); assert.match(r.reason, /manual path/); }
    const io = fakeIo(), root = tmp();
    const out = await (await import("./release.mjs")).runRelease({ io, repo: REPO, root, id: newReleaseId(), opts: {}, config: {}, branches: {} });
    assert.equal(out.status, "blocked");
    assert.equal(out.step, "review");
  });

  it("state is written atomically under FORGEDOCK_RELEASE_DIR and is private", async () => {
    const root = tmp(), id = newReleaseId();
    openRelease(root, id).save({ v: 1 });
    assert.deepEqual(JSON.parse(readFileSync(join(root, id, "state.json"), "utf8")), { v: 1 });
    assert.ok(!existsSync(join(root, id, `state.json.tmp-${process.pid}`)));
    assert.throws(() => openRelease(root, "../x"), /invalid release id/);
  });

  it("readReleaseConfig reads auto_merge / artifact_check / version_sync", () => {
    assert.deepEqual(readReleaseConfig("release:\n  auto_merge: true\n  artifact_check: npm view x\n  version_sync: true\n"), { autoMerge: true, artifactCheck: "npm view x", versionSync: true });
    assert.deepEqual(readReleaseConfig(""), { autoMerge: false, artifactCheck: null, versionSync: false });
  });

  it("CLI: rejects unknown options and exits 3 on a blocked step, naming the resume command", async () => {
    const root = tmp(), io = fakeIo();
    await assert.rejects(() => releaseFromCli(["--bogus"], { io, env: { FORGEDOCK_RELEASE_DIR: root }, cwd: root }), /unknown option/);
    const code = await releaseFromCli(["--repo", REPO], { io, env: { FORGEDOCK_RELEASE_DIR: root }, cwd: root });
    assert.equal(code, 3);
    assert.ok(io.printed.some((l) => /forgedock release --resume r\d/.test(l)));
  });
});
