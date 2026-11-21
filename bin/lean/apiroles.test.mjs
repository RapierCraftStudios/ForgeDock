// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpDir } from "../tests/_tmp.mjs";
import { withApiRoles, runApiRole, readReviewBackend, makeReadOnlyHandlers, apiCostUsd, classifyApiError, ApiRoleError, READ_ONLY_TOOLS, API_TOOLS_NOTE, API_EFFORT } from "./apiroles.mjs";
import { parseReview, decide } from "./conformance.mjs";
import { parseVerifierFindings } from "./verifier.mjs";

// No network: every client below is a fake with the SDK's `beta.messages.stream(...).finalMessage()` shape.
const fence = (o) => "```json\n" + JSON.stringify(o) + "\n```";
const U = (i, o, cw = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });
const reply = (content, stop = "end_turn", usage = U(100, 50), extra = {}) => ({ id: `msg_${Math.random().toString(36).slice(2, 8)}`, model: "claude-sonnet-5-5", content, stop_reason: stop, usage, ...extra });
const text = (t) => ({ type: "text", text: t });
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
function fakeClient(replies) {
  const calls = [];
  return { calls, beta: { messages: { stream(params, opts) { calls.push({ params: structuredClone(params), opts }); const r = replies.shift(); return { finalMessage: async () => { if (r instanceof Error) throw r; return r; } }; } } } };
}
class APIError extends Error { constructor(status, m) { super(m); this.status = status; } }
class RateLimitError extends APIError {}
class AuthenticationError extends APIError {}
const SDK = { default: null, APIError, RateLimitError, AuthenticationError };
const handlers = { read_file: ({ path }) => `1\tcontent of ${path}`, grep: () => "(no matches)" };
const KEY = { ANTHROPIC_API_KEY: "sk-test" };
const cliRunner = (textOut, extra = {}) => { const calls = []; const f = async (a) => { calls.push(a); return { text: textOut, sessionId: "s1", usage: U(30000, 900, 37000, 0), costUsd: 0.2, durationMs: 1000, turns: 3, model: a.model, ...extra }; }; f.calls = calls; return f; };
const wrap = (cli, client, o = {}) => withApiRoles(cli, { mode: "api", env: KEY, sdkLoader: async () => SDK, clientFactory: () => client, handlersFor: () => handlers, ...o });
const reviewArgs = (o = {}) => ({ role: "reviewer", issue: 7, cwd: "/wt", model: "claude-sonnet-5-5", resume: null, system: "SYS", readOnly: true, prompt: "<diff>…</diff>", ...o });

// Conformance fixture (the conformance.test.mjs contract): one conforming reply, one with a blocking finding.
const ISSUE = "## Requirements\n1. The scrape route must release the spend reservation on 429.\n2. The search route must release the spend reservation on 429.\n\n- [ ] Billing pricing is unchanged.";
const Q1 = "The scrape route must release the spend reservation on 429.", Q2 = "The search route must release the spend reservation on 429.";
const C = { requirements: [{ id: "R1", quote: Q1, disposition: "deliver" }, { id: "R2", quote: Q2, disposition: "deliver" }], deliverables: [{ id: "D1", path: "src/scrape.js" }, { id: "D2", path: "src/search.js" }],
  preserve: [{ id: "P1", what: "Billing pricing is unchanged. (src/billing.js)" }], validate: [{ id: "V1", command: "node --test test/leak.test.js" }] };
const files = ["src/scrape.js", "src/search.js", "test/leak.test.js"];
const ctx = { contract: C, changedFiles: files, issueText: ISSUE, pathExists: (p) => p === "src/billing.js" };
const good = { issue_coverage: [{ quote: Q1, status: "covered" }, { quote: Q2, status: "covered" }, { quote: "Billing pricing is unchanged.", status: "covered" }],
  requirements: [{ id: "R1", status: "implemented", evidence: "src/scrape.js:7", validated_by: "V1" }, { id: "R2", status: "implemented", evidence: "src/search.js:7", validated_by: "V1" }],
  scope: [{ file: "src/scrape.js", authorized_by: "D1" }, { file: "src/search.js", authorized_by: "D2" }, { file: "test/leak.test.js", authorized_by: "test" }],
  preserve: [{ id: "P1", status: "intact", evidence: "src/billing.js:1" }], regressions: [], verdict: "CONFORMS", summary: "ok" };
const blocking = { ...good, requirements: [good.requirements[0], { id: "R2", status: "missing", evidence: "", validated_by: "" }], regressions: [{ at: "src/scrape.js:9", failure: "reservation released twice" }], verdict: "NONCONFORMING", summary: "R2 missing" };
const judge = (t) => { const d = decide(parseReview(t), ctx); return { state: d.state, failures: d.failures.map((f) => [f.code, f.detail]) }; };

