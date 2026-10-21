// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#4275: the context compiler. Before the builder's plan call the engine compiles the issue's GitHub/git
 * neighbourhood into a small, budgeted context pack: explicit links (parent, Depends on, cross-references, siblings),
 * prior attempts at this issue, merged PRs on the issue's files that were reverted or whose decisions/findings name a
 * symbol from the issue, and repo-fact file pointers. Only GitHub and git are read; nothing here is ForgeDock-specific
 * beyond the FORGE:* records lanes already write. `gatherContextFacts` does the I/O; `compileContextPack` is pure, so the
 * same facts always give a byte-identical pack. The pack is a hint: it never enters the issue text contracts quote from.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isTrustedComment, parseDependsOn } from "../engine/phases.mjs";
import { codeForTerminalReason } from "../engine/outcome-codes.mjs";
import { namedPaths } from "./prefilter.mjs";
import { parseContractComment, noComments } from "./render.mjs";
import { REPO_FACTS_FILE, TEST_MAP_FILE } from "./testmap.mjs";

// noComments lives in render.mjs (#4298: one comment-strip helper for context, conformance and prefilter).
export { noComments };

export const CONTEXT_MODES = Object.freeze(["shadow", "on", "off"]);
export const CONTEXT_SOURCES = Object.freeze(["graph", "attempts", "pitfalls", "ledger", "facts"]);
export const DEFAULT_CONTEXT_BYTES = 6144;
export const DEFAULT_LEDGER_DAYS = 30;
/** #4375: a pitfall not seen in this many lanes of the repo ages out (forge.yaml engine.context_pack_pitfall_lanes). */
export const DEFAULT_PITFALL_LANES = 50;
/** Bounds on GitHub reads per pack: linked issues read, ledger PRs inspected. */
export const MAX_LINKS = 20;
export const MAX_LEDGER_PRS = 8;
export const REPO_FACT_FILES = Object.freeze([REPO_FACTS_FILE, TEST_MAP_FILE]);
const ATTEMPT_MARKERS = ["NEEDS_HUMAN", "BASE_SYNC", "FIX_CI"];
const LINE_MAX = 200;

