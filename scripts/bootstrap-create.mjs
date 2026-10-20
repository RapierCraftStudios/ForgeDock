#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * scripts/bootstrap-create.mjs — idempotent, resumable backlog creation for /bootstrap (#4176, part of #4155)
 *
 * Takes a plan that passes scripts/bootstrap-validate.mjs and makes it real on GitHub: the spike parent issue,
 * milestones in build order with their `milestone/<slug>` branches, every sub-issue (guardrails and domain rules
 * injected into its Context, `#{{KEY}}` placeholders resolved), board items with Status=Todo, Priority and Component,
 * a FORGE:BOOTSTRAP_PLAN and a FORGE:DECOMPOSED comment on the spike, and `workflow:decomposed` via
 * scripts/transition-label.sh. Nothing is written when the plan or the spike doc is invalid.
 *
 * Re-running is safe: the spike is reused by exact title, milestones by title, branches when present, sub-issues by
 * exact title plus a `**Parent**: #<spike>` line, comments when a trusted marker comment already exists.
 *
 * Plan fields on top of the validator's shape (all optional):
 *   "spike": "SPIKE"                                  plan key of the spike parent issue (default "SPIKE")
 *   "spikeDoc": "docs/engineering/technical-spike.md" spike doc, checked for its sections (checkSpikeDoc)
 *   "guardrails": ["no auto-send"], "domainRules": ["India-only data residency"]
 *   issues[].priority: "p0".."p3" (label priority:P<n> + board Priority), issues[].component: board Component label,
 *   issues[].estimatedDiffLines: number (FORGE:BOOTSTRAP_PLAN estimate)
 *   "costPerIssueUsd": 3                              dry-run cost estimate per build issue (#4177)
 *
 * Usage: node scripts/bootstrap-create.mjs <plan.json> [--dry-run] [--json] [--repo OWNER/NAME] [--config forge.yaml]
 *                                                     [--base <branch>] [--cost-per-issue <usd>]
 * Cost: plan.costPerIssueUsd, else --cost-per-issue, else DEFAULT_ISSUE_COST_USD, times the build sub-issues.
 * Repo: --repo, else forge.yaml project.owner/project.repo. Base: --base, else branches.staging, else "staging".
 * Exit: 0 created (or dry-run preview); 1 plan or spike doc invalid (nothing written); 2 usage; 3 GitHub error.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validatePlan, formatErrors, resolvePlaceholders, isNeedsHuman } from "./bootstrap-validate.mjs";
import { milestoneSlug } from "../bin/lean/lane.mjs";

const SELF_DIR = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_SPIKE_DOC = "docs/engineering/technical-spike.md";
const PLACEHOLDER_RE = /#\{\{[^{}]*\}\}/;
/** Planning estimate of agent spend per build issue (one lean lane) for the dry-run preview; not a measured figure. */
export const DEFAULT_ISSUE_COST_USD = 3;

/** Spike-doc sections (templates/bootstrap/technical-spike.md), matched as a prefix of a `## ` heading. */
export const SPIKE_SECTIONS = [
  "Stack", "Repo layout", "Runtime topology", "Data model", "Security and privacy",
  "Design system and quality gates", "Route/API map", "Credentials", "Milestone plan",
];

