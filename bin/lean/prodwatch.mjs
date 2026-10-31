// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock prod-watch` (#4838, part of #4768): the poll loop over the prod-watch modules. One round is sources (#4833) ->
 * cluster, classify, validate (#4834) -> governor (#4835) -> one `io.llm` call per admitted cluster -> issue with a SIGNAL_REF
 * and the `target_watch` label -> verify -> metrics (#4837). Read-only toward production: only the declared source commands
 * and `deployed_probe` run. Human-only clusters are never filed; they go into one owner digest issue per UTC day. Only a
 * P0 incident pages (through `alert_channel`). A kill-switch file makes a round a no-op; `--dry-run` makes no writes.
 * Pure apart from `io` {exec, gh, llm, now, emit, page, exists, readState, writeState, sleep}; no state outside GitHub except a rebuildable cache.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { writeAtomic } from "./batch.mjs";
import { acquireLock, watchDir, loadWatches } from "./issuewatch.mjs";
import { loadPolicy } from "./decision-engine.mjs";
import { parseSources, runAdapter } from "./prodwatch-sources.mjs";
import { cluster, fingerprint, classifyCluster, validateCluster, tallyClusters, parseAlertRules, signalRef, trailerOf } from "./prodwatch-triage.mjs";
import { admit } from "./prodwatch-governor.mjs";
import { computeMetrics, sourceMode, emitMetrics } from "./prodwatch-metrics.mjs";

const KEYS = ["poll_minutes", "sources", "deployed_probe", "governor", "target_watch", "kill_switch", "alert_channel"];
const GOV_KEYS = ["max_issues_per_hour", "max_open_prod_issues", "max_cost_usd_per_round", "cost_per_issue_usd"];
export const DEFAULT_LABEL = "prod-watch";
export const DEFAULT_KILL_SWITCH = ".forge/prod-watch.off";
const DAY = (ms) => new Date(ms).toISOString().slice(0, 10);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

// ── config ─────────────────────────────────────────────────────────────────────────────────
const scalar = (v) => {
  const s = String(v ?? "").replace(/\s+#.*$/, "").trim();
  if (/^\{.*\}$/.test(s)) return Object.fromEntries(s.slice(1, -1).split(",").map((x) => x.split(/:(.*)/s).slice(0, 2).map((y) => scalar(y))).filter(([k]) => k));
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== "");
  if (s !== "" && Number.isFinite(Number(s))) return Number(s);
  return s.replace(/^(["'])(.*)\1$/, "$2");
};

/**
 * The `prod_watch:` block of forge.yaml text (sources are one flow map per line, or a block of scalar keys with an optional
 * `queries:` list of `- {..}` items; parseForgeYaml reads one nesting level only). Throws on an unknown key or a bad value.
 * @returns {{poll_minutes:number, sources:object[], deployed_probe:string|null, governor:object, target_watch:string|null, kill_switch:string, alert_channel:string|null}}
 */
export function parseProdWatch(raw) {
  const o = { sources: {}, governor: {} };
  let inSec = false, top = null, src = null, qs = false;
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const indent = /^\s*/.exec(line)[0].length;
    if (indent === 0) { inSec = /^prod_watch:\s*(#.*)?$/.test(line); top = null; src = null; continue; }
    if (!inSec) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && src && qs) { (o.sources[src].queries ??= []).push(scalar(item[1])); continue; }
    const m = /^\s*([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (indent <= 2) { top = m[1]; src = null; qs = false; if (!KEYS.includes(top)) throw new Error(`prod_watch: unknown key ${top}`); if (m[2] !== "") o[top] = scalar(m[2]); continue; }
    if (top === "governor") { if (!GOV_KEYS.includes(m[1])) throw new Error(`prod_watch.governor: unknown key ${m[1]}`); o.governor[m[1]] = scalar(m[2]); continue; }
    if (top !== "sources") continue;
    if (indent <= 4) { src = m[1]; qs = false; o.sources[src] = m[2] === "" ? {} : scalar(m[2]); continue; }
    if (!src) continue;
    if (m[1] === "queries" && m[2] === "") { qs = true; continue; }
    qs = false; o.sources[src][m[1]] = scalar(m[2]);
  }
  if (!Object.keys(o.sources).length) throw new Error("prod_watch.sources is required");
  const poll = o.poll_minutes == null ? 5 : Number(o.poll_minutes);
  if (!Number.isFinite(poll) || poll <= 0) throw new Error("prod_watch.poll_minutes must be a positive number");
  for (const k of GOV_KEYS) if (o.governor[k] != null && !(Number(o.governor[k]) >= 0)) throw new Error(`prod_watch.governor.${k} must be a number >= 0`);
  return {
    poll_minutes: poll, sources: parseSources(o.sources), deployed_probe: o.deployed_probe || null, governor: o.governor,
    target_watch: o.target_watch || null, kill_switch: o.kill_switch || DEFAULT_KILL_SWITCH, alert_channel: o.alert_channel || null,
  };
}

/** The label filed issues carry: the first `labels` entry of the issue_watch watch `target_watch` names, else `target_watch` itself, else `prod-watch`. */
export function targetLabel(cfg, raw = "") {
  if (!cfg.target_watch) return DEFAULT_LABEL;
  let w = null; try { w = loadWatches(raw)[cfg.target_watch]; } catch { /* a bad watch is not ours to report */ }
  return w?.labels?.[0] ?? cfg.target_watch;
}

// ── pure helpers ───────────────────────────────────────────────────────────────────────────
const SOURCE_TAG = /<!--\s*FORGE:PRODWATCH\s+source=(\S+?)\s*-->/;
const FP_TAG = /FORGE:SIGNAL_REF\s+fp=([0-9a-f]+)/;
/** Signal text is untrusted: a literal comment opener could forge a FORGE marker, so it is escaped before it reaches a body or prompt. */
const neutralize = (s) => String(s ?? "").replace(/<!--/g, "&lt;!--");
const oneLine = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Rows for computeMetrics from the prod-watch issues (open and closed) that carry our markers: GitHub is the register. */
export function metricRows(issues) {
  const rows = [];
  for (const i of issues ?? []) {
    const body = String(i.body ?? ""), trailer = trailerOf(body), source = SOURCE_TAG.exec(trailer)?.[1], fp = FP_TAG.exec(trailer)?.[1];
    if (!source) continue;
    const done = i.state === "CLOSED", notPlanned = done && /not.?planned/i.test(String(i.stateReason ?? ""));
    rows.push({ source, fp, signalAt: i.createdAt, issueAt: i.createdAt, mergedAt: done && !notPlanned ? i.closedAt : null, invalid: notPlanned });
  }
  return rows;
}

/** The human-only class (from the policy matrix `loadPolicy` returns) a cluster's text matches, else null. */
export function humanOnly(c, matrix = []) {
  const text = (c.signals ?? []).map((s) => `${s.title ?? ""}\n${s.body ?? ""}`).join("\n");
  return (matrix ?? []).find((m) => m?.re instanceof RegExp && new RegExp(m.re.source, m.re.flags.replace(/[gy]/g, "")).test(text))?.class ?? null;
}

const titleOf = (c) => neutralize(oneLine(c.signals?.[0]?.title ?? c.fingerprint, 100));
const issueTitle = (c) => `prod-watch: ${c.class} ${c.severity}: ${titleOf(c)}`;

/** Issue body: the LLM's hypothesis text (or a deterministic stub), the evidence, then the markers later rounds dedup on. */
export function issueBody(c, text, source) {
  // Every field above the trailer comes from signal data: neutralised, so none can open a comment that swallows the evidence or
  // reaches the trailer with a forged marker.
  const n = (v, max = 200) => neutralize(oneLine(v, max));
  const ev = (c.evidence?.length ? c.evidence : c.signals).slice(0, 5).map((s) => `- ${n(s.source ?? source, 80)}: ${n(s.title, 120)} (${n(s.body)})`).join("\n");
  return `${neutralize(text) || "Root-cause hypothesis unavailable this round; see the evidence."}\n\n**Class**: ${n(c.class, 60)}  **Severity**: ${n(c.severity, 20)}  **Copies**: ${n(c.count, 20)}  **Seen**: ${n(c.first_seen ?? "?", 40)} .. ${n(c.last_seen ?? "?", 40)}\n**Owner**: ${n(c.owner ?? "unassigned", 80)}\n\n### Evidence\n${ev}\n\n${signalRef(c.fingerprint)}\n<!-- FORGE:PRODWATCH source=${source} -->\n`;
}

/** Marks the one open storm-summary issue: later rounds edit it instead of filing another, and it never counts as a prod issue (#4869). */
export const SUMMARY_TAG = "<!-- FORGE:PRODWATCH_SUMMARY -->";
const isSummary = (i) => trailerOf(i?.body).includes(SUMMARY_TAG);

const issueNumber = (out) => Number(/(\d+)\s*$/.exec(String(out ?? "").trim())?.[1]) || null;

// ── one round ──────────────────────────────────────────────────────────────────────────────
/**
 * One poll round. `state` is the cache `{filed:[{at,fp,issue}], verified:{fp:at}, paged:{fp:at}, digest:{date,issue,items}}`; it is mutated
 * only when `dryRun` is false. Returns a report; never throws for a failing source or gh write (reported in `errors`).
 */
export async function roundOnce({ cfg, io, state = {}, dryRun = false, label = DEFAULT_LABEL, policyText = "", humanMatrix = [] }) {
  const nowMs = io.now(), rep = { dryRun, killed: false, filed: [], would_file: [], deferred: [], human: [], paged: [], verified: [], summary: null, digest: null, errors: [], cost_usd: 0, tally: null, metrics: {} };
  state.filed ??= []; state.verified ??= {}; state.paged ??= {};
  if (io.exists(cfg.kill_switch)) return { ...rep, killed: true };
  const write = async (what, fn) => { if (dryRun) return null; try { return await fn(); } catch (e) { rep.errors.push(`${what}: ${e.message}`); return null; } };

  let issues;
  try { issues = JSON.parse(String(await io.gh(["issue", "list", "--label", label, "--state", "all", "--limit", "200", "--json", "number,state,stateReason,body,createdAt,closedAt"]))); }
  catch (e) { return { ...rep, errors: [`issue list failed, nothing filed: ${e.message}`] }; }
  const openAll = issues.filter((i) => i.state === "OPEN"), openSummary = openAll.find(isSummary) ?? null;
  const open = openAll.filter((i) => !isSummary(i)), rows = metricRows(issues.filter((i) => !isSummary(i)));
  rep.metrics = computeMetrics(rows);

  const modes = Object.fromEntries(cfg.sources.map((s) => [s.name, sourceMode(s.name, rep.metrics)]));
  const signals = [];
  for (const s of cfg.sources) { const r = await runAdapter(s, io); signals.push(...r.signals.map((x) => ({ ...x, source: x.source ?? s.name }))); rep.errors.push(...r.errors); }
  const { rules } = parseAlertRules(policyText);
  const clusters = cluster(signals, open).map((c) => ({ ...c, source: c.signals[0]?.source, class: classifyCluster(c, rules) }));
  const validated = [];
  for (const c of clusters) validated.push({ ...(await validateCluster(c, { ...io, sources: cfg.sources })), source: c.source });
  rep.tally = tallyClusters(validated);

  const candidates = [];
  for (const v of validated) {
    const hc = v.fileable ? humanOnly(v, humanMatrix) : null;
    if (hc) rep.human.push({ fp: v.fingerprint, class: hc, title: titleOf(v) });
    else if (v.fileable && modes[v.source]?.mode === "shadow") rep.deferred.push({ fp: v.fingerprint, why: "source in shadow mode" });
    else candidates.push(v);
  }

  const gov = cfg.governor ?? {}, maxCost = gov.max_cost_usd_per_round > 0 ? Number(gov.max_cost_usd_per_round) : Infinity;
  // A call with no reported cost and no cost_per_issue_usd estimate counts as the whole cap: an unknown spend never passes as free (#4868).
  const unknownCost = Number(gov.cost_per_issue_usd) > 0 ? Number(gov.cost_per_issue_usd) : Number.isFinite(maxCost) ? maxCost : 0;
  const { file, summary } = admit(candidates, { governor: gov, state, openProdIssues: open, now: nowMs });
  for (const c of file) {
    if (rep.cost_usd >= maxCost) { rep.deferred.push({ fp: c.fingerprint, why: "max_cost_usd_per_round" }); continue; }
    let text = "";
    if (!dryRun) {
      try {
        const r = await io.llm(`Write the root-cause hypothesis and a short issue body (what is failing, likely cause, how to reproduce, first fix to try) for this production signal cluster. Follow this repo's issue conventions.\n\nClass: ${c.class}\nSeverity: ${c.severity}\nCopies: ${c.count}\n\n${c.signals.slice(0, 3).map((s) => `${neutralize(s.title)}\n${neutralize(oneLine(s.body, 600))}`).join("\n---\n")}`);
        text = String(r?.text ?? r ?? "");
        rep.cost_usd += Number(r?.cost_usd) > 0 ? Number(r.cost_usd) : unknownCost;
      } catch (e) { rep.cost_usd += unknownCost; rep.errors.push(`llm ${c.fingerprint}: ${e.message}`); }
    }
    const entry = { fp: c.fingerprint, title: issueTitle(c), body: issueBody(c, text, c.source) };
    if (dryRun) { rep.would_file.push(entry); continue; }
    const out = await write(`file ${c.fingerprint}`, () => io.gh(["issue", "create", "--title", entry.title, "--body", entry.body, "--label", label]));
    if (out == null) continue;
    const n = issueNumber(out);
    state.filed.push({ at: nowMs, fp: c.fingerprint, issue: n }); rep.filed.push({ ...entry, issue: n });
    if (c.class === "incident" && c.severity === "P0" && cfg.alert_channel && !state.paged[c.fingerprint]) {
      const ok = await write(`page ${c.fingerprint}`, () => io.page({ channel: cfg.alert_channel, title: entry.title, body: `P0 incident filed as #${n ?? "?"}` }));
      if (ok !== null) { state.paged[c.fingerprint] = nowMs; rep.paged.push(c.fingerprint); }
    }
  }
  for (const c of candidates) if (!file.includes(c) && !summary) rep.deferred.push({ fp: c.fingerprint, why: "governor" });
  if (summary) {
    rep.summary = summary;
    const body = `${neutralize(summary.body)}\n\n${SUMMARY_TAG}\n`;
    if (openSummary) await write("storm summary edit", () => io.gh(["issue", "edit", String(openSummary.number), "--title", summary.title, "--body", body]));
    else await write("storm summary", () => io.gh(["issue", "create", "--title", summary.title, "--body", body, "--label", label]));
  } else if (openSummary && !rep.deferred.length) {
    await write("storm summary close", () => io.gh(["issue", "close", String(openSummary.number), "--comment", "prod-watch: the governor admitted every cluster this round; the storm is over."]));
  }

  await digest({ rep, state, io, label, nowMs, write, dryRun });
  await verify({ cfg, io, state, issues, signals, rep, nowMs, write });
  if (!dryRun) { emitMetrics(rep.metrics, io); }
  return rep;
}

/** One owner digest issue per UTC day: created on the first human-only item, edited as more arrive. */
async function digest({ rep, state, io, label, nowMs, write, dryRun }) {
  if (!rep.human.length) return;
  const day = DAY(nowMs), d = state.digest?.date === day ? state.digest : { date: day, issue: null, items: [] };
  const fresh = rep.human.filter((h) => !d.items.some((x) => x.fp === h.fp));
  const items = [...d.items, ...fresh];
  rep.digest = { date: day, items };
  if (!fresh.length || dryRun) return;
  const body = `Human-only actions prod-watch will not take (${day}):\n\n${items.map((x) => `- ${x.class}: ${neutralize(x.title)} (fp ${x.fp})`).join("\n")}\n`;
  const title = `prod-watch owner digest ${day}`;
  // State is persisted only after the gh write succeeds, so a failed write is retried next round.
  if (d.issue) {
    if (await write("digest edit", () => io.gh(["issue", "edit", String(d.issue), "--body", body])) !== null) state.digest = { date: day, issue: d.issue, items };
  } else {
    const out = await write("digest create", () => io.gh(["issue", "create", "--title", title, "--body", body, "--label", label]));
    if (out !== null) state.digest = { date: day, issue: issueNumber(out), items };
  }
}

/** Closed (fixed) prod-watch issues: once `deployed_probe` exits 0 and the signal is gone, comment FORGE:VERIFIED; if it is still there, count it ineffective. */
async function verify({ cfg, io, state, issues, signals, rep, nowMs, write }) {
  if (!cfg.deployed_probe) return;
  const live = new Set(signals.map((s) => fingerprint(s)));
  const todo = issues.filter((i) => i.state === "CLOSED" && !/not.?planned/i.test(String(i.stateReason ?? "")) && FP_TAG.test(trailerOf(i.body)) && !state.verified[FP_TAG.exec(trailerOf(i.body))[1]]);
  if (!todo.length) return;
  const probe = await io.exec(cfg.deployed_probe);
  if (probe?.code !== 0) return;
  for (const i of todo) {
    const fp = FP_TAG.exec(trailerOf(i.body))[1];
    if (live.has(fp)) { rep.errors.push(`#${i.number}: signal ${fp} persists after the fix`); continue; }
    const ok = await write(`verify #${i.number}`, () => io.gh(["issue", "comment", String(i.number), "--body", `<!-- FORGE:VERIFIED fp=${fp} -->\nprod-watch: deployed probe passed and the signal is gone.`]));
    if (ok !== null) { state.verified[fp] = nowMs; rep.verified.push(i.number); }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────
export function formatProdWatchStatus(s, repo) {
  if (!s) return `prod-watch (${repo}): no status yet`;
  return [`prod-watch (${repo}) [${s.phase}] last round ${s.last ?? "never"}`, `  rounds: ${s.rounds ?? 0}  filed (total): ${s.filed ?? 0}  verified: ${s.verified ?? 0}  paged: ${s.paged ?? 0}`,
    `  last: ${s.killed ? "kill switch set, idle" : `clusters ${s.clusters ?? 0}, fileable ${s.fileable ?? 0}, deferred ${s.deferred ?? 0}, human ${s.human ?? 0}`}`, ...(s.errors?.length ? [`  errors: ${s.errors.slice(0, 3).join("; ")}`] : [])].join("\n");
}

/** The kill switch file: an absolute path as given, a relative one under the working directory (#4867 PW-2). */
export const killSwitchSet = (cwd, f) => existsSync(isAbsolute(f) ? f : join(cwd, f));

/** `claude --print --output-format json` output as {text, cost_usd}; plain text (no JSON) keeps cost unknown (#4868). */
export function llmResult(out) {
  try { const j = JSON.parse(String(out)); if (j && typeof j.result === "string") return { text: j.result, cost_usd: Number(j.total_cost_usd) > 0 ? Number(j.total_cost_usd) : null }; } catch { /* plain text */ }
  return { text: String(out ?? ""), cost_usd: null };
}

function realIo(env = process.env, cwd = process.cwd()) {
  const sh = (cmd, input) => { const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8", cwd, input, maxBuffer: 64 * 1024 * 1024, env }); return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; };
  return { env, now: () => Date.now(), exec: async (cmd) => sh(cmd), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    gh: (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
    llm: (prompt) => llmResult(execFileSync("claude", ["--print", "--output-format", "json"], { input: prompt, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })),
    page: ({ channel, title, body }) => { const r = sh(channel, `${title}\n${body}\n`); if (r.code !== 0) throw new Error(`alert channel exit ${r.code}`); return true; },
    exists: (f) => killSwitchSet(cwd, f), emit: (r) => process.stdout.write(`PRODWATCH_METRICS ${JSON.stringify(r)}\n`) };
}

const flag = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

export async function prodWatchFromCli(argv, deps = {}) {
  const [op] = argv;
  const usage = "usage: forgedock prod-watch run [--repo owner/repo] [--once] [--interval <s>] [--dry-run] | status [--repo owner/repo]";
  if (!["run", "status"].includes(op)) throw new Error(usage);
  const cwd = deps.cwd ?? process.cwd(), env = deps.env ?? process.env, print = deps.print ?? ((l) => console.log(l));
  const io = deps.io ?? realIo(env, cwd);
  let raw = ""; try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { /* no forge.yaml: parseProdWatch reports it */ }
  const cfg = parseProdWatch(raw);
  const repo = flag(argv, "--repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const dir = watchDir(repo, "prod-watch", env), statusFile = join(dir, "status.json"), stateFile = join(dir, "state.json");
  if (op === "status") { print(formatProdWatchStatus(readJson(statusFile), repo)); return { ok: true }; }
  const dryRun = argv.includes("--dry-run"), once = argv.includes("--once") || dryRun;
  const policy = loadPolicy({ io: { readFile: (p) => readFileSync(p, "utf8") }, cwd });
  const label = targetLabel(cfg, raw);
  const intervalMs = (Number(flag(argv, "--interval")) || cfg.poll_minutes * 60) * 1000;
  let release = () => {};
  if (!dryRun) { mkdirSync(dir, { recursive: true }); release = acquireLock(dir); }
  const state = (!dryRun && readJson(stateFile)) || {};
  const total = readJson(statusFile) ?? {};
  let last = null;
  try {
    for (let n = 0; ; n++) {
      last = await roundOnce({ cfg, io, state, dryRun, label, policyText: policy.policyText, humanMatrix: policy.matrix });
      if (dryRun) {
        print(last.killed ? "kill switch set: nothing to do" : `dry-run: would file ${last.would_file.length} issue(s)${last.summary ? " and one storm summary" : ""}, ${last.human.length} human-only, ${last.deferred.length} deferred`);
        for (const w of last.would_file) print(`  - ${w.title}`);
        for (const e of last.errors) print(`  ! ${e}`);
        break;
      }
      const s = { phase: once ? "done" : "polling", last: new Date(io.now()).toISOString(), rounds: (total.rounds ?? 0) + n + 1, filed: state.filed.length, verified: Object.keys(state.verified).length, paged: Object.keys(state.paged).length,
        killed: last.killed, clusters: last.tally?.clusters, fileable: last.tally?.fileable, deferred: last.deferred.length, human: last.human.length, errors: last.errors };
      state.filed = state.filed.slice(-500);
      writeAtomic(stateFile, JSON.stringify(state) + "\n"); writeAtomic(statusFile, JSON.stringify(s) + "\n");
      if (once) { print(formatProdWatchStatus(s, repo)); break; }
      await io.sleep(intervalMs);
    }
  } finally { release(); }
  return { ok: true, report: last };
}
