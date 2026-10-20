// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forgedock stats (forge#3835): a deterministic version-over-version report, no model in the loop.
 * GitHub is the primary source (trusted FORGE:TELEMETRY comments + labels); ~/.forge/stats-cache is an optional,
 * deletable cache; ~/.forge/runs is an optional extra source for runs that predate telemetry.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aggregate, DEFAULT_MIN_N } from "./aggregate.mjs";
import { fetchGithubRecords, isValidRepo, toModel } from "./github-source.mjs";
import { readLocalRuns, runsDir } from "./local-source.mjs";
import { renderCompact, renderJson, renderMarkdown } from "./render.mjs";
import { edgeQuery, parseEdge, verdictMix } from "./query.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export const HELP = `Usage: forgedock stats [--since <version|date>] [--repo <owner/repo>] [--json] [--refresh]
                      [--compact] [--no-local] [--no-cache] [--min-n N] [--release-times FILE]

Version-over-version report: Cost, Time, Flow, Review funnel, Gates and Issue flow per (version, repo), with a
delta against the previous version and a low-n flag for samples under 10. Missing data prints n/a.

  --since <v|date>      only versions >= <v> (e.g. 1.16.0) or activity on/after <date> (YYYY-MM-DD);
                        also bounds the GitHub crawl to that window
  --repo <owner/repo>   target repo (default: forge.yaml project, else the git origin remote)
  --json                machine-readable output
  --refresh             ignore the local cache and re-read everything from GitHub
  (progress is printed to stderr while crawling)
  --compact             one-row-per-version table (embedded in the staging review summary)
  --no-local            ignore ~/.forge/runs (FORGE_RUNS_DIR)
  --no-cache            do not read or write ~/.forge/stats-cache
  --min-n N             low-n threshold (default ${DEFAULT_MIN_N})
  --release-times FILE  "<version> <epoch-seconds>" lines used to estimate versions of unversioned records
                        (default: git tags v* of the ForgeDock checkout)

