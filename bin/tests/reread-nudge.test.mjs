// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4456: the builder's re-read nudge — a PostToolUse hook that reminds on the 3rd read of one path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payloadReads, nudgeFor, stateFile, main } from "../hooks/reread-nudge.mjs";
import { makeLeanRunner, rereadNudgeFlags, REREAD_HOOK } from "../lean/effects.mjs";
import { REREAD_MIN } from "../lean/toolstats.mjs";

const read = (file_path, session_id = "s1") => ({ session_id, cwd: "/w", tool_name: "Read", tool_input: { file_path } });
const bash = (command, session_id = "s1") => ({ session_id, cwd: "/w", tool_name: "Bash", tool_input: { command } });

describe("#4456 re-read nudge hook", () => {
  it("payloadReads uses the toolstats read definition, resolved against cwd", () => {
    assert.deepEqual(payloadReads(read("/w/a.mjs")), ["/w/a.mjs"]);
    assert.deepEqual(payloadReads(bash("sed -n 1,20p a.mjs && cat ./b.mjs")), ["/w/a.mjs", "/w/b.mjs"]);
    assert.deepEqual(payloadReads(bash("grep -n x a.mjs")), []);
    assert.deepEqual(payloadReads({ tool_name: "Edit", tool_input: { file_path: "/w/a.mjs" } }), []);
  });

  it("nudges on exactly the 3rd read of a path, counting Read and Bash reads of the same file together", () => {
    let counts = {};
    const msgs = [read("/w/a.mjs"), bash("head -n 5 a.mjs"), read("/w/a.mjs"), read("/w/a.mjs")].map((p) => {
      const r = nudgeFor(p, counts); counts = r.counts; return r.message;
    });
    assert.equal(REREAD_MIN, 3);
    assert.deepEqual(msgs.map(Boolean), [false, false, true, false]);
    assert.match(msgs[2], /\/w\/a\.mjs has now been read 3 times in this session: use your notes or the excerpt already in context/);
  });

  it("main keeps per-session state on disk and fails open", () => {
    const dir = mkdtempSync(join(tmpdir(), "reread-"));
    try {
      const outs = [1, 2, 3].map(() => main(JSON.stringify(read("/w/a.mjs")), { dir }));
      assert.deepEqual(outs.slice(0, 2), ["", ""]);
      const j = JSON.parse(outs[2]);
      assert.equal(j.hookSpecificOutput.hookEventName, "PostToolUse");
      assert.match(j.hookSpecificOutput.additionalContext, /a\.mjs has now been read 3 times/);
      assert.equal(main(JSON.stringify(read("/w/a.mjs", "other")), { dir }), "", "another session counts from zero");
      assert.equal(main("{bad", { dir }), "");
      assert.equal(main(JSON.stringify(bash("ls")), { dir }), "");
      assert.ok(stateFile("../x/y", dir).startsWith(dir + "/"), "session id is sanitised into the state dir");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the hook script runs as a CLI: silent twice, then the reminder JSON; exit 0 on bad input", () => {
    const dir = mkdtempSync(join(tmpdir(), "reread-cli-"));
    try {
      const run = (input) => execFileSync(process.execPath, [REREAD_HOOK], { input, env: { ...process.env, TMPDIR: dir }, encoding: "utf8" });
      const p = JSON.stringify(read("/w/z.mjs", `cli-${process.pid}`));
      assert.equal(run(p), ""); assert.equal(run(p), "");
      assert.match(run(p), /"additionalContext"/);
      assert.equal(run("{bad"), "");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("makeLeanRunner adds the --settings hook only for rereadNudge sessions that can use tools", async () => {
    const seen = [];
    const runCli = async (o) => { seen.push(o.sessionFlags); return { text: "", usage: null, costUsd: 0, durationMs: 0, turns: 0, sessionId: "s" }; };
    const base = { role: "builder", issue: 1, cwd: process.cwd(), prompt: "p", system: "" };
    await makeLeanRunner({ runCli })({ ...base });
    await makeLeanRunner({ runCli })({ ...base, rereadNudge: true });
    await makeLeanRunner({ runCli })({ ...base, rereadNudge: true, readOnly: true });
    await makeLeanRunner({ runCli })({ ...base, rereadNudge: true, noTools: true });
    const [plain, nudged, ro, none] = seen;
    assert.ok(!plain.includes("--settings"));
    assert.deepEqual(nudged, [...plain, ...rereadNudgeFlags()]);
    assert.ok(!ro.includes("--settings") && !none.includes("--settings"));
    const s = JSON.parse(rereadNudgeFlags()[1]);
    assert.equal(s.hooks.PostToolUse[0].matcher, "Read|Bash");
    assert.equal(s.hooks.PostToolUse[0].hooks[0].command, `${JSON.stringify(process.execPath)} ${JSON.stringify(REREAD_HOOK)}`);
    assert.ok(existsSync(REREAD_HOOK));
  });
});