describe("#5821 backend setting", () => {
  it("defaults to cli; env wins; a forge.yaml api/auto needs the host opt-in", () => {
    const d = tmpDir("apiroles-cfg-");
    assert.deepEqual(readReviewBackend({ cwd: d, env: {} }), { mode: "cli", source: "default", approved: true });
    writeFileSync(join(d, "forge.yaml"), "engine:\n  review_backend: api\n");
    assert.deepEqual(readReviewBackend({ cwd: d, env: {} }), { mode: "api", source: "forge.yaml", approved: false });
    assert.equal(readReviewBackend({ cwd: d, env: { FORGEDOCK_ALLOW_API_BACKEND: "1" } }).approved, true);
    assert.deepEqual(readReviewBackend({ cwd: d, env: { FORGEDOCK_REVIEW_BACKEND: "auto" } }), { mode: "auto", source: "env", approved: true });
    writeFileSync(join(d, "forge.yaml"), "engine:\n  review_backend: sometimes\n");
    assert.equal(readReviewBackend({ cwd: d, env: {} }).mode, "cli");
  });
  it("cli mode returns the CLI runner unchanged", () => { const cli = cliRunner("x"); assert.equal(withApiRoles(cli, { mode: "cli" }), cli); });
});

describe("#5821 verdict parity with the CLI path", () => {
  for (const [name, rows] of [["conforming", good], ["blocking finding", blocking]]) {
    it(`${name}: the API reply yields the same state and blocking failures as the CLI reply`, async () => {
      const t = `Checked the diff.\n${fence(rows)}`;
      const cliOut = await cliRunner(t)(reviewArgs());
      const client = fakeClient([reply([toolUse("tu1", "read_file", { path: "src/scrape.js" })], "tool_use"), reply([text(t)])]);
      const apiOut = await wrap(cliRunner("unused"), client)(reviewArgs());
      assert.equal(apiOut.backend, "api");
      assert.deepEqual(judge(apiOut.text), judge(cliOut.text));
    });
  }
  it("the blocking fixture really blocks (the parity above is not vacuous)", () => {
    const j = judge(fence(blocking));
    assert.equal(j.state, "nonconforming");
    assert.ok(j.failures.some(([c]) => c === "conformance.unimplemented") && j.failures.some(([c]) => c === "conformance.regression"));
  });
  it("verifier findings parse the same from both paths", async () => {
    const t = fence({ findings: [{ file: "src/scrape.js", line: 9, input: "429 twice", expected: "one release", actual: "two", why: "double release" }] });
    const client = fakeClient([reply([text(t)])]);
    const out = await wrap(cliRunner("unused"), client)(reviewArgs({ role: "verifier", maxTurns: 10, maxMs: 60000 }));
    const pathExists = (p) => files.includes(p);
    assert.deepEqual(parseVerifierFindings(out.text, { pathExists }), parseVerifierFindings(t, { pathExists }));
    assert.equal(parseVerifierFindings(out.text, { pathExists }).length, 1);
  });
});

describe("#5821 request shape", () => {
  it("stable cached prefix (tools, system), the prompt after it; adaptive thinking, explicit effort, no sampling params; server-side fallbacks on 5.5 models", async () => {
    const client = fakeClient([reply([text(fence(good))])]);
    await wrap(cliRunner("x"), client)(reviewArgs());
    const p = client.calls[0].params;
    assert.equal(p.model, "claude-sonnet-5-5");
    assert.deepEqual(p.tools.map((t) => t.name), READ_ONLY_TOOLS.map((t) => t.name));
    assert.equal(p.system.length, 1); assert.deepEqual(p.system[0].cache_control, { type: "ephemeral" });
    assert.equal(p.system[0].text, `SYS\n\n${API_TOOLS_NOTE}`);
    assert.deepEqual(p.messages, [{ role: "user", content: "<diff>…</diff>" }]);
    assert.deepEqual(p.cache_control, { type: "ephemeral" });
    assert.deepEqual(p.output_config, { effort: API_EFFORT });
    for (const k of ["thinking", "temperature", "top_p", "top_k"]) assert.equal(k in p, false, k);
    assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]); assert.equal(p.fallbacks, "default");
    assert.ok(p.max_tokens >= 32000);
    const c2 = fakeClient([reply([text("{}")])]);
    await wrap(cliRunner("x"), c2)(reviewArgs({ model: "claude-haiku-5-5" }));
    assert.equal("fallbacks" in c2.calls[0].params, false); assert.equal("betas" in c2.calls[0].params, false);
  });
  it("only fresh read-only reviewer/verifier calls take the API path", async () => {
    const client = fakeClient([]);
    const cli = cliRunner("x");
    const r = wrap(cli, client);
    await r(reviewArgs({ role: "builder", readOnly: false }));
    await r(reviewArgs({ resume: "sess" }));
    await r(reviewArgs({ role: "grouper", noTools: true }));
    assert.equal(client.calls.length, 0); assert.equal(cli.calls.length, 3);
  });
});

