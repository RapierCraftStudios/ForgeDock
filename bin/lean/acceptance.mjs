// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Feature-level acceptance (#5336): an epic declares user journeys, each a probe-format command that runs against the
 * assembled milestone branch; a milestone with an epic cannot ship or close, and its release review cannot pass, while a
 * journey is red, has never run on the branch head, or (at close) a post-deploy journey has not yet passed in production.
 * Deterministic: no model call. Same trust rule as probes (`isProbeDeclarer`, fail closed).
 *
 * Declaration, a top-level fenced block in the epic body or a declarer's comment (the latest wins):
 *   ```forge-acceptance
 *   journey: create a session-backed task and get a result
 *   run: ./scripts/journey-task.sh
 *   pass: exit 0            # or /regex/flags against stdout
 *   timeout: 300
 *   when: milestone         # default; `post-deploy` journeys run after release and hold the epic open
 *   ```
 * Each run is posted on the epic as a `FORGE:ACCEPTANCE` comment: {head, at, site, results}.
 * `forgedock acceptance check --body-file F | run --milestone T [--site post-deploy] | gate --milestone T|--branch B [--stage ship|close]`.
 */
import { readFileSync } from "node:fs";
import { isTrustedComment } from "../engine/phases.mjs";
import { noComments } from "./render.mjs";
import { fencedBlocks, isProbeDeclarer, runProbe, probeEnv, readProbeConfig, MAX_TIMEOUT_S } from "./probe.mjs";
import { listMilestones, milestoneSlug, readBranches, DEFAULT_FEATURE_PATTERN } from "./lane.mjs";

export const ACCEPTANCE_MARKER = "FORGE:ACCEPTANCE";
export const ACCEPTANCE_TAG = "forge-acceptance";
export const AWAITING_LABEL = "awaiting-measurement";
export const WHEN = ["milestone", "post-deploy"];

const isForgeMarker = (body) => /^\s*<!--\s*FORGE:/.test(String(body ?? ""));
const sameSha = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
const actorOf = (o) => ({ association: o?.author_association, type: o?.user?.type, login: o?.user?.login });

function journeyOf(f) {
  const bad = (why) => ({ error: `journey "${f.journey ?? "?"}": ${why}` });
  if (!f.journey) return { error: "a journey section has no name" };
  if (!f.run) return bad("no `run:` command");
  let pass = { kind: "exit" };
  const p = (f.pass ?? "").replace(/\s+#.*$/, "");
  if (p && !/^exit\s+0$/i.test(p)) {
    const r = /^\/(.+)\/([a-z]*)$/.exec(p);
    try { if (!r) return bad("`pass:` must be `exit 0` or /regex/flags"); new RegExp(r[1], r[2]); } catch { return bad("`pass:` regex does not compile"); }
    pass = { kind: "regex", re: r[1], flags: r[2] };
  }
  let timeoutS = null;
  if (f.timeout) {
    const t = parseInt(f.timeout, 10);
    if (!Number.isFinite(t) || t <= 0) return bad("`timeout:` must be a positive number of seconds");
    timeoutS = Math.min(t, MAX_TIMEOUT_S);
  }
  const when = (f.when ?? "milestone").toLowerCase();
  if (!WHEN.includes(when)) return bad("`when:` must be milestone or post-deploy");
  return { journey: { name: f.journey, run: f.run, pass, timeoutS, when } };
}

/** The last top-level forge-acceptance block of `text`: {journeys, errors}; journeys is empty when no block exists. */
export function parseAcceptance(text) {
  const blocks = fencedBlocks(noComments(String(text ?? ""), " ").replace(/\r\n?/g, "\n"), ACCEPTANCE_TAG);
  const out = { journeys: [], errors: [] };
  if (!blocks.length) return out;
  const sections = [];
  for (const line of blocks[blocks.length - 1].split("\n")) {
    const m = /^\s*(journey|run|pass|timeout|when)\s*:\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === "journey") sections.push({ journey: m[2] });
    else if (sections.length && !(k in sections.at(-1))) sections.at(-1)[k] = m[2];
  }
  for (const s of sections) { const j = journeyOf(s); if (j.error) out.errors.push(j.error); else out.journeys.push(j.journey); }
  return out;
}

/** Creation gate: {ok, journeys, errors}. An epic body needs at least one valid journey and no malformed one. */
export function validateEpic(body) {
  const { journeys, errors } = parseAcceptance(body);
  const all = journeys.length ? errors : ["no `forge-acceptance` block with at least one journey (journey/run/pass)", ...errors];
  return { ok: !all.length, journeys, errors: all };
}

