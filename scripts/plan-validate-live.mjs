#!/usr/bin/env node
/**
 * scripts/plan-validate-live.mjs — bootstrap-validate's dependency-order rules on LIVE GitHub state (#4659)
 *
 * `forgedock plan validate --live` and the parallel-start gate in `forgedock orchestrate`. Deterministic, no LLM.
 * Milestone (train) order: due_on ascending (nulls last), then milestone number; GitHub has no explicit order field.
 * Each cross-milestone `Depends on` edge is `ok` (dep in an earlier milestone and closed), `held` (earlier, not
 * shipped) or `invalid` (dep in a later milestone). Edges are read with the engine's parseDependsOn.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDependsOn } from "../bin/engine/phases.mjs";

/** Milestones in train order. Input: [{ title, number, due_on }]. */
export function orderMilestones(milestones) {
  const due = (m) => (m?.due_on ? Date.parse(m.due_on) : Infinity);
  return [...milestones].sort((a, b) => (due(a) - due(b) || 0) || (a.number ?? 0) - (b.number ?? 0)).map((m) => m.title);
}

/**
 * @param {{ order: string[], issues: Array<{ number: number, milestone: string|null, body?: string, state?: string }> }} live
 * @returns {{ ok: boolean, edges: Array<{ from: number, to: number, fromMilestone: string, toMilestone: string, state: "ok"|"held"|"invalid" }> }}
 */
export function classifyEdges({ order, issues }) {
  const index = new Map(order.map((t, i) => [t, i]));
  const byNumber = new Map(issues.map((it) => [it.number, it]));
  const edges = [];
  for (const it of issues) {
    if (!it.milestone || !index.has(it.milestone)) continue;
    for (const n of parseDependsOn(it.body, it.number)) {
      const dep = byNumber.get(n);
      if (!dep?.milestone || dep.milestone === it.milestone || !index.has(dep.milestone)) continue;
      const state = index.get(dep.milestone) > index.get(it.milestone) ? "invalid"
        : String(dep.state).toUpperCase() === "CLOSED" ? "ok" : "held";
      edges.push({ from: it.number, to: n, fromMilestone: it.milestone, toMilestone: dep.milestone, state });
    }
  }
  return { ok: !edges.some((e) => e.state === "invalid"), edges };
}

export function formatLiveReport({ edges }) {
  if (!edges.length) return "plan validate --live: no cross-milestone edges";
  const lines = edges.map((e) => `${e.state}: #${e.from} (${e.fromMilestone}) depends on #${e.to} (${e.toMilestone})`);
  const n = (s) => edges.filter((e) => e.state === s).length;
  return `${lines.join("\n")}\nplan validate --live: ${n("ok")} ok, ${n("held")} held, ${n("invalid")} invalid`;
}

const parse = (s) => { try { return JSON.parse(String(s)); } catch { return null; } };

/** Read milestones and all issues of `repo` through `gh` (injectable: async (args) => stdout). */
export async function readLive({ gh, repo }) {
  const r = repo ? ["-R", repo] : [];
  const ms = parse(await gh(["api", `repos/${repo || "{owner}/{repo}"}/milestones?state=all&per_page=100`, "--paginate", "--slurp"]));
  const issues = parse(await gh(["issue", "list", ...r, "--state", "all", "--limit", "1000", "--json", "number,body,state,milestone"]));
  if (!Array.isArray(ms) || !Array.isArray(issues)) throw new Error("could not read milestones/issues from GitHub");
  return { order: orderMilestones(ms.flat()), issues: issues.map((i) => ({ ...i, milestone: i.milestone?.title ?? null })) };
}

/**
 * Parallel-start gate: dependencies of `issues` (not themselves in the batch) that are not merged into `baseOf(issue)`.
 * A dep is merged when it is CLOSED by a PR that is merged with that base. Unreadable issues are skipped (fail open:
 * the engine's own openDependency still guards each lane); an unreadable dep counts as unmet.
 * @returns {Promise<Array<{ issue: number, dep: number, base: string, why: string }>>}
 */
export async function unmetDependencies({ issues, baseOf, gh, repo }) {
  const r = repo ? ["-R", repo] : [];
  const view = async (n, fields) => parse(await gh(["issue", "view", String(n), ...r, "--json", fields]));
  const inBatch = new Set(issues);
  const unmet = [];
  for (const n of issues) {
    let rec;
    try { rec = await view(n, "body,milestone"); } catch { rec = null; }
    if (!rec || !rec.milestone) continue;
    const base = await baseOf(n);
    if (!base) continue;
    for (const dep of parseDependsOn(rec.body, n).filter((d) => !inBatch.has(d))) {
      let why = null;
      try {
        const d = await view(dep, "state,closedByPullRequestsReferences");
        if (String(d?.state).toUpperCase() !== "CLOSED") why = "not closed";
        else {
          let merged = false;
          for (const pr of d.closedByPullRequestsReferences ?? []) {
            const p = parse(await gh(["pr", "view", String(pr.number), ...r, "--json", "baseRefName,mergedAt"]));
            if (p?.mergedAt && p.baseRefName === base) { merged = true; break; }
          }
          if (!merged) why = `closed but not merged into ${base}`;
        }
      } catch { why = "unreadable"; }
      if (why) unmet.push({ issue: n, dep, base, why });
    }
  }
  return unmet;
}

const ghExec = async (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024, timeout: 60000 });

/** CLI body: `plan validate --live [--repo owner/repo] [--json]`. Returns the exit code (1 when any edge is invalid). */
export async function runLive(argv, { gh = ghExec, out = (t) => process.stdout.write(`${t}\n`), err = (t) => process.stderr.write(`${t}\n`) } = {}) {
  if (argv[0] !== "validate" || !argv.includes("--live")) { err("usage: forgedock plan validate --live [--repo owner/repo] [--json]"); return 2; }
  const i = argv.indexOf("--repo");
  const repo = i >= 0 ? argv[i + 1] : "";
  let report;
  try { report = classifyEdges(await readLive({ gh, repo })); } catch (e) { err(`plan validate --live: ${e.message}`); return 2; }
  out(argv.includes("--json") ? JSON.stringify(report) : formatLiveReport(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runLive(process.argv.slice(2));
}
