// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account rotators (#5094). With `execution.account_rotator: tokenbaton`, the `claude` on PATH is a shim that runs every
 * call on the logged-in account with the most room (`CLAUDE_CONFIG_DIR=~/.claude-<n>`), so an exhausted account is not an
 * exhausted host. This adapter reads tokenbaton's per-account quota state: `~/.tokenbaton/current` (the account number)
 * and `~/.tokenbaton/live.<n>` (`"<5h used %> <5h reset epoch s> <weekly used %> <weekly reset epoch s> <updated s>"`).
 * Every method re-reads the files (no cache), never writes, and fails open: unreadable state behaves as no rotator.
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backendIdentity } from "../engine.mjs";

export const ROTATOR_KINDS = ["tokenbaton"];
/** An account has headroom below this 5-hour use (%), like the computeshare quota-aware picker. */
export const HEADROOM_PCT = 95;

/** One `live.N` line as numbers, or null when malformed. */
export function parseLive(text) {
  const f = String(text ?? "").trim().split(/\s+/).map(Number);
  if (f.length < 4 || !f.slice(0, 4).every(Number.isFinite)) return null;
  return { fiveHourPct: f[0], fiveHourResetMs: f[1] * 1000, weeklyPct: f[2], weeklyResetMs: f[3] * 1000 };
}

/**
 * Handle on an account rotator, or null (unknown kind, or no readable state).
 * @returns {null | {kind, accounts, current(), headroom(), resumeAt(), accountIdentity(n), currentIdentity(), isAccount(id)}}
 */
export function openRotator({ kind, home = homedir(), env = process.env, now = () => Date.now(), readFile = (p) => readFileSync(p, "utf8"), listDir = (d) => readdirSync(d) } = {}) {
  if (!ROTATOR_KINDS.includes(kind)) return null;
  const dir = join(home, ".tokenbaton");
  const current = () => { try { const n = Number(String(readFile(join(dir, "current"))).trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; } };
  const accounts = () => {
    let names = [];
    try { names = listDir(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      const m = /^live\.(\d+)$/.exec(name);
      if (!m) continue;
      let live = null;
      try { live = parseLive(readFile(join(dir, name))); } catch { live = null; }
      if (live) out.push({ n: Number(m[1]), ...live });
    }
    return out.sort((a, b) => a.n - b.n);
  };
  if (current() === null || !accounts().length) return null;
  const used = (pct, resetMs) => (resetMs <= now() ? 0 : pct);
  const hasRoom = (a) => used(a.fiveHourPct, a.fiveHourResetMs) < HEADROOM_PCT && used(a.weeklyPct, a.weeklyResetMs) < 100;
  const accountIdentity = (n) => backendIdentity({ backend: "cli", env: { ...env, CLAUDE_CONFIG_DIR: join(home, `.claude-${n}`) } });
  return {
    kind,
    /** The accounts with readable `live.N` state, re-read on every access. */
    get accounts() { return accounts(); },
    current,
    /** True when any account has headroom. */
    headroom: () => accounts().some(hasRoom),
    /** Epoch ms at which the first account regains headroom (now when one has it), or null when unknown. */
    resumeAt: () => {
      const t = now(), at = accounts().map((a) => {
        if (hasRoom(a)) return t;
        const r = [];
        if (used(a.fiveHourPct, a.fiveHourResetMs) >= HEADROOM_PCT) r.push(a.fiveHourResetMs);
        if (used(a.weeklyPct, a.weeklyResetMs) >= 100) r.push(a.weeklyResetMs);
        return Math.max(...r);
      }).filter((x) => Number.isFinite(x) && x > 0);
      return at.length ? Math.min(...at) : null;
    },
    accountIdentity,
    /** Identity of the current account; null when `current` is unreadable. */
    currentIdentity: () => { const n = current(); return n === null ? null : accountIdentity(n); },
    /** True when `id` is the identity of one of the rotator's accounts. */
    isAccount: (id) => typeof id === "string" && accounts().some((a) => accountIdentity(a.n) === id),
  };
}

/** True while a usage-limited call should be retried at once on the next account: headroom, and fewer tries than accounts. */
export function rotatorRetry(rotator, tries) {
  try { return Boolean(rotator) && tries < rotator.accounts.length && rotator.headroom(); } catch { return false; }
}

/**
 * How orchestrate requeues a `rate_limited` lane under a rotator (#5094), or null when the host hold applies (no rotator,
 * no account with headroom, unreadable state). A lane that ran on one of the rotator's accounts (or reported none) is rerun
 * at once, at most once per account; any other credential (a remote sandbox's) waits for its own reset. Neither sets a host hold.
 * #5203: `poolId` (orchestrate's `remote.identity()`, the pool hold key) rotates like a rotator account: since #5165 the pool
 * router hands each sandbox the lowest-usage tokenbaton login, so a rerun lands on another account.
 * @returns {null | {delayMs:number, rotated:boolean}}
 */
export function quotaRequeue({ rotator, r, prior = null, delayMs, poolId = null }) {
  if (!rotator) return null;
  try {
    if (!rotator.headroom()) return null;
    const id = r?.backendId ?? null, rotations = Number(prior?.rotations) || 0;
    if ((!id || (poolId && id === poolId) || rotator.isAccount(id)) && rotations < rotator.accounts.length) return { delayMs: 0, rotated: true };
    return { delayMs, rotated: false };
  } catch { return null; }
}
