// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock review-staging [<PR>]` (#4358): the deterministic pre-dispatch of the staging->main review
 * (commands/review-pr-staging.md Phase -1, 0A, 0B.1, 0C and the roster), with one reviewer brief per selected domain
 * written to a file. The calling agent dispatches the briefs the manifest lists; nothing is extracted from the spec by hand.
 *
 * Steps: route marker -> bundle PR set -> open review-finding gate (stops on block) -> 0B.1 scope -> review-prepare.sh
 * (stops on BLOCKED) -> roster (ctx.roster, computed by review-roster.sh inside review-prepare.sh) -> briefs -> manifest.
 *
 * Post-dispatch (#4359), after the reviewers posted and the agent saved the /test-gate output:
 * `--finalize --test-gate-output FILE [--notes-dropped N]`: delivery + panel guard and the 6.5 verdict handling
 * (scripts/review-staging-post.sh), then review-finalize.sh extract, classify (dry run, then for real) and file-prepare;
 * prints one FILE line per worklist item to file through /issue. `--summary [--filed N]...`: the Phase 8 verdict and summary
 * comment, which always carries one gate marker (FORGE:GATE_PASS on APPROVE FOR DEPLOY, FORGE:GATE_FAILURE otherwise).
 *
 * State files keep the spec's names in $FORGE_SCRATCHPAD (default <cwd>/.forge-scratch). Scripts come from this install's
 * own root, never the repo under review. Every effect goes through `io`, so the flow is testable without gh or git.
 */
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseForgeYaml } from "./forge-utils.mjs";

const INSTALL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "usage: forgedock review-staging [<PR number|PR URL>] [--thorough] [--json]\n" +
  "       forgedock review-staging [<PR>] --finalize --test-gate-output <file> [--notes-dropped <n>] [--json]\n" +
  "       forgedock review-staging [<PR>] --summary [--filed <issue>]... [--json]";
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Persona file / catalog keys per canonical marker domain (review-pr-agents.md routing table). */
const INDEX_KEY = { auth: "auth", billing: "billing", database: "database", api: "api", frontend: "frontend", infra: "infrastructure" };
const CONFIG_DOMAIN = { scraper: "scraping" };
const READ_ONLY_GIT_RULE = "Read-only git rule: never run `git checkout`, `git switch`, `git reset`, `git stash`, or `git merge` in the main checkout (the shared primary working tree). Inspect PR code with `git show <sha>:<path>`, `gh pr diff`, `gh api`, or a per-PR worktree (`git worktree add --detach`) you remove afterward.";
/** Reviewers whose prompts are prose inside the spec (no persona template): dispatched per the spec, not briefed here. */
const SPEC_PANEL = "material-change (Phase 2), bug hunters (Phase 3), code-quality (Phase 4), regression-risk (Phase 6)";

class Stop extends Error {
  constructor(code, lines) { super(lines.join("\n")); this.code = code; this.lines = lines; }
}

/** argv -> {pr, thorough, json, mode, testGateOutput, notesDropped, filed}. Throws Stop(2) on anything else (`--delta` belongs to #4360). */
export function parseArgs(argv) {
  const o = { pr: null, thorough: false, json: false, mode: "pre", testGateOutput: null, notesDropped: 0, filed: [] };
  const setMode = (m, a) => { if (o.mode !== "pre") throw new Stop(2, [`review-staging: ${a} cannot be combined with --${o.mode}`, USAGE]); o.mode = m; };
  const value = (i, a) => { const v = argv[i + 1]; if (v == null || v.startsWith("--")) throw new Stop(2, [`review-staging: ${a} requires a value`, USAGE]); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thorough") o.thorough = true;
    else if (a === "--json") o.json = true;
    else if (a === "--finalize") setMode("finalize", a);
    else if (a === "--summary") setMode("summary", a);
    else if (a === "--test-gate-output") o.testGateOutput = value(i++, a);
    else if (a === "--notes-dropped") {
      const v = value(i++, a);
      if (!/^\d+$/.test(v)) throw new Stop(2, [`review-staging: --notes-dropped must be a count: ${v}`, USAGE]);
      o.notesDropped = Number(v);
    } else if (a === "--filed") {
      for (const n of value(i++, a).split(/[\s,]+/).filter(Boolean)) {
        const m = /^#?(\d+)$/.exec(n);
        if (!m) throw new Stop(2, [`review-staging: --filed takes issue numbers: ${n}`, USAGE]);
        o.filed.push(Number(m[1]));
      }
    } else if (!a.startsWith("-") && o.pr == null) {
      const m = /^(?:https?:\/\/\S*\/pull\/)?(\d+)$/.exec(a);
      if (!m) throw new Stop(2, [`review-staging: not a PR number or URL: ${a}`, USAGE]);
      o.pr = Number(m[1]);
    } else throw new Stop(2, [`review-staging: unknown argument: ${a}`, USAGE]);
  }
  if (o.mode !== "finalize" && (o.testGateOutput != null || o.notesDropped)) throw new Stop(2, ["review-staging: --test-gate-output/--notes-dropped belong to --finalize", USAGE]);
  if (o.mode !== "summary" && o.filed.length) throw new Stop(2, ["review-staging: --filed belongs to --summary", USAGE]);
  if (o.mode !== "pre" && o.thorough) throw new Stop(2, ["review-staging: --thorough belongs to the pre-dispatch", USAGE]);
  if (o.mode === "finalize" && !o.testGateOutput) throw new Stop(2, ["review-staging: --finalize requires --test-gate-output <file> (the saved /test-gate output)", USAGE]);
  return o;
}

