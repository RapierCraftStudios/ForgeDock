// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6238: one shared dedupe primitive for engine-filed issues. GitHub's text search does not reliably match hidden HTML-comment
// markers, so the lookup lists issues (state all) and filters bodies locally with `includes`; the search is only a hint.

const DAY_MS = 86_400_000;
export const REOPEN_WITHIN_MS = 30 * DAY_MS;
const WAITERS_RE = /<!-- FORGE:WAITERS ([\d,]*) -->/;

const parse = (raw) => { try { const r = JSON.parse(String(raw || "[]")); return Array.isArray(r) ? r : []; } catch { return []; } };
const isOpen = (r) => String(r?.state ?? "").toUpperCase() === "OPEN";
const numberOf = (out) => Number(/\/issues\/(\d+)/.exec(String(out))?.[1]) || null;

/** The plain alphanumeric token of a marker (`<!-- FORGE:X a.b -->` -> `FORGEXab`): safe as a search query, never a qualifier. */
export function plainToken(key) { return String(key).replace(/[^A-Za-z0-9]/g, ""); }

/** Issues whose body carries `key`, newest first. Tries a plain-token search, then the unfiltered list; empty on failure. */
export async function findFiledIssues({ ghc, repo, key }) {
  const cols = ["--state", "all", "--json", "number,state,closedAt,createdAt,body", "--limit", "100"];
  const local = (rows) => rows.filter((r) => String(r?.body ?? "").includes(key)).sort((x, y) => Number(y.number) - Number(x.number));
  try {
    const tok = plainToken(key);
    const hits = tok ? local(parse(await ghc(["issue", "list", "-R", repo, "--search", tok, ...cols]))) : [];
    if (hits.length) return hits;
    return local(parse(await ghc(["issue", "list", "-R", repo, ...cols])));
  } catch { return []; }
}

/** The waiter numbers in a body's FORGE:WAITERS block, or null when it has none. */
export function parseWaiters(body) {
  const m = WAITERS_RE.exec(String(body ?? ""));
  return m ? m[1].split(",").filter(Boolean).map(Number) : null;
}

/** `body` with its waiter block (visible line plus marker) replaced or appended. */
export function withWaiters(body, waiters) {
  const nums = [...new Set(waiters)].sort((a, b) => a - b);
  const block = `Waiting issues: ${nums.length ? nums.map((n) => `#${n}`).join(", ") : "none"}\n<!-- FORGE:WAITERS ${nums.join(",")} -->`;
  const text = String(body ?? "");
  const old = /(?:Waiting issues: [^\n]*\n)?<!-- FORGE:WAITERS [\d,]* -->/;
  return old.test(text) ? text.replace(old, block) : `${text}\n\n${block}`;
}

/** Adds/removes waiters in issue `number`'s body; reopens a closed issue when adding. Returns {waiters, hadBlock, state} (waiters null when unreadable). */
export async function updateWaiters({ ghc, repo, number, add = [], remove = [] }) {
  const v = JSON.parse(String(await ghc(["issue", "view", String(number), "-R", repo, "--json", "state,body"])));
  const prior = parseWaiters(v.body);
  const next = [...new Set([...(prior ?? []), ...add])].filter((n) => !remove.includes(n));
  const open = isOpen(v);
  if (add.length && !open) await ghc(["issue", "reopen", String(number), "-R", repo]);
  if (add.length || (prior && next.length !== prior.length)) {
    if (!prior || next.join() !== prior.join() || (add.length && !open)) await ghc(["issue", "edit", String(number), "-R", repo, "--body", withWaiters(v.body, next)]);
  }
  return { waiters: next, hadBlock: prior !== null, state: add.length ? "OPEN" : String(v.state ?? "").toUpperCase() };
}

/**
 * File or find the one issue carrying `key`: prefers open, else reopens a closed match closed within `reopenWithinMs`, else
 * creates. `occurrence` is appended as a comment only when not already on the issue. Returns {number, created, reopened}; number null on failure to create.
 */
export async function ensureFiledIssueDetailed({ ghc, repo, key, title, body, occurrence = "", reopenWithinMs = REOPEN_WITHIN_MS, now = Date.now() }) {
  const hits = await findFiledIssues({ ghc, repo, key });
  const hit = hits.find(isOpen) ?? hits.find((h) => now - Date.parse(h.closedAt) < reopenWithinMs);
  if (!hit) {
    const out = await ghc(["issue", "create", "-R", repo, "--title", String(title).slice(0, 120), "--body", body]);
    return { number: numberOf(out), created: true, reopened: false };
  }
  const reopened = !isOpen(hit);
  if (reopened) await ghc(["issue", "reopen", String(hit.number), "-R", repo]);
  const occ = String(occurrence ?? "").trim();
  if (occ && !String(hit.body ?? "").includes(occ)) {
    let seen = false;
    try { seen = (JSON.parse(String(await ghc(["issue", "view", String(hit.number), "-R", repo, "--json", "comments"])))?.comments ?? []).some((c) => String(c?.body ?? "").includes(occ)); } catch { /* comment anyway */ }
    if (!seen) await ghc(["issue", "comment", String(hit.number), "-R", repo, "--body", occ]);
  }
  return { number: Number(hit.number), created: false, reopened };
}

/** ensureFiledIssueDetailed, returning only the issue number. */
export async function ensureFiledIssue(args) { return (await ensureFiledIssueDetailed(args)).number; }
