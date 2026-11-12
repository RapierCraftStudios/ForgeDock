// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parseSeamForm, roleAnchors, buildSeam, seamContract, renderSeamTest, seamFailures, checkSeam, authMode } from "./seam.mjs";
import { anchorMatches } from "./decisions.mjs";
import { anchorMatches as checkerAnchorMatches } from "../../templates/contracts/seam-check.mjs";
import { normaliseDecision } from "./decisions.mjs";

const io = (files) => ({ list: () => Object.keys(files), read: (p) => files[p] });
const contract = (o) => ({ v: 1, id: "i1-1", boundary: "b", auth: "", ...o });

describe("seam forms (#5338)", () => {
  it("parses a route, a function signature and a typed payload; prose has no machine form", () => {
    assert.deepEqual(parseSeamForm("`POST /v1/search/{id}`"), { kind: "route", route: { method: "POST", path: "/v1/search/{id}" } });
    assert.deepEqual(parseSeamForm("refund(job_id: str, amount_micro: int, *, reason=None)").symbol, { name: "refund", params: [{ name: "job_id", optional: false, variadic: false }, { name: "amount_micro", optional: false, variadic: false }, { name: "reason", optional: true, variadic: false }] });
    assert.equal(parseSeamForm("billing.refund(a)").symbol.name, "refund");
    assert.deepEqual(parseSeamForm("queue research.jobs {query, device?: string, city}").payload.fields, ["query", "device", "city"]);
    assert.equal(parseSeamForm("a JSON document with the results"), null);
  });
  it("roles: provider:/consumer: prefixes set the side, a bare anchor is governed but on neither; a seam needs both sides", () => {
    const r = roleAnchors(["provider:worker/", "consumer:api/", "shared/"]);
    assert.deepEqual(r.all, ["worker/", "api/", "shared/"]);
    assert.deepEqual(r.provider, ["worker/"]);
    assert.deepEqual(r.consumer, ["api/"]);
    assert.equal(buildSeam(parseSeamForm("POST /x"), roleAnchors(["provider:a/"]), "k"), null);
    assert.equal(buildSeam(null, r, "k"), null);
    assert.equal(buildSeam(parseSeamForm("POST /x"), r, "k").kind, "route");
  });
  it("the checker's anchor rule is the register's (parity)", () => {
    for (const [a, p] of [["src/a.js", "src/a.js"], ["src/a/", "src/a/b.js"], ["src/**", "src/a/b.js"], ["src/*.js", "src/a/b.js"], ["src/a", "src/a/b.js"], ["./x/", "x/y"], ["", "x"]]) assert.equal(checkerAnchorMatches(a, p), anchorMatches(a, p), `${a} ${p}`);
  });
  it("auth mode: an API key with a negated session is api-key; a session is not", () => {
    assert.equal(authMode("API key only, no session cookie"), "api-key");
    assert.equal(authMode("x-api-key header"), "api-key");
    assert.equal(authMode("session cookie or API key"), "session");
    assert.equal(authMode("internal"), "other");
  });
});