const hash12 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
const oneLine = (s, max = LINE_MAX) => {
  const t = noComments(s, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const stripComments = (s) => noComments(s).replace(/\r\n/g, "\n").trim();
const byNum = (a, b) => a - b;

/** forge.yaml engine.context_pack (+ _sources, _bytes, _days, _pitfall_lanes) normalised; invalid values fall back to the defaults. */
export function parseContextPackConfig({ mode, sources, bytes, days, pitfallLanes } = {}) {
  const m = String(mode ?? "").trim().toLowerCase();
  const list = Array.isArray(sources) ? sources : typeof sources === "string" && sources.trim() ? sources.split(/[\s,]+/) : null;
  const picked = list ? CONTEXT_SOURCES.filter((s) => list.map((x) => String(x).trim().toLowerCase()).includes(s)) : [...CONTEXT_SOURCES];
  const pos = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
  return { mode: CONTEXT_MODES.includes(m) ? m : "shadow", sources: picked, budgetBytes: pos(bytes, DEFAULT_CONTEXT_BYTES), days: pos(days, DEFAULT_LEDGER_DAYS), pitfallLanes: pos(pitfallLanes, DEFAULT_PITFALL_LANES) };
}

/** `**Parent**: #N` (decomposition sub-issue body line); null when absent. */
export function parentOf(body) {
  const m = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*|__)?parent(?:\*\*|__)?[ \t]*:?(?:\*\*|__)?[ \t]*:?[ \t]*#(\d+)\b/im.exec(stripComments(body));
  return m ? Number(m[1]) : null;
}

/** The FORGE:STATE record a projector keeps in an issue body, or null. */
export function stateOf(body) {
  const m = /<!--\s*FORGE:STATE\s*(\{[\s\S]*?\})\s*-->/.exec(String(body ?? ""));
  if (!m) return null;
  try { const j = JSON.parse(m[1]); return j && typeof j === "object" ? j : null; } catch { return null; }
}

/** Issue numbers the body links to: `#N` and same-repo issue/PR URLs (HTML comments ignored). */
export function bodyLinks(body, repo, self) {
  const s = stripComments(body);
  const out = new Set([...s.matchAll(/(?:^|[^\w&/#])#(\d+)\b/g)].map((m) => Number(m[1])));
  if (repo) {
    const esc = String(repo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const m of s.matchAll(new RegExp(`github\\.com/${esc}/(?:issues|pull)/(\\d+)`, "g"))) out.add(Number(m[1]));
  }
  out.delete(Number(self));
  return [...out].filter((n) => Number.isSafeInteger(n) && n > 0).sort(byNum);
}

/**
 * Code symbols the issue names in backticks: identifiers with a case change, an underscore, a dot or a call `()`.
 * Plain lowercase words (`shadow`, `on`) and paths are left out, so a match means a specific function or symbol.
 */
export function issueSymbols(body) {
  const out = new Set();
  for (const m of stripComments(body).matchAll(/`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\(\))?`/g)) {
    const id = m[1];
    if (id.length < 3) continue;
    if (m[2] || /[a-z][A-Z]|_|\./.test(id) || /^[A-Z][a-z]+[A-Z]/.test(id)) out.add(id.split(".").at(-1));
  }
  return [...out].sort();
}

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namesSymbol = (text, symbols) => symbols.some((s) => new RegExp(`(?:^|[^\\w$])${reEscape(s)}(?:$|[^\\w$])`).test(String(text)));

/** Rerun (an earlier run left a record or salvage), decomposed child (`**Parent**`), or first attempt. */
export function laneType({ resumed = false, attempts = 0, body = "" } = {}) {
  if (resumed || attempts > 0) return "rerun";
  if (parentOf(body) != null) return "child";
  return "first";
}

/** Earlier runs visible without any extra call: a FORGE:STATE terminal reason in the body plus trusted attempt records. */
export function priorAttempts(body, comments = []) {
  return (stateOf(body)?.terminalReason ? 1 : 0) + comments.filter((c) => ATTEMPT_MARKERS.includes(markerOf(c?.body)) && trusted(c)).length;
}

/**
 * Cache key for a compiled pack: issue + base head SHA, plus the config that shapes it and (#4298, #4304) the hash of the
 * issue's human scope text (`scope`) and prior-attempt count, so an edit or a new attempt on the same base compiles a
 * fresh pack. Not `updatedAt`: the lane's own FORGE:STATE/CONTEXT posts and label edits bump it, so the cache never hit.
 * #4375: `stamp.pitfalls` (the selected pitfall signatures) joins the key, so a newly learned pitfall is never served stale.
 */
export const contextPackCacheKey = (issue, headSha, cfg = {}, stamp = {}) =>
  `context-${issue}-${String(headSha ?? "").trim().slice(0, 40) || "nohead"}-${hash12(JSON.stringify([cfg.sources ?? [], cfg.budgetBytes ?? null, cfg.days ?? null,
    ...(stamp?.scope != null || stamp?.attempts != null ? [String(stamp.scope ?? ""), Number(stamp.attempts) || 0] : []),
    ...(stamp?.links ? [`links:${stamp.links}`] : []), ...(stamp?.pitfalls?.length ? [`pitfalls:${stamp.pitfalls.join(",")}`] : [])]))}.json`;

/** Max referenced issues whose state is read for the cache stamp (#4318: one GraphQL call for all of them). */
export const LINK_STAMP_MAX = 100;
/**
 * #4316: the linked-issue part of the cache stamp: a hash of `n:STATE` for each issue the body references (parent, Depends
 * on, `#N` links), so a pack never shows a linked issue as open after it closed on the same base. #4318: one GraphQL call
 * reads every state plus the issue's own cross-reference/connected timeline count (a new relation changes the stamp too);
 * above LINK_STAMP_MAX the highest (most recent) numbers are kept. A failed call counts every number as `n:?`; never
 * throws; '' (and no call) when the body references nothing.
 */
export async function linkStateStamp({ gh, repo, issue, body }) {
  const parent = parentOf(body);
  const nums = [...new Set([...(parent ? [parent] : []), ...parseDependsOn(stripComments(body), issue), ...bodyLinks(body, repo, issue)])]
    .filter((n) => Number.isSafeInteger(n) && n > 0 && n !== Number(issue)).sort(byNum).slice(-LINK_STAMP_MAX);
  if (!nums.length) return "";
  const [owner, name] = String(repo ?? "").split("/");
  const self = Number(issue);
  const q = `query($o:String!,$n:String!){repository(owner:$o,name:$n){${Number.isSafeInteger(self) && self > 0
    ? `self:issueOrPullRequest(number:${self}){... on Issue{timelineItems(itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT,DISCONNECTED_EVENT]){totalCount}}}` : ""}${
    nums.map((n) => `i${n}:issueOrPullRequest(number:${n}){... on Issue{state} ... on PullRequest{state}}`).join(" ")}}}`;
  let r = null;
  try { r = JSON.parse(String(await gh(["api", "graphql", "-f", `query=${q}`, "-f", `o=${owner ?? ""}`, "-f", `n=${name ?? ""}`])))?.data?.repository ?? null; } catch { r = null; }
  const states = nums.map((n) => `${n}:${String(r?.[`i${n}`]?.state ?? "").toUpperCase() || "?"}`);
  const rel = r?.self?.timelineItems?.totalCount;
  return hash12([...states, `rel:${Number.isInteger(rel) ? rel : "?"}`].join(","));
}

// ---- gather (I/O) ----

const parseLines = (out) => String(out ?? "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && typeof x === "object");
const commentId = (c) => /#issuecomment-(\d+)/.exec(String(c?.url ?? ""))?.[1] ?? c?.id ?? null;
/**
 * forge#4297: a FORGE:STATE value as an outcome code (`ci.red`, `needs-human`, `conformance.unimplemented`), or null. A
 * linked issue's body is anyone's text, so a multi-line, marked-up or over-long value never reaches the pack.
 */
export const codeOf = (v) => (typeof v === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(v) ? v : null);
/**
 * The typed outcome of a FORGE:STATE record: the `terminalCode` and `failureClasses` the engine writes at the end of a run
 * (forge#4275); older records fall back to the code their terminal reason maps to (null for the catch-all).
 */
const outcomeOf = (st) => {
  const reason = codeOf(st?.terminalReason);
  const c = codeOf(st?.terminalCode) ?? (reason ? codeForTerminalReason(reason) : null);
  return codeOf(c) && c !== "unclassified" ? c : null;
};
const failuresOf = (st) => (Array.isArray(st?.failureClasses) ? [...new Set(st.failureClasses.map(codeOf).filter(Boolean))].sort().slice(0, 5) : []);
const trusted = (c) => {
  const login = String(c?.author?.login ?? c?.user?.login ?? "");
  return isTrustedComment({ author_association: c?.authorAssociation ?? c?.author_association, user: { login, type: c?.user?.type ?? (/\[bot\]$|^app\//.test(login) ? "Bot" : "User") } });
};
/** First line of a FORGE record that is not a marker or a heading. */
const recordLine = (body) => oneLine(noComments(body).split("\n").map((l) => l.trim()).find((l) => l && !/^#+\s/.test(l)) ?? "");
const markerOf = (body) => /^\s*<!--\s*FORGE:([A-Z_]+)\s*-->/.exec(String(body ?? ""))?.[1] ?? null;

async function readIssue(gh, repo, n) {
  const j = JSON.parse(String(await gh(["api", `repos/${repo}/issues/${n}`])));
  return { number: Number(j.number ?? n), title: oneLine(j.title, 120), state: String(j.state ?? "").toUpperCase() || null, stateReason: j.state_reason ?? null, body: String(j.body ?? ""), pr: Boolean(j.pull_request) };
}
async function readComments(gh, repo, n) {
  return parseLines(await gh(["api", "--paginate", `repos/${repo}/issues/${n}/comments`, "--jq", ".[] | {id, body, author_association, user: {type: .user.type, login: .user.login}} | @json"]));
}

/**
 * Collect the facts for one issue's pack. `io`: {gh, git, exists}; git runs in `cwd` (the lane worktree), base is the
 * base ref. Every source is independent and best effort: a failing source is listed in `errors` and contributes nothing.
 */
export async function gatherContextFacts({ io, repo, issue, iss, comments = [], cwd, base, sources = CONTEXT_SOURCES, days = DEFAULT_LEDGER_DAYS, now = Date.now(), pitfalls = [] }) {
  const facts = { issue: Number(issue), links: [], attempts: [], pitfalls: [], ledger: [], facts: [], errors: [] };
  const body = String(iss?.body ?? "");
  const on = new Set(sources);
  const step = async (name, fn) => { if (!on.has(name)) return; try { await fn(); } catch (e) { facts.errors.push(`${name}: ${oneLine(e?.message ?? e, 120)}`); } };
  const git = (args) => io.git(args, { cwd });

  await step("graph", async () => {
    const rel = new Map();
    const parent = parentOf(body);
    if (parent) rel.set(parent, "parent");
    for (const d of parseDependsOn(stripComments(body), issue)) if (!rel.has(d)) rel.set(d, "depends-on");
    for (const n of bodyLinks(body, repo, issue)) if (!rel.has(n)) rel.set(n, "link");
    let xrefs = [];
    try {
      // forge#4297: a reference from another repo carries that repo's number; only same-repo references are read here
      const own = `/repos/${String(repo).toLowerCase()}`;
      xrefs = String(await io.gh(["api", "--paginate", `repos/${repo}/issues/${issue}/timeline`, "--jq", '.[] | select(.event == "cross-referenced") | "\(.source.issue.repository_url) \(.source.issue.number)"']))
        .split("\n").map((l) => l.trim().split(" ")).filter(([url]) => String(url ?? "").toLowerCase().endsWith(own))
        .map(([, n]) => Number(n)).filter((n) => Number.isSafeInteger(n) && n > 0 && n !== Number(issue));
    } catch (e) { facts.errors.push(`graph: timeline ${oneLine(e?.message ?? e, 80)}`); }
    for (const n of [...new Set(xrefs)].sort(byNum)) if (!rel.has(n)) rel.set(n, "cross-ref");
    if (parent) {
      try {
        const pc = (await readComments(io.gh, repo, parent)).filter(trusted);
        const dec = [...pc].reverse().find((c) => markerOf(c.body) === "DECOMPOSED");
        const subs = dec ? [...String(dec.body).matchAll(/^[ \t]*[-*][ \t]+#(\d+)\b/gm)].map((m) => Number(m[1])) : [];
        for (const s of [...new Set(subs)].sort(byNum)) if (s !== Number(issue) && !rel.has(s)) rel.set(s, "sibling");
      } catch (e) { facts.errors.push(`graph: siblings ${oneLine(e?.message ?? e, 80)}`); }
    }
    const order = { parent: 0, "depends-on": 1, link: 2, "cross-ref": 3, sibling: 4 };
    const picked = [...rel.entries()].sort((a, b) => order[a[1]] - order[b[1]] || a[0] - b[0]).slice(0, MAX_LINKS);
    for (const [n, r] of picked) {
      let rec;
      try { rec = await readIssue(io.gh, repo, n); } catch { facts.links.push({ number: n, rel: r, title: null, state: null, code: null, result: "unreadable" }); continue; }
      const st = stateOf(rec.body);
      const reason = codeOf(st?.terminalReason), fails = failuresOf(st);
      facts.links.push({ number: n, rel: r, kind: rec.pr ? "pr" : "issue", title: rec.title, state: rec.state, code: outcomeOf(st),
        result: reason ?? (rec.state === "CLOSED" ? rec.stateReason ?? "closed" : null), ...(fails.length ? { failures: fails } : {}), ...(r === "parent" || r === "depends-on" ? { body: stripComments(rec.body) } : {}) });
    }
  });

  await step("attempts", async () => {
    const st = stateOf(body), reason = codeOf(st?.terminalReason), pr = Number(st?.pr);
    if (reason) facts.attempts.push({ kind: "state", ref: `#${issue} FORGE:STATE`, line: `last run ended ${reason}${outcomeOf(st) ? ` (${outcomeOf(st)})` : ""}${failuresOf(st).length ? `; failures ${failuresOf(st).join(", ")}` : ""}${Number.isSafeInteger(pr) && pr > 0 ? `, PR #${pr}` : ""}` });
    for (const c of comments) {
      const m = markerOf(c?.body);
      if (!m || !ATTEMPT_MARKERS.includes(m) || !trusted(c)) continue;
      facts.attempts.push({ kind: m.toLowerCase().replace("_", "-"), ref: `comment ${commentId(c) ?? "?"}`, line: `FORGE:${m}: ${recordLine(c.body)}` });
    }
    const refs = String(await git(["for-each-ref", "--format=%(refname) %(objectname:short)", `refs/forge/salvage/${issue}/`])).split("\n").map((l) => l.trim()).filter(Boolean).sort();
    for (const l of refs) { const [ref, sha] = l.split(" "); facts.attempts.push({ kind: "salvage", ref, line: `salvaged uncommitted work at ${sha ?? "?"} (git diff HEAD ${ref} --stat)` }); }
  });

  // #4375: already read and selected by the engine from the local ledger (pitfalls.mjs selectPitfalls); no I/O here
  await step("pitfalls", async () => {
    for (const p of Array.isArray(pitfalls) ? pitfalls : []) {
      if (p && typeof p.sig === "string") facts.pitfalls.push({ sig: p.sig, trigger: String(p.trigger ?? ""), lesson: oneLine(p.lesson ?? "", 160), globs: (p.globs ?? []).slice(0, 5), count: Number(p.count) || 1, match: p.match === "files" ? "files" : "repo" });
    }
  });

  await step("ledger", async () => {
    const paths = namedPaths(body);
    const symbols = issueSymbols(body);
    if (!paths.length || !base) return;
    const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
    const out = String(await git(["log", "--first-parent", `--since=${since}`, "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", base, "--", ...paths]));
    const commits = out.split("\x1e").filter((x) => x.trim()).map((rec) => {
      const [sha, subject = "", msg = "", files = ""] = rec.split("\x1f");
      const pr = Number(/Merge pull request #(\d+)/.exec(subject)?.[1] ?? /\(#(\d+)\)\s*$/.exec(subject)?.[1]) || null;
      return { sha: sha.trim(), subject: subject.trim(), msg, pr, files: files.split("\n").map((f) => f.trim()).filter(Boolean),
        revert: /^Revert\b/.test(subject.trim()) || /\/revert-\d+-/.test(subject) || /^This reverts commit [0-9a-f]{7,40}/m.test(msg) };
    });
    const reverts = commits.filter((c) => c.revert);
    const revertedBy = (c) => reverts.find((r) => r !== c && ((c.pr && (new RegExp(`#${c.pr}\\b`).test(`${r.subject}\n${r.msg}`) || new RegExp(`/revert-${c.pr}-`).test(r.subject))) || r.msg.includes(c.sha) || r.msg.includes(c.sha.slice(0, 12))));
    for (const c of commits.filter((x) => x.pr || x.revert).slice(0, MAX_LEDGER_PRS)) {
      let title = c.subject, notes = [];
      const reverted = c.revert ? null : revertedBy(c);
      if (c.pr) {
        try {
          const pr = JSON.parse(String(await io.gh(["api", `repos/${repo}/pulls/${c.pr}`, "--jq", "{title, body, head: .head.ref}"])));
          title = oneLine(pr.title ?? title, 120);
          const linked = Number(/issue-(\d+)/.exec(String(pr.head ?? ""))?.[1] ?? /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(String(pr.body ?? ""))?.[1]) || null;
          const recs = [...(await readComments(io.gh, repo, c.pr)), ...(linked ? await readComments(io.gh, repo, linked) : [])].filter(trusted);
          for (const r of recs) {
            const m = markerOf(r.body);
            if (m === "DECISION") notes.push(...String(r.body).split("\n").slice(1).map((l) => oneLine(l, 160)).filter((l) => l && !l.startsWith("#")).map((l) => `decision: ${l}`));
            if (m === "CONTRACT") for (const d of parseContractComment(r.body)?.contract?.decisions ?? []) notes.push(oneLine(`decision ${d?.id ?? ""}: ${d?.choice ?? ""}`, 160));
            if (m === "REVIEW") notes.push(...String(r.body).split("\n").filter((l) => /^- `[\w.-]+`:/.test(l.trim())).map((l) => oneLine(`finding ${l.trim().slice(2)}`, 160)));
          }
        } catch (e) { facts.errors.push(`ledger: PR #${c.pr} ${oneLine(e?.message ?? e, 80)}`); }
      }
      const named = [...new Set(notes)].filter((n) => namesSymbol(n, symbols));
      const titleNames = namesSymbol(`${title}\n${c.subject}`, symbols);
      if (!(c.revert || reverted || named.length || titleNames)) continue;
      facts.ledger.push({ pr: c.pr, sha: c.sha.slice(0, 12), title, revert: c.revert, reverted: reverted ? reverted.sha.slice(0, 12) : null, files: c.files.slice(0, 4), notes: named.slice(0, 2) });
    }
  });

  await step("facts", async () => {
    for (const p of REPO_FACT_FILES) if (await io.exists(`${cwd}/${p}`)) facts.facts.push(p);
  });
  return facts;
}

// ---- compile (pure) ----

// forge#4297: codes are re-checked here too, so facts read back from the cache get the same whitelist
const linkLine = (l) => { const fails = (Array.isArray(l.failures) ? l.failures : []).map(codeOf).filter(Boolean), res = codeOf(l.result);
  return `- #${l.number} [${l.rel}${l.kind === "pr" ? ", PR" : ""}] ${l.state ?? "?"}${l.title ? ` "${l.title}"` : ""}${codeOf(l.code) ? `; outcome ${l.code}` : ""}${res ? `; ${res}` : ""}${fails.length ? `; failures ${fails.join(", ")}` : ""}`; };
const pitfallLine = (p) => `- [${p.trigger}] ${oneLine(p.lesson, 160)}${p.globs?.length ? ` (${p.globs.join(", ")})` : ""}; seen ${p.count}×`;
const ledgerLine = (p) => `- ${p.pr ? `PR #${p.pr}` : "commit"} ${p.sha}${p.revert ? " [revert]" : ""}${p.reverted ? ` [reverted by ${p.reverted}]` : ""} "${p.title}"${p.files?.length ? ` (${p.files.join(", ")})` : ""}${p.notes?.length ? ` — ${p.notes.join("; ")}` : ""}`;

/**
 * The pack text for `facts`, ranked: explicit links (parent > Depends on > body links > cross-references > siblings),
 * prior attempts, recurring pitfalls of the repo (#4375, in the engine's selected order), the symbol ledger (newest first), repo-fact pointers. One line per item; a parent or dependency also
 * carries its full body when it fits. Items that do not fit `budgetBytes` are dropped whole and counted in `truncated`.
 * `pitfalls` lists the kept pitfalls ({sig, match}) for the run log (#4375).
 * @returns {{text:string, bytes:number, items:number, truncated:number, sources:object, found:object, hash:string|null, pitfalls:object[]}}
 */
export function compileContextPack(facts, { budgetBytes = DEFAULT_CONTEXT_BYTES, sources = CONTEXT_SOURCES } = {}) {
  const on = new Set(sources);
  const cand = [];
  if (on.has("graph")) for (const l of facts?.links ?? []) cand.push({ src: "graph", line: linkLine(l), full: l.body ? `${linkLine(l)}\n${l.body.split("\n").map((x) => `  > ${x}`).join("\n")}` : null });
  if (on.has("attempts")) for (const a of facts?.attempts ?? []) cand.push({ src: "attempts", line: `- ${a.ref}: ${oneLine(a.line)}` });
  if (on.has("pitfalls")) for (const p of facts?.pitfalls ?? []) cand.push({ src: "pitfalls", line: pitfallLine(p), pit: { sig: p.sig, match: p.match } });
  if (on.has("ledger")) for (const p of facts?.ledger ?? []) cand.push({ src: "ledger", line: ledgerLine(p) });
  if (on.has("facts")) for (const f of facts?.facts ?? []) cand.push({ src: "facts", line: `- ${f} (repo facts file; read it if relevant)` });
  const found = Object.fromEntries(CONTEXT_SOURCES.map((s) => [s, cand.filter((c) => c.src === s).length]));
  const empty = { text: "", bytes: 0, items: 0, truncated: 0, sources: Object.fromEntries(CONTEXT_SOURCES.map((s) => [s, 0])), found, hash: null, pitfalls: [] };
  if (!cand.length) return empty;
  const titles = { graph: "Linked issues and PRs", attempts: "Prior attempts at this issue", pitfalls: "Recurring pitfalls in this repo (past rework)", ledger: "Merged PRs on the same symbols (reverts, decisions, findings)", facts: "Repo facts" };
  const head = `Context pack for #${facts.issue}`;
  const size = (s) => Buffer.byteLength(s, "utf8");
  const kept = [];
  let used = size(head) + 1, truncated = 0;
  for (const c of cand) {
    const secCost = kept.some((k) => k.src === c.src) ? 0 : size(`\n${titles[c.src]}:`) + 1;
    const pick = [c.full, c.line].find((t) => t && used + secCost + size(t) + 1 <= budgetBytes);
    if (!pick) { truncated++; continue; }
    kept.push({ src: c.src, text: pick, pit: c.pit });
    used += secCost + size(pick) + 1;
  }
  if (!kept.length) return { ...empty, truncated };
  const parts = [head];
  for (const s of CONTEXT_SOURCES) {
    const rows = kept.filter((k) => k.src === s);
    if (rows.length) parts.push(`\n${titles[s]}:`, ...rows.map((r) => r.text));
  }
  const text = parts.join("\n");
  return { text, bytes: size(text), items: kept.length, truncated, sources: Object.fromEntries(CONTEXT_SOURCES.map((s) => [s, kept.filter((k) => k.src === s).length])), found, hash: hash12(text), pitfalls: kept.filter((k) => k.pit).map((k) => k.pit) };
}

/** The pack text without its pitfalls section (#4375: pitfalls are local only and never posted). */
export function publicPackText(text) {
  const out = [];
  let skip = false;
  for (const l of String(text ?? "").split("\n")) {
    if (/^[^\s-].*:$/.test(l)) skip = l === "Recurring pitfalls in this repo (past rework):";
    else if (skip && l === "") skip = false;
    if (!skip) out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** The collapsed FORGE:CONTEXT issue record body (without the marker); pitfalls show as a count only (#4375). */
export function renderContextRecord(pack, { mode, laneType: lt }) {
  const src = CONTEXT_SOURCES.map((s) => `${s} ${pack.sources?.[s] ?? 0}/${pack.found?.[s] ?? 0}`).join(", ");
  return `<details><summary>Context pack: ${pack.items} item(s), ${pack.bytes} bytes, ${pack.truncated} dropped (mode ${mode}, lane ${lt}, hash ${pack.hash})</summary>\n\nSources (included/found): ${src}${pack.sources?.pitfalls ? " (pitfalls are local only, not shown)" : ""}\n\n~~~~text\n${noComments(publicPackText(pack.text)).replace(/~~~~/g, "~~~")}\n~~~~\n</details>`;
}

/**
 * The pack for one run: read from the cache (`cacheDir`, keyed by issue + base head SHA + config + `stamp` {scope, attempts}) or gathered
 * and compiled, then cached. `gather` returns the facts; `fs` is {read, write, rename?, list?, rm?}. A gather that
 * reported source errors is not cached (#4298), the write goes through a temp file and a rename, and the issue's other
 * cached packs are pruned. A cache miss or any write/rename/prune failure is not an error.
 */
export async function contextPackFor({ cfg, issue, headSha, cacheDir, fs, gather, stamp = {} }) {
  const name = cacheDir && headSha ? contextPackCacheKey(issue, headSha, cfg, stamp) : null;
  const file = name ? join(cacheDir, name) : null;
  if (file && fs?.read) {
    try { const c = JSON.parse(await fs.read(file)); if (c?.pack && typeof c.pack.text === "string") return { ...c, cached: true }; } catch { /* miss */ }
  }
  const facts = await gather();
  const out = { pack: compileContextPack(facts, cfg), errors: facts?.errors ?? [] };
  if (file && fs?.write && !out.errors.length) await cachePack(fs, cacheDir, file, name, issue, JSON.stringify(out));
  return { ...out, cached: false };
}

async function cachePack(fs, cacheDir, file, name, issue, text) {
  try {
    if (typeof fs.rename === "function") {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.write(tmp, text);
      await fs.rename(tmp, file);
    } else await fs.write(file, text);
  } catch { return; /* cache is optional */ }
  if (typeof fs.list !== "function" || typeof fs.rm !== "function") return;
  try {
    const prefix = `context-${issue}-`;
    for (const f of await fs.list(cacheDir)) {
      if (f !== name && f.startsWith(prefix) && f.endsWith(".json")) { try { await fs.rm(join(cacheDir, f)); } catch { /* best effort */ } }
    }
  } catch { /* best effort */ }
}
