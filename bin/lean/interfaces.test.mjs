// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { sliceCount, checkInterfaces, freshDecisions, seedDecisions, writeContracts, consumerNotices, notifyConsumers, interfacesFromCli, decisionComment } from "./interfaces.mjs";
import { interfaceDecisions, interfaceRows, withDecisionRows, supersede, normaliseDecision, readDecisionIndex } from "./decisions.mjs";
import { precheck, applyAmendments } from "./conformance.mjs";
import { seamFailures } from "./seam.mjs";

const TABLE = (rows) => ["| Boundary | Signature or schema | Auth mode | Owner issue | Anchors | Consumers |", "|---|---|---|---|---|---|", ...rows].join("\n");
const SPIKE = (extra = "") => `## Stack\n**Rationale**: x\n\n## Milestone plan\n1. api\n2. web\n\n${extra}`;
const EPIC = (extra = "") => `## Goal\nShip search.\n\n## Slices\n- [ ] #11 api\n- [ ] #12 web\n\n${extra}`;
const IFACE = `## Interfaces\n\n${TABLE(["| web -> api | POST /v1/search | API key only, no session cookie | #11 | `provider:api/`, `consumer:web/` | #12, search-sdk |"])}\n\n**Rationale**: one boundary\n`;

describe("Interfaces section validation (#5338)", () => {
  it("counts slices: a spike's numbered Milestone plan, an epic's list items", () => {
    assert.equal(sliceCount(SPIKE()), 2);
    assert.equal(sliceCount(EPIC()), 2);
    assert.equal(sliceCount(`## Slices\n1. one\n2. two\n3. three\n`), 3);
    assert.equal(sliceCount("## Goal\n- [ ] #1 a\n- [ ] #2 b\n"), 2);
    assert.equal(sliceCount("## Goal\nno list"), 0);
  });
  it("a spike or an epic with two or more slices and no Interfaces section fails; one slice, or a section, passes", () => {
    for (const [body, kind] of [[SPIKE(), "spike"], [EPIC(), "epic"]]) {
      const r = checkInterfaces(body, { kind });
      assert.equal(r.ok, false, kind);
      assert.match(r.problems[0], /no `## Interfaces` section: 2 slices/);
      assert.equal(checkInterfaces(body + IFACE, { kind }).ok, true, kind);
      assert.equal(checkInterfaces(body, { kind: "auto" }).ok, false);
    }
    assert.equal(checkInterfaces("## Slices\n- [ ] #1 only\n", { kind: "epic" }).ok, true);
    assert.equal(checkInterfaces("## Goal\nx").required, false);
  });
  it("the section needs a Rationale line, and an epic needs a real boundary row (a placeholder row does not count)", () => {
    assert.match(checkInterfaces(EPIC("## Interfaces\n" + TABLE(["| a -> b | f(x) | key | #1 | `p/` | |"])), { kind: "epic" }).problems[0], /no \*\*Rationale\*\*/);
    const ph = EPIC(`## Interfaces\n${TABLE(["| {web -> api} | {POST /x} | {key} | {issue} | `{provider:a/}` | {#n} |"])}\n\n**Rationale**: r\n`);
    assert.match(checkInterfaces(ph, { kind: "epic" }).problems[0], /no boundary row/);
    assert.equal(checkInterfaces(SPIKE(`## Interfaces\n${TABLE(["| {a} | {b} | {c} | {d} | `{e}` | |"])}\n\n**Rationale**: r\n`), { kind: "spike" }).ok, true, "the spike template ships a placeholder row");
  });
  it("notes a machine-form signature that declares no sides (no contract test can be generated)", () => {
    const body = EPIC(`## Interfaces\n${TABLE(["| a -> b | POST /v1/x | key | #1 | `api/` | |"])}\n\n**Rationale**: r\n`);
    assert.deepEqual(checkInterfaces(body, { kind: "epic" }).unchecked, ["a -> b"]);
    assert.deepEqual(checkInterfaces(EPIC(IFACE), { kind: "epic" }).unchecked, []);
  });
  it("rows are read by header name: a five-column table without Consumers still parses", () => {
    const rows = interfaceRows(`## Interfaces\n| Boundary | Signature or schema | Auth mode | Owner issue | Anchors |\n|--|--|--|--|--|\n| a -> b | refund(id) | key | #3 | \`provider:w/\`, \`consumer:a/\` |\n`);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].consumers, []);
    assert.equal(rows[0].seam.kind, "symbol");
    assert.deepEqual(interfaceRows(EPIC(IFACE))[0].consumers, ["#12", "search-sdk"]);
  });
});

