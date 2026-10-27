#!/usr/bin/env node
// readiness.mjs — preview/deploy gate readiness from external prerequisites (forge#4660).
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Usage: readiness.mjs [--repo|-R owner/name] [--target preview|staging|prod] [--digest] [--issues file.json|-]
//
// A prerequisite is an open issue labelled `needs-human:external` whose body has a `gates:` line
// (`preview|staging-deploy|prod-deploy|feature-flag:<name>`, comma separated) and an `owner:` line.
// A code issue that carries its own `gates:` line names a milestone the gate still needs.
// Default output is the Readiness report; --digest prints the ordered human actions; --target prints
// DEPLOYABLE or NOT DEPLOYABLE for that target and exits 1 when not deployable.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const EXTERNAL_LABEL = "needs-human:external";
const GATE_RE = /^(?:preview|staging-deploy|prod-deploy|feature-flag:[A-Za-z0-9._-]+)$/;
/** Deploy target -> the gate whose open prerequisites make it not deployable. */
export const TARGET_GATE = { preview: "preview", staging: "staging-deploy", prod: "prod-deploy" };

const labelNames = (i) => (Array.isArray(i?.labels) ? i.labels.map((l) => (typeof l === "string" ? l : l?.name)) : []);

/** Valid gate names from the issue body's `gates:` line(s); invalid entries are dropped. */
export function parseGates(body) {
  const out = [];
  for (const m of String(body ?? "").matchAll(/^[ \t]*gates:[ \t]*(.*)$/gim)) {
    for (const g of m[1].split(",").map((s) => s.trim().replace(/^`|`$/g, ""))) if (GATE_RE.test(g) && !out.includes(g)) out.push(g);
  }
  return out;
}

/** `owner:` value, or null. */
export function parseOwner(body) {
  const m = /^[ \t]*owner:[ \t]*(\S.*?)[ \t]*$/im.exec(String(body ?? ""));
  return m ? m[1] : null;
}

const deps = (body) => {
  const m = /^[ \t]*depends on[ \t]*:?[ \t]*(.*)$/gim;
  const out = new Set();
  for (const x of String(body ?? "").matchAll(m)) for (const n of x[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  return [...out];
};

/**
 * `issues`: open issues { number, title, body, labels, milestone?, createdAt? }; `now`: ms.
 * Returns { gates: { <gate>: { red, blocksMerge, prerequisites:[{number,title,owner,ageDays}], milestones:[title] } }, digest:[...] }.
 */
export function readiness(issues, now = Date.now()) {
  const list = Array.isArray(issues) ? issues : [];
  const prereqs = list.filter((i) => labelNames(i).includes(EXTERNAL_LABEL));
  const gates = {};
  const slot = (g) => (gates[g] ??= { red: true, blocksMerge: false, prerequisites: [], milestones: [] });
  const entry = (i) => {
    const t = Date.parse(i.createdAt);
    return { number: i.number, title: String(i.title ?? ""), owner: parseOwner(i.body), ageDays: Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : null };
  };
  for (const i of prereqs) for (const g of parseGates(i.body)) slot(g).prerequisites.push(entry(i));
  for (const i of list) {
    if (labelNames(i).includes(EXTERNAL_LABEL)) continue;
    const ms = typeof i.milestone === "string" ? i.milestone : i.milestone?.title;
    if (!ms) continue;
    for (const g of parseGates(i.body)) if (gates[g] && !gates[g].milestones.includes(ms)) gates[g].milestones.push(ms);
  }
  return { gates, digest: digest(prereqs, now) };
}

/** Open prerequisites in dependency order (a prerequisite follows the open ones it depends on); `after` lists those. */
export function digest(prereqs, now = Date.now()) {
  const byNum = new Map(prereqs.map((i) => [i.number, i]));
  const after = (i) => deps(i.body).filter((n) => n !== i.number && byNum.has(n));
  const done = new Set(), order = [], visiting = new Set();
  const visit = (i) => {
    if (done.has(i.number) || visiting.has(i.number)) return; // a cycle is cut, never loops
    visiting.add(i.number);
    for (const n of after(i)) visit(byNum.get(n));
    visiting.delete(i.number);
    done.add(i.number);
    order.push(i);
  };
  [...prereqs].sort((a, b) => a.number - b.number).forEach(visit);
  return order.map((i) => {
    const t = Date.parse(i.createdAt);
    return { number: i.number, title: String(i.title ?? ""), owner: parseOwner(i.body), gates: parseGates(i.body),
      ageDays: Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : null, after: after(i), unblocked: after(i).length === 0 };
  });
}

/** `{ deployable, openPrerequisites }` for a target (preview|staging|prod). A feature-flag gate never affects it. */
export function deployable(report, target) {
  const g = report.gates[TARGET_GATE[target]];
  const open = g ? g.prerequisites : [];
  return { deployable: open.length === 0, openPrerequisites: open };
}

const who = (p) => `#${p.number} ${p.title.slice(0, 60)} (owner: ${p.owner ?? "unassigned"}, age: ${p.ageDays ?? "?"}d)`;

export function formatReport(report) {
  const names = Object.keys(report.gates).sort();
  if (!names.length) return "Readiness: no open external prerequisites";
  const lines = ["Readiness (open external prerequisites per gate):"];
  for (const g of names) {
    const x = report.gates[g];
    const flag = g.startsWith("feature-flag:") ? " (flag-gated features may merge; gate stays red)" : "";
    lines.push(`  ${g}: RED${flag}`, ...x.prerequisites.map((p) => `    - ${who(p)}`));
    lines.push(`    code milestones needed: ${x.milestones.length ? x.milestones.join(", ") : "none recorded"}`);
  }
  return lines.join("\n");
}

export function formatDigest(report) {
  if (!report.digest.length) return "Digest: no open human actions";
  return ["Digest (human actions, dependency order):", ...report.digest.map((d, i) =>
    `  ${i + 1}. #${d.number} ${d.title.slice(0, 60)} [${d.gates.join(",") || "no gates"}] owner: ${d.owner ?? "unassigned"}${d.unblocked ? " - unblocked" : ` - after ${d.after.map((n) => `#${n}`).join(", ")}`}`)].join("\n");
}

function main(argv) {
  const opt = (f) => { const k = argv.indexOf(f); return k >= 0 ? argv[k + 1] : undefined; };
  const src = opt("--issues");
  let issues;
  if (src) issues = JSON.parse(readFileSync(src === "-" ? 0 : src, "utf8"));
  else {
    const repo = opt("--repo") ?? opt("-R");
    const r = spawnSync("gh", ["issue", "list", ...(repo ? ["-R", repo] : []), "--state", "open", "--limit", "200", "--json", "number,title,body,labels,milestone,createdAt"], { encoding: "utf8" });
    if (r.status !== 0) { console.error("readiness: gh issue list failed"); return 2; }
    issues = JSON.parse(r.stdout || "[]");
  }
  const report = readiness(issues);
  const target = opt("--target");
  if (target) {
    if (!TARGET_GATE[target]) { console.error("readiness: --target must be preview|staging|prod"); return 2; }
    const d = deployable(report, target);
    console.log(d.deployable ? `DEPLOYABLE ${target}` : [`NOT DEPLOYABLE ${target}: ${TARGET_GATE[target]} gate has ${d.openPrerequisites.length} open prerequisite(s)`, ...d.openPrerequisites.map((p) => `  - ${who(p)}`)].join("\n"));
    return d.deployable ? 0 : 1;
  }
  console.log(argv.includes("--digest") ? formatDigest(report) : formatReport(report));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
