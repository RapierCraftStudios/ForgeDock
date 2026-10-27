// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * needs-human premises and the owner-ask registry (#4725).
 *
 * A blocker that names an external fact records it as a machine-checkable predicate, `Premise: <kind>:<args>`:
 *   issue-closed:<N>            issue #N is closed
 *   date-after:<ISO date>       now is at or past the date
 *   pkg-version:<name>@<ver>    the registry's latest version of <name> is >= <ver> (`io.pkgVersion(name)`)
 * It is re-evaluated before the label is applied (`needsHuman`, lean.mjs) and on the daemon timer (`sweepPremises`): a predicate
 * that holds clears needs-human so the next scheduler pass picks the issue up. An unknown answer (unreadable, no resolver) never clears.
 *
 * Every owner ask is recorded once on GitHub as a `FORGE:ASK key=<hash>` annotation ({ask, unblocks:[issues]}); a new needs-human
 * with the same normalized ask links to the existing entry. GitHub is the register: nothing here is a local cache. Pure apart from `io`.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

export const PREMISE_MARKER = "FORGE:PREMISE";
export const ASK_MARKER = "FORGE:ASK";
const PREMISE_RE = /^\s*Premise:\s*(issue-closed|date-after|pkg-version):(\S+)\s*$/im;

/** The first `Premise:` line of a text as `{kind, arg}`, or null. */
export function parsePredicate(text) {
  const m = PREMISE_RE.exec(String(text ?? ""));
  if (!m) return null;
  const kind = m[1].toLowerCase(), arg = m[2];
  if (kind === "issue-closed") return /^#?\d+$/.test(arg) ? { kind, arg: String(Number(arg.replace("#", ""))) } : null;
  if (kind === "date-after") return Number.isFinite(Date.parse(arg)) ? { kind, arg } : null;
  return /^[^@\s]+@\d+(\.\d+)*[\w.+-]*$/.test(arg) ? { kind, arg } : null;
}

export const formatPredicate = (p) => (p ? `Premise: ${p.kind}:${p.arg}` : "");

