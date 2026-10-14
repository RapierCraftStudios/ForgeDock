// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { makePiRunner, buildPiArgs, parsePiEvents, PI_READ_ONLY_TOOLS } from "./pi-runner.mjs";
import { readLeanRuntime } from "../engine-cli.mjs";

const end = (text, usage = {}, extra = {}) => JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "m1",
  content: [{ type: "text", text }], usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, cost: { total: 0.01 }, ...usage }, ...extra } });

/** A fake `pi` that records its argv and stdin, then prints the given JSON lines and exits with `code`. */
function fakePi(lines, code = 0) {
  const d = tmpDir("pi-runner-");
  const bin = `${d}/pi`;
  writeFileSync(`${d}/out.jsonl`, lines.join("\n") + "\n");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${d}/argv"\ncat > "${d}/stdin"\ncat "${d}/out.jsonl"\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { d, bin, argv: () => readFileSync(`${d}/argv`, "utf8").trim().split("\n"), stdin: () => readFileSync(`${d}/stdin`, "utf8") };
}

describe("pi runner", () => {
  it("runs bare pi with the prompt on stdin and returns the last assistant text, summed usage and the session id", async () => {
    const f = fakePi([JSON.stringify({ type: "session", id: "x" }), end("thinking aloud"), end("```json\n{\"verdict\":\"PASS\"}\n```", { input: 20 })]);
    const run = makePiRunner({ bin: f.bin, sessionDir: `${f.d}/s`, newId: () => "sid-1" });
    const r = await run({ role: "builder", cwd: f.d, model: "openai-codex/gpt-6-luna", resume: null, system: "", prompt: "fix #7" });
    assert.equal(f.stdin(), "fix #7");
    const a = f.argv();
    for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-approve"]) assert.ok(a.includes(flag), flag);
    assert.deepEqual(a.slice(a.indexOf("--session-id"), a.indexOf("--session-id") + 2), ["--session-id", "sid-1"]);
    assert.ok(!a.includes("--tools"), "the builder keeps pi's full tools");
    assert.equal(r.sessionId, "sid-1");
    assert.match(r.text, /PASS/);
    assert.deepEqual(r.usage, { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 });
    assert.equal(r.costUsd, 0.02);
    assert.equal(r.turns, 2);
    assert.equal(r.model, "openai-codex/m1");
  });

  it("a read-only reviewer gets only read/grep/find/ls plus the system prompt; a resume reuses the session id and drops the system prompt", async () => {
    const f = fakePi([end("ok")]);
    const run = makePiRunner({ bin: f.bin, sessionDir: `${f.d}/s`, newId: () => "fresh" });
    await run({ role: "reviewer", cwd: f.d, model: null, resume: null, system: "be strict", prompt: "p", readOnly: true });
    let a = f.argv();
    assert.equal(a[a.indexOf("--tools") + 1], PI_READ_ONLY_TOOLS);
    assert.equal(a[a.indexOf("--append-system-prompt") + 1], "be strict");
    assert.ok(!a.includes("--model"), "no model flag: pi's configured default");
    await run({ role: "builder", cwd: f.d, resume: "sid-1", system: "ignored on resume", prompt: "fix the review" });
    a = f.argv();
    assert.equal(a[a.indexOf("--session-id") + 1], "sid-1");
    assert.ok(!a.includes("--append-system-prompt"));
  });

  it("a non-zero exit or an errored final message without text rejects", async () => {
    await assert.rejects(makePiRunner({ bin: fakePi([], 3).bin, sessionDir: tmpDir("pi-s-") })({ role: "builder", cwd: process.cwd(), prompt: "p" }), /exit 3/);
    const errored = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "quota" } });
    await assert.rejects(makePiRunner({ bin: fakePi([errored]).bin, sessionDir: tmpDir("pi-s-") })({ role: "builder", cwd: process.cwd(), prompt: "p" }), /quota/);
  });

  it("an idle session is killed with runCore's CLI_IDLE code", async () => {
    const d = tmpDir("pi-idle-");
    writeFileSync(`${d}/pi`, "#!/bin/sh\ncat >/dev/null\nsleep 5\n"); chmodSync(`${d}/pi`, 0o755);
    await assert.rejects(makePiRunner({ bin: `${d}/pi`, sessionDir: `${d}/s` })({ role: "builder", cwd: d, prompt: "p", idleMs: 150 }), (e) => e.code === "CLI_IDLE");
  });

  it("buildPiArgs and parsePiEvents ignore non-assistant and malformed lines", () => {
    assert.ok(buildPiArgs({ sessionId: "s", sessionDir: "/d", model: "a/b" }).includes("a/b"));
    const r = parsePiEvents(["noise", "{bad", JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "u" }] } }), end("a")]);
    assert.equal(r.text, "a"); assert.equal(r.turns, 1);
  });
});

describe("readLeanRuntime", () => {
  it("defaults to claude, reads engine.lean_runtime, lets FORGEDOCK_LEAN_RUNTIME win, and rejects unknown runtimes", () => {
    const d = tmpDir("lean-runtime-");
    assert.equal(readLeanRuntime(d, {}), "claude");
    writeFileSync(`${d}/forge.yaml`, "engine:\n  lean_runtime: pi\n");
    assert.equal(readLeanRuntime(d, {}), "pi");
    assert.equal(readLeanRuntime(d, { FORGEDOCK_LEAN_RUNTIME: "claude" }), "claude");
    assert.throws(() => readLeanRuntime(d, { FORGEDOCK_LEAN_RUNTIME: "gemini" }), /claude or pi/);
  });
});
