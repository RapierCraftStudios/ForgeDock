// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Milestone integration runs (forge#4667). No LLM anywhere. Under "fast lane gate, heavy ship gate" the whole e2e suite
 * only runs at the ship PR; this runs it (report-only) on every active milestone branch on a schedule or every N lane
 * merges, so integration failures surface while the milestone is still open.
 *
 * - Config: forge.yaml `ci:` / `milestone_integration:` block (the parser flattens its keys under `ci`); inert without `workflow`.
 * - State: one `<!-- FORGE:INTEGRATION {json} -->` block in the GitHub milestone description (GitHub is the register):
 *   lastRun, lastGreen {sha, at, url}, redStreak, mergesSince, mergedPrs, issue.
 * - Red run: ONE `integration-red` issue per milestone (marker FORGE:INTEGRATION:<slug>), created or its body updated,
 *   with the failing specs and the merge range. Green: the issue is commented and closed, the streak resets.
 * - block_admission_after: the orchestrate seam `holds` refuses new lanes of the milestone while the red streak is at
 *   or over N, until a green run.
 * The workflow is dispatched on the milestone branch and awaited through runCiVerify (verify.mjs).
 */
import { milestoneSlug, readBranches, DEFAULT_FEATURE_PATTERN } from "./lane.mjs";
import { readMilestone } from "./drift.mjs";
import { runCiVerify } from "./verify.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_MARKER = "FORGE:INTEGRATION";
export const RED_LABEL = "integration-red";
const STATE_RE = /<!-- FORGE:INTEGRATION (\{[\s\S]*?\}) -->/;
const MAX_PRS = 100;

const arr = (x) => (Array.isArray(x) ? x : []);
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const posInt = (v) => { const n = Number(v); return str(v) !== "" && Number.isInteger(n) && n > 0 ? n : null; };
const short = (s) => String(s ?? "").slice(0, 7);

/**
 * forge.yaml `ci` section → {workflow, project, projectInput, intervalHours, everyMerges, blockAdmissionAfter, maxMinutes}
 * or null when no valid `workflow` is configured (the feature is off: nothing runs, files or holds).
 */
export function parseIntegration(sec) {
  const s = sec && typeof sec === "object" ? sec : {};
  const workflow = /^[A-Za-z0-9._/-]+$/.test(str(s.workflow)) ? str(s.workflow) : null;
  if (!workflow) return null;
  const hours = Number(s.interval_hours);
  return {
    workflow,
    project: str(s.project) || null,
    projectInput: /^[A-Za-z_][A-Za-z0-9_-]*$/.test(str(s.project_input)) ? str(s.project_input) : "project",
    intervalHours: str(s.interval_hours) !== "" && Number.isFinite(hours) && hours > 0 ? hours : 24,
    everyMerges: posInt(s.every_merges),
    blockAdmissionAfter: posInt(s.block_admission_after),
    maxMinutes: posInt(s.max_minutes) ?? 360,
  };
}

/** forge.yaml `ci:` of the checkout through parseIntegration; null when absent or unreadable. */
export function readIntegrationConfig(cwd = process.cwd()) {
  try { return parseIntegration(parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.ci); } catch { return null; }
}

export const emptyState = () => ({ v: 1, lastRun: null, lastGreen: null, redStreak: 0, mergesSince: 0, mergedPrs: [], issue: null });

/** The FORGE:INTEGRATION state in a milestone description (defaults filled), or null when there is no block. */
export function parseIntegrationState(description) {
  const m = STATE_RE.exec(String(description ?? ""));
  if (!m) return null;
  try { const s = JSON.parse(m[1]); return s && typeof s === "object" && !Array.isArray(s) ? { ...emptyState(), ...s } : null; } catch { return null; }
}

/** `description` with its FORGE:INTEGRATION block replaced (or appended); the text around it is unchanged. */
export function renderState(description, state) {
  const d = String(description ?? "");
  const block = `<!-- ${STATE_MARKER} ${JSON.stringify(state).replace(/>/g, "\\u003e")} -->`;
  if (STATE_RE.test(d)) return d.replace(STATE_RE, () => block);
  return d ? `${d}\n\n${block}` : block;
}

/** Due when never run, `intervalHours` elapsed, or `everyMerges` lane merges since the last run. */
export function isDue(state, cfg, nowMs) {
  const s = state ?? emptyState();
  if (!s.lastRun?.at) return { due: true, reason: "never run" };
  if (cfg.everyMerges && s.mergesSince >= cfg.everyMerges) return { due: true, reason: `${s.mergesSince} lane merge(s) since the last run` };
  const age = nowMs - Date.parse(s.lastRun.at);
  if (!Number.isFinite(age) || age >= cfg.intervalHours * 3600000) return { due: true, reason: `last run ${Number.isFinite(age) ? `${Math.round(age / 3600000)}h` : "unknown"} ago` };
  return { due: false, reason: "not due" };
}