/** `## ` sections of a markdown text, fenced code ignored: [{ heading, lines }]. */
function h2Sections(text) {
  const out = [];
  let cur = null, fence = null;
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const f = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (f) fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0];
    const h = !fence && !f && line.match(/^##(?!#)[ \t]+(.+?)[ \t]*$/);
    if (h) { cur = { heading: h[1], lines: [] }; out.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return out;
}

/**
 * Check a spike doc: every SPIKE_SECTIONS section present, each with at least one ADR-style `**Rationale**:` line.
 * @returns {{ ok: boolean, missing: string[], noRationale: string[] }}
 */
export function checkSpikeDoc(text) {
  const secs = h2Sections(text);
  const missing = [], noRationale = [];
  for (const name of SPIKE_SECTIONS) {
    const s = secs.find((x) => x.heading.toLowerCase().startsWith(name.toLowerCase()));
    if (!s) missing.push(name);
    else if (!s.lines.some((l) => /\*\*Rationale\*\*:/.test(l))) noRationale.push(name);
  }
  return { ok: missing.length === 0 && noRationale.length === 0, missing, noRationale };
}

/**
 * Append the plan's guardrails and domain rules to the end of a body's `## Context` section (idempotent).
 * Bodies without a Context section are returned unchanged (the validator rejects those).
 */
export function injectGuardrails(body, guardrails = [], domainRules = []) {
  const g = (guardrails ?? []).filter((x) => typeof x === "string" && x.trim());
  const d = (domainRules ?? []).filter((x) => typeof x === "string" && x.trim());
  if ((!g.length && !d.length) || /^\*\*Guardrails\*\*:/m.test(body)) return body;
  const lines = String(body).split("\n");
  let start = -1, end = lines.length, fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^[ \t]*(`{3,}|~{3,})/);
    if (f) { fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0]; continue; }
    if (fence || !/^##(?!#)[ \t]+/.test(lines[i])) continue;
    if (start < 0 && /^##[ \t]+context\b/i.test(lines[i])) start = i;
    else if (start >= 0) { end = i; break; }
  }
  if (start < 0) return body;
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  const block = [""];
  if (g.length) block.push("**Guardrails**:", ...g.map((x) => `- ${x}`));
  if (d.length) block.push(...(g.length ? [""] : []), "**Domain rules**:", ...d.map((x) => `- ${x}`));
  lines.splice(end, 0, ...block);
  return lines.join("\n");
}

/** Sub-issues (every plan issue but the spike) in dependency order: milestone order, then a stable topo sort. */
export function subIssueOrder(plan) {
  const spikeKey = plan.spike ?? "SPIKE";
  const mIdx = new Map(plan.milestones.map((m, i) => [m.key, i]));
  const pending = plan.issues.filter((it) => it.key !== spikeKey)
    .map((it, i) => ({ it, i })).sort((a, b) => mIdx.get(a.it.milestone) - mIdx.get(b.it.milestone) || a.i - b.i)
    .map((x) => x.it);
  const keys = new Set(pending.map((it) => it.key));
  const done = new Set(), out = [];
  while (pending.length) {
    const at = pending.findIndex((it) => (it.deps ?? []).every((d) => !keys.has(d) || done.has(d)));
    const [next] = pending.splice(at < 0 ? 0 : at, 1);
    done.add(next.key);
    out.push(next);
  }
  return out;
}

/** The priority label for an issue (`p1` -> `priority:P1`), or null. */
export function priorityLabel(issue) {
  const m = String(issue?.priority ?? "").match(/^p([0-3])$/i);
  return m ? `priority:P${m[1]}` : null;
}

/** Plan preview for --dry-run: milestones, titles, DAG summary, estimated agent cost. No GitHub access. */
export function planPreview(plan, { costPerIssueUsd } = {}) {
  const spikeKey = plan.spike ?? "SPIKE";
  const spike = plan.issues.find((it) => it.key === spikeKey);
  const subs = subIssueOrder(plan);
  const edges = subs.reduce((n, it) => n + (it.deps ?? []).filter((d) => d !== spikeKey).length, 0);
  const human = subs.filter(isNeedsHuman);
  const lines = ["## Bootstrap plan preview (dry run: nothing written to GitHub)", "",
    `Spike: ${spike ? spike.title : "(missing)"} — doc \`${plan.spikeDoc ?? DEFAULT_SPIKE_DOC}\``, ""];
  plan.milestones.forEach((m, i) => {
    const its = subs.filter((it) => it.milestone === m.key);
    lines.push(`### ${i + 1}. ${m.title} (\`milestone/${milestoneSlug(m.title)}\`, ${its.length} issues)`);
    for (const it of its) {
      const deps = (it.deps ?? []).filter((d) => d !== spikeKey);
      lines.push(`- ${it.title}${isNeedsHuman(it) ? " [needs-human]" : ""}${deps.length ? ` — depends on ${deps.join(", ")}` : ""}`);
    }
    lines.push("");
  });
  lines.push(`DAG: ${subs.length} sub-issues (${subs.length - human.length} build, ${human.length} needs-human), ${edges} dependency edges, ${plan.milestones.length} milestones.`);
  const rate = [plan.costPerIssueUsd, costPerIssueUsd].find((r) => Number.isFinite(r) && r > 0) ?? DEFAULT_ISSUE_COST_USD;
  const build = subs.length - human.length;
  lines.push(`Estimated agent cost: ~$${(build * rate).toFixed(2)} (${build} build issues × $${rate}/issue; needs-human and spike excluded).`);
  return lines.join("\n");
}

/** `<!-- FORGE:BOOTSTRAP_PLAN -->` body, the shape commands/work-on/decompose.md Phase D0 reads. */
export function bootstrapPlanComment(plan) {
  const subs = subIssueOrder(plan);
  const pos = new Map(subs.map((it, i) => [it.key, i + 1]));
  const items = subs.map((it, i) => {
    const deps = (it.deps ?? []).filter((d) => pos.has(d)).map((d) => pos.get(d));
    const est = Number.isFinite(it.estimatedDiffLines) ? ` — ESTIMATED_DIFF_LINES: ${it.estimatedDiffLines}` : "";
    return `${i + 1}. ${it.title}${est}${deps.length ? ` _(depends on ${deps.join(", ")})_` : ""}`;
  });
  return ["<!-- FORGE:BOOTSTRAP_PLAN -->", "## Bootstrap Plan", "", `Spike: \`${plan.spikeDoc ?? DEFAULT_SPIKE_DOC}\``, "",
    "### Decomposition Assessment", "", "**YES**", "", ...items, ""].join("\n");
}

/** `<!-- FORGE:DECOMPOSED -->` body in the decompose Phase D5 format (`- #N: TITLE _(depends on #M)_`). */
export function decomposedComment(plan, numbers, { attribution = true } = {}) {
  const spikeKey = plan.spike ?? "SPIKE";
  const subs = subIssueOrder(plan);
  const items = subs.map((it) => {
    const deps = (it.deps ?? []).filter((d) => d !== spikeKey && numbers.has(d)).map((d) => `#${numbers.get(d)}`);
    return `- #${numbers.get(it.key)}: ${it.title}${deps.length ? ` _(depends on ${deps.join(", ")})_` : ""}${isNeedsHuman(it) ? " — needs-human" : ""}`;
  });
  return ["<!-- FORGE:DECOMPOSED -->", "## Decomposition Complete", "",
    "This spike has been broken into sub-issues by /bootstrap. Each sub-issue runs through its own /work-on pipeline independently.", "",
    "**Plan source**: bootstrap", "", "### Sub-Issues Created", "", ...items, "", "### Decomposition Rationale", "",
    `Milestones in build order: ${plan.milestones.map((m) => m.title).join(" → ")}. Needs-human issues are referenced by code issues but never block them; mocks keep dev and CI green.`,
    ...(attribution ? ["", "> Pipeline powered by [ForgeDock](https://github.com/RapierCraftStudios/ForgeDock)"] : []),
    "<!-- FORGE:DECOMPOSED:COMPLETE -->"].join("\n");
}

/** Human hand-off: created links, needs-human links, `/orchestrate` per milestone in build order. */
export function handoffText(result) {
  const link = (x) => `- #${x.number} ${x.title} — ${x.url}${x.reused ? " (reused)" : ""}`;
  const lines = ["## Bootstrap hand-off", "", `Spike: #${result.spike.number} ${result.spike.title} — ${result.spike.url}`, "", "### Created"];
  lines.push(...result.issues.filter((x) => !x.needsHuman).map(link));
  lines.push("", "### Needs a human");
  const human = result.issues.filter((x) => x.needsHuman);
  lines.push(...(human.length ? human.map(link) : ["- none"]));
  lines.push("", "### Next commands (in build order)");
  result.milestones.forEach((m, i) => lines.push(`${i + 1}. ${m.orchestrate}`));
  if (result.notes.length) lines.push("", "### Notes", ...result.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}

const parseIssueNumber = (out) => {
  const m = String(out).match(/\/issues\/(\d+)/);
  if (!m) throw new Error(`could not read the created issue number from: ${String(out).trim().slice(0, 200)}`);
  return Number(m[1]);
};

/**
 * Create (or reuse) the whole backlog. All GitHub access goes through `io`:
 *   io.gh(args, input?) -> stdout string (throws on failure)
 *   io.sh(cmd, args, input?) -> stdout string (bash helpers: transition-label.sh, trusted-comments.sh)
 * @returns {object} result for handoffText (spike, issues, milestones, notes)
 */
export function createBacklog(plan, { io, repo, config = {}, base }) {
  const spikeKey = plan.spike ?? "SPIKE";
  const spikePlan = plan.issues.find((it) => it.key === spikeKey);
  if (!spikePlan) throw new Error(`plan has no spike issue with key ${spikeKey}`);
  const notes = [];
  const board = config.project_board ?? {};
  const pattern = config.branches?.feature_pattern || "milestone/{slug}";
  const baseBranch = base || config.branches?.staging || "staging";
  const gh = (args, input) => io.gh(args, input);
  const json = (args) => JSON.parse(gh(args) || "null");

  // Labels: create only the missing ones (never overwrite an existing label's colour or description).
  const haveLabels = new Set((json(["label", "list", "-R", repo, "--limit", "1000", "--json", "name"]) ?? []).map((l) => l.name));
  const wanted = new Set(plan.issues.flatMap((it) => [...(it.labels ?? []), priorityLabel(it)]).filter(Boolean));
  for (const l of wanted) if (!haveLabels.has(l)) gh(["label", "create", l, "-R", repo]);

  // Milestones in build order, each with its lane branch.
  const ghMilestones = json(["api", `repos/${repo}/milestones?state=all&per_page=100`]) ?? [];
  let baseSha = null;
  const milestones = plan.milestones.map((m) => {
    let reused = ghMilestones.some((g) => g.title === m.title);
    if (!reused) gh(["api", `repos/${repo}/milestones`, "--method", "POST", "-f", `title=${m.title}`, "-f", `description=${m.description ?? ""}`, "-f", "state=open"]);
    const slug = milestoneSlug(m.title);
    if (!slug) throw new Error(`milestone "${m.title}" gives an empty branch slug`);
    const branch = pattern.replace("{slug}", slug);
    let exists = true;
    try { gh(["api", `repos/${repo}/git/ref/heads/${branch}`]); } catch { exists = false; }
    if (!exists) {
      baseSha ??= gh(["api", `repos/${repo}/git/ref/heads/${baseBranch}`, "--jq", ".object.sha"]).trim();
      gh(["api", `repos/${repo}/git/refs`, "--method", "POST", "-f", `ref=refs/heads/${branch}`, "-f", `sha=${baseSha}`]);
    }
    return { key: m.key, title: m.title, branch, reused, orchestrate: `/orchestrate milestone "${m.title}"` };
  });
  const milestoneTitle = new Map(plan.milestones.map((m) => [m.key, m.title]));

  // Existing issues, read once (no search-index lag on a resume right after a create).
  const existing = json(["issue", "list", "-R", repo, "--state", "all", "--limit", "2000", "--json", "number,title,body,url,labels"]) ?? [];
  const numbers = new Map(Object.entries(plan.numbers ?? {}).filter(([, n]) => Number.isSafeInteger(n) && n > 0));
  const finalBody = (it) => injectGuardrails(resolvePlaceholders(it.body, numbers), plan.guardrails, plan.domainRules);
  const records = new Map();
  const ensure = (it, match) => {
    const found = existing.find((x) => x.title === it.title && match(x));
    if (found) {
      numbers.set(it.key, found.number);
      records.set(it.key, { number: found.number, url: found.url, body: found.body ?? "", labels: (found.labels ?? []).map((l) => l.name), reused: true });
      return;
    }
    const args = ["issue", "create", "-R", repo, "--title", it.title, "--body-file", "-", "--milestone", milestoneTitle.get(it.milestone)];
    for (const l of [...(it.labels ?? []), priorityLabel(it)].filter(Boolean)) args.push("--label", l);
    const body = finalBody(it);
    const out = gh(args, body);
    const number = parseIssueNumber(out);
    numbers.set(it.key, number);
    records.set(it.key, { number, url: String(out).trim().split("\n").pop(), body, labels: [], reused: false });
  };

  ensure(spikePlan, () => true);
  const spikeNo = numbers.get(spikeKey);
  const parentRe = new RegExp(`\\*\\*Parent\\*\\*:?\\s*#${spikeNo}(?!\\d)`);
  const subs = subIssueOrder(plan);
  for (const it of subs) ensure(it, (x) => parentRe.test(x.body ?? ""));

  // Edit pass: resolve forward references left as placeholders at create time (also finishes an interrupted run).
  for (const it of [spikePlan, ...subs]) {
    const rec = records.get(it.key);
    if (!PLACEHOLDER_RE.test(rec.body)) continue;
    const body = finalBody(it);
    if (body === rec.body) continue;
    gh(["issue", "edit", String(rec.number), "-R", repo, "--body-file", "-"], body);
    rec.body = body;
  }

  // Board: Status=Todo, Priority, Component (best effort per field; skipped when the board is not configured).
  if (board.project_number && board.project_id) {
    const owner = board.owner || config.project?.owner || repo.split("/")[0];
    const fields = board.field_ids ?? {}, options = board.option_ids ?? {};
    const components = Array.isArray(board.components) ? board.components : [];
    for (const it of [spikePlan, ...subs]) {
      const rec = records.get(it.key);
      const itemId = gh(["project", "item-add", String(board.project_number), "--owner", owner, "--url", rec.url, "--format", "json", "--jq", ".id"]).trim();
      if (!itemId) { notes.push(`#${rec.number}: board item id not returned; fields not set`); continue; }
      const prio = String(it.priority ?? "").toLowerCase();
      const comp = components.find((c) => it.component && String(c.label ?? "").toLowerCase() === String(it.component).toLowerCase())
        ?? components.find((c) => c.repo === repo);
      const sets = [[fields.status, options.status?.todo], [fields.priority, options.priority?.[prio]], [fields.component, comp?.option_id]];
      for (const [field, option] of sets) {
        if (!field || !option) continue;
        try {
          gh(["project", "item-edit", "--project-id", board.project_id, "--id", itemId, "--field-id", field, "--single-select-option-id", option]);
        } catch (e) { notes.push(`#${rec.number}: board field ${field} not set (${String(e?.message ?? e).slice(0, 120)})`); }
      }
    }
  } else {
    notes.push("project_board not configured in forge.yaml (project_number/project_id): board sync skipped");
  }

  // Spike comments, posted once: a trusted marker comment already present is reused.
  const comments = gh(["api", "--paginate", `repos/${repo}/issues/${spikeNo}/comments`]);
  const trusted = (re) => io.sh("bash", [`${SELF_DIR}trusted-comments.sh`, "count", re], comments).trim() !== "0";
  const attribution = String(config.branding?.show_attribution ?? "true") !== "false";
  if (!trusted("^<!-- FORGE:BOOTSTRAP_PLAN -->")) gh(["issue", "comment", String(spikeNo), "-R", repo, "--body-file", "-"], bootstrapPlanComment(plan));
  if (!trusted("^<!-- FORGE:DECOMPOSED -->")) gh(["issue", "comment", String(spikeNo), "-R", repo, "--body-file", "-"], decomposedComment(plan, numbers, { attribution }));
  if (!records.get(spikeKey).labels.includes("workflow:decomposed")) {
    io.sh("bash", [`${SELF_DIR}transition-label.sh`, String(spikeNo), "-R", repo, "decomposed"]);
  }

  const spikeRec = records.get(spikeKey);
  return {
    repo,
    spike: { key: spikeKey, number: spikeNo, title: spikePlan.title, url: spikeRec.url, reused: spikeRec.reused },
    issues: subs.map((it) => ({ key: it.key, number: numbers.get(it.key), title: it.title, url: records.get(it.key).url,
      needsHuman: isNeedsHuman(it), milestone: milestoneTitle.get(it.milestone), reused: records.get(it.key).reused })),
    milestones,
    notes,
  };
}

/** Plan + spike-doc preflight shared by the CLI and tests: [] when creation may proceed. */
export function preflight(plan, spikeText) {
  const errors = [];
  const v = validatePlan(plan);
  if (!v.ok) errors.push(formatErrors(v.errors));
  else if (!plan.issues.some((it) => it.key === (plan.spike ?? "SPIKE"))) errors.push(`(plan): [invalid-plan] no spike issue with key ${plan.spike ?? "SPIKE"}`);
  if (spikeText == null) errors.push(`(spike): [missing-spike-doc] ${plan?.spikeDoc ?? DEFAULT_SPIKE_DOC} not found`);
  else {
    const s = checkSpikeDoc(spikeText);
    if (s.missing.length) errors.push(`(spike): [missing-section] ${s.missing.join(", ")}`);
    if (s.noRationale.length) errors.push(`(spike): [missing-rationale] no **Rationale**: line in ${s.noRationale.join(", ")}`);
  }
  return errors;
}

const defaultIo = {
  gh: (args, input) => execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 << 20 }),
  sh: (cmd, args, input) => execFileSync(cmd, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] }),
};