/** The epic's declared journeys: the latest declarer comment, else the body when its author is a declarer. {journeys, errors, source} | {untrusted:true} | null. */
export function declaredAcceptance(iss) {
  let untrusted = false;
  for (const c of [...(iss?.comments ?? [])].reverse()) {
    if (isForgeMarker(c?.body)) continue;
    const a = parseAcceptance(c?.body);
    if (!a.journeys.length && !a.errors.length) continue;
    if (isProbeDeclarer(actorOf(c))) return { ...a, source: "comment" };
    untrusted = true;
  }
  const a = parseAcceptance(iss?.body);
  if (a.journeys.length || a.errors.length) {
    if (isProbeDeclarer(actorOf(iss))) return { ...a, source: "body" };
    untrusted = true;
  }
  return untrusted ? { untrusted: true } : null;
}

/** The FORGE:ACCEPTANCE comment: pass/fail, when, and on which head. */
export function renderAcceptanceComment({ head, at, site, branch, rows }) {
  const pass = rows.length > 0 && rows.every((r) => r.result === "pass");
  const rec = { head, at, site, branch, result: pass ? "pass" : "fail", results: Object.fromEntries(rows.map((r) => [r.name, { result: r.result, exit: r.exit, ms: r.ms }])) };
  const table = rows.map((r) => `| ${r.name.replace(/\|/g, "/")} | ${r.result} | ${r.exit ?? "timeout"} |`);
  const tails = rows.filter((r) => r.result === "fail").map((r) => `<details><summary>${r.name.replace(/[<>]/g, "")}</summary>\n\n\`\`\`\`\n${String(r.output ?? "").trim() || "(no output)"}\n\`\`\`\`\n</details>`);
  return [`<!-- ${ACCEPTANCE_MARKER} -->`, `## Feature acceptance (${site}): ${rec.result}`, JSON.stringify(rec), "",
    `Ran on \`${String(head).slice(0, 12)}\`${branch ? ` of \`${branch}\`` : ""} at ${at}.`, "", "| Journey | Result | Exit |", "|---|---|---|", ...table, "", ...tails].join("\n");
}

/** {head, at, site, result, results} of a FORGE:ACCEPTANCE comment body, or null. */
export function acceptanceResultOf(body) {
  const s = String(body ?? "");
  if (!s.trimStart().startsWith(`<!-- ${ACCEPTANCE_MARKER} -->`)) return null;
  const line = s.split("\n").find((l) => /^\{.*"results"/.test(l.trim()));
  try { const j = line && JSON.parse(line.trim()); return j && typeof j.head === "string" && j.results && typeof j.results === "object" ? j : null; } catch { return null; }
}

/** Run `journeys` (those of `site`) in `cwd`; rows {name, when, result, exit, ms, output}. */
export async function runJourneys({ journeys, site = "milestone", cwd, config = readProbeConfig(cwd), env = process.env, spawn }) {
  const rows = [];
  for (const j of journeys.filter((x) => x.when === site)) {
    const r = await runProbe(j, { cwd, env: probeEnv(config.env, env), mask: config.env.map((k) => env[k]), timeoutS: config.timeoutS, ...(spawn ? { spawn } : {}) });
    rows.push({ name: j.name, when: j.when, ...r });
  }
  return rows;
}

/**
 * The gate for one milestone's epics. `epics`: [{number, declared, comments}]. `stage`: "ship" needs every milestone journey
 * green on `head`; "close" also needs every post-deploy journey to have passed (any head, site post-deploy).
 * Returns {ok, reasons}. A milestone with no epics is not gated.
 */
export function gateMilestone({ epics, head, stage = "ship" }) {
  const reasons = [];
  for (const e of epics) {
    const tag = `epic #${e.number}`;
    const d = e.declared;
    if (!d || d.untrusted || !d.journeys?.length) { reasons.push(`${tag}: no runnable journey declared${d?.untrusted ? " (only by untrusted authors)" : ""}`); continue; }
    if (d.errors?.length) reasons.push(`${tag}: ${d.errors.join("; ")}`);
    const recs = (e.comments ?? []).filter((c) => isTrustedComment(c)).map((c) => acceptanceResultOf(c.body)).filter(Boolean);
    const onHead = recs.filter((r) => r.site !== "post-deploy" && sameSha(r.head, head)).at(-1);
    for (const j of d.journeys.filter((x) => x.when === "milestone")) {
      const got = onHead?.results?.[j.name]?.result;
      if (got === "pass") continue;
      reasons.push(`${tag}: journey "${j.name}" ${got ? "is red" : recs.length ? `has not run on ${String(head).slice(0, 7)}` : "has never run"}`);
    }
    if (stage === "close") {
      for (const j of d.journeys.filter((x) => x.when === "post-deploy")) {
        if (!recs.some((r) => r.site === "post-deploy" && r.results?.[j.name]?.result === "pass")) reasons.push(`${tag}: post-deploy journey "${j.name}" has not passed in production (epic stays open, ${AWAITING_LABEL})`);
      }
    }
  }
  return { ok: !reasons.length, reasons };
}