/** Replace every `[KEY]` in one pass: a substituted value is never rescanned, so diff text cannot inject placeholders. */
export function renderBrief(template, values) {
  return template.replace(/\[([A-Z][A-Z0-9_]*)\]/g, (m, k) => (Object.hasOwn(values, k) && values[k] != null ? String(values[k]) : m));
}

/** Text manifest the calling agent acts on. */
export function buildManifest(m) {
  const lines = [
    `REVIEW_STAGING: PR #${m.pr} head ${m.headSha}`,
    `GATE: ${m.gate}`,
    `BUNDLE_PRS: ${(m.bundle ?? []).join(" ")}`,
    `SCOPE_MODE=${m.scopeMode}`,
    `ROSTER: tier=${m.tier} agents=${m.briefs.map((b) => b.domain).join(" ")}${m.reason ? ` reason=${m.reason}` : ""}`,
    `CONTEXT_FILE=${m.contextFile}`,
    ...m.briefs.map((b) => `DISPATCH ${b.domain} ${b.path}`),
    `NEXT: dispatch one isolated reviewer per DISPATCH line (prompt = the brief file's content) in a single message; before each launch append its domain to ${m.launchedFile}.`,
    `NEXT: dispatch the spec-owned panel per commands/review-pr-staging.md (${SPEC_PANEL}), appending each domain to the same file.`,
    `NEXT: after every reviewer posted, run /test-gate, save its output to a file, then run: forgedock review-staging ${m.pr} --finalize --test-gate-output <file>`,
  ];
  return lines.join("\n");
}

