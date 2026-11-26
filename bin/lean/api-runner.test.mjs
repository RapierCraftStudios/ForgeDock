// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApiCall, buildApiRequest, apiCostUsd, ApiRunnerError } from "./api-runner.mjs";
import { summarizeApiRoute, compare, formatApiReport } from "./api-report.mjs";
import { compareFindings, replay, replaySample, loadSamples } from "./api-parity.mjs";
import { splitCacheablePrefix } from "./prompts.mjs";

const okFetch = (body, seen = []) => async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => body }; };
const reply = { model: "claude-sonnet-5-5", content: [{ type: "text", text: "{\"rows\":[]}" }], usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000 } };

describe("#5821 api runner", () => {
  it("request shape: system and prefix carry cache_control, the tail does not", async () => {
    const seen = [];
    await runApiCall({ system: "SYS", prefix: "PRE", tail: "TAIL", fetchImpl: okFetch(reply, seen), env: { ANTHROPIC_API_KEY: "k" } });
    const body = JSON.parse(seen[0].init.body);
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(body.messages[0].content.map((c) => [c.text, Boolean(c.cache_control)]), [["PRE", true], ["TAIL", false]]);
    assert.equal(seen[0].init.headers["x-api-key"], "k");
    assert.equal(buildApiRequest({ model: "m", prefix: "p" }).messages[0].content.length, 1);
  });
  it("usage maps to the runner contract and cost", async () => {
    const r = await runApiCall({ prefix: "p", fetchImpl: okFetch(reply), env: { ANTHROPIC_API_KEY: "k" } });
    assert.equal(r.turns, 1); assert.equal(r.route, "api"); assert.equal(r.text, "{\"rows\":[]}");
    assert.equal(r.baselineTokens, 3010);
    assert.ok(Math.abs(r.costUsd - (10 * 3 + 20 * 15 + 1000 * 3.75 + 2000 * 0.3) / 1e6) < 1e-9);
    assert.equal(r.costUsd, apiCostUsd(r.usage, r.model));
  });
  it("error classes: no key, 429, 401, empty, transport", async () => {
    const kind = (p) => p.then(() => null, (e) => e instanceof ApiRunnerError ? e.kind : "other");
    assert.equal(await kind(runApiCall({ prefix: "p", env: {} })), "auth");
    const st = (status) => async () => ({ ok: false, status });
    assert.equal(await kind(runApiCall({ prefix: "p", fetchImpl: st(429), env: { ANTHROPIC_API_KEY: "k" } })), "rate_limit");
    assert.equal(await kind(runApiCall({ prefix: "p", fetchImpl: st(401), env: { ANTHROPIC_API_KEY: "k" } })), "auth");
    assert.equal(await kind(runApiCall({ prefix: "p", fetchImpl: okFetch({ content: [] }), env: { ANTHROPIC_API_KEY: "k" } })), "empty");
    assert.equal(await kind(runApiCall({ prefix: "p", fetchImpl: async () => { throw new Error("down"); }, env: { ANTHROPIC_API_KEY: "k" } })), "transport");
  });
  it("timeout aborts the request", async () => {
    const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    await assert.rejects(runApiCall({ prefix: "p", maxMs: 20, fetchImpl: hang, env: { ANTHROPIC_API_KEY: "k" } }), (e) => e.kind === "timeout");
  });
  it("splitCacheablePrefix: prefix + tail is the prompt, cut after the last </diff>", () => {
    const p = "a<diff>\nx\n</diff>\n<structure>s</structure>";
    const s = splitCacheablePrefix(p);
    assert.equal(s.prefix + s.tail, p); assert.ok(s.prefix.endsWith("</diff>")); assert.equal(splitCacheablePrefix("none").tail, "");
  });
  it("header names both earlier attempts and the CLI fallback", () => {
    const head = readFileSync(new URL("./api-runner.mjs", import.meta.url), "utf8").slice(0, 2000);
    assert.match(head, /#5347/); assert.match(head, /#2385/); assert.match(head, /fallback/);
  });
});

describe("#5821 api report and parity", () => {
  const rows = [
    { ts: "2026-01-01T00:00:00Z", issue: 1, event: "phase_attempt", baseline_tokens: 37000, cache_creation_tokens: 30000, input_tokens: 10, cache_read_tokens: 10000, cost_usd_delta: "1.0" },
    { ts: "2026-01-01T00:01:00Z", issue: 1, event: "phase_attempt", baseline_tokens: 37000, cache_creation_tokens: 10000, input_tokens: 10, cache_read_tokens: 30000, cost_usd_delta: "1.0" },
    { ts: "2026-01-01T00:02:00Z", issue: 1, event: "phase_attempt", baseline_tokens: 37000, cache_creation_tokens: 0, input_tokens: 10, cache_read_tokens: 0, cost_usd_delta: "0.5" },
    { ts: "2026-03-01T00:00:00Z", issue: 2, event: "phase_attempt", route: "api", cache_creation_tokens: 100, input_tokens: 10, cache_read_tokens: 900, cost_usd_delta: "0.2" },
  ];
  it("report: per-issue session count, cache-write share and cost split at the cutoff", () => {
    const c = compare(rows, "2026-02-01T00:00:00Z");
    assert.equal(c.before.fresh_cli_sessions, 3); assert.equal(c.before.cost_usd_per_issue, 2.5);
    assert.equal(c.after.fresh_cli_sessions, 0); assert.equal(c.after.api_calls, 1);
    assert.ok(c.after.cache_write_share < c.before.cache_write_share);
    assert.match(formatApiReport(c), /before: 1 issues, 3 fresh CLI sessions \(3\.00\/issue\)/);
    assert.equal(summarizeApiRoute([]).issues, 0);
    writeFileSync(join(mkdtempSync(join(tmpdir(), "rep-")), "x"), "");
  });
  it("parity: compares blocking findings of two replies", async () => {
    const t = (...ids) => JSON.stringify({ rows: ids.map((id) => ({ id, status: "fail" })) });
    assert.equal(compareFindings(t("R1"), t("R1")).match, true);
    assert.deepEqual(compareFindings(t("R1", "R2"), t("R1")).onlyCli, ["R2"]);
    const r = await replay({ prompt: "p", runCli: async () => ({ text: t("R1"), costUsd: 1 }), runApi: async () => ({ text: t("R1"), costUsd: 0.2 }) });
    assert.equal(r.match, true); assert.equal(r.apiCost, 0.2);
  });
  it("parity sample: replays a directory of past-PR prompts and reports the match rate", async () => {
    const t = (...ids) => JSON.stringify({ rows: ids.map((id) => ({ id, status: "fail" })) });
    const d = mkdtempSync(join(tmpdir(), "par-")); writeFileSync(join(d, "pr1.txt"), "same"); writeFileSync(join(d, "pr2.txt"), "differs");
    const samples = loadSamples([d]); assert.equal(samples.length, 2);
    const out = await replaySample({ samples, runCli: async (p) => ({ text: t("R1") }), runApi: async (p) => ({ text: p === "differs" ? t("R1", "R2") : t("R1") }) });
    assert.equal(out.total, 2); assert.equal(out.matched, 1); assert.equal(out.rate, 0.5);
    assert.deepEqual(out.results.find((x) => !x.match).onlyApi, ["R2"]);
  });
});
