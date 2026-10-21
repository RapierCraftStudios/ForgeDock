// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * End-to-end conformance gate on a disposable REAL git repository: a bare origin with main + staging, a clone,
 * lane worktrees, real commits, diffs, test runs and --no-ff merges into staging. GitHub is in-memory. The builder
 * makes real code edits; the reviewer is an oracle that derives every row from the real worktree (or a generic PASS).
 * Fixture: a small service whose routes leak a spend reservation on 429; issue #101 asks for three routes fixed or
 * tracked, the 429 re-thrown unchanged, a regression test, and billing pricing unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpDir } from "../tests/_tmp.mjs";
import { runCore } from "./lean.mjs";
import { readLog } from "../engine/runlog.mjs";
import { runCheckCommand } from "./effects.mjs";
import { checkFromCli } from "../engine-cli.mjs";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (args, cwd) => { try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV }); } catch (e) { throw Object.assign(new Error(`git ${args.join(" ")}: ${e.stderr || e.message}`), { stderr: String(e.stderr ?? "") }); } };
const HAVE_GIT = spawnSync("git", ["--version"]).status === 0;
const writeAll = (root, files) => { for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); } };

// ---- fixture ----
const Q = {
  R1: "The scrape route must release the spend reservation when the rate limiter rejects the request.",
  R2: "The search route must release the spend reservation when the rate limiter rejects the request.",
  R3: "The export route has the same leak and must be fixed or tracked in a follow-up issue.",
  R4: "The original 429 error must be re-thrown unchanged (status 429 and retryAfter preserved).",
  AC1: "A regression test shows outstanding reservations return to 0 after a 429 on each fixed route.",
  AC2: "Existing route tests still pass.",
  AC3: "Billing pricing is unchanged.",
};
const ISSUE = { number: 101, title: "429 from the rate limiter leaks the spend reservation in scrape, search and export",
  body: `## Problem\nWhen the per-user rate limiter rejects a request with 429, the scrape, search and export routes have already reserved spend and never release it.\n\n## Requirements\n1. ${Q.R1}\n2. ${Q.R2}\n3. ${Q.R3}\n4. ${Q.R4}\n\n## Acceptance Criteria\n- [ ] ${Q.AC1}\n- [ ] ${Q.AC2}\n- [ ] ${Q.AC3}` };