const branchOf = (pattern, title) => { const slug = milestoneSlug(title); return slug ? String(pattern || DEFAULT_FEATURE_PATTERN).replace("{slug}", slug) : null; };

/** The open milestone whose branch is `branch` (or titled `title`): {number, title, branch}, or null. */
export async function findMilestone({ io, repo, title = null, branch = null, pattern = DEFAULT_FEATURE_PATTERN }) {
  for (const m of await listMilestones({ gh: io.gh, repo, state: "all" })) {
    const b = branchOf(pattern, m.title);
    if ((title && m.title === title) || (branch && b === branch)) return { number: m.number, title: m.title, branch: b };
  }
  return null;
}

/** The milestone's epic issues, each with comments and declared journeys. */
export async function readEpics({ io, repo, milestone }) {
  const list = JSON.parse(String(await io.gh(["api", `repos/${repo}/issues?milestone=${milestone.number}&labels=epic&state=all&per_page=100`, "--jq", "[.[] | select(.pull_request == null)]"])) || "[]");
  const out = [];
  for (const iss of list) {
    const raw = String(await io.gh(["api", `repos/${repo}/issues/${iss.number}/comments`, "--paginate", "--jq", ".[]"]));
    const comments = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    out.push({ number: iss.number, state: iss.state, declared: declaredAcceptance({ ...iss, comments }), comments });
  }
  return out;
}

/** Gate by milestone title or branch. Fails closed: a milestone with epics whose head cannot be read is blocked. Not gated: no milestone or no epic. */
export async function gateByRef({ io, repo, title = null, branch = null, head = null, stage = "ship", pattern = DEFAULT_FEATURE_PATTERN }) {
  const ms = await findMilestone({ io, repo, title, branch, pattern });
  if (!ms) return { gated: false, ok: true, reasons: [] };
  const epics = await readEpics({ io, repo, milestone: ms });
  if (!epics.length) return { gated: false, ok: true, reasons: [], milestone: ms };
  let h = head;
  if (!h && ms.branch) { try { h = String(await io.gh(["api", `repos/${repo}/branches/${encodeURIComponent(ms.branch)}`, "--jq", ".commit.sha"])).trim(); } catch { h = null; } }
  if (!h) return { gated: true, ok: false, reasons: [`milestone ${ms.title}: head of ${ms.branch} unreadable (fail closed)`], milestone: ms };
  return { gated: true, ...gateMilestone({ epics, head: h, stage }), milestone: ms, epics, head: h };
}

/** Run a milestone's journeys in `cwd` (checked out at its branch head) and post the result on each epic. Resolves [{epic, result, rows}]. */
export async function runMilestoneJourneys({ io, repo, milestone, cwd, head, site = "milestone", now = () => new Date().toISOString(), config, env, spawn, dryRun = false }) {
  const out = [];
  for (const e of await readEpics({ io, repo, milestone })) {
    if (!e.declared?.journeys?.length || e.declared.untrusted) { out.push({ epic: e.number, result: "no-journey", rows: [] }); continue; }
    const rows = await runJourneys({ journeys: e.declared.journeys, site, cwd, ...(config ? { config } : {}), ...(env ? { env } : {}), ...(spawn ? { spawn } : {}) });
    if (!rows.length) { out.push({ epic: e.number, result: "no-journey", rows }); continue; }
    const body = renderAcceptanceComment({ head, at: now(), site, branch: milestone.branch, rows });
    if (!dryRun) {
      await io.gh(["issue", "comment", String(e.number), "-R", repo, "--body", body]);
      if (site === "milestone" && rows.some((r) => r.result === "fail")) { try { await io.gh(["issue", "edit", String(e.number), "-R", repo, "--add-label", "integration-red"]); } catch { /* label is advisory */ } }
    }
    out.push({ epic: e.number, result: rows.every((r) => r.result === "pass") ? "pass" : "fail", rows });
  }
  return out;
}

