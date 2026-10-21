// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock review-staging [<PR>]` (#4358): the deterministic pre-dispatch of the staging->main review
 * (commands/review-pr-staging.md Phase -1, 0A, 0B.1, 0C and the roster), with one reviewer brief per selected domain
 * written to a file. The calling agent dispatches the briefs the manifest lists; nothing is extracted from the spec by hand.
 *
 * Steps: route marker -> bundle PR set -> open review-finding gate (stops on block) -> 0B.1 scope -> review-prepare.sh
 * (stops on BLOCKED) -> roster (ctx.roster, computed by review-roster.sh inside review-prepare.sh) -> briefs -> manifest.
 * State files keep the spec's names in $FORGE_SCRATCHPAD (default <cwd>/.forge-scratch), so the phases still run from the
 * spec (6.5 onward) read them unchanged. Scripts come from this install's own root, never the repo under review.
 * Every effect goes through `io`, so the flow is testable without gh or git.
 */
import { execFile } from "node:child_process";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseForgeYaml } from "./forge-utils.mjs";

const INSTALL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "usage: forgedock review-staging [<PR number|PR URL>] [--thorough] [--json]";
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

/** argv -> {pr, thorough, json}. Throws Stop(2) on anything else (`--delta` belongs to #4360). */
export function parseArgs(argv) {
  const o = { pr: null, thorough: false, json: false };
  for (const a of argv) {
    if (a === "--thorough") o.thorough = true;
    else if (a === "--json") o.json = true;
    else if (!a.startsWith("-") && o.pr == null) {
      const m = /^(?:https?:\/\/\S*\/pull\/)?(\d+)$/.exec(a);
      if (!m) throw new Stop(2, [`review-staging: not a PR number or URL: ${a}`, USAGE]);
      o.pr = Number(m[1]);
    } else throw new Stop(2, [`review-staging: unknown argument: ${a}`, USAGE]);
  }
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
    `SCOPE_MODE=${m.scopeMode}`,
    `ROSTER: tier=${m.tier} agents=${m.briefs.map((b) => b.domain).join(" ")}${m.reason ? ` reason=${m.reason}` : ""}`,
    `CONTEXT_FILE=${m.contextFile}`,
    ...m.briefs.map((b) => `DISPATCH ${b.domain} ${b.path}`),
    `NEXT: dispatch one isolated reviewer per DISPATCH line (prompt = the brief file's content) in a single message; before each launch append its domain to ${m.launchedFile}.`,
    `NEXT: dispatch the spec-owned panel per commands/review-pr-staging.md (${SPEC_PANEL}), then continue at Phase 6.5.`,
  ];
  return lines.join("\n");
}

function defaultIo() {
  const run = (cmd, args, opts = {}) => new Promise((res) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, env: opts.env ?? process.env, cwd: opts.cwd }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
  return {
    root: INSTALL_ROOT, env: process.env, cwd: process.cwd(), run,
    gh: async (args) => { const r = await run("gh", args); if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim()}`); return r.stdout; },
    readFile: (p) => nodeFs.readFileSync(p, "utf8"),
    writeFile: (p, s) => nodeFs.writeFileSync(p, s),
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
  return { ghRepo: `${owner}/${repo}`, defaultBranch: cfg.branches?.default || "main", stagingBranch: cfg.branches?.staging || "staging" };
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

async function main(argv, io) {
  const a = parseArgs(argv);
  const c = readConfig(io);
  const sd = io.env.FORGE_SCRATCHPAD || join(io.cwd, ".forge-scratch");
  io.mkdir(sd);
  // Child scripts resolve ForgeDock helpers from this install (FORGEDOCK_HOME is authoritative in forge_resolve).
  const env = { ...io.env, FORGE_SCRATCHPAD: sd, FORGEDOCK_HOME: io.root };

  // Phase -1: PR, head SHA, prior passes, route marker, run-keyed pointer
  let pr = a.pr;
  if (pr == null) {
    const n = (await io.gh(["pr", "list", "-R", c.ghRepo, "--head", c.stagingBranch, "--base", c.defaultBranch, "--state", "open", "--json", "number", "--jq", ".[0].number"])).trim();
    if (!/^\d+$/.test(n)) throw new Stop(1, [`review-staging: no open ${c.stagingBranch}->${c.defaultBranch} PR found`]);
    pr = Number(n);
  }
  let head = "";
  try { head = (await io.gh(["pr", "view", String(pr), "-R", c.ghRepo, "--json", "headRefOid", "--jq", ".headRefOid"])).trim(); } catch { /* fail closed below */ }
  if (!SHA_RE.test(head)) throw new Stop(1, [`REVIEW_RESULT: status: BLOCKED, blocker: could not resolve a full head SHA for PR #${pr}; nothing reviewed (fail closed)`]);
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

  const m = { pr, headSha: head, gate, scopeMode: scope.scope_mode, tier: ctx.roster?.tier ?? "full", reason: ctx.roster?.reason ?? "", contextFile: ctxFile, launchedFile, briefs, reentry: priorRoutes > 0 };
  io.out(a.json ? JSON.stringify(m) : buildManifest(m));
  return 0;
}

/** CLI entry: returns the exit code (0 ready to dispatch, 1 blocked/failed, 2 usage). */
export async function reviewStagingFromCli(argv, io = defaultIo()) {
  try {
    return await main(argv, io);
  } catch (e) {
    if (e instanceof Stop) { io.err(e.lines.join("\n")); return e.code; }
    io.err(`review-staging: ${e.message}`);
    return 1;
  }
}
