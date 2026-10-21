// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// forgedock review-staging (#4358): pre-dispatch flow with an in-memory gh / script runner / fs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reviewStagingFromCli, parseArgs, renderBrief, buildManifest } from "../review-staging.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SD = "/sd";
const CTX = `${SD}/review-ctx-42.json`;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function ctxJson(o = {}) {
  return {
    schema_version: 1, status: "OK", blockers: [],
    pr: { number: 42, title: "Release 9.9.9" },
    classification: { services: ["cli"] },
    config: { project_name: "Proj", project_context: "ctx", domains: { infra: "infra ctx" } },
    churn_context: "churn", index_slices: { infrastructure: "idx" }, broken_assumptions: ["drift in ci.yml"],
    roster: { tier: "medium", reason: "61-150 lines", agents: ["security", "infra"] },
    templates: { source: "plugin_root", base: "/tpl", monolithic_catalog: "" },
    slices: { security: { paths: ["a.js", "b.js"], diff_file: "/slice-security.diff" }, infra: { paths: [".github/workflows/ci.yml"], diff_file: "/slice-infra.diff" } },
    full_files: ["a.js", "b.js"],
    ...o,
  };
}

/** World: files, gh calls, script calls. `o.gate`/`o.prepare` choose script outcomes. */
function world(o = {}) {
  const w = { files: { "/repo/forge.yaml": "project:\n  owner: o\n  repo: r\nbranches:\n  default: main\n  staging: staging\n", "/tpl/protocols.md": "PROTO [PR_NUMBER]", "/tpl/security.md": "SEC pr=[PR_NUMBER] sha=[REVIEW_SHA] short=[REVIEW_SHA_SHORT] dom=[AGENT_DOMAIN] files=[FILE_LIST] slice=[DOMAIN_DIFF_SLICE] keep=[UNKNOWN_KEY]", "/tpl/infra.md": "INFRA [DOMAIN_CONTEXT] [INDEX_SLICE] [CHURN_CONTEXT] [PROJECT_NAME]", "/slice-security.diff": "+ x = '[PR_NUMBER]'", "/slice-infra.diff": "+ run: x", ...(o.files ?? {}) }, gh: [], scripts: [], out: [], err: [] };
  w.io = {
    root: "/install", cwd: "/repo", env: { FORGE_SCRATCHPAD: SD, FORGE_RUN_KEY: "rk", ...(o.env ?? {}) },
    gh: async (a) => {
      w.gh.push(a);
      const k = a.slice(0, 2).join(" ");
      if (k === "pr list") return o.openPr ?? "42\n";
      if (k === "pr view") return `${o.head ?? HEAD}\n`;
      if (k === "pr comment") return "";
      if (a[0] === "api") return o.priorRoutes ?? "0\n";
      if (k === "issue list") return JSON.stringify(a.includes("open") ? [{ number: 7, title: "bug (PR #42)", body: "" }, { number: 8, title: "bug (PR #420)", body: "" }] : []);
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    run: async (cmd, args, opts) => {
      const script = args[0].split("/").pop(), sub = args[1];
      w.scripts.push({ script, sub, args, env: opts.env });
      if (script === "review-staging-pre.sh" && sub === "bundle") { w.files[`${SD}/42_bundle-prs.txt`] = "5\n"; return { code: 0, stdout: "PRs in staging→main bundle: 5", stderr: "" }; }
      if (script === "review-staging-pre.sh" && sub === "gate") return o.gate ?? { code: 0, stdout: "✅ Open review-finding gate: PASSED\nRESULT: PASS\n", stderr: "" };
      if (script === "review-staging-pre.sh" && sub === "scope") { w.files[`${SD}/42_scope.json`] = JSON.stringify(o.scope ?? { scope_mode: "scoped", reviewed_pr_count: 1, reviewed_commits: ["c1"], unreviewed_commits: ["c2"], unreviewed_files: ["b.js"], cross_pr_files: [], deploy_wiring_files: [".github/workflows/ci.yml"] }); return { code: 0, stdout: "SCOPE_MODE=scoped reviewed_prs=1", stderr: "" }; }
      if (script === "review-prepare.sh") {
        const p = o.prepare ?? { code: 0, ctx: ctxJson() };
        if (p.ctx) w.files[CTX] = JSON.stringify(p.ctx);
        return { code: p.code, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected script ${script}`);
    },
    readFile: (p) => { if (p in w.files) return w.files[p]; if (p.startsWith(REPO_ROOT)) return readFileSync(p, "utf8"); throw new Error(`ENOENT ${p}`); },
    writeFile: (p, s) => { w.files[p] = s; },
    mkdir: () => {},
    out: (s) => w.out.push(s), err: (s) => w.err.push(s),
  };
  return w;
}

const comments = (w) => w.gh.filter((a) => a[0] === "pr" && a[1] === "comment").map((a) => a[a.indexOf("--body") + 1]);

describe("review-staging args", () => {
  it("accepts a number, a PR URL, --thorough and --json", () => {
    assert.deepEqual(parseArgs(["42"]), { pr: 42, thorough: false, json: false });
    assert.equal(parseArgs(["https://github.com/o/r/pull/77", "--json"]).pr, 77);
    assert.equal(parseArgs([]).pr, null);
    assert.equal(parseArgs(["--thorough"]).thorough, true);
  });
  it("rejects --delta (#4360), unknown flags and garbage with exit 2", async () => {
    for (const argv of [["42", "--delta", "abc"], ["--bogus"], ["4x2"], ["42", "43"]]) {
      const w = world();
      assert.equal(await reviewStagingFromCli(argv, w.io), 2, argv.join(" "));
      assert.equal(w.gh.length, 0);
    }
  });
});

describe("review-staging flow", () => {
  it("posts the unchanged route marker, writes one brief per roster domain and lists exactly those", async () => {
    const w = world();
    assert.equal(await reviewStagingFromCli(["42"], w.io), 0, w.err.join("\n"));
    assert.deepEqual(comments(w), [`<!-- FORGE:REVIEW_ROUTE mode=staging-deploy spec=review-pr-staging.md sha=${HEAD.slice(0, 7)} -->`]);
    assert.equal(w.files[`${SD}/staging_pr_number.rk`], "42\n");
    assert.equal(w.files[`${SD}/42_launched_review_agents`], "");
    assert.deepEqual(w.scripts.map((s) => s.sub && s.script === "review-staging-pre.sh" ? s.sub : s.script), ["bundle", "gate", "scope", "review-prepare.sh"]);
    const prep = w.scripts.find((s) => s.script === "review-prepare.sh").args;
    for (const f of ["--no-delta", "--build-gate", "advisory", "--out", CTX]) assert.ok(prep.includes(f), f);
    assert.equal(w.scripts[0].env.FORGEDOCK_HOME, "/install");
    const dispatch = w.out[0].split("\n").filter((l) => l.startsWith("DISPATCH "));
    assert.deepEqual(dispatch, [`DISPATCH security ${SD}/review-staging-42/brief-security.md`, `DISPATCH infra ${SD}/review-staging-42/brief-infra.md`]);
    const sec = w.files[`${SD}/review-staging-42/brief-security.md`];
    assert.match(sec, /^PROTO 42/);
    assert.ok(sec.includes(`sha=${HEAD} short=${HEAD.slice(0, 7)} dom=security files=a.js b.js`));
    assert.ok(sec.includes("slice=+ x = '[PR_NUMBER]'"), "a substituted value is never rescanned");
    assert.ok(sec.includes("keep=[UNKNOWN_KEY]"), "an unsupplied placeholder stays visible");
    assert.ok(sec.includes(`<!-- FORGE:REVIEW-AGENT:security -->`) && sec.includes(`Reviewed-SHA: ${HEAD}`));
    assert.ok(sec.includes("SCOPE_MODE=scoped") && sec.includes("UNREVIEWED_COMMITS: c2") && sec.includes("DEPLOY_WIRING_FILES: .github/workflows/ci.yml"));
    assert.ok(sec.includes("drift in ci.yml") && sec.includes("Read-only git rule"));
    assert.ok(w.files[`${SD}/review-staging-42/brief-infra.md`].startsWith("PROTO 42\n\n---\n\nINFRA infra ctx idx churn Proj"));
  });

  it("resolves the open staging->main PR when none is given and carries prior findings on re-entry", async () => {
    const w = world({ priorRoutes: "1\n0\n" });
    assert.equal(await reviewStagingFromCli([], w.io), 0, w.err.join("\n"));
    assert.ok(w.gh.some((a) => a[0] === "pr" && a[1] === "list" && a.includes("staging") && a.includes("main")));
    const sec = w.files[`${SD}/review-staging-42/brief-security.md`];
    assert.ok(sec.includes("#7: bug (PR #42)") && !sec.includes("#8:"), "anchored PR filter");
  });

  it("stops with exit 1 when no open staging PR exists", async () => {
    const w = world({ openPr: "\n" });
    assert.equal(await reviewStagingFromCli([], w.io), 1);
    assert.equal(comments(w).length, 0);
  });

  it("fails closed on an unresolved head SHA: no marker, no scripts", async () => {
    const w = world({ head: "n/a" });
    assert.equal(await reviewStagingFromCli(["42"], w.io), 1);
    assert.equal(comments(w).length, 0);
    assert.equal(w.scripts.length, 0);
    assert.match(w.err.join("\n"), /BLOCKED/);
  });

  it("a blocked gate stops before scope, prepare and briefs", async () => {
    const w = world({ gate: { code: 1, stdout: "⛔ DEPLOY BLOCKED\nRESULT: BLOCK DEPLOY\n", stderr: "" } });
    assert.equal(await reviewStagingFromCli(["42"], w.io), 1);
    assert.deepEqual(w.scripts.map((s) => s.sub), ["bundle", "gate"]);
    assert.ok(!Object.keys(w.files).some((p) => p.includes("brief-")));
    assert.match(w.err.join("\n"), /RESULT: BLOCK DEPLOY/);
    assert.equal(w.out.length, 0);
  });

  it("a BLOCKED prepare stops with its blockers and writes no briefs", async () => {
    const w = world({ prepare: { code: 3, ctx: { status: "BLOCKED", blockers: ["no templates"] } } });
    assert.equal(await reviewStagingFromCli(["42"], w.io), 1);
    assert.match(w.err.join("\n"), /BLOCKER: no templates[\s\S]*REVIEW_RESULT: status: BLOCKED/);
    assert.ok(!Object.keys(w.files).some((p) => p.includes("brief-")));
  });

  it("a missing persona template is BLOCKED, never an inline review", async () => {
    const w = world({ prepare: { code: 0, ctx: ctxJson({ roster: { tier: "small", reason: "", agents: ["security", "billing"] } }) } });
    assert.equal(await reviewStagingFromCli(["42"], w.io), 1);
    assert.match(w.err.join("\n"), /persona template for billing not found/);
  });

  it("a scope failure widens to full scope", async () => {
    const w = world({ scope: null });
    w.io.run = ((orig) => async (cmd, args, opts) => (args[1] === "scope" ? { code: 1, stdout: "", stderr: "x" } : orig(cmd, args, opts)))(w.io.run);
    assert.equal(await reviewStagingFromCli(["42"], w.io), 0);
    assert.match(w.out[0], /SCOPE_MODE=full/);
  });

  it("--json prints one object with the dispatch list; --thorough reaches prepare", async () => {
    const w = world();
    assert.equal(await reviewStagingFromCli(["42", "--json", "--thorough"], w.io), 0);
    const m = JSON.parse(w.out[0]);
    assert.equal(m.pr, 42);
    assert.equal(m.headSha, HEAD);
    assert.deepEqual(m.briefs.map((b) => b.domain), ["security", "infra"]);
    assert.ok(w.scripts.find((s) => s.script === "review-prepare.sh").args.join(" ").includes("--thorough true"));
  });

  it("builds briefs from the shipped persona templates (marker contract intact)", async () => {
    const base = `${REPO_ROOT}commands/review-pr-agents`;
    const w = world({ files: { "/slice-security.diff": "+ y" }, prepare: { code: 0, ctx: ctxJson({ templates: { source: "plugin_root", base } }) } });
    assert.equal(await reviewStagingFromCli(["42"], w.io), 0, w.err.join("\n"));
    const sec = w.files[`${SD}/review-staging-42/brief-security.md`];
    assert.ok(sec.includes("FORGE:REVIEW-AGENT:") && sec.includes(`Reviewed-SHA: ${HEAD}`));
    assert.ok(!sec.includes("[REVIEW_SHA]") && !sec.includes("[PR_NUMBER]") && !sec.includes("[AGENT_DOMAIN]"));
  });
});

describe("review-staging helpers", () => {
  it("renderBrief substitutes in one pass", () => {
    assert.equal(renderBrief("[A] [B] [C]", { A: "[B]", B: "b" }), "[B] b [C]");
  });
  it("buildManifest names every brief and the launched-agents file", () => {
    const t = buildManifest({ pr: 1, headSha: HEAD, gate: "PASS", scopeMode: "full", tier: "small", reason: "", contextFile: "/c", launchedFile: "/l", briefs: [{ domain: "security", path: "/b" }] });
    assert.match(t, /^DISPATCH security \/b$/m);
    assert.match(t, /append its domain to \/l/);
  });
  it("is codebase-agnostic: no repo-specific paths", () => {
    const src = readFileSync(new URL("../review-staging.mjs", import.meta.url), "utf8");
    for (const s of ["services/", "web/src", "AlterLab", "alterlab"]) assert.ok(!src.includes(s), s);
  });
});