describe("registering a spike or epic's interfaces in the decision register (#5338)", () => {
  const idx = () => { const dir = tmpDir("ifc-"); process.env.FORGEDOCK_DECISIONS_DIR = dir; return dir; };
  it("an epic's Interfaces row and anchored architecture choice are posted once per id and indexed; a lane on the anchors gets the preserve row", () => {
    idx();
    const body = EPIC(`## Auth\n**Rationale**: keys everywhere\n**Anchors**: \`api/auth/\`\n\n${IFACE}`);
    const posts = [];
    const first = seedDecisions({ text: body, issue: 40, repo: "o/r", comments: [], post: (b) => posts.push(b) });
    assert.deepEqual(first.map((d) => d.id), ["i40-1", "i40-2"]);
    assert.match(posts[0], /^<!-- FORGE:DECISION \{/);
    assert.match(posts[1], /Interface web -> api: POST \/v1\/search; auth API key only, no session cookie; owner #11/);
    const again = seedDecisions({ text: body, issue: 40, repo: "o/r", comments: posts, post: (b) => posts.push(b) });
    assert.deepEqual(again, [], "idempotent on resume");
    assert.equal(posts.length, 2);
    const recs = readDecisionIndex("o/r");
    assert.equal(recs.length, 2);
    assert.deepEqual(recs[1].consumers, ["#12", "search-sdk"]);
    assert.equal(recs[1].seam.kind, "route");
    const lane = withDecisionRows({ deliverables: [{ id: "D1", path: "web/app/api/search/route.ts" }], preserve: [] }, recs);
    assert.deepEqual(lane.preserve.map((p) => [p.source, p.decision]), [["decision", "i40-2"]]);
    assert.match(lane.preserve[0].what, /POST \/v1\/search/);
    assert.deepEqual(freshDecisions({ text: body, issue: 40, comments: [decisionComment(first[0])] }).map((d) => d.id), ["i40-2"]);
  });
  it("CLI: check exits 1 for the missing section and 0 with it; register posts via gh once; contract writes the test for machine-form rows", async () => {
    const dir = idx(); const out = [];
    const files = { "epic.md": EPIC(), "ok.md": EPIC(IFACE) };
    const deps = { print: (t) => out.push(t), readFile: (f) => files[f] };
    assert.equal(await interfacesFromCli(["check", "--body-file", "epic.md", "--kind", "epic"], deps), 1);
    assert.match(out.at(-1), /interfaces: no `## Interfaces` section/);
    assert.equal(await interfacesFromCli(["check", "--body-file", "ok.md", "--kind", "epic"], deps), 0);
    const calls = [];
    const gh = async (a, input) => { calls.push([a, input]); return a[1] === "view" ? JSON.stringify({ comments: calls.filter((c) => c[0][1] === "comment").map((c) => ({ body: c[1] })) }) : ""; };
    assert.equal(await interfacesFromCli(["register", "--issue", "40", "--body-file", "ok.md", "--repo", "o/r"], { ...deps, gh }), 0);
    assert.equal(calls.filter((c) => c[0][1] === "comment").length, 1);
    assert.match(out.at(-1), /registered 1 decision\(s\) on #40: i40-1/);
    await interfacesFromCli(["register", "--issue", "40", "--body-file", "ok.md", "--repo", "o/r"], { ...deps, gh });
    assert.equal(calls.filter((c) => c[0][1] === "comment").length, 1, "re-run posts nothing");
    assert.match(out.at(-1), /already present/);
    await assert.rejects(() => interfacesFromCli(["register", "--body-file", "ok.md"], deps), /usage/);
    const o = join(dir, "contracts");
    assert.equal(await interfacesFromCli(["contract", "--issue", "40", "--body-file", "ok.md", "--out", o], deps), 0);
    assert.ok(existsSync(join(o, "seam-check.mjs")) && existsSync(join(o, "i40-1.contract.test.mjs")));
    assert.match(readFileSync(join(o, "i40-1.contract.test.mjs"), "utf8"), /"kind": "route"/);
    assert.deepEqual(writeContracts({ text: EPIC(), issue: 1, outDir: join(dir, "none") }), { written: [], skipped: [] });
  });
});

describe("a superseded interface tells its consumers (#5338)", () => {
  const old = normaliseDecision({ id: "i40-1", choice: "Interface web -> api: POST /v1/search", anchors: ["api/", "web/"], issue: 40, consumers: ["#12", "#13", "search-sdk"] });
  const rec = supersede(old, normaliseDecision({ id: "d41-1", choice: "Interface web -> api: POST /v2/search", why: "v2", anchors: ["api/", "web/"], issue: 41 })).next;
  it("the new record inherits the consumers; none for a decision that supersedes nothing", () => {
    assert.deepEqual(rec.consumers, ["#12", "#13", "search-sdk"]);
    assert.deepEqual(consumerNotices(rec).map((n) => [n.consumer, n.issue]), [["#12", 12], ["#13", 13], ["search-sdk", null]]);
    assert.deepEqual(consumerNotices({ ...rec, supersedes: undefined }), []);
  });
  it("closed consumers are reopened, open ones commented, a named consumer gets one new issue; idempotent on a re-run", async () => {
    const calls = [], comments = { 12: [], 13: [] };
    const gh = async (a) => {
      calls.push(a.join(" "));
      if (a[0] === "issue" && a[1] === "view") return JSON.stringify({ state: a[2] === "12" ? "CLOSED" : "OPEN", comments: (comments[a[2]] ?? []).map((body) => ({ body })) });
      if (a[0] === "issue" && a[1] === "comment") { comments[a[2]].push(a[a.indexOf("--body") + 1]); return ""; }
      if (a[0] === "issue" && a[1] === "list") return JSON.stringify(calls.some((c) => c.startsWith("issue create")) ? [{ number: 99 }] : []);
      if (a[0] === "issue" && a[1] === "create") return "https://github.com/o/r/issues/99\n";
      return "";
    };
    const first = await notifyConsumers({ rec, pr: 77, repo: "o/r", gh });
    assert.deepEqual(first.map((x) => [x.consumer, x.action, x.issue]), [["#12", "reopened", 12], ["#13", "notified", 13], ["search-sdk", "filed", 99]]);
    assert.ok(calls.includes("issue reopen 12 -R o/r") && !calls.includes("issue reopen 13 -R o/r"));
    assert.ok(calls.some((c) => c.startsWith("issue edit 12") && c.includes("--remove-label workflow:merged")));
    assert.match(comments[12][0], /FORGE:INTERFACE_CHANGED decision=d41-1 consumer=#12/);
    assert.match(comments[12][0], /supersedes `i40-1` \(PR #77\)/);
    const second = await notifyConsumers({ rec, pr: 77, repo: "o/r", gh });
    assert.deepEqual(second.map((x) => x.action), ["reopened", "notified", "exists"]);
    assert.equal(comments[12].length, 1, "one notice per consumer");
    assert.equal(calls.filter((c) => c.startsWith("issue create")).length, 1);
  });
  it("a failing consumer is reported, never thrown", async () => {
    const r = await notifyConsumers({ rec, repo: "o/r", gh: async () => { throw new Error("HTTP 500"); } });
    assert.deepEqual(r.map((x) => x.action), ["failed", "failed", "failed"]);
  });
});

describe("replay: the audit's interface mismatches are flagged at lane review, not at release review (#5338)", () => {
  // The spike rows the architecture would have carried (AlterLab Search/Hands): the refund primitive, the web proxy auth
  // mode (#39210, #39569) and the device/city/uule payload (worker BUG-1).
  const spike = `${SPIKE()}## Interfaces\n\n${TABLE([
    "| research -> refund primitive | refund(job_id, amount_micro) | internal | #101 | `provider:worker/refund.py`, `consumer:api/research/` | #102 |",
    "| web proxy -> API | POST /v1/search | API key only, no session cookie or JWT | #103 | `provider:api/routes/`, `consumer:web/app/api/` | #104 |",
    "| API -> worker | queue search.jobs {query, device, city, uule} | internal | #105 | `provider:worker/handlers/`, `consumer:api/search/` | |",
  ])}\n\n**Rationale**: each boundary is a contract\n`;
  const recs = interfaceDecisions(spike, { issue: 100 });
  const base = {
    "worker/refund.py": "async def refund(job_id: str, amount_micro: int) -> None:\n    ...\n",
    "api/research/run.py": "await refund(job.id, amount_micro=cost)\n",
    "api/routes/search.py": "@router.post('/v1/search')\nasync def search(): ...\n",
    "web/app/api/search/route.ts": "export async function POST() { return fetch(`${API}/v1/search`, { headers: { 'x-api-key': KEY } }); }\n",
    "worker/handlers/search.py": "def handle(j): return j['query'], j['device'], j['city'], j['uule']\n",
    "api/search/enqueue.py": "enqueue({'query': q, 'device': d, 'city': c, 'uule': u})\n",
  };
  const lane = (changes) => {
    const files = { ...base, ...changes };
    const changed = Object.keys(changes);
    const contract = withDecisionRows({ requirements: [], deliverables: changed.map((p, i) => ({ id: `D${i + 1}`, path: p })), preserve: [] }, recs);
    const seam = seamFailures({ records: recs, changedFiles: changed, list: () => Object.keys(files), read: (p) => files[p] });
    return { contract, seam, pc: precheck({ contract: { ...contract, deliverables: [] }, result: { requirements: [], validation: [], preserve: [] }, changedFiles: changed, ignore: changed, seamFailures: seam }) };
  };
  it("the baseline repo is clean: every seam row has a contract", () => {
    assert.equal(recs.filter((r) => r.seam).length, 3);
    assert.deepEqual(lane({ "worker/refund.py": base["worker/refund.py"] }).seam, []);
  });
  it("refund signature drift: flagged on the lane that changes the primitive, with the row as a preserve item", () => {
    const l = lane({ "worker/refund.py": "async def refund(job_id: str) -> None:\n    ...\n" });
    assert.ok(l.contract.preserve.some((p) => p.source === "decision" && /refund\(job_id, amount_micro\)/.test(p.what)));
    assert.deepEqual(l.seam.map((f) => f.kind), ["interface_seam"]);
    assert.match(l.seam[0].detail, /refund\(job_id\) does not match the declared refund\(job_id, amount_micro\)/);
    assert.equal(l.pc.ok, false);
    assert.ok(l.pc.failures.some((f) => f.kind === "interface_seam"));
  });
  it("cookie vs API key: a web proxy that forwards the session cookie to the API-key-only route is flagged at lane review", () => {
    const l = lane({ "web/app/api/search/route.ts": "export async function POST(req) { return fetch(`${API}/v1/search`, { headers: { cookie: req.headers.get('cookie') ?? '' } }); }\n" });
    assert.ok(l.seam.length >= 1);
    assert.match(l.seam[0].detail, /web\/app\/api\/search\/route\.ts:1.*Cookie header/);
    assert.ok(l.pc.failures.some((f) => f.kind === "interface_seam" && f.code === "conformance.preserve_violated"));
  });
  it("dropped payload fields: the handler that stops reading device/city/uule is flagged", () => {
    const l = lane({ "worker/handlers/search.py": "def handle(j): return j['query']\n" });
    assert.deepEqual(l.seam.map((f) => /field "(\w+)"/.exec(f.detail)[1]), ["device", "city", "uule"]);
  });
  it("changing an interface on purpose needs a supersedes decision, which retires the row and the seam check", () => {
    const changes = { "worker/refund.py": "async def refund(job_id: str) -> None:\n    ...\n" };
    const files = { ...base, ...changes };
    const a = applyAmendments({ requirements: [{ id: "R1", quote: "q", disposition: "deliver" }], deliverables: [{ id: "D1", path: "worker/refund.py" }], preserve: withDecisionRows({ deliverables: [{ id: "D1", path: "worker/refund.py" }], preserve: [] }, recs).preserve }, [{ kind: "decision", why: "refund is job-scoped now", decision: { choice: "Interface research -> refund: refund(job_id)", anchors: ["worker/refund.py"], supersedes: "i100-1" } }], "q", { baseFiles: Object.keys(files) });
    assert.deepEqual(a.problems, []);
    assert.equal(a.contract.preserve.some((p) => p.decision === "i100-1"), false);
    assert.deepEqual(seamFailures({ records: recs, changedFiles: Object.keys(changes), list: () => Object.keys(files), read: (p) => files[p], superseded: a.decisions.map((d) => d.supersedes).filter(Boolean) }), []);
  });
});
