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
import { parseContractComment } from "./render.mjs";

export const CONTEXT_MODES = Object.freeze(["shadow", "on", "off"]);
export const CONTEXT_SOURCES = Object.freeze(["graph", "attempts", "ledger", "facts"]);
export const DEFAULT_CONTEXT_BYTES = 6144;
export const DEFAULT_LEDGER_DAYS = 30;
/** Bounds on GitHub reads per pack: linked issues read, ledger PRs inspected. */
export const MAX_LINKS = 20;
export const MAX_LEDGER_PRS = 8;
export const REPO_FACT_FILES = Object.freeze([".forge/repo-facts.json", ".forge/test-map.json"]);
const ATTEMPT_MARKERS = ["NEEDS_HUMAN", "BASE_SYNC", "FIX_CI"];
const LINE_MAX = 200;

const hash12 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
const oneLine = (s, max = LINE_MAX) => {
  const t = String(s ?? "").replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const stripComments = (s) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").trim();
const byNum = (a, b) => a - b;

/** forge.yaml engine.context_pack (+ _sources, _bytes, _days) normalised; invalid values fall back to the defaults. */
export function parseContextPackConfig({ mode, sources, bytes, days } = {}) {
  const m = String(mode ?? "").trim().toLowerCase();
  const list = Array.isArray(sources) ? sources : typeof sources === "string" && sources.trim() ? sources.split(/[\s,]+/) : null;
  const picked = list ? CONTEXT_SOURCES.filter((s) => list.map((x) => String(x).trim().toLowerCase()).includes(s)) : [...CONTEXT_SOURCES];
  const pos = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
  return { mode: CONTEXT_MODES.includes(m) ? m : "shadow", sources: picked, budgetBytes: pos(bytes, DEFAULT_CONTEXT_BYTES), days: pos(days, DEFAULT_LEDGER_DAYS) };
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

const namesSymbol = (text, symbols) => symbols.some((s) => new RegExp(`(?:^|[^\\w$])${s.replace(/\$/g, "\\$")}(?:$|[^\\w$])`).test(String(text)));

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

/** Cache key for a compiled pack: issue + base head SHA, plus the config that shapes it. */
export const contextPackCacheKey = (issue, headSha, cfg = {}) =>
  `context-${issue}-${String(headSha ?? "").trim().slice(0, 40) || "nohead"}-${hash12(JSON.stringify([cfg.sources ?? [], cfg.budgetBytes ?? null, cfg.days ?? null]))}.json`;

// ---- gather (I/O) ----

const parseLines = (out) => String(out ?? "").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && typeof x === "object");
const commentId = (c) => /#issuecomment-(\d+)/.exec(String(c?.url ?? ""))?.[1] ?? c?.id ?? null;
/**
 * The typed outcome of a FORGE:STATE record: the `terminalCode` and `failureClasses` the engine writes at the end of a run
 * (forge#4275); older records fall back to the code their terminal reason maps to (null for the catch-all).
 */
const outcomeOf = (st) => {
  const reason = st?.terminalReason ?? null;
  const c = typeof st?.terminalCode === "string" && st.terminalCode ? st.terminalCode : reason ? codeForTerminalReason(reason) : null;
  return c && c !== "unclassified" ? c : null;
};
const failuresOf = (st) => (Array.isArray(st?.failureClasses) ? [...new Set(st.failureClasses.filter((x) => typeof x === "string" && x))].sort().slice(0, 5) : []);
const trusted = (c) => {
  const login = String(c?.author?.login ?? c?.user?.login ?? "");
  return isTrustedComment({ author_association: c?.authorAssociation ?? c?.author_association, user: { login, type: c?.user?.type ?? (/\[bot\]$|^app\//.test(login) ? "Bot" : "User") } });
};
/** First line of a FORGE record that is not a marker or a heading. */
const recordLine = (body) => oneLine(String(body ?? "").replace(/<!--[\s\S]*?-->/g, "").split("\n").map((l) => l.trim()).find((l) => l && !/^#+\s/.test(l)) ?? "");
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
export async function gatherContextFacts({ io, repo, issue, iss, comments = [], cwd, base, sources = CONTEXT_SOURCES, days = DEFAULT_LEDGER_DAYS, now = Date.now() }) {
  const facts = { issue: Number(issue), links: [], attempts: [], ledger: [], facts: [], errors: [] };
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
      xrefs = String(await io.gh(["api", "--paginate", `repos/${repo}/issues/${issue}/timeline`, "--jq", '.[] | select(.event == "cross-referenced") | .source.issue.number']))
        .split("\n").map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n > 0 && n !== Number(issue));
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
      const reason = st?.terminalReason ?? null, fails = failuresOf(st);
      facts.links.push({ number: n, rel: r, kind: rec.pr ? "pr" : "issue", title: rec.title, state: rec.state, code: outcomeOf(st),
        result: reason ?? (rec.state === "CLOSED" ? rec.stateReason ?? "closed" : null), ...(fails.length ? { failures: fails } : {}), ...(r === "parent" || r === "depends-on" ? { body: stripComments(rec.body) } : {}) });
    }
  });

  await step("attempts", async () => {
    const st = stateOf(body);
    if (st?.terminalReason) facts.attempts.push({ kind: "state", ref: `#${issue} FORGE:STATE`, line: `last run ended ${st.terminalReason}${outcomeOf(st) ? ` (${outcomeOf(st)})` : ""}${failuresOf(st).length ? `; failures ${failuresOf(st).join(", ")}` : ""}${st.pr ? `, PR #${st.pr}` : ""}` });
    for (const c of comments) {
      const m = markerOf(c?.body);
      if (!m || !ATTEMPT_MARKERS.includes(m) || !trusted(c)) continue;
      facts.attempts.push({ kind: m.toLowerCase().replace("_", "-"), ref: `comment ${commentId(c) ?? "?"}`, line: `FORGE:${m}: ${recordLine(c.body)}` });
    }
    const refs = String(await git(["for-each-ref", "--format=%(refname) %(objectname:short)", `refs/forge/salvage/${issue}/`])).split("\n").map((l) => l.trim()).filter(Boolean).sort();
    for (const l of refs) { const [ref, sha] = l.split(" "); facts.attempts.push({ kind: "salvage", ref, line: `salvaged uncommitted work at ${sha ?? "?"} (git diff HEAD ${ref} --stat)` }); }
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

const linkLine = (l) => `- #${l.number} [${l.rel}${l.kind === "pr" ? ", PR" : ""}] ${l.state ?? "?"}${l.title ? ` "${l.title}"` : ""}${l.code ? `; outcome ${l.code}` : ""}${l.result ? `; ${oneLine(l.result, 80)}` : ""}${l.failures?.length ? `; failures ${l.failures.join(", ")}` : ""}`;
const ledgerLine = (p) => `- ${p.pr ? `PR #${p.pr}` : "commit"} ${p.sha}${p.revert ? " [revert]" : ""}${p.reverted ? ` [reverted by ${p.reverted}]` : ""} "${p.title}"${p.files?.length ? ` (${p.files.join(", ")})` : ""}${p.notes?.length ? ` — ${p.notes.join("; ")}` : ""}`;

/**
 * The pack text for `facts`, ranked: explicit links (parent > Depends on > body links > cross-references > siblings),
 * prior attempts, the symbol ledger (newest first), repo-fact pointers. One line per item; a parent or dependency also
 * carries its full body when it fits. Items that do not fit `budgetBytes` are dropped whole and counted in `truncated`.
 * @returns {{text:string, bytes:number, items:number, truncated:number, sources:object, found:object, hash:string|null}}
 */
export function compileContextPack(facts, { budgetBytes = DEFAULT_CONTEXT_BYTES, sources = CONTEXT_SOURCES } = {}) {
  const on = new Set(sources);
  const cand = [];
  if (on.has("graph")) for (const l of facts?.links ?? []) cand.push({ src: "graph", line: linkLine(l), full: l.body ? `${linkLine(l)}\n${l.body.split("\n").map((x) => `  > ${x}`).join("\n")}` : null });
  if (on.has("attempts")) for (const a of facts?.attempts ?? []) cand.push({ src: "attempts", line: `- ${a.ref}: ${oneLine(a.line)}` });
  if (on.has("ledger")) for (const p of facts?.ledger ?? []) cand.push({ src: "ledger", line: ledgerLine(p) });
  if (on.has("facts")) for (const f of facts?.facts ?? []) cand.push({ src: "facts", line: `- ${f} (repo facts file; read it if relevant)` });
  const found = Object.fromEntries(CONTEXT_SOURCES.map((s) => [s, cand.filter((c) => c.src === s).length]));
  const empty = { text: "", bytes: 0, items: 0, truncated: 0, sources: Object.fromEntries(CONTEXT_SOURCES.map((s) => [s, 0])), found, hash: null };
  if (!cand.length) return empty;
  const titles = { graph: "Linked issues and PRs", attempts: "Prior attempts at this issue", ledger: "Merged PRs on the same symbols (reverts, decisions, findings)", facts: "Repo facts" };
  const head = `Context pack for #${facts.issue}`;
  const size = (s) => Buffer.byteLength(s, "utf8");
  const kept = [];
  let used = size(head) + 1, truncated = 0;
  for (const c of cand) {
    const secCost = kept.some((k) => k.src === c.src) ? 0 : size(`\n${titles[c.src]}:`) + 1;
    const pick = [c.full, c.line].find((t) => t && used + secCost + size(t) + 1 <= budgetBytes);
    if (!pick) { truncated++; continue; }
    kept.push({ src: c.src, text: pick });
    used += secCost + size(pick) + 1;
  }
  if (!kept.length) return { ...empty, truncated };
  const parts = [head];
  for (const s of CONTEXT_SOURCES) {
    const rows = kept.filter((k) => k.src === s);
    if (rows.length) parts.push(`\n${titles[s]}:`, ...rows.map((r) => r.text));
  }
  const text = parts.join("\n");
  return { text, bytes: size(text), items: kept.length, truncated, sources: Object.fromEntries(CONTEXT_SOURCES.map((s) => [s, kept.filter((k) => k.src === s).length])), found, hash: hash12(text) };
}

/** The collapsed FORGE:CONTEXT issue record body (without the marker). */
export function renderContextRecord(pack, { mode, laneType: lt }) {
  const src = CONTEXT_SOURCES.map((s) => `${s} ${pack.sources[s]}/${pack.found[s]}`).join(", ");
  return `<details><summary>Context pack: ${pack.items} item(s), ${pack.bytes} bytes, ${pack.truncated} dropped (mode ${mode}, lane ${lt}, hash ${pack.hash})</summary>\n\nSources (included/found): ${src}\n\n~~~~text\n${pack.text.replace(/~~~~/g, "~~~")}\n~~~~\n</details>`;
}

/**
 * The pack for one run: read from the cache (`cacheDir`, keyed by issue + base head SHA + config) or gathered and
 * compiled, then cached. `gather` returns the facts; `fs` is {read, write}. A cache miss or write failure is not an error.
 */
export async function contextPackFor({ cfg, issue, headSha, cacheDir, fs, gather }) {
  const file = cacheDir && headSha ? join(cacheDir, contextPackCacheKey(issue, headSha, cfg)) : null;
  if (file && fs?.read) {
    try { const c = JSON.parse(await fs.read(file)); if (c?.pack && typeof c.pack.text === "string") return { ...c, cached: true }; } catch { /* miss */ }
  }
  const facts = await gather();
  const out = { pack: compileContextPack(facts, cfg), errors: facts?.errors ?? [] };
  if (file && fs?.write) { try { await fs.write(file, JSON.stringify(out)); } catch { /* cache is optional */ } }
  return { ...out, cached: false };
}
