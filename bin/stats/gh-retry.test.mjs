// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5530: the real defaultGh and the real crawls run against a scripted `gh` binary on PATH that stands in for the GitHub
// service (its replies, its HTTP 5xx stderr and exit codes). No JS function of the code under test is substituted.
import { tmpDir } from "../tests/_tmp.mjs";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as source from "./github-source.mjs";

const { defaultGh, fetchGithubRecords } = source;
import { gatherDefects } from "./depth.mjs";
import { gatherCompounding } from "./compounding.mjs";

const BIN = String.raw`#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = __dirname, args = process.argv.slice(2), line = args.join(" ");
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\n");
const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
const calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l).join(" "));
for (const f of plan.failures ?? []) {
  if (!new RegExp(f.match).test(line)) continue;
  if (calls.filter((c) => new RegExp(f.match).test(c)).length <= f.times) { process.stderr.write(f.stderr + "\n"); process.exit(1); }
}
if (args[0] === "api" && args[1] === "graphql") {
  const q = args.find((a) => a.startsWith("query=")), full = /comments\(first/.test(q), repo = {};
  for (const m of q.matchAll(/i(\d+): issueOrPullRequest/g)) {
    const node = plan.store[m[1]] ?? null;
    repo["i" + m[1]] = node && (full ? node : { __typename: node.__typename, updatedAt: node.updatedAt });
  }
  process.stdout.write(JSON.stringify({ data: { repository: repo } }));
  process.exit(0);
}
const c = /repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(line);
if (c) { process.stdout.write(JSON.stringify(plan.restComments?.[c[1]] ?? [])); process.exit(0); }
for (const r of plan.replies ?? []) if (new RegExp(r.match).test(line)) { process.stdout.write(r.out); process.exit(0); }
process.stdout.write("[]");
`;

const ENV = { FORGE_TRAIL_TRUSTED_ASSOCIATIONS: "OWNER,MEMBER,COLLABORATOR" };
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const T0 = Date.UTC(2026, 9, 1);
let dir, saved;
const plan = (p) => { writeFileSync(join(dir, "plan.json"), JSON.stringify(p)); writeFileSync(join(dir, "calls.log"), ""); };
const calls = () => readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

before(() => {
  dir = tmpDir("gh-retry-");
  writeFileSync(join(dir, "gh"), BIN);
  chmodSync(join(dir, "gh"), 0o755);
  saved = { PATH: process.env.PATH, RETRY: process.env.FORGE_STATS_GH_RETRY_MS };
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  process.env.FORGE_STATS_GH_RETRY_MS = "1";
});
after(() => {
  process.env.PATH = saved.PATH;
  if (saved.RETRY === undefined) delete process.env.FORGE_STATS_GH_RETRY_MS; else process.env.FORGE_STATS_GH_RETRY_MS = saved.RETRY;
});
beforeEach(() => plan({}));

const telemetry = (issue, eid) => `<!-- FORGE:TELEMETRY v1 -->\n\`\`\`jsonl\n${JSON.stringify({ v: 1, ts: iso(T0), repo: "o/r", issue, run: `r_${issue}`, eid, event: "phase_attempt", phase: "build" })}\n\`\`\``;
const node = (n, { pr = false, comments = [], updatedAt = iso(T0 + n * 60000), more = false } = {}) => ({
  __typename: pr ? "PullRequest" : "Issue", number: n, createdAt: iso(T0), closedAt: iso(T0 + DAY), updatedAt, milestone: n === 1 ? { title: "v1" } : null,
  labels: { nodes: n === 1 ? [{ name: "bug" }] : [] }, author: { __typename: n === 2 ? "Bot" : "User", login: "u" },
  comments: { pageInfo: { hasNextPage: more }, nodes: comments } });
const trusted = (issue, eid) => ({ body: telemetry(issue, eid), authorAssociation: "MEMBER", author: { __typename: "User", login: "m" } });
const untrusted = (issue, eid) => ({ body: telemetry(issue, eid), authorAssociation: "NONE", author: { __typename: "User", login: "mallory" } });
const store = (n, extra = {}) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, node(i + 1, {
  pr: (i + 1) % 10 === 0, comments: (i + 1) % 5 === 0 ? [trusted(i + 1, `e${i + 1}`), untrusted(i + 1, `x${i + 1}`)] : [], ...(extra[i + 1] ?? {}) })]));
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("defaultGh retries a 504 on the FORGE:GUARD search so --compounding gathers instead of aborting (#5530 compounding)", async () => {
  plan({ failures: [{ match: "^issue list", times: 1, stderr: "HTTP 504: Gateway Timeout (https://api.github.com/graphql)" }] });
  const r = await gatherCompounding({ repo: "o/r", gh: defaultGh, cwd: dir });
  assert.deepEqual(r.guards, []);
  assert.equal(calls().filter((a) => a[0] === "issue" && a[1] === "list").length, 2);
});

test("a non-transient error is not retried (#5530 non-transient)", async () => {
  plan({ failures: [{ match: "issues/1$", times: 9, stderr: "gh: Not Found (HTTP 404)" }] });
  await assert.rejects(defaultGh(["api", "repos/o/r/issues/1"]), /404/);
  assert.equal(calls().length, 1);
  plan({ failures: [{ match: "issues/1$", times: 9, stderr: "HTTP 503: Service Unavailable" }] });
  await assert.rejects(defaultGh(["api", "repos/o/r/issues/1"]), /503/);
  assert.equal(calls().length, 4, "4 attempts, then the 5xx is thrown");
});