describe("seam checker: the three mismatches the audit found (#5338)", () => {
  const refund = contract({ kind: "symbol", symbol: parseSeamForm("refund(job_id, amount_micro)").symbol, provider: ["worker/"], consumer: ["api/"] });
  it("symbol: a refund primitive with the wrong signature, and a call that does not fit, are findings; a matching pair is clean", () => {
    const bad = io({ "worker/refund.py": "async def refund(self, job_id: str) -> None:\n    ...\n", "api/research.py": "await refund(job.id, amount_micro=5)\nawait refund(job.id, 5, 6)\n" });
    const r = checkSeam(refund, bad);
    assert.deepEqual(r.findings.map((f) => [f.side, f.file, f.line]), [["provider", "worker/refund.py", 1], ["consumer", "api/research.py", 2]]);
    assert.match(r.findings[0].detail, /TypeError/);
    assert.match(r.findings[1].detail, /too many arguments/);
    const good = io({ "worker/refund.py": "async def refund(job_id: str, amount_micro: int, *, reason=None):\n    ...\n", "api/research.py": "await refund(job.id, amount_micro=5)\nawait refund(job.id, 7)\n", "api/other.py": "refund(**kw)\n" });
    assert.deepEqual(checkSeam(refund, good).findings, []);
    assert.match(checkSeam(refund, io({ "worker/x.py": "pass", "api/y.py": "pass" })).findings[0].detail, /no definition of refund/);
  });
  it("symbol: TypeScript functions, arrow bindings and methods are definitions", () => {
    const c = contract({ kind: "symbol", symbol: parseSeamForm("charge(id, cents)").symbol, provider: ["lib/"], consumer: ["app/"] });
    for (const def of ["export async function charge(id: string, cents: number) {}", "export const charge = async (id: string, cents: number) => {}", "class B {\n  async charge(id: string, cents: number): Promise<void> {}\n}"]) {
      assert.deepEqual(checkSeam(c, io({ "lib/a.ts": def, "app/b.ts": "await charge(a, 3)" })).findings, [], def);
    }
    assert.equal(checkSeam(c, io({ "lib/a.ts": "export function charge(id: string) {}", "app/b.ts": "charge(a, 3)" })).findings.length, 1);
  });
  it("route: a web proxy that forwards the session cookie / JWT to an API-key-only route is flagged, one that sends the key is clean", () => {
    const route = contract({ kind: "route", auth: "API key only, no session cookie", route: { method: "POST", path: "/v1/search" }, provider: ["api/"], consumer: ["web/"] });
    const api = { "api/routes.py": "@router.post('/v1/search')\nasync def search(): ...\n" };
    const cookie = checkSeam(route, io({ ...api, "web/app/api/search/route.ts": "export async function POST(req) {\n  return fetch(`${API}/v1/search`, { headers: { cookie: req.headers.get('cookie') } });\n}" }));
    assert.deepEqual(cookie.findings.map((f) => f.side), ["consumer", "consumer"]);
    assert.match(cookie.findings[0].detail, /Cookie header/);
    assert.match(cookie.findings[1].detail, /never sends one/);
    const jwt = checkSeam(route, io({ ...api, "web/lib/s.ts": "const session = await getServerSession();\nfetch(`${API}/v1/search`, { headers: { Authorization: `Bearer ${session.accessToken}` } })" }));
    assert.ok(jwt.findings.some((f) => /session token|session JWT/.test(f.detail)));
    assert.deepEqual(checkSeam(route, io({ ...api, "web/lib/s.ts": "fetch(`${API}/v1/search`, { headers: { 'x-api-key': process.env.ALTERLAB_API_KEY } })" })).findings, []);
    assert.match(checkSeam(route, io({ "api/other.py": "pass", "web/x.ts": "pass" })).findings[0].detail, /no handler for POST \/v1\/search/);
    const next = checkSeam(contract({ ...route, route: { method: "GET", path: "/v1/jobs/{id}" } }), io({ "api/v1/jobs/[id]/route.ts": "export async function GET() {}", "web/a.ts": "x" }));
    assert.deepEqual(next.findings, []);
  });
  it("payload: fields the API accepts and the worker handler drops are flagged on the side that drops them", () => {
    const p = contract({ kind: "payload", payload: parseSeamForm("queue research.jobs {query, device, city, uule}").payload, provider: ["worker/"], consumer: ["api/"] });
    const r = checkSeam(p, io({ "worker/handler.py": "def handle(job):\n    return job['query'], job['device']\n", "api/search.py": "enqueue({'query': q, 'device': d, 'city': c, 'uule': u})\n" }));
    assert.deepEqual(r.findings.map((f) => [f.side, /"(\w+)"/.exec(f.detail)[1]]), [["provider", "city"], ["provider", "uule"]]);
    assert.deepEqual(checkSeam(p, io({ "worker/handler.py": "job['query'] job['device'] job['city'] job['uule']", "api/search.py": "query device city uule" })).findings, []);
  });
  it("a side with no source files is unchecked, never a silent pass", () => {
    assert.match(checkSeam(refund, io({ "worker/refund.py": "def refund(job_id, amount_micro): ..." })).unchecked, /consumer anchors/);
  });
});

describe("seamFailures at lane review and the generated contract test (#5338)", () => {
  const rec = normaliseDecision({ id: "i9-1", choice: "Interface api -> worker: refund(job_id, amount_micro)", anchors: ["worker/", "api/"], issue: 9, seam: { kind: "symbol", auth: "internal", symbol: parseSeamForm("refund(job_id, amount_micro)").symbol, provider: ["worker/"], consumer: ["api/"] } });
  const files = { "worker/refund.py": "def refund(job_id): ...", "api/r.py": "refund(a, b)", "docs/a.md": "x" };
  it("flags a mismatch only when the lane touches the anchors, and not for a superseded record", () => {
    assert.ok(rec.seam);
    const f = seamFailures({ records: [rec], changedFiles: ["worker/refund.py"], ...io(files) });
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "interface_seam");
    assert.equal(f[0].code, "conformance.preserve_violated");
    assert.match(f[0].detail, /i9-1.*worker\/refund\.py:1.*supersedes:"i9-1"/);
    assert.deepEqual(seamFailures({ records: [rec], changedFiles: ["docs/a.md"], ...io(files) }), []);
    assert.deepEqual(seamFailures({ records: [rec], changedFiles: ["worker/refund.py"], superseded: ["i9-1"], ...io(files) }), []);
    assert.deepEqual(seamFailures({ records: [{ ...rec, status: "superseded" }], changedFiles: ["worker/refund.py"], ...io(files) }), []);
  });
  it("the generated test file runs under node --test and fails for a broken seam, passes for a sound one (nothing mocked)", () => {
    const root = tmpDir("seam-");
    const write = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
    spawnSync("git", ["init", "-q"], { cwd: root });
    write("contracts/seam-check.mjs", spawnSync("cat", [new URL("../../templates/contracts/seam-check.mjs", import.meta.url).pathname], { encoding: "utf8" }).stdout);
    write("contracts/i9-1.contract.test.mjs", renderSeamTest(seamContract(rec)));
    for (const [rel, t] of Object.entries(files)) write(rel, t);
    const run = () => spawnSync(process.execPath, ["--test", "contracts/i9-1.contract.test.mjs"], { cwd: root, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")) });
    const red = run();
    assert.notEqual(red.status, 0);
    assert.match(red.stdout + red.stderr, /provider and consumer disagree on i9-1/);
    write("worker/refund.py", "def refund(job_id, amount_micro): ...");
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
  });
});
