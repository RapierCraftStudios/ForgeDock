// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4456: the builder's re-read nudge — a PostToolUse hook that reminds on the 3rd read of one path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { payloadReads, nudgeFor, guardFor, stateFile, main } from "../hooks/reread-nudge.mjs";
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
    const dir = tmpDir("reread-");
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
    } finally { /* tmpDir cleans up at exit */ }
  });

  it("the hook script runs as a CLI: silent twice, then the reminder JSON; exit 0 on bad input", () => {
    const dir = tmpDir("reread-cli-");
    try {
      const run = (input) => execFileSync(process.execPath, [REREAD_HOOK], { input, env: { ...process.env, TMPDIR: dir }, encoding: "utf8" });
      const p = JSON.stringify(read("/w/z.mjs", `cli-${process.pid}`));
      assert.equal(run(p), ""); assert.equal(run(p), "");
      assert.match(run(p), /"additionalContext"/);
      assert.equal(run("{bad"), "");
    } finally { /* tmpDir cleans up at exit */ }
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

describe("#4580 re-read guard (PreToolUse)", () => {
  const pre = (p) => ({ ...p, hook_event_name: "PreToolUse" });
  const post = (p) => ({ ...p, hook_event_name: "PostToolUse" });
  const setup = () => {
    const dir = tmpDir("reread-guard-"), f = join(dir, "a.mjs");
    writeFileSync(f, "x");
    return { dir, f, rd: (extra = {}) => ({ session_id: "g1", cwd: dir, tool_name: "Read", tool_input: { file_path: f, ...extra } }) };
  };

  it("denies the 3rd full-file Read of an unchanged path, with a reason pointing at notes or a line range", () => {
    const { dir, rd } = setup();
    for (let i = 0; i < 2; i++) {
      assert.equal(main(JSON.stringify(pre(rd())), { dir }), "", `read ${i + 1} allowed`);
      main(JSON.stringify(post(rd())), { dir });
    }
    const j = JSON.parse(main(JSON.stringify(pre(rd())), { dir }));
    assert.equal(j.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /already been read 2 times.*line range/);
  });

  it("allows ranged reads, Bash and a changed file; fails open on bad input", () => {
    const { dir, f, rd } = setup();
    for (let i = 0; i < 2; i++) main(JSON.stringify(post(rd())), { dir });
    assert.equal(main(JSON.stringify(pre(rd({ offset: 10, limit: 20 }))), { dir }), "");
    assert.equal(main(JSON.stringify(pre({ ...rd(), tool_name: "Bash", tool_input: { command: `cat ${f}` } })), { dir }), "");
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    assert.equal(main(JSON.stringify(pre(rd())), { dir }), "", "an edited file may be read again");
    main(JSON.stringify(post(rd())), { dir });
    assert.equal(main(JSON.stringify(pre(rd())), { dir }), "", "the count restarted after the change");
    assert.equal(main("{bad", { dir }), "");
    assert.equal(guardFor(pre(rd()), { [f]: 5 }, { [f]: 1 }, () => null), null, "unreadable mtime allows");
  });

  it("rereadNudgeFlags registers the guard on PreToolUse Read and leaves PostToolUse as it was", () => {
    const s = JSON.parse(rereadNudgeFlags()[1]);
    assert.equal(s.hooks.PreToolUse[0].matcher, "Read");
    assert.deepEqual(s.hooks.PreToolUse[0].hooks, s.hooks.PostToolUse[0].hooks);
    assert.equal(s.hooks.PostToolUse[0].matcher, "Read|Bash");
  });
});
