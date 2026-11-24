// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5748: the Actions lane provider over a fake GitHub API.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { actionsProvider, laneCap, LANE_RESULT_MARKER, ACTIONS_TIMEOUT_CODE } from "./sandbox-actions.mjs";
import { openBatch } from "./batch.mjs";

/** A fake GitHub: workflow runs by run-name, issue comments, the authenticated login. */
export function fakeGithub({ login = "forgedock-bot" } = {}) {
  const g = { runs: [], comments: [], dispatches: [], cancelled: [], nextId: 100 };
  g.api = async (method, path, body) => {
    if (method === "POST" && /\/dispatches$/.test(path)) {
      g.dispatches.push({ path, body });
      g.runs.push({ id: g.nextId++, display_title: `forgedock-lane ${body.inputs.lane_id}`, status: "in_progress", conclusion: null, run_started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:04:30Z" });
      return null;
    }
    if (method === "GET" && /\/runs\?/.test(path)) return { workflow_runs: g.runs };
    if (method === "GET" && /\/comments\?/.test(path)) return [g.comments];
    if (method === "GET" && path === "repos/o/r") return { default_branch: "main" };
    if (method === "GET" && path === "user") return { login };
    if (method === "POST" && /\/cancel$/.test(path)) { const r = g.runs.find((x) => path.includes(`/runs/${x.id}/`)); g.cancelled.push(r.id); r.status = "completed"; return null; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  g.finish = (id, result, { author = "github-actions[bot]", conclusion = "success" } = {}) => {
    const r = g.runs.find((x) => x.display_title === `forgedock-lane ${id}`); r.status = "completed"; r.conclusion = conclusion;
    if (result) g.comments.push({ user: { login: author }, body: `${LANE_RESULT_MARKER(id)}\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` });
  };
  return g;
}
const make = (g, settings = {}) => { const work = tmpDir("actions-"); const batch = openBatch(join(work, "batches"), "bt"); return { batch, provider: actionsProvider({ batch, repo: "o/r", settings, api: g.api, env: {}, credentials: () => null, gitIdentity: () => ({}) }) }; };
const START = { issue: 7, args: ["--repo", "o/r", "--lane", "staging"], env: {}, secrets: [] };

describe("actions provider (#5748)", () => {
  it("dispatches forgedock-lane.yml with non-secret inputs only, on the base lane ref", async () => {
    const g = fakeGithub(); const { provider } = make(g, { secrets: ["GH_TOKEN"] });
    const h = await provider.start({ ...START, env: { GH_TOKEN: "s3cret-value-123" }, secrets: ["GH_TOKEN"] });
    assert.equal(provider.name, "actions");
    const d = g.dispatches[0];
    assert.match(d.path, /repos\/o\/r\/actions\/workflows\/forgedock-lane\.yml\/dispatches$/);
    assert.equal(d.body.ref, "staging");
    assert.deepEqual(Object.keys(d.body.inputs).sort(), ["args", "batch", "issue", "lane_id", "ref"]);
    assert.equal(JSON.stringify(d).includes("s3cret-value-123"), false);
    assert.deepEqual(JSON.parse(d.body.inputs.args), ["--repo", "o/r", "--lane", "staging"]);
    assert.equal(d.body.inputs.lane_id, h.id);
    assert.equal(await provider.status(h), "running");
  });
  it("polls the run and reads the result from a github-actions[bot] comment only", async () => {
    const g = fakeGithub(); const { provider } = make(g);
    const h = await provider.start(START);
    g.finish(h.id, { terminalReason: "merged", pr: 9 }, { author: "mallory" }); // a spoofed comment on a public repo
    assert.equal(await provider.status(h), "exited");
    assert.equal(await provider.fetchResult(h), null);
    g.comments.push({ user: { login: "github-actions[bot]" }, body: `${LANE_RESULT_MARKER(h.id)}\n\`\`\`json\n{"terminalReason":"merged","pr":9}\n\`\`\`` });
    assert.deepEqual(await provider.fetchResult(h), { terminalReason: "merged", pr: 9 });
    assert.equal(h.minutes, 4.5);
  });
  it("a run that hit the job time limit without a result is a retryable deferral", async () => {
    const g = fakeGithub(); const { provider } = make(g);
    const h = await provider.start(START);
    g.finish(h.id, null, { conclusion: "timed_out" });
    const r = await provider.fetchResult(h);
    assert.equal(r.terminalReason, "deferred"); assert.equal(r.code, ACTIONS_TIMEOUT_CODE); assert.ok(r.retryInSeconds > 0);
  });
  it("a run that is not listed is gone after the dispatch grace; teardown cancels a live run", async () => {
    const g = fakeGithub(); let t = 0; const { batch } = make(g);
    const provider = actionsProvider({ batch, repo: "o/r", settings: {}, api: g.api, env: {}, credentials: () => null, gitIdentity: () => ({}), now: () => t });
    const h = await provider.start(START); g.runs.length = 0;
    assert.equal(await provider.status(h), "running"); t = 130000;
    assert.equal(await provider.status(h), "gone");
    const h2 = await provider.start({ ...START, issue: 8 });
    assert.equal(await provider.teardown(h2), true); assert.equal(g.cancelled.length, 1);
    assert.equal(await provider.teardown(h2), true);
  });
  it("capacity is the plan's job limit minus the CI reserve minus lanes in flight", async () => {
    assert.equal(laneCap({ plan: "free" }), 15); assert.equal(laneCap({ plan: "team", ciReserve: 10 }), 50);
    assert.equal(laneCap({ jobLimit: 8, ciReserve: 20 }), 0); assert.equal(laneCap({}), 15);
    const g = fakeGithub(); const { provider } = make(g, { plan: "free", ciReserve: 5 });
    assert.deepEqual(await provider.capacity(), { free: 15, online: null });
    await provider.start(START); await provider.start({ ...START, issue: 8 });
    assert.equal((await provider.capacity()).free, 13);
  });
  it("refuses a dispatcher that is not the configured app/bot, and an unsafe base ref", async () => {
    const g = fakeGithub({ login: "someone-else" }); const { provider } = make(g, { dispatcher: "forgedock-bot" });
    await assert.rejects(provider.start(START), { code: "actions.dispatcher_refused" });
    assert.equal(g.dispatches.length, 0);
    const ok = make(fakeGithub(), { dispatcher: "forgedock-bot" }).provider;
    await ok.start(START);
    const g2 = fakeGithub(); await make(g2).provider.start({ ...START, args: [] }); assert.equal(g2.dispatches[0].body.ref, "main"); // no --lane: the default branch
    await assert.rejects(make(fakeGithub()).provider.start({ ...START, args: ["--lane", "-x"] }), { code: "execution.provider.misconfigured" });
  });
});