function readConfig(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(execFileSync("yq", ["-o=json", ".", path], { encoding: "utf8" })) ?? {}; } catch { return {}; }
}

export function main(argv, { io = defaultIo, out = process.stdout, err = process.stderr } = {}) {
  let planPath = null, dryRun = false, asJson = false, repo = "", configPath = process.env.FORGE_CONFIG || "forge.yaml", base = "", costPerIssueUsd;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} requires a value`); return argv[++i]; };
    try {
      if (a === "--dry-run") dryRun = true;
      else if (a === "--json") asJson = true;
      else if (a === "--repo") repo = val();
      else if (a === "--config") configPath = val();
      else if (a === "--base") base = val();
      else if (a === "--cost-per-issue") {
        costPerIssueUsd = Number(val());
        if (!Number.isFinite(costPerIssueUsd) || costPerIssueUsd <= 0) throw new Error("--cost-per-issue must be a positive number");
      }
      else if (!planPath && !a.startsWith("--")) planPath = a;
      else throw new Error(`unknown argument ${a}`);
    } catch (e) { err.write(`bootstrap-create: ${e.message}\n`); return 2; }
  }
  if (!planPath) { err.write("usage: node scripts/bootstrap-create.mjs <plan.json> [--dry-run] [--json] [--repo OWNER/NAME] [--config forge.yaml] [--base <branch>] [--cost-per-issue <usd>]\n"); return 2; }
  let plan;
  try { plan = JSON.parse(readFileSync(planPath, "utf8")); } catch (e) { err.write(`bootstrap-create: cannot read plan: ${e.message}\n`); return 2; }
  const spikePath = plan?.spikeDoc ?? DEFAULT_SPIKE_DOC;
  const spikeText = existsSync(spikePath) ? readFileSync(spikePath, "utf8") : null;
  const errors = preflight(plan, spikeText);
  if (errors.length) { err.write(errors.join("\n") + "\nbootstrap-create: not creating anything; fix the plan or spike doc\n"); return 1; }
  if (dryRun) { out.write(planPreview(plan, { costPerIssueUsd }) + "\n"); return 0; }

  const config = readConfig(configPath);
  repo ||= config.project?.owner && config.project?.repo ? `${config.project.owner}/${config.project.repo}` : "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) { err.write("bootstrap-create: no target repository: pass --repo OWNER/NAME or a forge.yaml with project.owner/project.repo\n"); return 2; }
  let result;
  try { result = createBacklog(plan, { io, repo, config, base }); } catch (e) {
    err.write(`bootstrap-create: GitHub error: ${String(e?.stderr || e?.message || e).trim().slice(0, 500)}\nRe-run the same command to resume; existing issues are reused.\n`);
    return 3;
  }
  out.write((asJson ? JSON.stringify(result, null, 2) : handoffText(result)) + "\n");
  return 0;
}

// Run as CLI only when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
