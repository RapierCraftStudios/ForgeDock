// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Auto-add of epic and decomposition children to a running batch (#4965): `orchestration.auto_add_children`.
// Pure and deterministic: the child scan reads one open-issue list per pass; no LLM call.
import { parentOf } from "./context.mjs";
import { parseHelpFields } from "./selftest-static.mjs";

export const AUTO_MODES = ["off", "decomposed", "epic", "all"];
export const DEFAULT_AUTO_MODE = "decomposed";
export const DEFAULT_POLL_S = 120;

/** @returns {string} a valid mode (case-insensitive), else `fallback` (forge.yaml typos never stop a batch). */
export function parseAutoMode(v, fallback = DEFAULT_AUTO_MODE) {
  const m = String(v ?? "").trim().toLowerCase();
  return AUTO_MODES.includes(m) ? m : fallback;
}

/** The CLI form: an unknown mode is an operator error. */
export function parseAutoModeFlag(v) {
  const m = String(v ?? "").trim().toLowerCase();
  if (!AUTO_MODES.includes(m)) throw new Error(`--auto-children must be one of ${AUTO_MODES.join(" | ")}`);
  return m;
}

/** Seconds between scans: a positive integer, else the default. */
export function parsePollS(v, fallback = DEFAULT_POLL_S) {
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** Does `mode` add the epic/tracker children (`epic`, `all`)? */
export const addsEpicChildren = (mode) => mode === "epic" || mode === "all";
/** Does `mode` join the sub-issues of a decomposed lane (`decomposed`, `all`; `epic` keeps today's join too)? */
export const joinsDecomposed = (mode) => mode !== "off";

const nodesOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.nodes) ? v.nodes : []);
const labelsOf = (it) => nodesOf(it?.labels).map((l) => String(l?.name ?? l));

/**
 * @param {{number:number, body?:string, labels?:any, parent?:any, subIssues?:any}[]} list one open-issue list
 * @param {Iterable<number>} roots the batch issues plus the `--epic N` epics
 * @param {Iterable<number>} skip issues the batch already holds
 * @returns {number[]} open children of a root, ascending: `**Parent**: #P` line, `parent` field, or the root's `subIssues`;
 *   an issue labelled `needs-human` is left out.
 */
export function selectChildren({ list, roots, skip = [] }) {
  const rootSet = new Set(roots), skipSet = new Set(skip), open = new Set(), out = new Set();
  for (const it of list ?? []) if (Number.isSafeInteger(it?.number)) open.add(it.number);
  for (const it of list ?? []) {
    const n = it?.number;
    if (!open.has(n)) continue;
    if (rootSet.has(n)) for (const s of nodesOf(it.subIssues)) if (open.has(s?.number)) out.add(s.number);
    const p = it.parent?.number ?? parentOf(it.body ?? "");
    if (p != null && rootSet.has(p)) out.add(n);
  }
  const byNum = new Map((list ?? []).map((it) => [it.number, it]));
  return [...out].filter((n) => !skipSet.has(n) && !labelsOf(byNum.get(n)).includes("needs-human")).sort((a, b) => a - b);
}

const REQUIRED_FIELDS = ["number", "body", "labels"], OPTIONAL_FIELDS = ["parent", "subIssues"];

/** The `--json` list this host's `gh issue list` accepts (read from its `--help`, K4): the required fields plus whichever sub-issue fields it advertises. */
export async function hostListFields(gh) {
  let have = [];
  try { have = parseHelpFields(await gh(["issue", "list", "--help"])); } catch { have = []; }
  return [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS.filter((f) => have.includes(f))];
}

/**
 * One open-issue list with what `selectChildren` reads. A host `gh` without `parent`/`subIssues` still lists with the
 * required fields, so children are found by their `**Parent**: #P` line.
 */
export async function readChildList({ gh, repo, limit = 1000, fields = null }) {
  const f = fields ?? (await hostListFields(gh));
  const raw = await gh(["issue", "list", "-R", repo, "--state", "open", "--limit", String(limit), "--json", f.join(",")]);
  const v = JSON.parse(raw);
  return Array.isArray(v) ? v : [];
}

/**
 * Issues another live batch of this repo still holds (in its order, no final row): children there are not added here.
 * @param {{batchMod:object, root:string, self:string, repo:string}} p
 */
export function liveElsewhere({ batchMod, root, self, repo }) {
  const held = new Set();
  let ids = [];
  try { ids = batchMod.listBatches(root); } catch { return held; }
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw : raw?.id;
    if (!id || id === self) continue;
    try {
      const b = batchMod.openBatch(root, id);
      if (b.readReport() || (b.readPlan()?.repo ?? repo) !== repo) continue;
      const st = b.store.load();
      if (!st) continue;
      for (const n of st.order ?? []) if (!(st.results ?? {})[n]) held.add(n);
    } catch { /* an unreadable batch holds nothing */ }
  }
  return held;
}

/** `#a blocked by #b, ...` for the declared edges of the added children that stay inside the batch. */
export const edgeText = (edges) => edges.map((e) => `#${e.from} blocked by #${e.to}`).join(", ");
