// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Milestone drift checkpoint (forge#4161). No LLM anywhere: facts that merged lanes already computed are summed, and
 * an issue is filed only when a threshold is crossed.
 *
 * - Summary: each merged milestone lane's merge-time STRUCTURE_DELTA (`result.structure`, lean.mjs recordStructure) is
 *   folded into one `<!-- FORGE:DRIFT {json} -->` block in the GitHub milestone description (GET + PATCH per merge).
 *   The fold is keyed by PR, so a re-fold is a no-op. Text outside the block is kept byte for byte.
 * - Report: `scripts/milestone-drift.sh` recomputes pair growth, new edges and size growth from git (fork point to
 *   the milestone head). The summary only attributes PRs.
 * - Crossings (only with `orchestrate.drift` thresholds): one templated issue per crossing in the milestone,
 *   deduplicated by its `<!-- FORGE:DRIFT:<slug>:<kind>:<key> -->` marker against the milestone's open issues.
 * - block_dispatch (off by default): a queued issue on the same milestone lane whose Affected Files sit under a
 *   flagged package dir is held.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUMMARY_MARKER = "FORGE:DRIFT";
const SUMMARY_RE = /<!-- FORGE:DRIFT (\{[\s\S]*?\}) -->/;
// The summary keeps the largest growth entries only, so the description stays small.
export const MAX_GROWTH_FILES = 50;
const SCRIPT = fileURLToPath(new URL("../../scripts/milestone-drift.sh", import.meta.url));

export const emptySummary = (milestone) => ({ v: 1, milestone, merged: [], pairs: {}, deps_added: [], deps_removed: [], growth: {} });

const arr = (x) => (Array.isArray(x) ? x : []);
const edgeKey = (e) => `${e?.from}:${e?.to}`;

/**
 * Fold one merged run's structure record into the summary (pure; returns a new object). Keyed by PR: a PR already in
 * `merged` leaves the summary unchanged.
 */
export function foldSummary(summary, { issue, pr, milestone, structure }) {
  const s = summary && typeof summary === "object" ? summary : emptySummary(milestone ?? null);
  const merged = arr(s.merged);
  if (pr != null && merged.some((m) => m?.pr === pr)) return s;
  const st = structure ?? {};
  const pairs = { ...(s.pairs ?? {}) };
  const touch = (e, field, n) => {
    if (!e?.from || !e?.to || !(n > 0)) return;
    const k = edgeKey(e), p = pairs[k] ?? { files_added: 0, files_removed: 0, prs: [] };
    pairs[k] = { ...p, [field]: (p[field] ?? 0) + n, prs: field === "files_added" && pr != null && !p.prs.includes(pr) ? [...p.prs, pr] : p.prs };
  };
  for (const e of arr(st.new_edges)) touch(e, "files_added", Number(e?.files) || 0);
  for (const e of arr(st.removed_edges)) touch(e, "files_removed", Number(e?.files) || 0);
  const deps = (old, add) => [...arr(old), ...arr(add).filter((e) => e?.from && e?.to).map((e) => ({ from: e.from, to: e.to, ...(e.kind ? { kind: e.kind } : {}), pr: pr ?? null }))];
  const growth = { ...(s.growth ?? {}) };
  for (const g of arr(st.top_growth)) if (g?.file && Number(g.lines) > 0) growth[g.file] = (growth[g.file] ?? 0) + Number(g.lines);
  const topGrowth = Object.fromEntries(Object.entries(growth).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_GROWTH_FILES));
  return { v: 1, milestone: s.milestone ?? milestone ?? null, merged: [...merged, { issue: issue ?? null, pr: pr ?? null }], pairs,
    deps_added: deps(s.deps_added, st.deps_added), deps_removed: deps(s.deps_removed, st.deps_removed), growth: topGrowth };
}

/** The FORGE:DRIFT summary in a milestone description, or null. */
export function parseSummary(description) {
  const m = SUMMARY_RE.exec(String(description ?? ""));
  if (!m) return null;
  try { const s = JSON.parse(m[1]); return s && typeof s === "object" && !Array.isArray(s) ? s : null; } catch { return null; }
}