const FN = { scrape: "scrape", search: "search", export: "exportData" };
const route = (r, fixed) => `import { reserve, ${fixed ? "release, " : ""}settle } from "../quota.js";\nimport { check } from "../ratelimit.js";\n\nexport async function ${FN[r]}(req, limits) {\n  const id = reserve(req.user, 1);\n${fixed ? "  try {\n    check(req.user, limits);\n  } catch (e) {\n    release(id);\n    throw e;\n  }" : "  check(req.user, limits);"}\n  settle(id);\n  return { ok: true, ${r}: req.q };\n}\n`;
const BILLING = "export function price(units) { return units * 0.01; }\n";
const BASE = {
  "package.json": `{ "name": "fixture-svc", "type": "module", "private": true }\n`,
  "src/quota.js": "const r = new Map();\nlet n = 1;\nexport function reserve(user, amount) { const id = n++; r.set(id, { user, amount }); return id; }\nexport function release(id) { return r.delete(id); }\nexport function settle(id) { return r.delete(id); }\nexport function outstanding() { return r.size; }\nexport function _reset() { r.clear(); n = 1; }\n",
  "src/ratelimit.js": "export class RateLimited extends Error { constructor(s) { super(\"rate limited\"); this.status = 429; this.retryAfter = s; } }\nexport function check(user, limits) { if ((limits[user] ?? 1) <= 0) throw new RateLimited(30); limits[user] = (limits[user] ?? 1) - 1; }\n",
  "src/billing.js": BILLING,
  "src/routes/scrape.js": route("scrape", false), "src/routes/search.js": route("search", false), "src/routes/export.js": route("export", false),
  "test/routes.test.js": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { scrape } from "../src/routes/scrape.js";\nimport { price } from "../src/billing.js";\ntest("scrape answers under the limit", async () => assert.deepEqual(await scrape({ user: "u", q: "a" }, { u: 3 }), { ok: true, scrape: "a" }));\ntest("price", () => assert.equal(price(150), 1.5));\n`,
};
const leakTest = (rs) => `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { outstanding, _reset } from "../src/quota.js";\n${rs.map((r) => `import { ${FN[r]} } from "../src/routes/${r}.js";`).join("\n")}\nfor (const [n, fn] of [${rs.map((r) => `["${r}", ${FN[r]}]`).join(", ")}]) test(\`\${n}: 429 releases and re-throws\`, async () => { _reset(); await assert.rejects(fn({ user: "u", q: "x" }, { u: 0 }), (e) => e.status === 429 && e.retryAfter === 30); assert.equal(outstanding(), 0); });\n`;
const V1 = "node --test test/routes.test.js test/leak.test.js"; // explicit files: Node 26 rejects directory args to --test

const D = { R1: { id: "D1", path: "src/routes/scrape.js", change: "release on 429", requirements: ["R1", "R4"] }, R2: { id: "D2", path: "src/routes/search.js", change: "release on 429", requirements: ["R2", "R4"] },
  R3: { id: "D3", path: "src/routes/export.js", change: "release on 429", requirements: ["R3", "R4"] }, R5: { id: "D4", path: "test/leak.test.js", change: "regression test", requirements: ["R5"] } };
const req = (id, disposition = "deliver", extra = {}) => ({ id, quote: Q[id === "R5" ? "AC1" : id], disposition, ...extra });
const contract = (reqs) => ({ requirements: reqs, deliverables: reqs.filter((r) => r.disposition === "deliver" && D[r.id]).map((r) => D[r.id]),
  preserve: [{ id: "P1", what: `${Q.AC3} (src/billing.js price())` }, { id: "P2", what: `${Q.AC2} (test/routes.test.js)` }], validate: [{ id: "V1", command: V1 }] });
const FULL = () => contract([req("R1"), req("R2"), req("R3"), req("R4"), req("R5")]);
const OMIT = () => contract([req("R1"), req("R2"), req("R4"), req("R5")]);
const DEFER = () => contract([req("R1"), req("R2"), req("R3", "defer", { why: "export.js ships on the data-export module's own release train" }), req("R4"), req("R5")]);

// ---- world ----
function makeWorld(dir, script) {
  const origin = path.join(dir, "origin.git"), repo = path.join(dir, "repo"), merger = path.join(dir, "merger");
  git(["init", "-q", "--bare", "-b", "main", origin], dir);
  git(["clone", "-q", origin, repo], dir);
  writeAll(repo, BASE);
  git(["add", "-A"], repo); git(["commit", "-q", "-m", "base"], repo);
  git(["push", "-q", "origin", "main"], repo); git(["push", "-q", "origin", "main:staging"], repo); git(["fetch", "-q", "origin"], repo);
  git(["clone", "-q", origin, merger], dir);
  const gh = { issues: { 101: { ...ISSUE, state: "OPEN", reason: null, labels: new Set(), comments: [] } }, next: 200, prs: [] };
  const counts = { builder: 0, reviewer: 0 };
  const tools = (wt) => ({
    write: (files) => writeAll(wt, files),
    lean: (name, v) => writeAll(wt, { [`.forge-lean/${name}`]: typeof v === "string" ? v : JSON.stringify(v) }),
    commit: (m) => { git(["add", "-A"], wt); if (git(["status", "--porcelain"], wt).trim()) git(["commit", "-q", "-m", m], wt); },
    restore: (p) => git(["checkout", "origin/staging", "--", p], wt),
    run: (cmd) => spawnSync("sh", ["-c", cmd], { cwd: wt, encoding: "utf8" }).status,
    changed: () => git(["diff", "--name-only", "origin/staging...HEAD"], wt).trim().split("\n").filter(Boolean),
  });
  const io = {
    gh: async (a) => {
      const k = a.slice(0, 2).join(" "), n = Number(a[2]), val = (f) => a[a.indexOf(f) + 1];
      if (a[0] === "api") return "";
      if (k === "repo view") return "main\n";
      if (k === "issue view" && a.includes("milestone")) return JSON.stringify({ milestone: null });
      if (k === "issue view") { const i = gh.issues[n]; return JSON.stringify({ number: i.number, title: i.title, body: i.body, state: i.state, comments: [] }); }
      if (k === "issue comment") { gh.issues[n].comments.push(val("--body")); return `https://github.com/o/r/issues/${n}#c${gh.issues[n].comments.length}\n`; }
      if (k === "issue edit") { for (let i = 0; i < a.length; i++) { if (a[i] === "--add-label") a[i + 1].split(",").forEach((l) => gh.issues[n].labels.add(l)); if (a[i] === "--remove-label") a[i + 1].split(",").forEach((l) => gh.issues[n].labels.delete(l)); } return ""; }
      if (k === "issue close") { Object.assign(gh.issues[n], { state: "CLOSED", reason: val("--reason") }); return ""; }
      if (k === "pr list") return "[]";
      if (k === "pr create") { const p = { number: 300 + gh.prs.length, base: val("--base"), head: val("--head"), body: val("--body"), state: "OPEN" }; gh.prs.push(p); return `https://github.com/o/r/pull/${p.number}\n`; }
      if (k === "pr view") return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (k === "pr merge") {
        const p = gh.prs.find((x) => x.number === n);
        git(["fetch", "-q", "origin"], merger);
        assert.ok(git(["rev-parse", `origin/${p.head}`], merger).startsWith(val("--match-head-commit").slice(0, 12)), "merges only the reviewed head");
        git(["checkout", "-q", "-B", p.base, `origin/${p.base}`], merger);
        git(["merge", "-q", "--no-ff", "-m", `Merge PR #${n}`, `origin/${p.head}`], merger);
        git(["push", "-q", "origin", p.base], merger);
        p.state = "MERGED"; return "";
      }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async (args, { cwd } = {}) => git(args, cwd ?? repo),
    runner: async (c) => {
      const n = ++counts[c.role];
      const text = c.role === "builder" ? (await script.builder(n, c, tools(c.cwd)), "done") : script.reviewer(n, c);
      return { text, sessionId: "sess-1", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0, durationMs: 1, turns: 1, model: "m" };
    },
    transitionLabel: async (n, st) => { const i = gh.issues[n]; for (const l of [...i.labels]) if (l.startsWith("workflow:")) i.labels.delete(l); i.labels.add(`workflow:${st}`); },
    requiredChecks: async () => [],
    fileFollowups: async ({ parent, items }) => { // stands in for scripts/file-deferred-followups.sh: ONE batched issue per parent
      let f = Object.values(gh.issues).find((i) => i.parent === parent);
      if (!f) { f = { number: gh.next++, parent, title: `Follow-up from #${parent}`, body: "", state: "OPEN", labels: new Set(), comments: [], items: [] }; gh.issues[f.number] = f; }
      for (const it of items) if (!f.items.includes(it.key)) f.items.push(it.key);
      return Object.fromEntries(items.map((i) => [i.key, f.number]));
    },
    fs: { read: async (p) => fs.readFileSync(p, "utf8"), stat: async (p) => fs.statSync(p), append: async (p, t) => fs.appendFileSync(p, t), write: async (p, t) => fs.writeFileSync(p, t),
      exists: async (p) => fs.existsSync(p), rmdir: async (p) => fs.rmSync(p, { recursive: true, force: true }) },
  };
  const observe = (ret) => {
    git(["fetch", "-q", "origin"], merger);
    const staged = (p) => git(["show", `origin/staging:${p}`], merger);
    const i = gh.issues[101], pr = gh.prs[0];
    return { ret, issue: i, pr, counts, followups: Object.values(gh.issues).filter((x) => x.number !== 101),
      markers: i.comments.map((c) => /<!-- (FORGE:[A-Z_]+)/.exec(c)?.[1]),
      staging: { search: staged("src/routes/search.js").includes("release(id)"), export: staged("src/routes/export.js").includes("release(id)"), billingChanged: staged("src/billing.js") !== BILLING } };
  };
  return { io, repo, observe };
}

// ---- builder and reviewer scripts ----
const fix = (t, rs) => t.write(Object.fromEntries([...rs.map((r) => [`src/routes/${r}.js`, route(r, true)]), ["test/leak.test.js", leakTest(rs)]]));
const claimAll = (k) => k.requirements.map((r) => ({ id: r.id, status: r.disposition === "deliver" ? "implemented" : "deferred", evidence: D[r.id] ? `${D[r.id].path}:7` : "" }));
function builderScript(cs) {
  let res = null;
  const finish = (t) => { res.validation = [{ id: "V1", command: V1, exit: t.run(V1) }]; t.lean("implementation.md", `### Approach\nrelease in a catch\n\n### Changes\n${t.changed().map((f) => `- ${f}`).join("\n")}\n\n### Acceptance Criteria Status\n- see result\n\n### Verification\n- ${V1}\n\n### Notes\nnone`); t.lean("result.json", res); };
  return async (n, c, t) => {
    if (n === 1) { t.lean("investigation.md", "**Verdict**: CONFIRMED\n**Confidence**: high\n**Severity**: high\n**Task Type**: bug\n\n### Root Cause\ncheck() throws after reserve() with no release"); t.lean("contract.json", cs.contract()); return; }
    if (n === 2) { cs.impl(t); t.commit("fix: release on 429"); if (cs.selfCheck) await cs.selfCheck(c.cwd); res = { status: "fixed", summary: "release on 429", requirements: (cs.claims ?? claimAll)(cs.contract()), amendments: [] }; finish(t); return; }
    if (cs.resume) { cs.resume(t, res); t.commit("fix: conformance"); }
    finish(t);
  };
}
/** A diligent reviewer made deterministic: every row comes from the worktree the engine handed it. */
function oracle(c) {
  const between = (tag) => c.prompt.split(`<${tag}>\n`)[1].split(`\n</${tag}>`)[0];
  const k = JSON.parse(between("contract")), files = between("changed_files").split("\n").filter(Boolean);
  const read = (p) => { try { return fs.readFileSync(path.join(c.cwd, p), "utf8"); } catch { return ""; } };
  const lineOf = (p, s) => read(p).split("\n").findIndex((l) => l.includes(s)) + 1;
  const R = { R1: "scrape", R2: "search", R3: "export" };
  const rows = k.requirements.map((r) => {
    if (r.disposition !== "deliver") return { id: r.id, status: r.disposition === "defer" ? "deferred" : r.disposition, deferral_ok: Boolean(r.why) };
    if (R[r.id]) { const p = `src/routes/${R[r.id]}.js`; return read(p).includes("release(id)") ? { id: r.id, status: "implemented", evidence: `${p}:${lineOf(p, "release(id)")}`, validated_by: "V1" } : { id: r.id, status: "missing", evidence: `${p}:${lineOf(p, "check(")}`, note: "no release on 429" }; }
    if (r.id === "R4") return { id: "R4", status: "implemented", evidence: `src/routes/scrape.js:${lineOf("src/routes/scrape.js", "throw e")}`, validated_by: "V1" };
    return { id: r.id, status: read("test/leak.test.js") ? "implemented" : "missing", evidence: "test/leak.test.js:5", validated_by: "V1" };
  });
  const covered = (q) => k.requirements.some((r) => r.quote === q) || k.preserve.some((p) => p.what.includes(q));
  const billing = git(["diff", "--name-only", "origin/staging...HEAD", "--", "src/billing.js"], c.cwd).trim() !== "";
  const rv = { issue_coverage: Object.values(Q).map((q) => ({ quote: q, status: covered(q) ? "covered" : "missing" })), requirements: rows,
    scope: files.map((f) => ({ file: f, authorized_by: k.deliverables.find((d) => d.path === f)?.id ?? (f.startsWith("test/") ? "test" : "none") })),
    preserve: [{ id: "P1", status: billing ? "violated" : "intact", evidence: "src/billing.js:1" }, { id: "P2", status: "intact", evidence: "test/routes.test.js:1" }], regressions: [] };
  const bad = rv.issue_coverage.some((x) => x.status !== "covered") || rows.some((r) => ["missing", "partial"].includes(r.status)) || rv.scope.some((s) => s.authorized_by === "none") || billing;
  return "```json\n" + JSON.stringify({ ...rv, verdict: bad ? "NONCONFORMING" : "CONFORMS", summary: "oracle" }) + "\n```";
}
const generic = () => "```json\n" + JSON.stringify({ verdict: "PASS", fixes_issue: true, regression: false, reason: "looks good" }) + "\n```";

async function runCase(cs, conformance = "enforce", extra = {}) {
  const dir = tmpDir("conf-e2e-");
  const w = makeWorld(dir, { builder: builderScript(cs), reviewer: (n, c) => (cs.generic ? generic() : oracle(c)) });
  if (extra.runCommand) w.io.runCommand = extra.runCommand;
  const ret = await runCore({ issue: 101, repo: "o/r", lane: "staging", cwd: w.repo, worktreeRoot: path.join(dir, "wt"), dir: path.join(dir, "runs"), io: w.io, random: () => 0.5, stableMs: 0, livePollMs: 20, conformance, ...(extra.opts ?? {}) });
  return { ...w.observe(ret), log: readLog(path.join(dir, "runs"), 101) };
}
const blocked = (o, code) => {
  assert.equal(o.ret.terminalReason, "needs-human"); assert.equal(o.ret.code, code);
  assert.equal(o.pr, undefined, "no PR"); assert.equal(o.issue.state, "OPEN");
  assert.ok(o.issue.labels.has("needs-human")); assert.ok(![...o.issue.labels].some((l) => l.startsWith("workflow:")));
  assert.ok(!o.staging.search && !o.staging.export, "staging untouched");
};
const merged = (o) => {
  assert.equal(o.ret.terminalReason, "merged"); assert.equal(o.pr.state, "MERGED"); assert.equal(o.pr.base, "staging");
  assert.equal(o.issue.state, "CLOSED"); assert.equal(o.issue.reason, "completed"); assert.deepEqual([...o.issue.labels], ["workflow:merged"]);
  assert.match(o.pr.body, /Closes #101$/);
};

describe("conformance gate end-to-end (real git, disposable repo)", { skip: !HAVE_GIT && "git not available" }, () => {
  it("1 complete: conforms, merges into staging, closes completed", async () => {
    const o = await runCase({ contract: FULL, impl: (t) => fix(t, ["scrape", "search", "export"]) });
    merged(o); assert.ok(o.staging.search && o.staging.export && !o.staging.billingChanged);
    assert.deepEqual([o.counts.builder, o.counts.reviewer], [2, 1]);
    assert.deepEqual(o.markers, ["FORGE:STARTED", "FORGE:INVESTIGATION", "FORGE:CONTRACT", "FORGE:IMPLEMENTATION", "FORGE:REVIEW", "FORGE:TRAJECTORY"]);
  });
  it("2 omission: the contract silently drops requirement 3; review catches it; issue stays open, nothing merged", async () => {
    const o = await runCase({ contract: OMIT, impl: (t) => fix(t, ["scrape", "search"]) });
    blocked(o, "conformance.omission"); assert.deepEqual([o.counts.builder, o.counts.reviewer], [3, 2]);
  });
  it("2b omission recovered by typed amendments on the resume: merges with all three routes fixed", async () => {
    const o = await runCase({ contract: OMIT, impl: (t) => fix(t, ["scrape", "search"]),
      resume: (t, res) => { fix(t, ["scrape", "search", "export"]); res.requirements.push({ id: "R3", status: "implemented" });
        res.amendments = [{ kind: "add-requirement", requirement: req("R3"), why: "the issue's requirement 3 was missing" }, { kind: "add-deliverable", id: "D3", path: "src/routes/export.js", why: "implements R3" }]; } });
    merged(o); assert.ok(o.staging.export); assert.ok(o.markers.includes("FORGE:AMENDMENT"));
  });
  it("3 scope creep: an unauthorized billing change is stopped by the precheck and reverted before it can reach staging", async () => {
    const o = await runCase({ contract: FULL, impl: (t) => { fix(t, ["scrape", "search", "export"]); t.write({ "src/billing.js": "export function price(units) { return Math.round(units) * 0.01; }\n" }); },
      resume: (t) => t.restore("src/billing.js") });
    merged(o); assert.equal(o.staging.billingChanged, false); assert.deepEqual([o.counts.builder, o.counts.reviewer], [3, 1]);
  });
  it("4 a claimed follow-up without a tracking issue blocks merge before any review", async () => {
    const o = await runCase({ contract: FULL, impl: (t) => fix(t, ["scrape", "search"]), claims: (k) => claimAll(k).map((r) => (r.id === "R3" ? { id: "R3", status: "deferred", note: "follow-up" } : r)) });
    blocked(o, "conformance.untracked_deferral"); assert.equal(o.counts.reviewer, 0); assert.equal(o.followups.length, 0);
  });
  it("4b the deferral made typed on the resume is tracked, linked, and the issue closes", async () => {
    const o = await runCase({ contract: FULL, impl: (t) => fix(t, ["scrape", "search"]), claims: (k) => claimAll(k).map((r) => (r.id === "R3" ? { id: "R3", status: "deferred" } : r)),
      resume: (t, res) => { res.amendments = [{ kind: "defer", requirement: "R3", why: "export ships on its own release train" }]; } });
    merged(o); assert.equal(o.followups.length, 1); assert.equal(o.followups[0].state, "OPEN");
    assert.match(o.pr.body, new RegExp(`Remaining work tracked\\n- #${o.followups[0].number}`)); assert.ok(o.markers.includes("FORGE:TRACKED"));
  });
  it("5 a contracted deferral is filed once the reviewer accepts it, and the issue closes with the link", async () => {
    const o = await runCase({ contract: DEFER, impl: (t) => fix(t, ["scrape", "search"]) });
    merged(o); assert.equal(o.followups.length, 1); assert.deepEqual(o.followups[0].items, [`R3: ${Q.R3}`]);
    assert.match(o.issue.comments.find((c) => c.includes("FORGE:CONTRACT")), /defer \(filed after review accepts it\)/);
    assert.match(o.pr.body, new RegExp(`Remaining work tracked\\n- #${o.followups[0].number}`));
    assert.ok(o.issue.comments.some((c) => c.includes("FORGE:TRACKED") && c.includes(`#${o.followups[0].number}`)));
  });
  it("shadow (default): an omission merges as today, and the posted review says the gate would block it", async () => {
    const o = await runCase({ contract: OMIT, impl: (t) => fix(t, ["scrape", "search"]) }, "shadow");
    merged(o); assert.equal(o.staging.export, false, "the omitted route still leaks, exactly as today");
    assert.match(o.issue.comments.find((c) => c.includes("FORGE:REVIEW")), /would BLOCK \(nonconforming\)[\s\S]*conformance\.omission/);
    assert.deepEqual([o.counts.builder, o.counts.reviewer], [2, 1]);
  });
  it("#4364 forgedock check in the lane worktree runs the engine's commands and reaches its verdict", async () => {
    let cli = null;
    const learned = [V1, "exit 3"];
    const o = await runCase({ contract: FULL, impl: (t) => fix(t, ["scrape", "search", "export"]),
      selfCheck: async (wt) => { cli = await checkFromCli([], { cwd: wt, git: async (a, cwd) => git(a, cwd), out: () => {} }); } },
    "enforce", { runCommand: runCheckCommand, opts: { precheck: { commands: learned }, verify: { maxRounds: 0 } } });
    merged(o);
    const [engine] = o.log.filter((e) => e.event === "PRECHECK_COMMANDS");
    assert.deepEqual(cli.commands.map(({ command, rc }) => ({ command, rc })), engine.results.map(({ command, rc }) => ({ command, rc })));
    assert.deepEqual(engine.results.map((r) => r.rc), [0, 3], "one passing and one failing pre-PR command");
    // validate: the CLI's V1 run agrees with the engine's conformance precheck (no validate failure)
    assert.deepEqual(cli.validate.map(({ id, rc }) => ({ id, rc })), [{ id: "V1", rc: 0 }]);
    assert.ok(!o.log.some((e) => e.event === "PRECHECK" && e.failures.length), "the engine's validate verdict passes too");
    assert.equal(cli.ok, false); assert.equal(cli.exitCode, 1);
    // the run was on the final tree, so the engine records it as red (not skipped/stale) on both events
    assert.equal(engine.self_check, "red");
    assert.deepEqual(o.log.filter((e) => e.event === "SELF_CHECK_MISSING").map((e) => e.state), ["red"]);
  });
  it("6 a generic PASS over an incomplete implementation never merges (review.incomplete)", async () => {
    const o = await runCase({ contract: FULL, impl: (t) => fix(t, ["scrape", "export"]), generic: true });
    blocked(o, "review.incomplete"); assert.deepEqual([o.counts.builder, o.counts.reviewer], [2, 2]);
  });
});