Audit queries (forge#4165; JSON, from structure_delta / run_terminal telemetry, no comment bodies read):
  --edge FROM:TO        merged PRs that added the dependency or import edge FROM -> TO (e.g. @s/web:@s/db)
  --milestone M         conformance verdict mix and per-day structure series for milestone M
`;

export function parseArgs(argv) {
  const o = { since: null, repo: null, edge: null, milestone: null, json: false, refresh: false, compact: false, local: true, cache: true, minN: DEFAULT_MIN_N, releaseTimes: null, help: false };
  const val = (i, name) => {
    const v = argv[i + 1];
    if (v == null || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : null;
    const name = eq ? eq[0] : a;
    const take = () => { if (eq) return eq[1]; const v = val(i, name); i++; return v; };
    if (name === "--since") o.since = take();
    else if (name === "--repo") o.repo = take();
    else if (name === "--release-times") o.releaseTimes = take();
    else if (name === "--edge") { const v = take(); if (!parseEdge(v)) throw new Error("--edge must be FROM:TO"); o.edge = v; }
    else if (name === "--milestone") o.milestone = take();
    else if (name === "--min-n") { const v = take(); if (!/^\d+$/.test(v)) throw new Error("--min-n must be a non-negative integer"); o.minN = Number(v); }
    else if (name === "--json") o.json = true;
    else if (name === "--refresh") o.refresh = true;
    else if (name === "--compact") o.compact = true;
    else if (name === "--no-local") o.local = false;
    else if (name === "--no-cache") o.cache = false;
    else if (name === "--help" || name === "-h") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/** "--since" is a date (YYYY-MM-DD[...]) or a version (1.16.0). */
export function parseSince(since) {
  if (!since) return {};
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
    const ms = Date.parse(since);
    if (Number.isNaN(ms)) throw new Error(`invalid --since date: ${since}`);
    return { sinceMs: ms };
  }
  if (/^v?\d+(\.\d+)*$/.test(since)) return { sinceVersion: since.replace(/^v/, "") };
  throw new Error(`--since must be a version (1.16.0) or a date (YYYY-MM-DD): ${since}`);
}

export function parseReleaseTimes(text) {
  return String(text ?? "").split("\n").map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 2 && /^\d+$/.test(p[1])).map((p) => ({ v: p[0].replace(/^v/, ""), t: Number(p[1]) }));
}

// A version --since becomes the tag's release time minus this margin: unversioned records are placed by release time, so
// the crawl must start a little before the tag.
const VERSION_SINCE_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * Lower-bound timestamp for the GitHub crawl from `--since`: a date as is, a version as its tag time minus a margin.
 * Returns { since: ISO | null, note }: since null means a full crawl (no --since, or a version with no known tag time).
 */
export function sinceToTimestamp(since, releaseTimes = []) {
  const p = parseSince(since);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (p.sinceMs != null) return { since: iso(p.sinceMs), note: null };
  if (p.sinceVersion) {
    const hit = releaseTimes.find((r) => r.v === p.sinceVersion);
    if (hit) return { since: iso(hit.t * 1000 - VERSION_SINCE_MARGIN_MS), note: null };
    return { since: null, note: `no release time known for ${p.sinceVersion}; crawling the full history (pass --release-times or use a date to bound it)` };
  }
  return { since: null, note: null };
}

/** Throttled stderr progress printer (never stdout, so --json stays parseable). */
export function makeProgressPrinter(write = (t) => process.stderr.write(t), now = Date.now) {
  let last = 0, lastPhase = null;
  return ({ phase, done, total }) => {
    const t = now();
    const final = total != null && done >= total;
    if (phase === lastPhase && !final && t - last < 2000) return;
    last = t; lastPhase = phase;
    write(`forgedock stats: ${phase} ${done}${total != null ? `/${total}` : ""}\n`);
  };
}

function gitTagTimes() {
  try {
    const out = execFileSync("git", ["-C", join(here, "..", ".."), "for-each-ref", "refs/tags", "--format=%(refname:short) %(creatordate:unix)"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseReleaseTimes(out.split("\n").filter((l) => /^v\d/.test(l)).join("\n"));
  } catch { return []; }
}

/** --repo, else forge.yaml project.owner/repo, else the git origin remote. */
export function resolveRepo(explicit, cwd = process.cwd()) {
  if (explicit) return explicit;
  for (const f of ["forge.yaml", ".forge.yaml"]) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    try {
      const m = /^project:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(readFileSync(p, "utf8"));
      const owner = /^[ \t]+owner:\s*"?([\w.-]+)"?/m.exec(m?.[1] ?? "")?.[1];
      const repo = /^[ \t]+repo:\s*"?([\w.-]+)"?/m.exec(m?.[1] ?? "")?.[1];
      if (owner && repo) return `${owner}/${repo}`;
    } catch { /* fall through */ }
  }
  try {
    const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
    if (m) return `${m[1]}/${m[2]}`;
  } catch { /* none */ }
  return null;
}

/** Build the report object. deps: { gh, env, localRuns, now, onProgress, warn, sleep } for tests. Never touches the network when `gh` is stubbed. */
export async function buildReport(opts, deps = {}) {
  const env = deps.env ?? process.env;
  const repo = opts.repo;
  let releaseTimes = [];
  if (opts.releaseTimes) releaseTimes = parseReleaseTimes(readFileSync(opts.releaseTimes, "utf8"));
  else if (deps.releaseTimes) releaseTimes = deps.releaseTimes;
  else releaseTimes = gitTagTimes();
  const bound = sinceToTimestamp(opts.since, releaseTimes);
  if (bound.note) (deps.warn ?? ((m) => process.stderr.write(`forgedock stats: ${m}\n`)))(bound.note);
  const gh = await fetchGithubRecords({ repo, since: bound.since, refresh: opts.refresh, useCache: opts.cache, gh: deps.gh, env,
    onProgress: deps.onProgress, sleep: deps.sleep, now: deps.now });
  if (opts.edge || opts.milestone) { // forge#4165: audit query instead of the version report
    const e = opts.edge ? parseEdge(opts.edge) : null;
    const query = { ...(e ? { edge: { ...e, prs: edgeQuery(gh.records, e.from, e.to) } } : {}), ...(opts.milestone ? { mix: verdictMix(gh.records, gh.items, opts.milestone) } : {}) };
    return { repo, sources: { github: { items: gh.items.length, records: gh.records.length, cached: gh.fromCache } }, query };
  }
  const model = toModel(repo, gh);
  const ghKeys = new Set(model.runs.map((r) => `${r.repo}#${r.issue}`));
  let local = [];
  if (opts.local) {
    local = (deps.localRuns ?? readLocalRuns(runsDir(env))).filter((r) => r.repo === repo && !ghKeys.has(`${r.repo}#${r.issue}`));
  }
  const report = aggregate({ runs: [...model.runs, ...local], events: model.events, issues: model.issues },
    { minN: opts.minN, releaseTimes, ...parseSince(opts.since) });
  return { repo, sources: { github: { items: gh.items.length, records: gh.records.length, cached: gh.fromCache }, local: { runs: local.length } }, ...report };
}

export async function runStats(argv, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) {
    process.stderr.write(`forgedock stats: ${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) { process.stdout.write(HELP); return 0; }
  opts.repo = resolveRepo(opts.repo);
  if (!opts.repo || !isValidRepo(opts.repo)) {
    process.stderr.write(`forgedock stats: could not resolve a valid owner/repo (pass --repo owner/repo)\n`);
    return 2;
  }
  try {
    const report = await buildReport(opts, { onProgress: makeProgressPrinter(), ...deps });
    process.stdout.write(`${opts.json || report.query ? renderJson(report) : opts.compact ? renderCompact(report) : renderMarkdown(report)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`forgedock stats: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runStats(process.argv.slice(2));
}