/** `description` with its FORGE:DRIFT block replaced (or appended); the text around it is unchanged. */
export function renderSummary(description, summary) {
  const d = String(description ?? "");
  // `>` never appears in the JSON's structure, so escaping it keeps `-->` out of the comment and the JSON valid.
  const block = `<!-- ${SUMMARY_MARKER} ${JSON.stringify(summary).replace(/>/g, "\\u003e")} -->`;
  if (SUMMARY_RE.test(d)) return d.replace(SUMMARY_RE, () => block);
  return d ? `${d}\n\n${block}` : block;
}

export const crossingMarker = (slug, c) => `FORGE:DRIFT:${slug}:${c.kind}:${c.key}`;

/** One issue per crossing: {title, body, marker}. The body is a template (numbers and files from the report). */
export function crossingIssues(report, { slug, milestone }) {
  const fork = String(report?.fork_point ?? "").slice(0, 12);
  const files = arr(report?.files);
  return arr(report?.crossings).map((c) => {
    const marker = crossingMarker(slug, c);
    let evidence = [];
    if (c.kind === "pair_growth") {
      const [from, to] = String(c.key).split("->");
      const p = arr(report?.pairs).find((x) => x.from === from && x.to === to) ?? {};
      evidence = [...arr(p.files).map((f) => `- \`${f}\``), ...(arr(p.prs).length ? [`- PRs: ${p.prs.map((n) => `#${n}`).join(", ")}`] : [])];
    } else if (c.kind === "package_lines") {
      evidence = files.filter((f) => f.package === c.key).map((f) => `- \`${f.path}\` +${f.added} -${f.removed}`);
    } else {
      const f = files.find((x) => x.path === c.key);
      if (f) evidence = [`- \`${f.path}\` +${f.added} -${f.removed}`];
    }
    const what = { pair_growth: "value-import files", package_lines: "lines of growth", file_lines: "lines of growth" }[c.kind] ?? "growth";
    const body = [
      "## Problem", "",
      `\`milestone/${slug}\` (${milestone}) crossed \`orchestrate.drift.${c.kind}\` since its fork point \`${fork}\`: \`${c.key}\` has ${c.value} ${what} (threshold ${c.threshold}). No single PR shows this; found by \`scripts/milestone-drift.sh\` after a lane merged.`, "",
      "## Evidence", "", ...(evidence.length ? evidence : ["- (see `scripts/milestone-drift.sh " + slug + "`)"]), "",
      "## Acceptance Criteria", "",
      `- [ ] \`scripts/milestone-drift.sh ${slug}\` no longer reports \`${c.kind}\` for \`${c.key}\`, or the growth is recorded as intended in the repo's architecture doc`, "",
      `<!-- ${marker} -->`,
    ].join("\n");
    return { title: `drift(milestone/${slug}): ${c.kind} ${c.key} ${c.value} > ${c.threshold}`, body, marker, kind: c.kind, key: c.key };
  });
}

/**
 * File the crossings that no open issue of the milestone carries yet: one `gh issue list` read, one create per new
 * crossing. `seen` (markers filed earlier in this process) guards against a list that lags a fresh create.
 * @returns {Promise<{filed: Array<{marker:string, number:?number}>, skipped: string[]}>}
 */
export async function fileCrossings({ gh, repo, milestone, issues, seen = new Set() }) {
  if (!issues.length) return { filed: [], skipped: [] };
  const open = JSON.parse(String(await gh(["issue", "list", "-R", repo, "--milestone", milestone, "--state", "open", "--limit", "500", "--json", "number,body"])) || "[]");
  const bodies = arr(open).map((x) => String(x?.body ?? ""));
  const filed = [], skipped = [];
  for (const it of issues) {
    if (seen.has(it.marker) || bodies.some((b) => b.includes(`<!-- ${it.marker} -->`))) { skipped.push(it.marker); continue; }
    const out = String(await gh(["issue", "create", "-R", repo, "--title", it.title, "--body", it.body, "--milestone", milestone]));
    seen.add(it.marker);
    filed.push({ marker: it.marker, number: Number(/\/issues\/(\d+)/.exec(out)?.[1]) || null });
  }
  return { filed, skipped };
}

/** Package dirs a report flags: package_lines crossings and the importing side of pair_growth crossings. */
export function flaggedPackages(report) {
  return [...new Set(arr(report?.crossings).filter((c) => (c.kind === "package_lines" || c.kind === "pair_growth") && c.package_path).map((c) => c.package_path))].sort();
}

/** The first flagged package dir that one of `files` sits under (or names), else null. */
export function heldBy(files, flagged) {
  for (const d of arr(flagged)) if (arr(files).some((f) => f === d || String(f).startsWith(`${d}/`))) return d;
  return null;
}

/** {number, description} of the milestone titled `title`, or null. One `gh api` read. */
export async function readMilestone({ gh, repo, title }) {
  const list = JSON.parse(String(await gh(["api", `repos/${repo}/milestones?state=all&per_page=100`])) || "[]");
  const m = arr(list).find((x) => x?.title === title);
  return m ? { number: m.number, description: m.description ?? "" } : null;
}

const defaultRunScript = (args, { cwd }) => new Promise((res, rej) => {
  execFile("bash", [SCRIPT, ...args], { cwd, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => (e ? rej(e) : res(stdout)));
});

/**
 * The orchestrate seam: `{ onMerged(issue, row, result), holds? }`. `config` is engine-cli `readDrift()` (null: the
 * summary only, no script run, no issue, no hold). `holds` exists only with `config.blockDispatch`. Calls to onMerged
 * are serialised, so parallel merges never race on the milestone description.
 */
export function makeDrift({ repo, cwd, io, config = null, stagingBranch = "staging", affectedFiles = () => [], runScript = defaultRunScript, onEvent = () => {} }) {
  const flagged = new Map(); // lane -> flagged package dirs (from the last report of that milestone)
  const seen = new Set();
  let chain = Promise.resolve();
  const thresholds = config && ["pairGrowth", "packageLines", "fileLines"].some((k) => config[k] != null);

  async function check(issue, row, result) {
    const lane = String(result?.lane ?? row?.lane ?? "");
    const title = result?.milestone;
    if (!lane.startsWith("milestone/") || !title || !result?.structure) return null;
    const slug = lane.slice("milestone/".length);
    const ms = await readMilestone({ gh: io.gh, repo, title });
    if (!ms) { onEvent({ issue, detail: `drift: milestone "${title}" not found` }); return null; }
    const before = parseSummary(ms.description);
    const summary = foldSummary(before ?? emptySummary(title), { issue, pr: result.pr ?? row?.pr ?? null, milestone: title, structure: result.structure });
    if (summary !== before) await io.gh(["api", "-X", "PATCH", `repos/${repo}/milestones/${ms.number}`, "-f", `description=${renderSummary(ms.description, summary)}`]);
    if (!thresholds) return { summary };
    for (const b of [lane, stagingBranch]) { try { await io.git(["fetch", "origin", b], { cwd }); } catch { /* offline: the local refs */ } }
    const dir = mkdtempSync(join(tmpdir(), "milestone-drift-")), file = join(dir, "summary.json");
    let report;
    try {
      writeFileSync(file, JSON.stringify(summary));
      const t = (flag, v) => (v != null ? [flag, String(v)] : []);
      report = JSON.parse(String(await runScript([slug, "--summary", file, ...t("--pair-growth", config.pairGrowth), ...t("--package-lines", config.packageLines), ...t("--file-lines", config.fileLines)], { cwd })));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    flagged.set(lane, flaggedPackages(report));
    const filed = await fileCrossings({ gh: io.gh, repo, milestone: title, issues: crossingIssues(report, { slug, milestone: title }), seen });
    if (filed.filed.length) onEvent({ issue, detail: `drift: filed ${filed.filed.map((f) => (f.number ? `#${f.number}` : f.marker)).join(", ")}` });
    return { summary, report, ...filed };
  }

  const seam = {
    onMerged(issue, row, result) {
      const p = chain.then(() => check(issue, row, result));
      chain = p.catch(() => {});
      return p;
    },
  };
  if (config?.blockDispatch) {
    seam.holds = (issue, { body, lane }) => {
      const f = flagged.get(lane);
      return f?.length ? heldBy(affectedFiles(body), f) : null;
    };
  }
  return seam;
}
