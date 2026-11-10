// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Re-plan loop (#5342): a `design-invalidated` block files one spike-amendment issue, holds the affected open siblings
// behind it with the existing `**Depends on**` edge, and `replan apply` re-evaluates each child once the amendment merged.
// Pure and deterministic: no LLM call. The amendment lane writes the per-child dispositions; the engine only applies them.
import { parentOf } from "./context.mjs";
import { selectChildren, readChildList } from "./autochildren.mjs";

export const REPLAN_MARKER = "FORGE:REPLAN";
export const CHILD_DISPOSITIONS = Object.freeze(["unchanged", "re-scoped", "dropped"]);
export const DISPOSITIONS_TAG = "forge-replan-dispositions";
const TEXT_MAX = 600;

const text = (v, max = TEXT_MAX) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const issueNo = (v) => { const n = Number(String(v ?? "").replace(/^#/, "")); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const strList = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === "string").map((x) => x.trim().replace(/^\.?\/+/, "")).filter(Boolean))];

/**
 * The typed `design-invalidated` block: {decision, why} required; `epic` (the epic or tracker to amend), `supersedes` (a
 * decision-register id), `paths` (files of the invalidated interface) optional. Null when decision or why is missing.
 */
export function normaliseInvalidation(block, issue = null) {
  const decision = text(block?.decision), why = text(block?.why);
  if (!decision || !why) return null;
  const epic = issueNo(block?.epic);
  return { decision, why, epic: epic && epic !== Number(issue) ? epic : null, supersedes: text(block?.supersedes, 60) || null, paths: strList(block?.paths ?? block?.anchors) };
}

/** The epic of `issue`: the block's own `epic`, else the `**Parent**: #N` line of the issue body. */
export const epicOf = (inv, body) => inv?.epic ?? parentOf(body ?? "");

/** Hidden record on the amendment issue body, read back to find it again (idempotent filing) and to reach its epic. */
const recordOf = (body) => {
  const m = new RegExp(`<!--\\s*${REPLAN_MARKER}\\s*(\\{[\\s\\S]*?\\})\\s*-->`).exec(String(body ?? ""));
  if (!m) return null;
  try { const j = JSON.parse(m[1]); return issueNo(j?.epic) ? { epic: issueNo(j.epic), from: issueNo(j.from) } : null; } catch { return null; }
};
export const amendmentEpic = (body) => recordOf(body)?.epic ?? null;

/** Open amendment issue of `epic` in one open-issue list, or null (a second invalidation joins it, never files another). */
export function findAmendment(list, epic) {
  const hit = (list ?? []).find((it) => recordOf(it?.body)?.epic === epic);
  return hit ? hit.number : null;
}

/** Open children of `epic` an invalidation touches: every open child, or only those naming one of `paths` when given. `self` is excluded. */
export function affectedChildren({ list, epic, self = null, paths = [] }) {
  const kids = selectChildren({ list, roots: [epic], skip: self ? [self] : [] });
  if (!paths.length) return kids;
  const by = new Map((list ?? []).map((it) => [it.number, it]));
  return kids.filter((n) => paths.some((p) => String(by.get(n)?.body ?? "").includes(p)));
}

export const amendmentTitle = (inv, epic) => `spike amendment: ${inv.decision.slice(0, 80)} no longer holds (epic #${epic})`;

/** Body of the amendment issue: the invalidated decision, why, the held children and the disposition block it must produce. */
export function amendmentBody({ inv, epic, from, children }) {
  const rec = JSON.stringify({ epic, from });
  return [`<!-- ${REPLAN_MARKER} ${rec} -->`, `**Parent**: #${epic}`, "",
    "## Spike amendment", `Invalidated by #${from}: **${inv.decision}**`, "", `Why: ${inv.why}`, ...(inv.supersedes ? ["", `Supersedes decision ${inv.supersedes}.`] : []), "",
    "Update the spike and the epic so the design holds again, and record the replacement decision (`supersedes`). Then give every held child a disposition in one fenced block:", "",
    `\`\`\`${DISPOSITIONS_TAG}`, JSON.stringify({ children: Object.fromEntries(children.map((n) => [n, { disposition: "unchanged" }])) }, null, 2), "```", "",
    `\`${CHILD_DISPOSITIONS.join("`, `")}`.concat("` (a re-scoped child carries `body`, regenerated from the amended design; a dropped child is closed as superseded)."), "",
    "A re-scoped child that is user-visible (a page or UI) must say in its body to run `/design` before build, so the rendered page is judged before the lanes merge (#5330).", "",
    `Held until this merges: ${children.length ? children.map((n) => `#${n}`).join(", ") : "none"}.`].join("\n");
}

const dependsLine = (n) => `**Depends on**: #${n}`;
const holdRe = (n) => new RegExp(`^[ \\t]*\\*\\*Depends on\\*\\*: #${n}[ \\t]*$\\n?`, "gim");

/** `body` with the hold edge on `amendment` added (once). */
export function holdEdge(body, amendment) {
  const b = String(body ?? "");
  return holdRe(amendment).test(b) ? b : `${b.replace(/\s+$/, "")}\n\n${dependsLine(amendment)}\n`;
}
/** `body` without the hold edge on `amendment`. */
export const releaseEdge = (body, amendment) => String(body ?? "").replace(holdRe(amendment), "").replace(/\s+$/, "") + "\n";

/** The last disposition block in the texts (issue body first, then comments): `{children:{N:{disposition, body?}}}` or null. */
export function parseDispositions(texts) {
  const re = new RegExp(`\`\`\`${DISPOSITIONS_TAG}\\s*\\n([\\s\\S]*?)\`\`\``, "g");
  let last = null;
  for (const t of texts ?? []) for (const m of String(t ?? "").matchAll(re)) { try { last = JSON.parse(m[1]); } catch { /* an unparsable block is skipped */ } }
  return last && typeof last.children === "object" && last.children ? last : null;
}

/**
 * Fail closed: every affected child needs one known disposition; a re-scoped child needs its regenerated body.
 * @returns {{ok:boolean, problem?:string, rows?:{n:number, disposition:string, body?:string}[]}}
 */
export function validateDispositions(d, affected) {
  const rows = [];
  for (const n of affected) {
    const e = d?.children?.[n] ?? d?.children?.[`#${n}`];
    if (!e || !CHILD_DISPOSITIONS.includes(e.disposition)) return { ok: false, problem: `open child #${n} has no valid disposition (${CHILD_DISPOSITIONS.join(", ")})` };
    if (e.disposition === "re-scoped" && !text(e.body, 100000)) return { ok: false, problem: `re-scoped child #${n} carries no regenerated body` };
    rows.push({ n, disposition: e.disposition, ...(e.disposition === "re-scoped" ? { body: String(e.body) } : {}) });
  }
  return { ok: true, rows };
}

/** The epic body with each child's checklist line marked once: dropped is checked and struck, re-scoped is annotated. */
export function renderEpicChecklist(epicBody, rows, amendment) {
  let out = String(epicBody ?? "");
  for (const r of rows) {
    if (r.disposition === "unchanged") continue;
    const re = new RegExp(`^([ \\t]*[-*+][ \\t]+)\\[[ xX]\\]([ \\t]+)(.*#${r.n}\\b.*)$`, "gm");
    out = out.replace(re, (_m, pre, sp, rest) => {
      if (/superseded by #|re-scoped by #/.test(rest)) return `${pre}[${r.disposition === "dropped" ? "x" : " "}]${sp}${rest}`;
      return r.disposition === "dropped" ? `${pre}[x]${sp}~~${rest}~~ (dropped, superseded by #${amendment})` : `${pre}[ ]${sp}${rest} (re-scoped by #${amendment})`;
    });
  }
  return out;
}

/**
 * Files (or joins) the one amendment issue of `epic` and holds every affected open child, and `self`, behind it.
 * @param {{gh:Function, create:Function, repo:string, issue:number, inv:object, epic:number, milestone?:string|null}} p
 *   gh: read, create: write (retried) `gh` runners returning stdout.
 * @returns {Promise<{amendment:number, created:boolean, held:number[]}>}
 */
export async function fileAmendment({ gh, create, repo, issue, inv, epic, milestone = null }) {
  const list = await readChildList({ gh, repo });
  const children = affectedChildren({ list, epic, self: issue, paths: inv.paths });
  let amendment = findAmendment(list, epic), created = false;
  if (!amendment) {
    const out = String(await create(["issue", "create", "-R", repo, "--title", amendmentTitle(inv, epic), "--body", amendmentBody({ inv, epic, from: issue, children }), ...(milestone ? ["--milestone", milestone] : [])]));
    amendment = issueNo(/\/issues\/(\d+)/.exec(out)?.[1]);
    if (!amendment) throw new Error(`cannot parse the amendment issue number from: ${out.slice(0, 200)}`);
    created = true;
  }
  const held = [];
  for (const n of [...children, issue]) {
    if (n === amendment) continue;
    const rec = JSON.parse(String(await gh(["issue", "view", String(n), "-R", repo, "--json", "body"])) || "{}");
    const next = holdEdge(rec.body, amendment);
    if (next !== String(rec.body ?? "")) await create(["issue", "edit", String(n), "-R", repo, "--body", next]);
    held.push(n);
  }
  return { amendment, created, held };
}

/**
 * After the amendment merged: re-evaluate every held open child from the dispositions the amendment lane wrote, release
 * the hold, and rewrite the epic checklist. Nothing is changed unless every affected child has a valid disposition.
 * @returns {Promise<{ok:boolean, problem?:string, rows?:object[]}>}
 */
export async function applyReplan({ gh, create, repo, amendment }) {
  const view = JSON.parse(String(await gh(["issue", "view", String(amendment), "-R", repo, "--json", "body,comments"])) || "{}");
  const epic = amendmentEpic(view.body);
  if (!epic) return { ok: false, problem: `#${amendment} is not a spike amendment (no ${REPLAN_MARKER} record)` };
  const d = parseDispositions([view.body, ...(view.comments ?? []).map((c) => c?.body)]);
  if (!d) return { ok: false, problem: `#${amendment} carries no \`${DISPOSITIONS_TAG}\` block` };
  const list = await readChildList({ gh, repo });
  const held = selectChildren({ list, roots: [epic] }).filter((n) => String(list.find((it) => it.number === n)?.body ?? "").includes(dependsLine(amendment)));
  const v = validateDispositions(d, held);
  if (!v.ok) return v;
  for (const r of v.rows) {
    const cur = String(list.find((it) => it.number === r.n)?.body ?? "");
    if (r.disposition === "dropped") {
      await create(["issue", "close", String(r.n), "-R", repo, "--reason", "not planned", "--comment", `Dropped: superseded by the design amendment in #${amendment}.`]);
      continue;
    }
    const base = r.disposition === "re-scoped" ? (parentOf(r.body) ? r.body : `${r.body.replace(/\s+$/, "")}\n\n**Parent**: #${epic}\n`) : cur;
    await create(["issue", "edit", String(r.n), "-R", repo, "--body", releaseEdge(base, amendment)]);
  }
  const ep = JSON.parse(String(await gh(["issue", "view", String(epic), "-R", repo, "--json", "body"])) || "{}");
  const next = renderEpicChecklist(ep.body, v.rows, amendment);
  if (next !== String(ep.body ?? "")) await create(["issue", "edit", String(epic), "-R", repo, "--body", next]);
  return { ok: true, rows: v.rows };
}

/** `forgedock replan apply --amendment N --repo owner/repo`. */
export async function replanFromCli(argv, deps = {}) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const usage = "usage: forgedock replan apply --amendment N --repo owner/repo";
  const amendment = issueNo(arg("--amendment")), repo = arg("--repo") ?? deps.repo;
  if (argv[0] !== "apply" || !amendment || !repo) throw new Error(usage);
  const io = deps.io ?? (await import("./effects.mjs")).makeLeanIo({ repo });
  const r = await applyReplan({ gh: (a) => io.gh(a), create: (a) => io.gh(a), repo, amendment });
  if (!r.ok) { process.stderr.write(`replan: ${r.problem}\n`); return 1; }
  for (const x of r.rows) process.stdout.write(`#${x.n}: ${x.disposition}\n`);
  return 0;
}
