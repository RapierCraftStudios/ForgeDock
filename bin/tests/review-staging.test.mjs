// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// forgedock review-staging (#4358): pre-dispatch flow; (#4359) post-dispatch --finalize / --summary; in-memory gh / script runner / fs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reviewStagingFromCli, parseArgs, renderBrief, buildManifest, stagingVerdict } from "../review-staging.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const FROM = "fedcba9876543210fedcba9876543210fedcba98";
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
    assert.deepEqual(parseArgs(["42"]), { pr: 42, thorough: false, json: false, mode: "pre", testGateOutput: null, notesDropped: 0, filed: [], delta: null });
    assert.equal(parseArgs(["https://github.com/o/r/pull/77", "--json"]).pr, 77);
    assert.equal(parseArgs([]).pr, null);
    assert.equal(parseArgs(["--thorough"]).thorough, true);
  });
  it("rejects a short --delta SHA, --delta outside the pre-dispatch or with --thorough, unknown flags and garbage with exit 2", async () => {
    for (const argv of [["42", "--delta", "abc"], ["42", "--delta"], ["42", "--delta", FROM.toUpperCase()], ["42", "--delta", FROM, "--thorough"], ["--delta", FROM, "--finalize", "--test-gate-output", "x"],
      ["--summary", "--delta", FROM], ["--bogus"], ["4x2"], ["42", "43"]]) {
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

/** Post-dispatch world: the pre-dispatch already left its state files in $SD. */
function postWorld(o = {}) {
  const findings = o.findings ?? [{ id: "SEC-1", severity: "MEDIUM", confidence: "LIKELY" }];
  const items = o.items ?? [
    { id: "SEC-1", action: "file", title: "x leaks (review finding — PR #42)", labels: ["review-finding", "priority:p2"], milestone: "", batchable: false, regression_of: null, file: "a.js", line: "3", severity: "MEDIUM", agent: "security" },
    { id: "SEC-2", action: "skip-dedup", title: "dup", dedup_of: 99 },
  ];
  const w = {
    gh: [], scripts: [], out: [], err: [], removed: [],
    files: {
      "/repo/forge.yaml": "project:\n  owner: o\n  repo: r\nbranches:\n  default: main\n  staging: staging\n",
      [`${SD}/staging_pr_number.rk`]: "42\n", [`${SD}/42_bundle-prs.txt`]: "5\n6\n", [CTX]: JSON.stringify(ctxJson()),
      [`${SD}/42_scope.json`]: JSON.stringify(o.scope ?? { scope_mode: "scoped", reviewed_pr_count: 1, unreviewed_commits: ["c2"], unreviewed_files: ["b.js"], cross_pr_files: ["a.js"], deploy_wiring_files: ["b.js"] }),
      ...(o.files ?? {}),
    },
  };
  const OUT = `${SD}/review-finalize-42`;
  w.io = {
    root: "/install", cwd: "/repo", env: { FORGE_SCRATCHPAD: SD, FORGE_RUN_KEY: "rk", ...(o.env ?? {}) },
    gh: async (a) => {
      w.gh.push(a);
      const k = a.slice(0, 2).join(" ");
      if (k === "pr view") return a.includes("headRefName") ? "staging\n" : `${o.head ?? HEAD}\n`;
      if (k === "pr comment") { if (o.commentFails) throw new Error("boom"); return ""; }
      if (k === "label create") return "";
      if (k === "pr list") return "42\n";
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    run: async (cmd, args, opts) => {
      if (cmd === "gh") { w.gh.push(args); return { code: o.ciCode ?? 0, stdout: o.ci ?? "0\n", stderr: "" }; }
      const script = args[0].split("/").pop(), sub = args[1];
      w.scripts.push({ script, sub, args, env: opts.env });
      if (script === "review-staging-post.sh" && sub === "delivery") return o.delivery ?? { code: 0, stdout: "DELIVERY: OK (2/2 ...)", stderr: "" };
      if (script === "review-staging-post.sh" && sub === "test-gate") {
        const t = o.testGate ?? { code: 0, verdict: "SKIP", reason: "SKIP — no runtime tests ran" };
        if (t.verdict != null) { w.files[`${SD}/42_test_gate_verdict`] = `${t.verdict}\n`; w.files[`${SD}/42_test_gate_reason`] = `${t.reason}\n`; }
        return { code: t.code, stdout: t.code ? "RESULT: BLOCK DEPLOY" : "", stderr: "" };
      }
      if (script === "review-finalize.sh") {
        if (o.rfFail?.sub === sub) return { code: o.rfFail.code, stdout: o.rfFail.code === 3 ? "REVIEW_RESULT: status: BLOCKED, blocker: x" : "", stderr: "" };
        if (sub === "extract") { w.files[`${OUT}/findings.json`] = JSON.stringify({ findings }); return { code: 0, stdout: `FINDINGS_KEPT=${findings.length}\nFINDINGS_DROPPED_STALE=1\nFINDINGS_PREEXISTING=0\nNOTES_DEMOTED_NO_SCENARIO=0\nAGENTS_WITHOUT_BLOCK=${o.withoutBlock ?? ""}\n`, stderr: "" }; }
        if (sub === "classify") { w.files[`${OUT}/note-list.txt`] = "- QA-1 nit (capped)\n"; w.files[`${OUT}/note-disposition.md`] = "<!-- FORGE:NOTE_DISPOSITION: out_of_scope=2 scope=scoped -->"; return { code: 0, stdout: "FINDINGS_FILED=1\nNOTES_LISTED=1\nNOTES_CAPPED=1\nNOTES_REFLAG=0\n", stderr: "" }; }
        if (sub === "file-prepare") { w.files[`${OUT}/worklist.json`] = JSON.stringify({ items }); return { code: 0, stdout: "FINDINGS_TO_FILE=1", stderr: "" }; }
      }
      if (script === "cost-report.sh") return { code: 0, stdout: "| v | cost |", stderr: "" };
      if (script === "forgedock.mjs") return { code: 1, stdout: "", stderr: "no auth" };
      throw new Error(`unexpected script ${script} ${sub}`);
    },
    readFile: (p) => { if (p in w.files) return w.files[p]; throw new Error(`ENOENT ${p}`); },
    writeFile: (p, s) => { w.files[p] = s; },
    rm: (p) => { w.removed.push(p); delete w.files[p]; },
    mkdir: () => {},
    out: (s) => w.out.push(s), err: (s) => w.err.push(s),
  };
  return w;
}
const FIN = ["--finalize", "--test-gate-output", "tg.txt"];
const rfCalls = (w) => w.scripts.filter((s) => s.script === "review-finalize.sh");
const flagOf = (args, f) => args[args.indexOf(f) + 1];

describe("review-staging post-dispatch args", () => {
  it("parses --finalize/--summary and their options", () => {
    assert.deepEqual(parseArgs(["42", ...FIN, "--notes-dropped", "2"]), { pr: 42, thorough: false, json: false, mode: "finalize", testGateOutput: "tg.txt", notesDropped: 2, filed: [], delta: null });
    assert.deepEqual(parseArgs(["--summary", "--filed", "101", "--filed", "#102,103"]).filed, [101, 102, 103]);
  });
  it("rejects bad combinations with exit 2 and touches nothing", async () => {
    for (const argv of [["--finalize"], ["--finalize", "--summary", "--test-gate-output", "x"], ["--summary", "--test-gate-output", "x"], ["--filed", "1"],
      ["--finalize", "--test-gate-output"], ["--finalize", "--test-gate-output", "x", "--notes-dropped", "-1"], ["--summary", "--filed", "abc"], ["--summary", "--thorough"]]) {
      const w = postWorld();
      assert.equal(await reviewStagingFromCli(argv, w.io), 2, argv.join(" "));
      assert.equal(w.gh.length + w.scripts.length, 0, argv.join(" "));
    }
  });
});

describe("review-staging --finalize", () => {
  it("runs delivery, test gate, extract, classify (dry run then real) and file-prepare in order and prints the items to file", async () => {
    const w = postWorld();
    assert.equal(await reviewStagingFromCli([...FIN, "--notes-dropped", "1"], w.io), 0, w.err.join("\n"));
    assert.deepEqual(w.scripts.map((s) => `${s.script}:${s.sub}`), ["review-staging-post.sh:delivery", "review-staging-post.sh:test-gate", "review-finalize.sh:extract", "review-finalize.sh:classify", "review-finalize.sh:classify", "review-finalize.sh:file-prepare"]);
    const [del, tg] = w.scripts;
    assert.equal(flagOf(del.args, "--head"), HEAD);
    assert.equal(flagOf(del.args, "--pr"), "42", "PR comes from the run-keyed pointer");
    assert.equal(flagOf(tg.args, "--output"), "tg.txt");
    assert.equal(flagOf(tg.args, "--prs-file"), `${SD}/42_bundle-prs.txt`);
    assert.equal(del.env.FORGEDOCK_HOME, "/install");
    const [ex, dry, real] = rfCalls(w);
    assert.equal(flagOf(ex.args, "--context"), CTX);
    assert.ok(dry.args.includes("--dry-run") && !real.args.includes("--dry-run"));
    for (const c of [dry, real]) {
      assert.equal(flagOf(c.args, "--prior-prs"), "5 6");
      assert.equal(flagOf(c.args, "--auto-merge"), "false");
      assert.equal(flagOf(c.args, "--scope-files"), `${SD}/42_scope-files.txt`);
    }
    assert.equal(flagOf(real.args, "--notes-dropped"), "1");
    assert.equal(w.files[`${SD}/42_scope-files.txt`], "a.js\nb.js\n", "scoped set = cross-PR + unreviewed + deploy wiring, deduped");
    assert.ok(w.gh.some((a) => a[0] === "label" && a.includes("staging-review")));
    const out = w.out[0];
    assert.match(out, /^CODE_BRANCH=staging$/m);
    assert.match(out, /^NOTE - QA-1 nit \(capped\)$/m);
    assert.match(out, /^SKIP skip-dedup #99 dup$/m);
    const file = out.split("\n").filter((l) => l.startsWith("FILE "));
    assert.equal(file.length, 1);
    assert.equal(JSON.parse(file[0].slice(5)).title, "x leaks (review finding — PR #42)");
    assert.match(out, /OUT_OF_SCOPE=2/);
    assert.match(out, /--summary --filed/);
    const st = JSON.parse(w.files[`${SD}/42_finalize.json`]);
    assert.equal(st.head, HEAD);
    assert.equal(st.testGate.verdict, "SKIP");
    assert.equal(st.toFile.length, 1);
  });

  it("a full-scope review passes no --scope-files", async () => {
    const w = postWorld({ scope: { scope_mode: "full" } });
    assert.equal(await reviewStagingFromCli(FIN, w.io), 0, w.err.join("\n"));
    for (const c of rfCalls(w).filter((s) => s.sub === "classify")) assert.ok(!c.args.includes("--scope-files"));
    assert.ok(w.removed.includes(`${SD}/42_scope-files.txt`), "a stale scope file is removed");
  });

  it("an incomplete panel stops before the test gate and triage", async () => {
    const w = postWorld({ delivery: { code: 1, stdout: "REVIEW DELIVERY FAILURE: missing findings comment(s) for: infra", stderr: "" } });
    assert.equal(await reviewStagingFromCli(FIN, w.io), 1);
    assert.equal(w.scripts.length, 1);
    assert.match(w.err.join("\n"), /missing findings comment[\s\S]*RESULT: BLOCK DEPLOY/);
  });

  it("a blocking test gate stops before triage", async () => {
    const w = postWorld({ testGate: { code: 1, verdict: "BLOCK", reason: "BLOCK (blocking posture, no override)" } });
    assert.equal(await reviewStagingFromCli(FIN, w.io), 1);
    assert.equal(rfCalls(w).length, 0);
    assert.match(w.err.join("\n"), /RESULT: BLOCK DEPLOY/);
  });

  it("review-finalize exit 3 (BLOCKED) stops and files nothing", async () => {
    const w = postWorld({ rfFail: { sub: "classify", code: 3 } });
    assert.equal(await reviewStagingFromCli(FIN, w.io), 1);
    assert.ok(!rfCalls(w).some((s) => s.sub === "file-prepare"));
    assert.match(w.err.join("\n"), /REVIEW_RESULT: status: BLOCKED[\s\S]*RESULT: BLOCK DEPLOY/);
    assert.equal(w.out.length, 0);
  });

  it("an agent comment without a findings block is a delivery failure", async () => {
    const w = postWorld({ withoutBlock: "infra" });
    assert.equal(await reviewStagingFromCli(FIN, w.io), 1);
    assert.match(w.err.join("\n"), /no structured findings block from: infra/);
  });

  it("a missing review context is BLOCKED (the pre-dispatch did not run)", async () => {
    const w = postWorld({ files: { [CTX]: "" } });
    assert.equal(await reviewStagingFromCli(FIN, w.io), 1);
    assert.match(w.err.join("\n"), /review context .* missing/);
  });
});

describe("review-staging --summary", () => {
  async function finalized(o = {}) {
    const w = postWorld(o);
    assert.equal(await reviewStagingFromCli(FIN, w.io), 0, w.err.join("\n"));
    w.gh.length = 0; w.out.length = 0; w.err.length = 0;
    return w;
  }
  const posted = (w) => comments(w);

  it("clean: posts one summary with GATE_PASS (never GATE_FAILURE), the Test Gate row and the triage counts; never merges", async () => {
    const w = await finalized();
    assert.equal(await reviewStagingFromCli(["--summary", "--filed", "101"], w.io), 0, w.err.join("\n"));
    const b = posted(w);
    assert.equal(b.length, 1);
    assert.ok(b[0].startsWith("<!-- FORGE:GATE_PASS -->\n"));
    assert.ok(b[0].includes("<!-- FORGE:GATE_PASS:TYPE=staging-review|BUNDLE=5 6 -->"));
    assert.ok(!b[0].includes("FORGE:GATE_FAILURE"));
    assert.match(b[0], /\| \*\*Test Gate\*\* \| `SKIP` \| `SKIP — no runtime tests ran` \|/);
    assert.match(b[0], /\*\*Test Gate: SKIP\*\*/);
    assert.match(b[0], /findings_filed: 1 \(#101\); out_of_scope: 2/);
    assert.match(b[0], /deduped: deduped: #99/);
    assert.match(b[0], /SCOPE_MODE: scoped; reviewed_prs: 1; unreviewed_commits: 1; cross_pr_files: 1/);
    assert.match(b[0], /### Pipeline cost\n\| v \| cost \|/);
    assert.match(b[0], /Pipeline stats: unavailable/);
    assert.ok(!w.gh.some((a) => a.includes("merge")));
    assert.match(w.out[0], /^VERDICT: APPROVE FOR DEPLOY/);
  });

  for (const [name, o, verdict] of [
    ["a CONFIRMED CRITICAL", { findings: [{ severity: "CRITICAL", confidence: "CONFIRMED" }] }, "BLOCK DEPLOY"],
    ["a CONFIRMED HIGH", { findings: [{ severity: "high", confidence: "confirmed" }] }, "NEEDS FIXES FIRST"],
    ["failing CI", { ci: "2\n", ciCode: 1 }, "BLOCK DEPLOY"],
    ["an unreadable CI result", { ci: "", ciCode: 1 }, "BLOCK DEPLOY"],
  ]) {
    it(`${name}: GATE_FAILURE, ${verdict}, exit 1`, async () => {
      const w = await finalized(o);
      assert.equal(await reviewStagingFromCli(["42", "--summary"], w.io), 1);
      const b = posted(w);
      assert.equal(b.length, 1);
      assert.ok(b[0].startsWith("<!-- FORGE:GATE_FAILURE -->\n") && b[0].includes("<!-- FORGE:GATE_FAILURE:TYPE=staging-review|BUNDLE=5 6 -->"));
      assert.ok(!b[0].includes("FORGE:GATE_PASS"));
      assert.match(b[0], new RegExp(`## Staging Review: ${verdict}`));
      assert.match(w.out[0], /RESULT: BLOCK DEPLOY/);
    });
  }

  it("a LIKELY HIGH does not block; a deleted test-gate verdict fails closed", async () => {
    const w = await finalized({ findings: [{ severity: "HIGH", confidence: "LIKELY" }] });
    assert.equal(await reviewStagingFromCli(["--summary"], w.io), 0, w.err.join("\n"));
    const w2 = await finalized();
    delete w2.files[`${SD}/42_test_gate_verdict`];
    assert.equal(await reviewStagingFromCli(["--summary"], w2.io), 1);
    assert.match(posted(w2)[0], /test-gate result missing\/invalid/);
  });

  it("refuses without --finalize state or when the head moved; posts no marker", async () => {
    const w = postWorld();
    assert.equal(await reviewStagingFromCli(["--summary"], w.io), 1);
    assert.match(w.err.join("\n"), /run forgedock review-staging 42 --finalize first/);
    const w2 = await finalized();
    w2.io.gh = ((orig) => async (a) => (a[1] === "view" && !a.includes("headRefName") ? `${"f".repeat(40)}\n` : orig(a)))(w2.io.gh);
    assert.equal(await reviewStagingFromCli(["--summary"], w2.io), 1);
    assert.match(w2.err.join("\n"), /head moved since --finalize/);
    assert.equal(posted(w).length + posted(w2).length, 0);
  });

  it("a failed post of the summary is BLOCKED", async () => {
    const w = await finalized();
    w.io.gh = ((orig) => async (a) => { if (a[1] === "comment") throw new Error("HTTP 502"); return orig(a); })(w.io.gh);
    assert.equal(await reviewStagingFromCli(["--summary"], w.io), 1);
    assert.match(w.err.join("\n"), /could not post the Phase 8 summary/);
  });

  it("stagingVerdict precedence: CI, invalid test gate, CRITICAL, HIGH", () => {
    const base = { ciFailing: 0, testGateInvalid: false, confirmedCritical: 0, confirmedHigh: 0 };
    assert.equal(stagingVerdict(base).verdict, "APPROVE FOR DEPLOY");
    assert.equal(stagingVerdict({ ...base, confirmedHigh: 1, ciFailing: 1 }).verdict, "BLOCK DEPLOY");
    assert.equal(stagingVerdict({ ...base, testGateInvalid: true }).verdict, "BLOCK DEPLOY");
    assert.equal(stagingVerdict({ ...base, confirmedHigh: 2 }).verdict, "NEEDS FIXES FIRST");
  });
});

describe("review-staging --delta (#4360)", () => {
  const DELTA_CTX = ctxJson({
    roster: { tier: "medium", reason: "delta fedcba9..0123456: domains the delta touches", agents: ["security"] },
    delta: { mode: "DELTA", from: FROM, carried_from: "", full_rounds: 0, files: ["a.js"] },
    slices: { security: { paths: ["a.js"], diff_file: "/slice-security.diff" } },
  });

  it("parses a full SHA", () => {
    assert.equal(parseArgs(["42", "--delta", FROM]).delta, FROM);
  });

  it("passes --delta-from with the unchanged --no-delta, briefs the delta only, and credits the spec panel; markers unchanged", async () => {
    const w = world({ prepare: { code: 0, ctx: DELTA_CTX } });
    assert.equal(await reviewStagingFromCli(["42", "--delta", FROM], w.io), 0, w.err.join("\n"));
    const prep = w.scripts.find((s) => s.script === "review-prepare.sh").args;
    assert.equal(flagOf(prep, "--delta-from"), FROM);
    for (const f of ["--no-delta", "--build-gate", "advisory"]) assert.ok(prep.includes(f), f);
    assert.deepEqual(comments(w), [`<!-- FORGE:REVIEW_ROUTE mode=staging-deploy spec=review-pr-staging.md sha=${HEAD.slice(0, 7)} -->`]);
    const sec = w.files[`${SD}/review-staging-42/brief-security.md`];
    assert.ok(sec.includes(`DELTA review: review only the changes in ${FROM}..${HEAD}`) && sec.includes("DELTA_FILES: a.js"));
    assert.ok(!sec.includes("SCOPE_MODE=scoped"), "the delta replaces the bundle scope text");
    assert.ok(sec.includes("<!-- FORGE:REVIEW-AGENT:security -->") && sec.includes(`Reviewed-SHA: ${HEAD}`));
    const out = w.out[0];
    assert.match(out, new RegExp(`^DELTA: ${FROM}\\.\\.${HEAD} files=1$`, "m"));
    assert.deepEqual(out.split("\n").filter((l) => l.startsWith("DISPATCH ")), [`DISPATCH security ${SD}/review-staging-42/brief-security.md`]);
    assert.match(out, /spec-owned panel .* is credited from the earlier pass at fedcba9; dispatch only the DISPATCH lines/);
    assert.ok(!out.includes("dispatch the spec-owned panel per"));
  });

  it("--json carries the delta; a FULL context (empty delta fell back) reports none", async () => {
    const w = world({ prepare: { code: 0, ctx: DELTA_CTX } });
    assert.equal(await reviewStagingFromCli(["42", "--delta", FROM, "--json"], w.io), 0);
    assert.deepEqual(JSON.parse(w.out[0]).delta, { from: FROM, files: ["a.js"] });
    const w2 = world();
    assert.equal(await reviewStagingFromCli(["42", "--delta", FROM], w2.io), 0);
    assert.ok(!w2.out[0].includes("DELTA:") && w2.out[0].includes("dispatch the spec-owned panel per"));
  });

  it("a --delta equal to the head is a stop: no marker, no scripts", async () => {
    const w = world();
    assert.equal(await reviewStagingFromCli(["42", "--delta", HEAD], w.io), 1);
    assert.equal(comments(w).length + w.scripts.length, 0);
    assert.match(w.err.join("\n"), /nothing to review/);
  });

  it("a BLOCKED delta prepare (no earlier pass to credit) stops with its blocker", async () => {
    const w = world({ prepare: { code: 3, ctx: { status: "BLOCKED", blockers: ["--delta-from x: no earlier pass to credit"] } } });
    assert.equal(await reviewStagingFromCli(["42", "--delta", FROM], w.io), 1);
    assert.match(w.err.join("\n"), /no earlier pass to credit/);
  });

  it("--finalize adds the delta files to the scope set and records the delta; --summary names the credited pass", async () => {
    const w = postWorld({ files: { [CTX]: JSON.stringify(DELTA_CTX) }, scope: { scope_mode: "scoped", cross_pr_files: ["b.js"], unreviewed_files: [], deploy_wiring_files: [] } });
    assert.equal(await reviewStagingFromCli(FIN, w.io), 0, w.err.join("\n"));
    assert.equal(w.files[`${SD}/42_scope-files.txt`], "a.js\nb.js\n");
    assert.equal(flagOf(rfCalls(w)[0].args, "--context"), CTX, "extract reads the DELTA context (it credits the earlier pass)");
    assert.deepEqual(JSON.parse(w.files[`${SD}/42_finalize.json`]).delta, { from: FROM, files: ["a.js"] });
    assert.match(w.out[0], new RegExp(`^DELTA_FROM=${FROM}$`, "m"));
    w.gh.length = 0; w.out.length = 0;
    assert.equal(await reviewStagingFromCli(["--summary"], w.io), 0, w.err.join("\n"));
    const b = comments(w)[0];
    assert.ok(b.includes(`- delta pass: fedcba9..${HEAD.slice(0, 7)} (1 file(s)); earlier pass at ${FROM} credited`));
    assert.ok(b.startsWith("<!-- FORGE:GATE_PASS -->\n") && b.includes("<!-- FORGE:GATE_PASS:TYPE=staging-review|BUNDLE=5 6 -->"));
  });

  it("a FULL review records no delta", async () => {
    const w = postWorld();
    assert.equal(await reviewStagingFromCli(FIN, w.io), 0);
    assert.equal(JSON.parse(w.files[`${SD}/42_finalize.json`]).delta, null);
    assert.ok(!w.out[0].includes("DELTA_FROM="));
  });
});
