// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRecord, emit } from "./telemetry.mjs";

let td; let saved;
const KEYS = ["FORGE_TELEMETRY", "FORGE_TELEMETRY_GH", "FORGE_TELEMETRY_BUFFER_DIR", "FORGE_TELEMETRY_MAX_CHARS", "FORGE_REPO", "FORGE_ISSUE", "FORGE_PR", "FORGE_RUN", "FORGE_PHASE", "TD"];

// Stub gh: lists $TD/comments.json, records the last PATCH/POST body in $TD/patched|posted, logs calls.
function stubGh(fail = false) {
  const p = join(td, "gh");
  writeFileSync(p, `#!/usr/bin/env bash
echo "$*" >> "$TD/calls"
${fail ? "exit 1" : ""}
case "$*" in
  "api --paginate "*) if [ -f "$TD/comments.json" ]; then cat "$TD/comments.json"; else echo '[]'; fi ;;
  "api -X PATCH"*) b="\${@: -1}"; printf '%s' "\${b#body=}" > "$TD/patched" ;;
  "api -X POST"*) b="\${@: -1}"; printf '%s' "\${b#body=}" > "$TD/posted" ;;
esac
`);
  chmodSync(p, 0o755);
  process.env.FORGE_TELEMETRY_GH = p;
}
const setComments = (bodies) => writeFileSync(join(td, "comments.json"),
  JSON.stringify(bodies.map((b, i) => ({ id: 100 + i, body: b, user: { type: "Bot" }, author_association: "NONE" }))));

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  td = mkdtempSync(join(tmpdir(), "tel-"));
  Object.assign(process.env, { TD: td, FORGE_TELEMETRY_BUFFER_DIR: join(td, "buf"), FORGE_REPO: "o/r", FORGE_ISSUE: "5" });
  for (const k of ["FORGE_TELEMETRY", "FORGE_PR", "FORGE_RUN", "FORGE_PHASE", "FORGE_TELEMETRY_MAX_CHARS"]) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(td, { recursive: true, force: true });
});

describe("telemetry emitter (node twin)", () => {
  it("builds the shared record shape with null context and typed payload", () => {
    const r = buildRecord("diff_size", { lines: "10", excluded: 0, threshold: 0, result: "OK", bad: "a`b\nc" });
    assert.deepEqual(Object.keys(r).slice(0, 9), ["v", "ts", "forge_version", "repo", "issue", "pr", "run", "phase", "event"]);
    assert.equal(r.v, 1); assert.equal(r.issue, 5); assert.equal(r.pr, null); assert.equal(r.run, null);
    assert.equal(r.lines, 10); assert.equal(r.result, "OK"); assert.equal(r.bad, "a_b c");
    assert.match(r.forge_version, /^\d+\.\d+\.\d+/);
  });

  it("drops reserved and malformed keys", () => {
    const r = buildRecord("x", { repo: "evil", "a b": 1, ok: 1 });
    assert.equal(r.repo, "o/r"); assert.equal(r.ok, 1); assert.equal("a b" in r, false);
  });

  it("creates then upserts one trusted comment", () => {
    stubGh();
    emit("ci_gate", { result: "PASS", rc: 0, checks: 3 });
    const posted = readFileSync(join(td, "posted"), "utf8");
    assert.match(posted, /^<!-- FORGE:TELEMETRY v1 -->\n```jsonl\n\{.*"event":"ci_gate".*\}\n```$/);
    setComments([posted]);
    emit("liveness", { decision: "DEFER", why: "lease" });
    const patched = readFileSync(join(td, "patched"), "utf8");
    assert.equal(patched.split("\n").filter((l) => l.startsWith("{")).length, 2);
    assert.deepEqual(existsSync(join(td, "buf")) ? readdirSync(join(td, "buf")) : [], []);
  });

  it("ignores an untrusted telemetry comment", () => {
    stubGh();
    writeFileSync(join(td, "comments.json"), JSON.stringify([{ id: 1, body: "<!-- FORGE:TELEMETRY v1 -->\n```jsonl\n```", user: { type: "User" }, author_association: "NONE" }]));
    emit("ci_gate", { result: "PASS" });
    assert.ok(existsSync(join(td, "posted")));
    assert.equal(existsSync(join(td, "patched")), false);
  });

  it("rolls over to part=N near the size limit", () => {
    stubGh();
    process.env.FORGE_TELEMETRY_MAX_CHARS = "300";
    setComments(["<!-- FORGE:TELEMETRY v1 -->\n```jsonl\n" + '{"a":"' + "x".repeat(250) + '"}\n```']);
    emit("ci_gate", { result: "PASS" });
    assert.match(readFileSync(join(td, "posted"), "utf8"), /^<!-- FORGE:TELEMETRY v1 part=2 -->/);
  });

  it("buffers on a failed write and flushes on the next emit", () => {
    stubGh(true);
    assert.doesNotThrow(() => emit("diff_size", { lines: 1 }));
    const files = readdirSync(join(td, "buf"));
    assert.deepEqual(files, ["o_r__5.jsonl"]);
    stubGh(false);
    emit("diff_size", { lines: 2 });
    const posted = readFileSync(join(td, "posted"), "utf8");
    assert.equal(posted.split("\n").filter((l) => l.startsWith("{")).length, 2);
    assert.equal(existsSync(join(td, "buf", "o_r__5.jsonl")), false);
  });

  it("never throws with an unwritable buffer dir and no gh", () => {
    process.env.FORGE_TELEMETRY_GH = "/nonexistent/gh";
    writeFileSync(join(td, "afile"), "x");
    process.env.FORGE_TELEMETRY_BUFFER_DIR = join(td, "afile", "buf"); // parent is a file: mkdir fails
    assert.doesNotThrow(() => emit("diff_size", { lines: 1 }));
  });

  it("honours FORGE_TELEMETRY=off and drops records with no target", () => {
    stubGh();
    process.env.FORGE_TELEMETRY = "off";
    assert.equal(emit("ci_gate", { result: "PASS" }), null);
    assert.equal(existsSync(join(td, "calls")), false);
    delete process.env.FORGE_TELEMETRY; delete process.env.FORGE_ISSUE;
    assert.equal(emit("ci_gate", { result: "PASS" }), null);
  });

  it("shell and node emitters produce the same keys", () => {
    process.env.FORGE_PR = "9"; process.env.FORGE_RUN = "r1"; process.env.FORGE_PHASE = "build";
    const sh = spawnSync("bash", ["-c", `. "${join(import.meta.dirname, "..", "..", "scripts", "lib", "telemetry.sh")}"; _forge_tel_record diff_size lines=10 result=OK`], { encoding: "utf8", env: process.env });
    const a = JSON.parse(sh.stdout); const b = buildRecord("diff_size", { lines: 10, result: "OK" });
    assert.deepEqual(Object.keys(a), Object.keys(b));
    for (const k of Object.keys(a)) if (k !== "ts" && k !== "eid") assert.deepEqual(a[k], b[k], k);
  });
});