describe("#5821 fallback to the CLI session", () => {
  it("api with no key: CLI result, apiFallback no_api_key, no client built", async () => {
    let built = 0; const cli = cliRunner("cli text");
    const r = withApiRoles(cli, { mode: "api", env: {}, sdkLoader: async () => SDK, clientFactory: () => { built++; return fakeClient([]); } });
    const out = await r(reviewArgs());
    assert.equal(out.text, "cli text"); assert.equal(out.backend, "cli"); assert.equal(out.apiFallback.reason, "no_api_key"); assert.equal(built, 0);
  });
  it("auto with no key: plain CLI result, nothing reported", async () => {
    const cli = cliRunner("cli text");
    const out = await withApiRoles(cli, { mode: "auto", env: {}, sdkLoader: async () => SDK })(reviewArgs());
    assert.equal(out.apiFallback, undefined); assert.equal(out.text, "cli text");
  });
  it("forge.yaml api without the host opt-in, a missing SDK and a model alias fall back", async () => {
    assert.equal((await withApiRoles(cliRunner("x"), { mode: "api", approved: false, env: KEY })(reviewArgs())).apiFallback.reason, "not_approved");
    assert.equal((await withApiRoles(cliRunner("x"), { mode: "api", env: KEY, sdkLoader: async () => null })(reviewArgs())).apiFallback.reason, "no_sdk");
    assert.equal((await wrap(cliRunner("x"), fakeClient([]))(reviewArgs({ model: "sonnet" }))).apiFallback.reason, "model_not_api_id");
  });
  it("an API error falls back per call; an auth error disables the API for the process", async () => {
    const client = fakeClient([new RateLimitError(429, "slow down"), reply([text("ok")]), new AuthenticationError(401, "bad key")]);
    const cli = cliRunner("cli text");
    const r = wrap(cli, client);
    const a = await r(reviewArgs());
    assert.equal(a.apiFallback.reason, "api_rate_limited"); assert.equal(a.text, "cli text");
    assert.equal((await r(reviewArgs())).backend, "api", "a rate limit is not sticky");
    assert.equal((await r(reviewArgs())).apiFallback.reason, "api_auth");
    assert.equal((await r(reviewArgs())).apiFallback.reason, "api_auth");
    assert.equal(client.calls.length, 3, "no API call after the auth failure");
    assert.equal(cli.calls.length, 3);
  });
  it("a refusal falls back with its category; the API tokens it spent are added to the attempt's usage and cost", async () => {
    const client = fakeClient([reply([], "refusal", U(1000, 0, 2000, 0), { stop_details: { type: "refusal", category: "cyber" } })]);
    const out = await wrap(cliRunner("cli text"), client)(reviewArgs());
    assert.equal(out.apiFallback.reason, "refusal"); assert.equal(out.apiFallback.detail, "cyber");
    assert.deepEqual(out.apiFallback.usage, U(1000, 0, 2000, 0));
    const spent = apiCostUsd(U(1000, 0, 2000, 0), "claude-sonnet-5-5");
    assert.equal(out.apiFallback.cost_usd, spent);
    assert.equal(out.costUsd, Math.round((0.2 + spent) * 1e6) / 1e6);
    assert.deepEqual(out.usage, U(31000, 900, 39000, 0));
  });
  it("max_tokens and an exhausted turn budget fall back", async () => {
    assert.equal((await wrap(cliRunner("x"), fakeClient([reply([text("{\"rows\":[")], "max_tokens")]))(reviewArgs())).apiFallback.reason, "max_tokens");
    const loop = fakeClient([reply([toolUse("a", "grep", { pattern: "x" })], "tool_use"), reply([toolUse("b", "grep", { pattern: "y" })], "tool_use")]);
    assert.equal((await wrap(cliRunner("x"), loop)(reviewArgs({ role: "verifier", maxTurns: 2 }))).apiFallback.reason, "max_turns");
  });
  it("classifyApiError uses the SDK's typed errors", () => {
    assert.deepEqual(classifyApiError(new AuthenticationError(401, "x"), SDK), { reason: "api_auth", detail: "x", sticky: true });
    assert.equal(classifyApiError(new APIError(529, "overloaded"), SDK).reason, "api_status_529");
    assert.equal(classifyApiError(new ApiRoleError("refusal", "bio"), SDK).reason, "refusal");
    assert.equal(classifyApiError(new Error("boom"), SDK).reason, "api_error");
  });
});