function defaultIo() {
  const run = (cmd, args, opts = {}) => new Promise((res) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, env: opts.env ?? process.env, cwd: opts.cwd, timeout: opts.timeout ?? 0 }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
  return {
    root: INSTALL_ROOT, env: process.env, cwd: process.cwd(), run,
    gh: async (args) => { const r = await run("gh", args); if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim()}`); return r.stdout; },
    readFile: (p) => nodeFs.readFileSync(p, "utf8"),
    writeFile: (p, s) => nodeFs.writeFileSync(p, s),
    rm: (p) => nodeFs.rmSync(p, { force: true }),
    mkdir: (p) => nodeFs.mkdirSync(p, { recursive: true }),
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
  };
}

function readConfig(io) {
  const path = io.env.FORGE_CONFIG || join(io.cwd, "forge.yaml");
  let cfg = {};
  try { cfg = parseForgeYaml(io.readFile(path)) ?? {}; } catch { /* absent config: owner/repo check below fails */ }
  const owner = cfg.project?.owner, repo = cfg.project?.repo;
  if (!owner || !repo) throw new Stop(1, [`review-staging: project.owner/project.repo not set in ${path}`]);
  return { ghRepo: `${owner}/${repo}`, defaultBranch: cfg.branches?.default || "main", stagingBranch: cfg.branches?.staging || "staging", configPath: path };
}

/** Same derivation as commands/review-pr-staging.md Phase -1 (and scripts/lib/fence-bootstrap.sh). */
function runKey(env) {
  const k = env.FORGE_RUN_KEY || env.FORGE_RUN_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || env.CODEX_THREAD_ID || env.OPENCODE_SESSION_ID || String(process.ppid);
  return k.replace(/[^A-Za-z0-9_-]/g, "_");
}

const findingFilter = (n) => (i) => (i.title ?? "").endsWith(`PR #${n})`) || new RegExp(`(^|\\n)\\*\\*Source\\*\\*: PR #${n}([^0-9]|$)`).test(i.body ?? "");

async function priorFindings(io, c, pr, state) {
  try {
    const list = JSON.parse(await io.gh(["issue", "list", "-R", c.ghRepo, "--label", "review-finding", "--state", state, "--search", `PR #${pr}`, "--limit", "50", "--json", "number,title,body"]));
    return list.filter(findingFilter(pr)).map((i) => `#${i.number}: ${i.title}`);
  } catch { return []; }
}

/** Shared protocols plus the persona text for `domain`; null when the template source cannot supply it. */
function loadTemplate(io, templates, domain) {
  const tryRead = (p) => { try { return io.readFile(p); } catch { return null; } };
  if (templates?.source === "monolithic_catalog") {
    const cat = templates.monolithic_catalog && tryRead(templates.monolithic_catalog);
    if (!cat) return null;
    const parts = cat.split(/^(?=### Agent:)/m);
    const persona = parts.slice(1).find((p) => p.split("\n")[0].toLowerCase().includes(domain === "infra" ? "infra" : domain));
    return persona ? `${parts[0]}\n${persona}` : null;
  }
  if (!templates?.base) return null;
  const protocols = tryRead(join(templates.base, "protocols.md"));
  const persona = tryRead(join(templates.base, `${domain}.md`));
  return protocols && persona ? `${protocols}\n\n---\n\n${persona}` : null;
}

function scopeSection(scope) {
  const list = (a) => (a?.length ? a.join(" ") : "(none)");
  if (scope.scope_mode !== "scoped") return `## Review scope\nSCOPE_MODE=full: review the full bundle diff. Report the scope used in your comment.`;
  return [
    "## Review scope",
    "SCOPE_MODE=scoped. Line-level review is limited to CROSS_PR_FILES, the diffs of UNREVIEWED_COMMITS, and a runtime/deploy readiness checklist (required secrets and env vars present and documented, migration ordering and collisions, deploy wiring and workflow sibling drift). Report every finding you see with its severity and file, whatever file or commit it lives in; a CRITICAL or HIGH finding is always kept. Safety-domain agents (Security, Auth, Billing, Concurrency, Database) still read the whole diff of any in-scope file. Report the scope used in your comment.",
    `REVIEWED_COMMITS: ${list(scope.reviewed_commits)}`,
    `UNREVIEWED_COMMITS: ${list(scope.unreviewed_commits)}`,
    `CROSS_PR_FILES: ${list(scope.cross_pr_files)}`,
    `DEPLOY_WIRING_FILES: ${list(scope.deploy_wiring_files)}`,
  ].join("\n");
}

async function bash(io, script, args, env) {
  return io.run("bash", [join(io.root, "scripts", script), ...args], { env, cwd: io.cwd });
}

async function openStagingPr(io, c) {
  const n = (await io.gh(["pr", "list", "-R", c.ghRepo, "--head", c.stagingBranch, "--base", c.defaultBranch, "--state", "open", "--json", "number", "--jq", ".[0].number"])).trim();
  if (!/^\d+$/.test(n)) throw new Stop(1, [`review-staging: no open ${c.stagingBranch}->${c.defaultBranch} PR found`]);
  return Number(n);
}

async function headSha(io, c, pr) {
  let head = "";
  try { head = (await io.gh(["pr", "view", String(pr), "-R", c.ghRepo, "--json", "headRefOid", "--jq", ".headRefOid"])).trim(); } catch { /* fail closed below */ }
  if (!SHA_RE.test(head)) throw new Stop(1, [`REVIEW_RESULT: status: BLOCKED, blocker: could not resolve a full head SHA for PR #${pr}; nothing reviewed (fail closed)`]);
  return head;
}

async function main(argv, io) {
  const a = parseArgs(argv);
  if (a.mode === "finalize") return finalize(a, io);
  if (a.mode === "summary") return summary(a, io);
  const c = readConfig(io);
  const sd = io.env.FORGE_SCRATCHPAD || join(io.cwd, ".forge-scratch");
  io.mkdir(sd);
  // Child scripts resolve ForgeDock helpers from this install (FORGEDOCK_HOME is authoritative in forge_resolve).
  const env = { ...io.env, FORGE_SCRATCHPAD: sd, FORGEDOCK_HOME: io.root };

  // Phase -1: PR, head SHA, prior passes, route marker, run-keyed pointer
  const pr = a.pr ?? await openStagingPr(io, c);
  const head = await headSha(io, c, pr);
  const sha7 = head.slice(0, 7);
  let priorRoutes = 0;
  try {
    const out = await io.gh(["api", "--paginate", `repos/${c.ghRepo}/issues/${pr}/comments`, "--jq", '[.[] | select(.body | test("FORGE:REVIEW_ROUTE"))] | length']);
    priorRoutes = out.split(/\s+/).filter(Boolean).reduce((s, x) => s + (Number(x) || 0), 0);
  } catch { /* unreadable: treated as a first pass */ }
  const priorOpen = priorRoutes > 0 ? await priorFindings(io, c, pr, "open") : [];
  const priorResolved = priorRoutes > 0 ? await priorFindings(io, c, pr, "closed") : [];
  await io.gh(["pr", "comment", String(pr), "-R", c.ghRepo, "--body", `<!-- FORGE:REVIEW_ROUTE mode=staging-deploy spec=review-pr-staging.md sha=${sha7} -->`]);
  io.writeFile(join(sd, `staging_pr_number.${runKey(io.env)}`), `${pr}\n`);

  // 0A: bundle PR set, then the open review-finding gate
  const common = ["--repo", c.ghRepo, "--pr", String(pr)];
  const branches = ["--default", c.defaultBranch, "--staging", c.stagingBranch];
  const prsFile = join(sd, `${pr}_bundle-prs.txt`);
  const b = await bash(io, "review-staging-pre.sh", ["bundle", ...common, ...branches, "--sd", sd], env);
  if (b.stdout.trim()) io.err(b.stdout.trim());
  if (b.code !== 0) throw new Stop(1, [b.stderr.trim(), `REVIEW_RESULT: status: BLOCKED, blocker: bundle PR set failed (exit ${b.code})`].filter(Boolean));
  const g = await bash(io, "review-staging-pre.sh", ["gate", ...common, "--prs-file", prsFile], env);
  if (g.code !== 0) {
    const out = g.stdout.trim();
    throw new Stop(1, [out, g.stderr.trim(), /RESULT: BLOCK DEPLOY/.test(out) ? "" : "RESULT: BLOCK DEPLOY"].filter(Boolean));
  }
  const gate = /human override/.test(g.stdout) ? "PASS (override)" : "PASS";

  // 0B.1: scope
  const s = await bash(io, "review-staging-pre.sh", ["scope", ...common, ...branches, "--prs-file", prsFile, "--sd", sd], env);
  if (s.stdout.trim()) io.err(s.stdout.trim());
  let scope;
  try { scope = JSON.parse(io.readFile(join(sd, `${pr}_scope.json`))); } catch { scope = null; }
  if (s.code !== 0 || !scope) scope = { scope_mode: "full" };   // a scope failure widens review, never narrows it

  // 0C: prepare (also runs review-roster.sh)
  const ctxFile = join(sd, `review-ctx-${pr}.json`);
  const p = await bash(io, "review-prepare.sh", ["--pr", String(pr), "--repo", c.ghRepo, "--no-delta", "--build-gate", "advisory", "--out", ctxFile, ...(a.thorough ? ["--thorough", "true"] : [])], env);
  let ctx = null;
  try { ctx = JSON.parse(io.readFile(ctxFile)); } catch { /* reported below */ }
  if (p.code !== 0 || !ctx) {
    const blockers = (ctx?.blockers ?? []).map((x) => `BLOCKER: ${x}`);
    throw new Stop(1, [...blockers, `REVIEW_RESULT: status: BLOCKED, blocker: review-prepare failed (exit ${p.code}); nothing reviewed (fail closed)`]);
  }

  // Roster + briefs
  const agents = ctx.roster?.agents?.length ? ctx.roster.agents : ["security"];
  const launchedFile = join(sd, `${pr}_launched_review_agents`);
  io.writeFile(launchedFile, "");
  const briefDir = join(sd, `review-staging-${pr}`);
  io.mkdir(briefDir);
  const briefs = [];
  for (const domain of agents) {
    const tpl = loadTemplate(io, ctx.templates, domain);
    if (!tpl) throw new Stop(1, [`REVIEW_RESULT: status: BLOCKED, blocker: persona template for ${domain} not found (source ${ctx.templates?.source ?? "none"}); never review inline`]);
    const slice = ctx.slices?.[domain];
    let diff = "";
    try { diff = slice?.diff_file ? io.readFile(slice.diff_file) : ""; } catch { diff = ""; }
    const values = {
      PR_NUMBER: pr, REVIEW_SHA: head, REVIEW_SHA_SHORT: sha7, AGENT_DOMAIN: domain, GH_REPO: c.ghRepo,
      TITLE: ctx.pr?.title ?? "", FILE_LIST: (slice?.paths ?? ctx.full_files ?? []).join(" "), SERVICES: (ctx.classification?.services ?? []).join(" "),
      PROJECT_NAME: ctx.config?.project_name ?? "", PROJECT_CONTEXT: ctx.config?.project_context ?? "",
      DOMAIN_CONTEXT: ctx.config?.domains?.[CONFIG_DOMAIN[domain] ?? domain] ?? "", CHURN_CONTEXT: ctx.churn_context ?? "",
      INDEX_SLICE: INDEX_KEY[domain] ? ctx.index_slices?.[INDEX_KEY[domain]] ?? "" : "", DOMAIN_DIFF_SLICE: diff,
    };
    const extra = [
      `## Staging review (staging->main PR #${pr}, head ${head})`,
      `Your marker domain is \`${domain}\`: start your comment with \`<!-- FORGE:REVIEW-AGENT:${domain} -->\`, then the line \`Reviewed-SHA: ${head}\`, and end it with the structured findings block.`,
      scopeSection(scope),
      ...(ctx.broken_assumptions?.length ? ["## Pre-found integration issues to verify", ...ctx.broken_assumptions.map((x) => `- ${x}`)] : []),
      ...(priorOpen.length ? ["## Prior open findings (carried forward: do not re-file)", ...priorOpen.map((x) => `- ${x}`)] : []),
      ...(priorResolved.length ? ["## Prior resolved findings (excluded from the verdict)", ...priorResolved.map((x) => `- ${x}`)] : []),
      READ_ONLY_GIT_RULE,
    ].join("\n\n");
    const path = join(briefDir, `brief-${domain}.md`);
    io.writeFile(path, `${renderBrief(tpl, values)}\n\n---\n\n${extra}\n`);
    briefs.push({ domain, path });
  }

  let bundle = [];
  try { bundle = io.readFile(prsFile).split(/\s+/).filter((n) => /^\d+$/.test(n)); } catch { /* reported empty */ }
  const m = { pr, headSha: head, gate, bundle, scopeMode: scope.scope_mode, tier: ctx.roster?.tier ?? "full", reason: ctx.roster?.reason ?? "", contextFile: ctxFile, launchedFile, briefs, reentry: priorRoutes > 0 };
  io.out(a.json ? JSON.stringify(m) : buildManifest(m));
  return 0;
}

const BLOCK_DEPLOY = "RESULT: BLOCK DEPLOY";
const VERDICT_RE = /^(BLOCK|PASS|SKIP)$/;

/** `KEY=value` lines (review-finalize.sh output) -> object. */
const parseKv = (text) => Object.fromEntries(String(text ?? "").split("\n").map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const readJson = (io, p) => { try { return JSON.parse(io.readFile(p)); } catch { return null; } };
const readText = (io, p) => { try { return io.readFile(p); } catch { return null; } };
const relay = (io, r) => { for (const t of [r.stdout, r.stderr]) if (t?.trim()) io.err(t.trim()); };
const upper = (x) => String(x ?? "").trim().toUpperCase();

/** Shared post-dispatch context: config, scratchpad, PR (argument, then the run-keyed pointer, then the open PR) and head. */
async function postContext(a, io) {
  const c = readConfig(io);
  const sd = io.env.FORGE_SCRATCHPAD || join(io.cwd, ".forge-scratch");
  io.mkdir(sd);
  const env = { ...io.env, FORGE_SCRATCHPAD: sd, FORGEDOCK_HOME: io.root };
  let pr = a.pr;
  if (pr == null) {
    const n = (readText(io, join(sd, `staging_pr_number.${runKey(io.env)}`)) ?? "").trim();
    pr = /^\d+$/.test(n) ? Number(n) : await openStagingPr(io, c);
  }
  return { c, sd, env, pr, head: await headSha(io, c, pr) };
}

/** Persisted Phase 6.5 result, validated on reload: anything missing or unknown is an invalid (BLOCK) verdict. */
function testGateResult(io, sd, pr) {
  const v = (readText(io, join(sd, `${pr}_test_gate_verdict`)) ?? "").split("\n")[0].trim();
  // eslint-disable-next-line no-control-regex
  const reason = (readText(io, join(sd, `${pr}_test_gate_reason`)) ?? "").split("\n")[0].replace(/[\x00-\x1f]/g, "").slice(0, 400);
  return VERDICT_RE.test(v) ? { verdict: v, reason, invalid: false } : { verdict: "BLOCK", reason: "persisted test-gate verdict missing/invalid", invalid: true };
}

/** --finalize: delivery, test gate, extract, classify (dry run + real), file-prepare; prints the items to file. */
async function finalize(a, io) {
  const { c, sd, env, pr, head } = await postContext(a, io);
  const common = ["--repo", c.ghRepo, "--pr", String(pr), "--sd", sd, "--head", head];

  // Incomplete-panel guard + 6.75 delivery
  const d = await bash(io, "review-staging-post.sh", ["delivery", ...common], env);
  relay(io, d);
  if (d.code !== 0) throw new Stop(1, [`REVIEW_RESULT: status: BLOCKED, blocker: reviewer delivery incomplete (exit ${d.code}); re-dispatch each missing reviewer once with the note "structured findings block required", else the panel is degraded`, BLOCK_DEPLOY]);

  // 6.5 verdict handling (override, posture, test-gate markers)
  const prsFile = join(sd, `${pr}_bundle-prs.txt`);
  const t = await bash(io, "review-staging-post.sh", ["test-gate", ...common, "--prs-file", prsFile, "--output", a.testGateOutput, "--default", c.defaultBranch,
    "--config", c.configPath], env);   // posture and override phrase are read from the config by the script (yq), as the spec did
  relay(io, t);
  if (t.code !== 0) throw new Stop(1, [t.code === 1 ? "" : `REVIEW_RESULT: status: BLOCKED, blocker: the test gate could not run (exit ${t.code})`, BLOCK_DEPLOY].filter(Boolean));
  const tg = testGateResult(io, sd, pr);

  // 7A-7C through the shared review-finalize.sh (exit 3 = REVIEW_RESULT: status: BLOCKED was printed)
  const ctxFile = join(sd, `review-ctx-${pr}.json`);
  if (!readText(io, ctxFile)) throw new Stop(1, [`REVIEW_RESULT: status: BLOCKED, blocker: review context ${ctxFile} missing (the pre-dispatch did not run); nothing triaged (fail closed)`, BLOCK_DEPLOY]);
  const outDir = join(sd, `review-finalize-${pr}`);
  const rf = async (sub, extra) => {
    const r = await io.run("bash", [join(io.root, "scripts", "review-finalize.sh"), sub, "--pr", String(pr), "--repo", c.ghRepo, "--context", ctxFile, "--out-dir", outDir, ...extra], { env, cwd: io.cwd });
    if (r.code !== 0) throw new Stop(1, [r.stdout.trim(), r.stderr.trim(), r.code === 3 ? "" : `REVIEW_RESULT: status: BLOCKED, blocker: review-finalize ${sub} failed (exit ${r.code})`, BLOCK_DEPLOY].filter(Boolean));
    return r;
  };
  const x = parseKv((await rf("extract", [])).stdout);
  if (x.AGENTS_WITHOUT_BLOCK?.trim()) throw new Stop(1, [`REVIEW DELIVERY FAILURE: no structured findings block from: ${x.AGENTS_WITHOUT_BLOCK.trim()}. Re-dispatch them once with the note "structured findings block required", else the panel is degraded.`, BLOCK_DEPLOY]);

  // 0B.1 scope set for 7B (a missing scope file means SCOPE_MODE=full: no out-of-scope demotion, announced)
  const scope = readJson(io, join(sd, `${pr}_scope.json`));
  if (!scope) io.err(`WARNING: ${join(sd, `${pr}_scope.json`)} unreadable: SCOPE_MODE=full (no out-of-scope demotion)`);
  const scopeMode = scope?.scope_mode === "scoped" ? "scoped" : "full";
  const scopeFile = join(sd, `${pr}_scope-files.txt`);
  io.rm(scopeFile);
  if (scopeMode === "scoped") {
    const files = [...new Set([...(scope.cross_pr_files ?? []), ...(scope.unreviewed_files ?? []), ...(scope.deploy_wiring_files ?? [])].filter(Boolean))].sort();
    io.writeFile(scopeFile, files.length ? `${files.join("\n")}\n` : "");
  }
  const scopeArgs = scopeMode === "scoped" ? ["--scope-files", scopeFile] : [];
  const bundle = (readText(io, prsFile) ?? "").split(/\s+/).filter((n) => /^\d+$/.test(n));
  const priorPrs = bundle.join(" ");

  await rf("classify", ["--auto-merge", "false", ...scopeArgs, "--prior-prs", priorPrs, "--dry-run"]);
  const notes = (readText(io, join(outDir, "note-list.txt")) ?? "").split("\n").filter((l) => l.trim());
  const k = parseKv((await rf("classify", ["--auto-merge", "false", ...scopeArgs, "--prior-prs", priorPrs, "--notes-fixed", "0", "--notes-dropped", String(a.notesDropped)])).stdout);
  const patterns = join(outDir, "patterns.json");
  await rf("file-prepare", readText(io, patterns)?.trim() ? ["--patterns", patterns] : []);
  const worklist = readJson(io, join(outDir, "worklist.json"));
  if (!Array.isArray(worklist?.items)) throw new Stop(1, [`REVIEW_RESULT: status: BLOCKED, blocker: ${join(outDir, "worklist.json")} unreadable after file-prepare (fail closed)`, BLOCK_DEPLOY]);
  try {
    await io.gh(["label", "create", "staging-review", "--color", "1D76DB", "--description", "Finding from a staging branch review before deploy to main. Managed by ForgeDock.", "--force", "-R", c.ghRepo]);
  } catch { /* an existing label or a transient failure never blocks filing */ }
  let codeBranch = "";
  try { codeBranch = (await io.gh(["pr", "view", String(pr), "-R", c.ghRepo, "--json", "headRefName", "--jq", ".headRefName"])).trim(); } catch { /* reported empty */ }
  if (!/^[A-Za-z0-9._/-]+$/.test(codeBranch)) codeBranch = c.stagingBranch;

  const findings = readJson(io, join(outDir, "findings.json"))?.findings ?? [];
  const confirmed = (sev) => findings.filter((f) => upper(f.confidence) === "CONFIRMED" && upper(f.severity) === sev).length;
  const outOfScope = Number(/out_of_scope=(\d+)/.exec(readText(io, join(outDir, "note-disposition.md")) ?? "")?.[1] ?? 0);
  const counts = {
    findings_kept: Number(x.FINDINGS_KEPT ?? 0), findings_dropped_stale: Number(x.FINDINGS_DROPPED_STALE ?? 0), findings_preexisting: Number(x.FINDINGS_PREEXISTING ?? 0),
    notes_demoted_no_scenario: Number(x.NOTES_DEMOTED_NO_SCENARIO ?? 0), findings_filed: Number(k.FINDINGS_FILED ?? 0), notes_listed: Number(k.NOTES_LISTED ?? 0),
    notes_capped: Number(k.NOTES_CAPPED ?? 0), notes_reflag: Number(k.NOTES_REFLAG ?? 0), notes_dropped: a.notesDropped, out_of_scope: outOfScope,
  };
  const items = worklist.items;
  const state = {
    pr, head, bundle, codeBranch, scopeMode, testGate: { verdict: tg.verdict, reason: tg.reason }, counts, notes,
    confirmedCritical: confirmed("CRITICAL"), confirmedHigh: confirmed("HIGH"),
    toFile: items.filter((i) => i.action === "file"), skipped: items.filter((i) => String(i.action).startsWith("skip-")),
  };
  io.writeFile(join(sd, `${pr}_finalize.json`), JSON.stringify(state));
  if (a.json) { io.out(JSON.stringify(state)); return 0; }
  io.out([
    `REVIEW_STAGING_FINALIZE: PR #${pr} head ${head}`,
    `TEST_GATE: ${tg.verdict} (${tg.reason})`,
    `SCOPE_MODE=${scopeMode}`,
    Object.entries(counts).map(([kk, v]) => `${kk.toUpperCase()}=${v}`).join(" "),
    `CODE_BRANCH=${codeBranch}`,
    ...notes.map((n) => `NOTE ${n}`),
    ...state.skipped.map((i) => `SKIP ${i.action}${i.dedup_of ? ` #${i.dedup_of}` : ""} ${i.title ?? ""}`.trimEnd()),
    ...state.toFile.map((i) => `FILE ${JSON.stringify(i)}`),
    `NEXT: list or drop each NOTE in the PR body under "## Non-blocking notes" (edit, never replace); a dropped NOTE count goes to --notes-dropped on a re-run.`,
    `NEXT: for each FILE line write the finding body and file it through /issue (commands/review-pr-staging.md, filing step), then pipe its ISSUE_CREATE_RESULT line to review-finalize.sh file-verify.`,
    `NEXT: then run: forgedock review-staging ${pr} --summary${state.toFile.length ? " --filed <N>..." : ""}`,
  ].join("\n"));
  return 0;
}

const TEST_GATE_NOTE = {
  SKIP: (r) => `> **Test Gate: SKIP**: No runtime tests ran for this bundle. This means acceptance criteria were NOT verified against running code before deploy. Cause: ${r}. To enable runtime testing, configure \`verification.integration_tests\` in \`forge.yaml\`.`,
  PASS: () => "> **Test Gate: PASS**: Acceptance criteria verified against running code. No batch-introduced runtime failures detected.",
  BLOCK: (r) => `> **Test Gate: BLOCK (override/advisory)**: Runtime failures were detected but deploy is proceeding. Reason: ${r}. Filed \`test-failure\` issues track the failures.`,
};

/** Phase 8 verdict from the deterministic inputs (CI, test gate, CONFIRMED CRITICAL/HIGH). */
export function stagingVerdict({ ciFailing, testGateInvalid, confirmedCritical, confirmedHigh }) {
  if (ciFailing > 0) return { verdict: "BLOCK DEPLOY", why: `CI failing (${ciFailing} required check(s) red; forgedock/verify excluded)` };
  if (testGateInvalid) return { verdict: "BLOCK DEPLOY", why: "test-gate result missing/invalid (fail closed)" };
  if (confirmedCritical > 0) return { verdict: "BLOCK DEPLOY", why: `${confirmedCritical} CONFIRMED CRITICAL finding(s)` };
  if (confirmedHigh > 0) return { verdict: "NEEDS FIXES FIRST", why: `${confirmedHigh} CONFIRMED HIGH finding(s)` };
  return { verdict: "APPROVE FOR DEPLOY", why: "no CI failure, no blocking test gate, no CONFIRMED CRITICAL/HIGH finding" };
}

/** --summary: Phase 8 verdict + summary comment ending in exactly one gate marker kind. Never merges. */
async function summary(a, io) {
  const { c, sd, env, pr, head } = await postContext(a, io);
  const st = readJson(io, join(sd, `${pr}_finalize.json`));
  if (!st || st.pr !== pr) throw new Stop(1, [`REVIEW_RESULT: status: BLOCKED, blocker: no --finalize state for PR #${pr}; run forgedock review-staging ${pr} --finalize first`, BLOCK_DEPLOY]);
  if (st.head !== head) throw new Stop(1, [`REVIEW_RESULT: status: BLOCKED, blocker: head moved since --finalize (${String(st.head).slice(0, 7)} -> ${head.slice(0, 7)}); re-run the staging review`, BLOCK_DEPLOY]);
  const tg = testGateResult(io, sd, pr);

  // Phase 1E read: forgedock/verify is excluded; an unreadable result counts as failing (fail closed)
  let ciFailing = 1;
  const ci = await io.run("gh", ["pr", "checks", String(pr), "-R", c.ghRepo, "--json", "name,bucket", "--jq", '[.[] | select(.name != "forgedock/verify") | select(.bucket == "fail" or .bucket == "cancel")] | length'], { env, cwd: io.cwd });
  if (/^\d+$/.test(ci.stdout.trim())) ciFailing = Number(ci.stdout.trim());

  const v = stagingVerdict({ ciFailing, testGateInvalid: tg.invalid, confirmedCritical: st.confirmedCritical, confirmedHigh: st.confirmedHigh });
  const pass = v.verdict === "APPROVE FOR DEPLOY";
  const marker = pass ? "FORGE:GATE_PASS" : "FORGE:GATE_FAILURE";
  const bundle = (st.bundle ?? []).join(" ");
  const filed = a.filed.map((n) => `#${n}`);
  if (a.filed.length < (st.toFile?.length ?? 0)) io.err(`WARNING: ${st.toFile.length} worklist item(s) to file, ${a.filed.length} reported filed (pattern consolidation may merge items; anything else is a dropped finding)`);
  const sc = readJson(io, join(sd, `${pr}_scope.json`)) ?? {};
  const n = st.counts ?? {};
  const deduped = (st.skipped ?? []).map((i) => (i.action === "skip-dedup" && i.dedup_of ? `deduped: #${i.dedup_of}` : `${i.action}: ${i.title ?? ""}`));
  const optional = async (title, cmd, args, timeout) => {
    const r = await io.run(cmd, args, { env, cwd: io.cwd, timeout });
    return r.code === 0 && r.stdout.trim() ? [`### ${title}`, r.stdout.trim()] : [`${title}: unavailable`];
  };
  const body = [
    `<!-- ${marker} -->`,
    `## Staging Review: ${v.verdict}`,
    "",
    `**Verdict**: ${v.verdict} (${v.why})`,
    `**Head**: \`${head}\``,
    `**Bundle PRs**: ${bundle || "(none)"}`,
    "",
    "### Risk Matrix",
    "| Domain | Result | Notes |",
    "|--------|--------|-------|",
    `| CI | ${ciFailing > 0 ? "FAIL" : "PASS"} | ${ciFailing} failing required check(s), forgedock/verify excluded |`,
    `| Findings | ${st.confirmedCritical} CRITICAL / ${st.confirmedHigh} HIGH (CONFIRMED) | per-domain verdicts are in the FORGE:REVIEW-AGENT comments |`,
    `| **Test Gate** | \`${tg.verdict}\` | \`${tg.reason || "Phase 6.5 not run"}\` |`,
    "",
    (TEST_GATE_NOTE[tg.verdict] ?? TEST_GATE_NOTE.BLOCK)(tg.reason),
    "",
    "### Finding Triage Results",
    `- SCOPE_MODE: ${st.scopeMode}; reviewed_prs: ${sc.reviewed_pr_count ?? 0}; unreviewed_commits: ${(sc.unreviewed_commits ?? []).length}; cross_pr_files: ${(sc.cross_pr_files ?? []).length}`,
    `- findings_kept: ${n.findings_kept ?? 0}; dropped_stale: ${n.findings_dropped_stale ?? 0}; pre-existing: ${n.findings_preexisting ?? 0}; notes_demoted_no_scenario: ${n.notes_demoted_no_scenario ?? 0}`,
    `- findings_filed: ${n.findings_filed ?? 0}${filed.length ? ` (${filed.join(", ")})` : ""}; out_of_scope: ${n.out_of_scope ?? 0}`,
    `- notes_fixed: 0; notes_listed: ${n.notes_listed ?? 0}; notes_dropped: ${n.notes_dropped ?? 0}; notes_capped: ${n.notes_capped ?? 0}; notes_reflag: ${n.notes_reflag ?? 0}`,
    `- deduped: ${deduped.length ? deduped.join("; ") : "(none)"}`,
    "",
    ...(await optional("Pipeline cost", "bash", [join(io.root, "scripts", "cost-report.sh"), "--last", "3"], 60_000)),
    "",
    ...(await optional("Pipeline stats", process.execPath, [join(io.root, "bin", "forgedock.mjs"), "stats", "--compact", "--repo", c.ghRepo], 120_000)),
    "",
    "This review never merges staging -> main: the deploy decision is made on GitHub.",
    "",
    `<!-- ${marker}:TYPE=staging-review|BUNDLE=${bundle} -->`,
  ].join("\n");
  try {
    await io.gh(["pr", "comment", String(pr), "-R", c.ghRepo, "--body", body]);
  } catch (e) {
    throw new Stop(1, [`REVIEW_RESULT: status: BLOCKED, blocker: could not post the Phase 8 summary and gate marker (${e.message})`, BLOCK_DEPLOY]);
  }
  if (a.json) io.out(JSON.stringify({ pr, headSha: head, verdict: v.verdict, why: v.why, marker, ciFailing, testGate: tg.verdict, filed: a.filed }));
  else io.out([`VERDICT: ${v.verdict} (${v.why})`, `GATE: ${marker} posted on PR #${pr}`, ...(pass ? [] : [BLOCK_DEPLOY])].join("\n"));
  return pass ? 0 : 1;
}

/** CLI entry: returns the exit code (0 ready to dispatch / continue / approved, 1 blocked/failed/not approved, 2 usage). */
export async function reviewStagingFromCli(argv, io = defaultIo()) {
  try {
    return await main(argv, io);
  } catch (e) {
    if (e instanceof Stop) { io.err(e.lines.join("\n")); return e.code; }
    io.err(`review-staging: ${e.message}`);
    return 1;
  }
}