test("defaultGh retry keeps the --depth defect column on a transient 504 (#5530 depth)", async () => {
  plan({ failures: [{ match: "search/issues", times: 1, stderr: "gh: HTTP 504: We couldn't respond to your request in time." }], replies: [{ match: ".", out: "" }] });
  const rows = [{ issue: 1, pr: 2, merged: true, endTs: iso(T0) }];
  const d = await gatherDefects({ repo: "o/r", gh: defaultGh, rows });
  assert.equal(d.get(1).defect, false);
  assert.equal(calls().filter((a) => a.some((x) => x.startsWith("search/issues"))).length, 2);
});

test("writes are never retried, even on a 5xx (#5530 write)", async () => {
  plan({ failures: [{ match: "^pr comment", times: 9, stderr: "HTTP 504: Gateway Timeout" }] });
  await assert.rejects(defaultGh(["pr", "comment", "5", "-R", "o/r", "--body", "x"]), /504/);
  assert.equal(calls().length, 1);
  const { isReadOnlyGh } = source;
  assert.equal(isReadOnlyGh(["api", "-X", "POST", "repos/o/r/issues"]), false);
  assert.equal(isReadOnlyGh(["api", "repos/o/r/issues/1/comments", "-f", "body=x"]), false);
  assert.equal(isReadOnlyGh(["api", "graphql", "-f", "query=mutation { x }"]), false);
  assert.equal(isReadOnlyGh(["api", "graphql", "-f", "query=query { x }", "-F", "first=10"]), true);
  assert.equal(isReadOnlyGh(["issue", "list", "-R", "o/r"]), true);
  assert.equal(isReadOnlyGh(["api", "--paginate", "repos/o/r/issues/1/events"]), true);
});

test("fetchGithubRecords numbers mode batches through GraphQL (#5530 batch)", async () => {
  plan({ store: store(50) });
  const r = await fetchGithubRecords({ repo: "o/r", gh: defaultGh, env: ENV, numbers: range(50), useCache: false });
  assert.ok(calls().length <= 3, `gh spawned ${calls().length} times`);
  assert.equal(r.items.length, 50);
  assert.deepEqual(r.records.map((x) => x.eid).sort(), range(10).map((i) => `e${i * 5}`).sort(), "only trusted telemetry");
  const one = r.items.find((i) => i.number === 1), ten = r.items.find((i) => i.number === 10), two = r.items.find((i) => i.number === 2);
  assert.deepEqual({ isPr: one.isPr, milestone: one.milestone, labels: one.labels, closedAt: one.closedAt }, { isPr: false, milestone: "v1", labels: ["bug"], closedAt: iso(T0 + DAY) });
  assert.equal(ten.isPr, true);
  assert.equal(two.authorType, "Bot");
});

test("an issue with over 100 comments falls back to the REST comments pages; a 5xx-failing batch is halved (#5530 batch)", async () => {
  plan({ store: store(20, { 7: { more: true } }), restComments: { 7: [{ body: telemetry(7, "late"), author_association: "OWNER", user: { type: "User", login: "o" } }] },
    failures: [{ match: "i1: issueOrPullRequest.*i20: issueOrPullRequest", times: 99, stderr: "HTTP 502: Bad Gateway" }] });
  const r = await fetchGithubRecords({ repo: "o/r", gh: defaultGh, env: ENV, numbers: range(20), useCache: false });
  assert.equal(r.items.length, 20);
  assert.ok(r.records.some((x) => x.eid === "late"));
  assert.ok(calls().some((a) => a.includes("repos/o/r/issues/7/comments")));
});

test("per-number cache keyed by updatedAt skips unchanged issues (#5530 cache)", async () => {
  const env = { ...ENV, FORGE_STATS_CACHE_DIR: join(dir, "cache") };
  plan({ store: store(50) });
  const first = await fetchGithubRecords({ repo: "o/r", gh: defaultGh, env, numbers: range(50) });
  plan({ store: store(50) });
  const second = await fetchGithubRecords({ repo: "o/r", gh: defaultGh, env, numbers: range(50) });
  assert.equal(calls().length, 1, "only the light updatedAt query");
  assert.deepEqual(second.records, first.records);
  assert.deepEqual(second.items, first.items);
  plan({ store: store(50, { 3: { updatedAt: iso(T0 + 9 * DAY), comments: [trusted(3, "new")] } }) });
  const third = await fetchGithubRecords({ repo: "o/r", gh: defaultGh, env, numbers: range(50) });
  assert.equal(calls().length, 2);
  assert.match(calls()[1].find((a) => a.startsWith("query=")), /i3: issueOrPullRequest/);
  assert.doesNotMatch(calls()[1].find((a) => a.startsWith("query=")), /i4: issueOrPullRequest/);
  assert.ok(third.records.some((x) => x.eid === "new"));
  const off = { ...ENV, FORGE_STATS_CACHE_DIR: join(dir, "cache-off") };
  plan({ store: store(5) });
  await fetchGithubRecords({ repo: "o/r", gh: defaultGh, env: off, numbers: range(5), useCache: false });
  assert.equal(existsSync(join(dir, "cache-off")), false);
});