/** `forgedock acceptance check|run|gate`. Resolves the exit code (1: invalid, red or blocked). */
export async function acceptanceFromCli(argv, deps = {}) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const print = deps.print ?? ((t) => console.log(t));
  const cwd = deps.cwd ?? process.cwd();
  const usage = "usage: forgedock acceptance check --body-file F | run --milestone T [--site milestone|post-deploy] [--repo o/r] | gate (--milestone T | --branch B) [--stage ship|close] [--repo o/r]";
  if (argv[0] === "check") {
    const f = val("--body-file");
    if (!f) throw new Error(usage);
    const v = validateEpic(deps.readFile ? deps.readFile(f) : readFileSync(f, "utf8"));
    if (v.ok) print(`acceptance: ${v.journeys.length} journey(s): ${v.journeys.map((j) => `${j.name} [${j.when}]`).join("; ")}`);
    else for (const e of v.errors) print(`acceptance: ${e}`);
    return v.ok ? 0 : 1;
  }
  if (argv[0] !== "run" && argv[0] !== "gate") throw new Error(usage);
  const repo = val("--repo") ?? deps.repo;
  if (!repo) throw new Error("acceptance needs the repo: pass --repo owner/repo");
  const io = deps.io ?? (await import("./effects.mjs")).makeLeanIo({ repo });
  const pattern = deps.pattern ?? readBranches(cwd).featurePattern ?? DEFAULT_FEATURE_PATTERN;
  if (argv[0] === "gate") {
    const stage = val("--stage") ?? "ship";
    if (stage !== "ship" && stage !== "close") throw new Error(usage);
    if (!val("--milestone") && !val("--branch")) throw new Error(usage);
    const g = await gateByRef({ io, repo, title: val("--milestone"), branch: val("--branch"), stage, pattern });
    if (!g.gated) print("acceptance: milestone has no epic; not gated");
    else if (g.ok) print(`acceptance: pass (${g.milestone.title} @ ${String(g.head).slice(0, 7)}, ${stage})`);
    else for (const r of g.reasons) print(`acceptance: BLOCKED: ${r}`);
    return g.ok ? 0 : 1;
  }
  const title = val("--milestone");
  const site = val("--site") ?? "milestone";
  if (!title || !WHEN.includes(site)) throw new Error(usage);
  const ms = await findMilestone({ io, repo, title, pattern });
  if (!ms) throw new Error(`no milestone titled ${title}`);
  const head = String(await (deps.git ?? io.git)(["rev-parse", "HEAD"], { cwd })).trim();
  const res = await runMilestoneJourneys({ io, repo, milestone: ms, cwd, head, site, dryRun: argv.includes("--dry-run"), ...(deps.spawn ? { spawn: deps.spawn } : {}) });
  for (const r of res) print(`acceptance: epic #${r.epic}: ${r.result}`);
  return res.some((r) => r.result === "fail") ? 1 : 0;
}

/**
 * The orchestrate seam's `journeys({title, branch, number})`: fetch the milestone branch, check it out detached in a
 * throwaway worktree, run the epics' milestone journeys there and post the results. Milestones with no epic or journey are a no-op.
 */
export function makeJourneyRunner({ repo, io, cwd = process.cwd(), tmpRoot }) {
  return async ({ title, branch, number }) => {
    if (!branch) return "no branch";
    const git = (a, o = {}) => io.git(a, { cwd, ...o });
    const epics = await readEpics({ io, repo, milestone: { number } });
    if (!epics.some((e) => e.declared?.journeys?.some((j) => j.when === "milestone"))) return "no journey declared";
    await git(["fetch", "origin", branch]);
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(mkdtempSync(join(tmpRoot ?? tmpdir(), "forge-journey-")), "wt");
    try {
      await git(["worktree", "add", "--detach", dir, `origin/${branch}`]);
      const head = String(await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
      const res = await runMilestoneJourneys({ io, repo, milestone: { number, title, branch }, cwd: dir, head });
      return res.map((r) => `#${r.epic} ${r.result}`).join(", ") || "no journey declared";
    } finally {
      try { await git(["worktree", "remove", "--force", dir]); } catch { /* pruned below */ }
      try { rmSync(join(dir, ".."), { recursive: true, force: true }); await git(["worktree", "prune"]); } catch { /* best effort */ }
    }
  };
}