describe("#5821 usage accounting", () => {
  it("sums usage over the tool loop; cost from usage at the served model's price; baseline is the first turn's context", async () => {
    const client = fakeClient([
      reply([toolUse("t1", "read_file", { path: "src/a.js" }), toolUse("t2", "read_file", { path: "src/b.js" })], "tool_use", U(4000, 200, 3000, 0)),
      reply([text(fence(good))], "end_turn", U(500, 800, 600, 7000)),
    ]);
    const out = await wrap(cliRunner("x"), client)(reviewArgs());
    assert.deepEqual(out.usage, U(4500, 1000, 3600, 7000));
    assert.equal(out.costUsd, apiCostUsd(out.usage, "claude-sonnet-5-5"));
    assert.equal(out.costUsd, Math.round(((4500 * 2 + 1000 * 10 + 7000 * 0.1 + 3600 * 2.5) / 1e6) * 1e6) / 1e6);
    assert.equal(out.baselineTokens, 7000); assert.equal(out.endTokens, 8100);
    assert.equal(out.turns, 2); assert.equal(out.sessionId, null); assert.equal(out.model, "claude-sonnet-5-5");
    assert.equal(out.toolUses.length, 2); assert.equal(out.tools.calls, 2); assert.equal(out.tools.turns, 1);
    // tool results go back in one user message, with thinking/tool_use content echoed unchanged
    const second = client.calls[1].params.messages;
    assert.equal(second.length, 3);
    assert.deepEqual(second[2].content.map((b) => [b.type, b.tool_use_id]), [["tool_result", "t1"], ["tool_result", "t2"]]);
  });
  it("an unknown or invalid tool call is an error tool_result, not a crash", async () => {
    const client = fakeClient([reply([toolUse("t1", "run_bash", { cmd: "rm -rf /" })], "tool_use"), reply([text("{}")])]);
    const out = await wrap(cliRunner("x"), client)(reviewArgs());
    assert.equal(out.backend, "api");
    const tr = client.calls[1].params.messages[2].content[0];
    assert.equal(tr.is_error, true); assert.match(tr.content, /unknown tool/);
  });
  it("runApiRole throws ApiRoleError with the spent usage on refusal", async () => {
    const client = fakeClient([reply([], "refusal", U(10, 0))]);
    await assert.rejects(runApiRole({ client, model: "claude-sonnet-5-5", system: "S", prompt: "P", cwd: "/wt", handlers }), (e) => e instanceof ApiRoleError && e.reason === "refusal" && e.usage.input_tokens === 10);
  });
});

describe("#5821 read-only tools", () => {
  const repo = () => {
    const d = tmpDir("apiroles-wt-");
    const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
    g("init", "-q"); g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "a.js"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
    writeFileSync(join(d, ".env"), "SECRET=1\n");
    g("add", "src/a.js"); g("commit", "-qm", "x");
    return d;
  };
  it("read_file returns numbered lines of tracked files only, confined to the worktree", () => {
    const d = repo();
    const h = makeReadOnlyHandlers(d);
    assert.equal(h.read_file({ path: "src/a.js", start_line: 2, end_line: 3 }), "2\tline 2\n3\tline 3");
    assert.throws(() => h.read_file({ path: ".env" }), /not a git-tracked file/);
    assert.throws(() => h.read_file({ path: "/etc/passwd" }), /repo-relative/);
    assert.throws(() => h.read_file({ path: "../x" }), /repo-relative/);
    assert.throws(() => h.read_file({ path: ".git/config" }), /not a git-tracked file/);
  });
  it("read_file refuses a tracked symlink that points outside the worktree", () => {
    const d = repo();
    const outside = tmpDir("apiroles-out-"); writeFileSync(join(outside, "s.txt"), "secret");
    symlinkSync(join(outside, "s.txt"), join(d, "link.txt"));
    execFileSync("git", ["add", "link.txt"], { cwd: d, stdio: "ignore" });
    assert.throws(() => makeReadOnlyHandlers(d).read_file({ path: "link.txt" }), /outside the worktree/);
  });
  it("grep searches tracked files with path:line output", () => {
    const d = repo();
    const h = makeReadOnlyHandlers(d);
    assert.equal(h.grep({ pattern: "^line 1[0-2]$" }), "src/a.js:10:line 10\nsrc/a.js:11:line 11\nsrc/a.js:12:line 12");
    assert.equal(h.grep({ pattern: "SECRET" }), "(no matches)");
    assert.throws(() => h.grep({ pattern: "x", path: "../" }), /repo-relative/);
  });
});
