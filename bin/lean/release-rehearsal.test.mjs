// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { runRelease, withStubs, newReleaseId, readReleaseConfig, openRelease } from "./release.mjs";
import { parseRehearsalConfig } from "./release-rehearsal.mjs";

const DISK = [{ mount: "/", type: "ext4" }];
const REPO = "o/r", HEAD = "b".repeat(40);
const ok = async () => ({ ok: true });

function fakeIo({ run = { ok: true }, issues = [], body = "Bundle" } = {}) {
  const calls = [], rehearsed = [];
  const st = { issues: [...issues], body };
  const io = {
    calls, rehearsed, st, now: () => 1_700_000_000_000, print: () => {},
    runningLanes: async () => [], batches: async () => [], setParallel: async () => {},
    rehearse: async (cmd, o) => { rehearsed.push([cmd, o]); return run; },
    gh: async (a) => {
      calls.push(a); const j = a.join(" ");
      if (a[0] === "pr" && a[1] === "list" && a.includes("open")) return JSON.stringify(a.includes("--head") ? [{ number: 7, headRefOid: HEAD, url: "u" }] : []);
      if (j.includes("--json headRefOid")) return JSON.stringify({ headRefOid: HEAD });
      if (j.includes("--json comments")) return JSON.stringify({ comments: [{ body: "FORGE:GATE_PASS" }] });
      if (a[0] === "api") return JSON.stringify([{ name: "forge/deploy-gate", conclusion: "success" }]);
      if (j.includes("--json body")) return JSON.stringify({ body: st.body });
      if (a[0] === "pr" && a[1] === "edit") { st.body = a[a.indexOf("--body") + 1]; return ""; }
      if (a[0] === "pr" && a[1] === "merge") return "";
      if (a[0] === "issue" && a[1] === "list") return JSON.stringify(st.issues);
      if (a[0] === "issue" && a[1] === "create") { st.issues.push({ number: 42, body: a[a.indexOf("--body") + 1] }); return "https://github.com/o/r/issues/42"; }
      if (a[0] === "issue" && a[1] === "comment") return "";
      throw new Error(`unexpected gh ${j}`);
    },
  };
  return io;
}
const go = async (io, config, root = tmpDir("rehearsal-"), id = newReleaseId()) => ({
  out: await runRelease({ io, repo: REPO, root, mounts: DISK, id, opts: { merge: true }, config, branches: { staging: "staging", default: "main" }, steps: withStubs({ review: ok, fixes: ok, "post-merge": ok }) }),
  root, id,
});
const cfg = (o = {}) => ({ rehearsal: parseRehearsalConfig({ rehearsal_command: "./dry-run.sh", ...o }) });

describe("release rehearsal (#5253)", () => {
  it("unconfigured: no rehearse, no issue/PR-body calls, promotion merges", async () => {
    const io = fakeIo();
    const { out } = await go(io, {});
    assert.equal(out.status, "done");
    assert.equal(io.rehearsed.length, 0);
    assert.ok(!io.calls.some((a) => a[0] === "issue" || (a[0] === "pr" && a[1] === "edit")));
    assert.ok(io.calls.some((a) => a[0] === "pr" && a[1] === "merge"));
  });

  it("failing rehearsal holds promotion and files one blocker with output and head; a rerun comments", async () => {
    const io = fakeIo({ run: { ok: false, code: 2, output: "bundle missing incident files" } });
    const { out, root, id } = await go(io, cfg());
    assert.equal(out.status, "stopped"); assert.equal(out.step, "rehearsal");
    assert.ok(!io.calls.some((a) => a[0] === "pr" && a[1] === "merge"));
    const creates = io.calls.filter((a) => a[0] === "issue" && a[1] === "create");
    assert.equal(creates.length, 1);
    const body = creates[0][creates[0].indexOf("--body") + 1];
    assert.ok(body.includes("bundle missing incident files") && body.includes(HEAD));
    assert.ok(creates[0].includes("release-blocker"));
    assert.match(io.st.body, /Rehearsal\*\*: FAIL/);
    assert.equal(openRelease(root, id).load().steps.rehearsal.result.head, HEAD);
    await go(io, cfg(), root, id);
    assert.equal(io.calls.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);
    assert.equal(io.calls.filter((a) => a[0] === "issue" && a[1] === "comment").length, 1);
    assert.equal((io.st.body.match(/<!-- FORGE:REHEARSAL -->/g) ?? []).length, 1);
  });

  it("blocking:false records the failure and still promotes", async () => {
    const io = fakeIo({ run: { ok: false, code: 1, output: "x" } });
    const { out } = await go(io, cfg({ rehearsal_blocking: "false" }));
    assert.equal(out.status, "done");
    assert.match(io.st.body, /non-blocking/);
  });

  it("passing rehearsal is recorded in state and PR body, then promotes; timeout is passed in ms", async () => {
    const io = fakeIo();
    const { out, root, id } = await go(io, cfg({ rehearsal_timeout: "30" }));
    assert.equal(out.status, "done");
    assert.equal(io.rehearsed[0][1].timeout, 30_000);
    const r = openRelease(root, id).load().steps.rehearsal;
    assert.ok(r.done && r.result.ok && r.result.head === HEAD);
    assert.match(io.st.body, /Rehearsal\*\*: PASS/);
  });

  it("config parsing", () => {
    assert.equal(readReleaseConfig("").rehearsal, null);
    assert.equal(parseRehearsalConfig({ rehearsal_command: "  " }), null);
    assert.deepEqual(readReleaseConfig("release:\n  rehearsal_command: ./d.sh\n  rehearsal_timeout: 60\n  rehearsal_blocking: false\n").rehearsal, { command: "./d.sh", timeoutMs: 60000, blocking: false });
  });
});