/** Numeric dotted-version compare (pre-release tails are ignored): -1 | 0 | 1. */
export function comparePremiseVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** Production `io.pkgVersion`: the npm registry's latest version of `name`, or null when unreachable. */
export function registryPkgVersion(name) {
  return new Promise((resolve) => {
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(String(name))) return resolve(null);
    execFile("npm", ["view", String(name), "version"], { timeout: 15000 }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

/** true | false | null (unknown). Never throws. */
export async function evalPredicate(p, { repo, io, now = Date.now() } = {}) {
  try {
    if (!p) return null;
    if (p.kind === "date-after") return now >= Date.parse(p.arg);
    if (p.kind === "issue-closed") {
      const v = JSON.parse(String(await io.gh(["issue", "view", p.arg, "-R", repo, "--json", "state"])));
      const s = String(v?.state ?? "").toUpperCase();
      return s === "CLOSED" ? true : s === "OPEN" ? false : null;
    }
    if (p.kind === "pkg-version") {
      if (typeof io?.pkgVersion !== "function") return null;
      const at = p.arg.lastIndexOf("@");
      const cur = await io.pkgVersion(p.arg.slice(0, at));
      return typeof cur === "string" && cur ? comparePremiseVersions(cur, p.arg.slice(at + 1)) >= 0 : null;
    }
  } catch { /* unknown */ }
  return null;
}

/** The dependencies of `deps` whose issue is closed (`stateOf(n)` → "CLOSED"|"OPEN"|other): satisfied edges, never blockers. */
export async function closedEdges(deps, stateOf) {
  const out = [];
  for (const d of deps ?? []) {
    let s = "";
    try { s = String((await stateOf(d)) ?? "").toUpperCase(); } catch { s = ""; }
    if (s === "CLOSED") out.push(d);
  }
  return out;
}

export const closedEdgeNote = (closed) => (closed?.length ? `Note: ${closed.map((n) => `#${n}`).join(", ")} ${closed.length > 1 ? "are" : "is"} closed, so ${closed.length > 1 ? "those" : "that"} \`Depends on\` edge${closed.length > 1 ? "s are" : " is"} satisfied and not a blocker.` : "");

/** The ask text lower-cased with issue refs, punctuation and spacing removed: the dedup key's input. */
export function normalizeAsk(text) {
  return String(text ?? "").toLowerCase().replace(/#\d+/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
export const askKey = (text) => createHash("sha1").update(normalizeAsk(text)).digest("hex").slice(0, 12);

const askComment = (key, ask, unblocks) => `<!-- ${ASK_MARKER} key=${key} -->\n## Owner ask\n${JSON.stringify({ ask: String(ask).slice(0, 500), unblocks })}`;
const readAsk = (body) => { try { return JSON.parse(String(body).split("\n").slice(2).join("\n")); } catch { return null; } };

/**
 * Records `ask` for `issue` once. Returns `{key, existing}`: `existing` is the issue holding the entry (the new issue is added to its
 * `unblocks`, nothing new is created) or null when this issue now holds it. Fail-open: an unreadable registry means a fresh entry.
 */
export async function registerAsk({ repo, io, issue, ask }) {
  const key = askKey(ask);
  if (!normalizeAsk(ask)) return { key, existing: null };
  try {
    const list = JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--state", "open", "--label", "needs-human", "--limit", "100", "--search", `"${ASK_MARKER} key=${key}" in:comments`, "--json", "number,comments"])));
    for (const i of Array.isArray(list) ? list : []) {
      if (i?.number === issue) continue;
      const c = (i.comments ?? []).find((x) => String(x?.body ?? "").includes(`${ASK_MARKER} key=${key}`));
      if (!c) continue;
      const cur = readAsk(c.body) ?? { ask, unblocks: [i.number] };
      const unblocks = [...new Set([...(cur.unblocks ?? []), i.number, issue])].sort((a, b) => a - b);
      await io.gh(["issue", "comment", String(i.number), "-R", repo, "--body", askComment(key, cur.ask ?? ask, unblocks)]);
      return { key, existing: i.number, unblocks };
    }
  } catch { /* fail-open */ }
  return { key, existing: null, entry: askComment(key, ask, [issue]) };
}

/**
 * The needs-human issues whose recorded premise now holds lose the label (and `needs-human:external`) with a comment; the next
 * scheduler pass picks them up. Rows: cleared | still-blocked | unknown | error. Never throws.
 */
export async function sweepPremises({ repo, io, now = Date.now(), dryRun = false, onResult = null } = {}) {
  const rows = [];
  let list = [];
  try { list = JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--state", "open", "--label", "needs-human", "--limit", "100", "--json", "number,comments"]))); } catch { return rows; }
  for (const i of (Array.isArray(list) ? list : []).sort((a, b) => a.number - b.number)) {
    const c = [...(i.comments ?? [])].reverse().find((x) => String(x?.body ?? "").includes(`${PREMISE_MARKER} `));
    if (!c) continue;
    let row;
    try {
      const p = parsePredicate(String(c.body).replace(/<!--\s*FORGE:PREMISE\s+(.*?)\s*-->/s, "Premise: $1"));
      const held = await evalPredicate(p, { repo, io, now });
      row = { issue: i.number, outcome: held === true ? "cleared" : held === false ? "still-blocked" : "unknown", predicate: formatPredicate(p) };
      if (held === true && !dryRun) {
        await io.gh(["issue", "edit", String(i.number), "-R", repo, "--remove-label", "needs-human", "--remove-label", "needs-human:external"]);
        await io.gh(["issue", "comment", String(i.number), "-R", repo, "--body", `## Premise no longer holds\n\`${formatPredicate(p)}\` is now true: \`needs-human\` was cleared and the issue is back in the queue.`]);
      }
    } catch (e) { row = { issue: i.number, outcome: "error", detail: String(e?.message ?? e).slice(0, 160) }; }
    rows.push(row);
    try { if (!dryRun) await onResult?.(row); } catch { /* an event sink never fails the sweep */ }
  }
  return rows;
}

/** The marker line a needs-human comment carries so the sweep can re-read the predicate. */
export const premiseAnnotation = (p) => (p ? `<!-- ${PREMISE_MARKER} ${p.kind}:${p.arg} -->` : "");
