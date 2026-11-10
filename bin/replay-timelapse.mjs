// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock replay --timelapse <batch|epic>` (#5293): a time-lapse of a recorded run, rendered from the local lifecycle
 * event log (docs/EVENTS.md) and the batch plan. Deterministic, no model call, read-only: the only GitHub access is an
 * `issue view` / GET `api` read to list an epic's children, enforced by `readOnlyGh`. Output is text frames plus a vhs
 * tape; GIF/MP4 are encoded only when `vhs` is already on PATH (nothing is installed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { batchRoot, listBatches } from "./lean/batch.mjs";
import { sinkPath } from "./engine/events.mjs";
import { parseForgeYaml } from "./forge-utils.mjs";

export const MIN_SECONDS = 30;
export const MAX_SECONDS = 90;
export const DEFAULT_SECONDS = 60;
export const FPS = 2;
const USAGE = "usage: forgedock replay --timelapse <batch-id|epic-number> [--repo owner/repo] [--out dir] [--format gif|mp4] [--duration 30-90] [--events file]";

/** Wrap a gh runner so any call that is not an issue read or a GET api call throws (the no-live-writes guarantee). */
export function readOnlyGh(gh) {
  return (args) => {
    const a = args.map(String);
    const method = a.findIndex((x) => x === "-X" || x === "--method");
    const read = (a[0] === "issue" && a[1] === "view") || (a[0] === "api" && !a.includes("-f") && !a.includes("-F") && !a.includes("--input") && (method < 0 || /^GET$/i.test(a[method + 1] ?? "")));
    if (!read) throw new Error(`replay is read-only: refused gh ${a.slice(0, 2).join(" ")}`);
    return gh(args);
  };
}

const issueNum = (x) => (typeof x === "number" ? x : typeof x === "string" && /^#?\d+$/.test(x.trim()) ? parseInt(x.trim().replace("#", ""), 10) : x && typeof x === "object" ? issueNum(x.issue ?? x.number) : NaN);

/** Resolve a batch id (local plan) or an epic number (children referenced in its body) to {issues, repo, created}. */
export async function resolveTarget(target, { root = batchRoot(), gh = null, repo = null } = {}) {
  const t = String(target ?? "").trim();
  if (listBatches(root).includes(t)) {
    const plan = JSON.parse(readFileSync(join(root, t, "plan.json"), "utf8"));
    const issues = (Array.isArray(plan.issues) ? plan.issues : []).map(issueNum).filter(Number.isInteger);
    return { kind: "batch", id: t, issues, repo: plan.repo ?? repo, created: typeof plan.created === "string" ? plan.created : null };
  }
  if (!/^#?\d+$/.test(t)) throw new Error(`no local batch "${t}" and it is not an epic number\n${USAGE}`);
  const epic = parseInt(t.replace("#", ""), 10);
  if (!gh) throw new Error("epic resolution needs gh");
  const raw = gh(["issue", "view", String(epic), ...(repo ? ["-R", repo] : []), "--json", "body"]);
  const body = String(JSON.parse(typeof raw === "string" ? raw : String(raw ?? "{}")).body ?? "");
  const issues = [...new Set([...body.matchAll(/#(\d+)/g)].map((m) => parseInt(m[1], 10)))].filter((n) => n !== epic);
  return { kind: "epic", id: `epic-${epic}`, issues, repo, created: null };
}

/** Events of `issues` from a lifecycle-events JSONL file, normalised to timeline items sorted by time. */
export function buildTimeline(lines, issues, { created = null } = {}) {
  const want = new Set(issues);
  const items = [];
  const seen = new Set();
  const createdMs = Date.parse(created ?? "");
  const kinds = { "lane.picked_up": "lane_start", "pr.opened": "pr_open", "pr.merged": "pr_merged", "release.promoted": "gate", "probe.passed": "gate" };
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e?.ts ?? "");
    if (!e || e.schema !== "forgedock.event" || !Number.isFinite(t) || !want.has(e.issue)) continue;
    if (!seen.has(e.issue)) { seen.add(e.issue); items.push({ t: Number.isFinite(createdMs) && createdMs < t ? createdMs : t, kind: "issue", issue: e.issue }); }
    if (kinds[e.type]) items.push({ t, kind: kinds[e.type], issue: e.issue, pr: e.pr ?? null, cost: e.type === "pr.merged" && Number.isFinite(e.cost_usd) ? e.cost_usd : 0 });
  }
  return items.sort((a, b) => a.t - b.t);
}

const clock = (ms) => { const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":"); };
const STATE = { issue: "open", lane_start: "building", pr_open: "PR open", pr_merged: "merged" };

/** `seconds` of frames (FPS each) evenly spaced across the timeline, whatever its real length; seconds clamped 30-90. */
export function buildFrames(items, { seconds = DEFAULT_SECONDS, title = "run" } = {}) {
  const dur = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Number.isFinite(+seconds) ? +seconds : DEFAULT_SECONDS));
  const n = Math.round(dur * FPS);
  const t0 = items[0]?.t ?? 0, span = Math.max(0, (items[items.length - 1]?.t ?? 0) - t0);
  const frames = [];
  let k = 0, cost = 0, gate = false;
  const state = new Map();
  for (let i = 0; i < n; i++) {
    const T = t0 + (n > 1 ? (span * i) / (n - 1) : 0);
    for (; k < items.length && items[k].t <= T; k++) {
      const it = items[k];
      if (it.kind === "gate") gate = true; else state.set(it.issue, { ...state.get(it.issue), state: STATE[it.kind], pr: it.pr ?? state.get(it.issue)?.pr ?? null });
      cost += it.cost ?? 0;
    }
    const merged = [...state.values()].filter((s) => s.state === "merged").length;
    const rows = [...state].map(([issue, s]) => `  #${String(issue).padEnd(6)} ${String(s.state).padEnd(9)} ${s.pr ? `PR #${s.pr}` : ""}`.trimEnd());
    frames.push([`ForgeDock time-lapse: ${title}`, `clock ${clock(T - t0)}   cost $${cost.toFixed(2)}   merged ${merged}/${state.size}   release gate ${gate ? "PASSED" : "pending"}`, "", ...rows, ""].join("\n"));
  }
  return frames;
}

/** vhs tape that plays the frame files at FPS and records `format` (gif|mp4). */
export function tapeFor(dir, format) {
  return ["# generated by `forgedock replay --timelapse`; render with: vhs timelapse.tape", `Output timelapse.${format}`, "Set FontSize 14", "Set Width 1200", "Set Height 650", "Set Theme \"Dracula\"", "Hide",
    `Type "for f in frames/*.txt; do clear; cat $f; sleep ${1 / FPS}; done; exit"`, "Enter", "Show", `Sleep ${Math.ceil(1 / FPS)}s`, ""].join("\n");
}

/** Write frames, the tape and meta under `out`; encode when vhs exists. Returns {out, frames, encoded, command}. */
export function writeOutput(out, frames, { format = "gif", meta = {}, spawn = spawnSync } = {}) {
  const dir = resolve(out), fdir = join(dir, "frames");
  mkdirSync(fdir, { recursive: true });
  frames.forEach((f, i) => writeFileSync(join(fdir, `frame-${String(i + 1).padStart(4, "0")}.txt`), f));
  writeFileSync(join(dir, "timelapse.tape"), tapeFor(dir, format));
  writeFileSync(join(dir, "timelapse.json"), JSON.stringify({ ...meta, frames: frames.length, fps: FPS, seconds: frames.length / FPS, format }, null, 2) + "\n");
  const command = `cd ${dir} && vhs timelapse.tape`;
  const have = spawn("vhs", ["--version"], { stdio: "ignore" });
  if (have?.error || have?.status !== 0) return { out: dir, frames: frames.length, encoded: false, command };
  const run = spawn("vhs", ["timelapse.tape"], { cwd: dir, stdio: "ignore" });
  return { out: dir, frames: frames.length, encoded: run?.status === 0, command };
}

function parseArgs(argv) {
  const o = { target: null, repo: null, out: null, format: "gif", seconds: DEFAULT_SECONDS, events: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--timelapse") o.target = v(); else if (a === "--repo") o.repo = v(); else if (a === "--out") o.out = v(); else if (a === "--events") o.events = v();
    else if (a === "--format") o.format = v(); else if (a === "--duration") o.seconds = Number(v());
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (!o.target) throw new Error(USAGE);
  if (o.format !== "gif" && o.format !== "mp4") throw new Error(`--format must be gif or mp4\n${USAGE}`);
  return o;
}

function repoFromConfig(cwd) {
  try {
    const y = parseForgeYaml(readFileSync(join(cwd, process.env.FORGE_CONFIG || "forge.yaml"), "utf8"));
    return y.project?.owner && y.project?.repo ? `${y.project.owner}/${y.project.repo}` : null;
  } catch { return null; }
}

/** CLI entry. Returns the exit code; `deps` = {gh, root, env, cwd, spawn, log} for tests. */
export async function replayFromCli(argv, deps = {}) {
  const o = parseArgs(argv), env = deps.env ?? process.env, log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));
  const gh = readOnlyGh(deps.gh ?? ((args) => execFileSync("gh", args, { encoding: "utf8" })));
  const repo = o.repo ?? repoFromConfig(deps.cwd ?? process.cwd());
  const target = await resolveTarget(o.target, { root: deps.root ?? batchRoot(env), gh, repo });
  const file = o.events ?? sinkPath(target.repo ?? repo, env.FORGE_EVENTS_DIR);
  if (!existsSync(file)) throw new Error(`no lifecycle event log at ${file} (docs/EVENTS.md); pass --events <file>`);
  const items = buildTimeline(readFileSync(file, "utf8").split("\n").filter(Boolean), target.issues, { created: target.created });
  if (!items.length) throw new Error(`no recorded events for ${target.id} in ${file}`);
  const frames = buildFrames(items, { seconds: o.seconds, title: target.id });
  const res = writeOutput(o.out ?? `timelapse-${target.id}`, frames, { format: o.format, spawn: deps.spawn, meta: { target: target.id, issues: target.issues.length } });
  log(`${res.frames} frames written to ${res.out}/frames`);
  log(res.encoded ? `rendered ${res.out}/timelapse.${o.format}` : `vhs not available or failed; render with: ${res.command}`);
  return 0;
}