const SPEC_RE = /[\w@./-]+\.(?:e2e-spec|e2e|spec|test)\.[cm]?[jt]sx?/g;
/** Spec files named in the failed-job logs (sorted, at most 50). */
export function failingSpecs(failures) {
  const out = new Set();
  for (const f of arr(failures)) for (const m of String(f?.log ?? "").match(SPEC_RE) ?? []) out.add(m.replace(/^\.\//, ""));
  return [...out].sort().slice(0, 50);
}

export const redMarker = (slug) => `${STATE_MARKER}:${slug}`;

/** Title and body of the integration-red issue. */
export function redIssue({ slug, milestone, head, state, failures, specs, runUrl, repo, at }) {
  const g = state.lastGreen;
  const range = g?.sha ? `\`${short(g.sha)}..${short(head)}\` ([compare](https://github.com/${repo}/compare/${g.sha}...${head}))` : `no green run yet; up to \`${short(head)}\``;
  const prs = arr(state.mergedPrs);
  const body = [
    `The scheduled full-suite integration run on \`milestone/${slug}\` is red (${state.redStreak} consecutive red run${state.redStreak === 1 ? "" : "s"}). The run is report-only.`, "",
    `- Run: ${runUrl ?? "n/a"} at \`${short(head)}\` (${at})`,
    `- Merge range since the last green run: ${range}`,
    `- Lane PRs merged in that range: ${prs.length ? prs.map((p) => `#${p}`).join(", ") : "none recorded"}`,
    `- Failing jobs: ${arr(failures).map((f) => f.job).filter(Boolean).join(", ") || "n/a"}`, "",
    "### Failing specs", "", ...(specs.length ? specs.map((s) => `- \`${s}\``) : ["- none named in the failed-job logs; see the run"]), "",
    "This issue is a ship-gate risk for the milestone and closes itself on the next green integration run.", "",
    `<!-- ${redMarker(slug)} -->`,
  ].join("\n");
  return { title: `integration-red(milestone/${slug}): full suite failing at ${short(head)}`, body, marker: redMarker(slug), milestone };
}

/** Open issue of the milestone carrying `marker`: its number, or null. */
async function findRed({ gh, repo, milestone, marker }) {
  const open = JSON.parse(String(await gh(["issue", "list", "-R", repo, "--milestone", milestone, "--state", "open", "--limit", "500", "--json", "number,body"])) || "[]");
  const hit = arr(open).find((x) => String(x?.body ?? "").includes(`<!-- ${marker} -->`));
  return hit ? Number(hit.number) : null;
}

/** Create the one integration-red issue, or replace the body of the open one. Resolves its number. */
export async function fileOrUpdateRed({ gh, repo, issue }) {
  const n = await findRed({ gh, repo, milestone: issue.milestone, marker: issue.marker });
  if (n) { await gh(["issue", "edit", String(n), "-R", repo, "--title", issue.title, "--body", issue.body]); return { number: n, created: false }; }
  const base = ["issue", "create", "-R", repo, "--title", issue.title, "--body", issue.body, "--milestone", issue.milestone];
  let out;
  try { out = String(await gh([...base, "--label", RED_LABEL])); } catch { out = String(await gh(base)); } // the label may not exist in the repo yet
  return { number: Number(/\/issues\/(\d+)/.exec(out)?.[1]) || null, created: true };
}

/** Green: comment on and close the open integration-red issue of the milestone, if any. */
export async function closeRed({ gh, repo, milestone, slug, head }) {
  const n = await findRed({ gh, repo, milestone, marker: redMarker(slug) });
  if (n) await gh(["issue", "close", String(n), "-R", repo, "--comment", `Integration run green at \`${short(head)}\`; closing.`]);
  return n;
}

const branchOf = (pattern, title) => { const slug = milestoneSlug(title); return slug ? { slug, branch: String(pattern || DEFAULT_FEATURE_PATTERN).replace("{slug}", slug) } : null; };

/** Head SHA of `branch`, or null when it does not exist. */
async function branchHead(gh, repo, branch) {
  try { return str(await gh(["api", `repos/${repo}/branches/${encodeURIComponent(branch)}`, "--jq", ".commit.sha"])) || null; } catch { return null; }
}

/**
 * One integration run of one milestone: dispatch, wait, record. Resolves {title, ran, result, detail, state}. `ran` is
 * false when the milestone is skipped (no branch, not due); a timeout or unavailable run records nothing and retries next time.
 */
export async function runMilestone({ io, repo, ms, cfg, pattern, nowFn = () => Date.now(), sleep, random, force = false, onPoll }) {
  const gh = io.gh, b = branchOf(pattern, ms.title);
  if (!b) return { title: ms.title, ran: false, detail: "milestone gives an empty branch slug" };
  const head = await branchHead(gh, repo, b.branch);
  if (!head) return { title: ms.title, ran: false, detail: `branch ${b.branch} not found` };
  const before = parseIntegrationState(ms.description) ?? emptyState();
  const due = isDue(before, cfg, nowFn());
  if (!force && !due.due) return { title: ms.title, ran: false, detail: due.reason, state: before };
  const v = await runCiVerify({ io, branch: b.branch, head, changedFiles: [cfg.project ?? "integration"], verify: { workflow: cfg.workflow, pathsInput: cfg.project ? cfg.projectInput : null, skipPaths: [] },
    ciMaxMinutes: cfg.maxMinutes, now: nowFn, sleep, random, ...(onPoll ? { onPoll } : {}) });
  if (v.result !== "pass" && v.result !== "fail") return { title: ms.title, ran: true, result: v.result, detail: v.detail, state: before };
  const at = new Date(nowFn()).toISOString();
  const state = { ...before, lastRun: { sha: head, at, result: v.result, url: v.runUrl ?? null }, mergesSince: 0 };
  if (v.result === "pass") {
    state.lastGreen = { sha: head, at, url: v.runUrl ?? null }; state.redStreak = 0; state.mergedPrs = []; state.issue = null;
    await closeRed({ gh, repo, milestone: ms.title, slug: b.slug, head });
  } else {
    state.redStreak = (before.redStreak ?? 0) + 1;
    const specs = failingSpecs(v.failures);
    const filed = await fileOrUpdateRed({ gh, repo, issue: redIssue({ slug: b.slug, milestone: ms.title, head, state: { ...state, blockAdmissionAfter: cfg.blockAdmissionAfter }, failures: v.failures, specs, runUrl: v.runUrl, repo, at }) });
    state.issue = filed.number;
  }
  await gh(["api", "-X", "PATCH", `repos/${repo}/milestones/${ms.number}`, "-f", `description=${renderState(ms.description, state)}`]);
  return { title: ms.title, ran: true, result: v.result, detail: v.detail, state };
}

/** Every open milestone → {number, title, description}. */
export async function listOpenMilestones({ gh, repo }) {
  return arr(JSON.parse(String(await gh(["api", `repos/${repo}/milestones?state=open&per_page=100`])) || "[]")).map((m) => ({ number: m.number, title: m.title, description: m.description ?? "" }));
}

/** Run every due active milestone (optionally only `only`, a title). Sequential: one suite at a time. Resolves the per-milestone results. */
export async function runIntegration({ io, repo, cfg, pattern, only = null, ...rest }) {
  if (!cfg) return [];
  const out = [];
  for (const ms of await listOpenMilestones({ gh: io.gh, repo })) {
    if (only && ms.title !== only) continue;
    try { out.push(await runMilestone({ io, repo, ms, cfg, pattern, ...rest })); } catch (e) { out.push({ title: ms.title, ran: false, detail: `failed: ${String(e?.message ?? e).slice(0, 200)}` }); }
  }
  return out;
}

/**
 * The orchestrate seam: `{ onMerged(issue, row, result), holds(issue, {lane}), prime(), settle() }`, or null when `cfg` is null.
 * onMerged counts the merge into the milestone state and, at `every_merges`, starts a run in the background (never in the
 * lane's slot); `settle()` waits for those. `prime()` loads the red streaks `holds` reads (synchronously) from the milestones.
 */
export function makeIntegration({ repo, io, cfg, pattern = DEFAULT_FEATURE_PATTERN, nowFn = () => Date.now(), sleep, random, onEvent = () => {} }) {
  if (!cfg) return null;
  const streaks = new Map(); // lane -> consecutive red runs
  const running = new Set();
  const pending = new Set();
  let chain = Promise.resolve();
  const lane = (title) => { const b = branchOf(pattern, title); return b ? b.branch : null; };
  const note = (ms, state) => { const l = lane(ms.title); if (l) streaks.set(l, state?.redStreak ?? 0); };

  async function count(issue, result) {
    const title = result?.milestone;
    if (!title) return;
    const ms = await readMilestone({ gh: io.gh, repo, title });
    if (!ms) return;
    const full = { ...ms, title };
    const s = parseIntegrationState(ms.description) ?? emptyState();
    const pr = result.pr ?? null;
    const next = { ...s, mergesSince: (s.mergesSince ?? 0) + 1, mergedPrs: pr != null && !s.mergedPrs.includes(pr) ? [...s.mergedPrs, pr].slice(-MAX_PRS) : s.mergedPrs };
    const desc = renderState(ms.description, next);
    await io.gh(["api", "-X", "PATCH", `repos/${repo}/milestones/${ms.number}`, "-f", `description=${desc}`]);
    note(full, next);
    if (!cfg.everyMerges || next.mergesSince < cfg.everyMerges || running.has(title)) return;
    running.add(title);
    const p = runMilestone({ io, repo, ms: { ...full, description: desc }, cfg, pattern, nowFn, sleep, random })
      .then((r) => { if (r.state) note(full, r.state); onEvent({ issue, detail: `integration: ${title} ${r.result ?? r.detail}` }); })
      .catch((e) => onEvent({ issue, detail: `integration run failed: ${String(e?.message ?? e).slice(0, 200)}` }))
      .finally(() => { running.delete(title); pending.delete(p); });
    pending.add(p);
  }

  return {
    onMerged(issue, row, result) {
      const p = chain.then(() => count(issue, result));
      chain = p.catch(() => {});
      return p;
    },
    holds(issue, { lane: l } = {}) {
      if (!cfg.blockAdmissionAfter) return null;
      const n = streaks.get(String(l ?? ""));
      return n >= cfg.blockAdmissionAfter ? `${n} consecutive red integration runs on ${l}` : null;
    },
    async prime() {
      for (const ms of await listOpenMilestones({ gh: io.gh, repo })) note(ms, parseIntegrationState(ms.description));
    },
    async settle() { await chain; while (pending.size) await Promise.allSettled([...pending]); },
  };
}

/**
 * `forgedock integration run [--repo owner/repo] [--milestone TITLE] [--force]`: one pass over the active milestones, for
 * cron or a GitHub Actions schedule. Prints one line per milestone. Resolves the exit code (1 when a run was red).
 * `forgedock integration status [--repo owner/repo]`: the last green full-suite run of each active milestone (those with
 * a state block, or all when `ci.workflow` is set), for /pipeline-status.
 */
export async function runIntegrationCli(argv, deps = {}) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  if (argv[0] === "status") {
    const repo = val("--repo") ?? deps.repo;
    if (!repo) throw new Error("integration needs the repo: pass --repo owner/repo");
    const io = deps.io ?? (await import("./effects.mjs")).makeLeanIo({ repo });
    const on = deps.cfg !== undefined ? !!deps.cfg : !!readIntegrationConfig(deps.cwd ?? process.cwd());
    for (const ms of await listOpenMilestones({ gh: io.gh, repo })) {
      const s = parseIntegrationState(ms.description);
      if (s || on) (deps.print ?? ((t) => console.log(t)))(`  integration: ${ms.title}: last green full-suite run ${s?.lastGreen?.at ?? "never"} (red streak ${s?.redStreak ?? 0})`);
    }
    return 0;
  }
  if (argv[0] !== "run") throw new Error("usage: forgedock integration run|status [--repo owner/repo] [--milestone TITLE] [--force]");
  const cwd = deps.cwd ?? process.cwd();
  const cfg = deps.cfg !== undefined ? deps.cfg : readIntegrationConfig(cwd);
  const print = deps.print ?? ((t) => console.log(t));
  if (!cfg) { print("integration: no ci.workflow configured in forge.yaml; nothing to run"); return 0; }
  const repo = val("--repo") ?? deps.repo;
  if (!repo) throw new Error("integration needs the repo: pass --repo owner/repo");
  const io = deps.io ?? (await import("./effects.mjs")).makeLeanIo({ repo });
  const pattern = deps.pattern ?? readBranches(cwd).featurePattern ?? DEFAULT_FEATURE_PATTERN;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const res = await runIntegration({ io, repo, cfg, pattern, only: val("--milestone"), force: argv.includes("--force"), nowFn: deps.now ?? (() => Date.now()), sleep, random: deps.random ?? Math.random });
  for (const r of res) print(`integration: ${r.title}: ${r.ran ? r.result ?? "n/a" : "skipped"}${r.detail ? ` (${r.detail})` : ""}`);
  return res.some((r) => r.result === "fail") ? 1 : 0;
}
