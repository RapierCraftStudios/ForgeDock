// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account rotators (#5094). With `execution.account_rotator: tokenbaton`, the `claude` on PATH is a shim that runs every
 * call on the logged-in account with the most room (`CLAUDE_CONFIG_DIR=~/.claude-<n>`), so an exhausted account is not an
 * exhausted host. This adapter reads tokenbaton's per-account quota state: `~/.tokenbaton/current` (the account number)
 * and `~/.tokenbaton/live.<n>` (`"<5h used %> <5h reset epoch s> <weekly used %> <weekly reset epoch s> <updated s>"`).
 * Every method re-reads the files (no cache), never writes, and fails open: unreadable state behaves as no rotator.
 * #5205: detected without config when TOKENBATON_HOME is set or the shim is the first `claude` on PATH; a sample whose
 * reset has passed is stale (unknown, never 0%); callers pass the accounts that just hit a limit as `exclude`; a rotation
 * relaunch pins an account picked here (tokenbaton#3 `--pick --json --exclude` when the CLI has it, else live.N).
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { backendIdentity } from "../engine.mjs";

export const ROTATOR_KINDS = ["tokenbaton"];
/** Env switch: `off` disables auto-detection (bin/tests/_tmp.mjs sets it for test processes, #5205). */
export const ROTATOR_ENV = "FORGEDOCK_ACCOUNT_ROTATOR";
/** Bound on every tokenbaton / tokenbaton-ctl call (ms). */
export const ROTATOR_CALL_TIMEOUT_MS = 5000;
/** An account has headroom below this 5-hour use (%), like the computeshare quota-aware picker. */
export const HEADROOM_PCT = 95;

/** One `live.N` line as numbers, or null when malformed. */
export function parseLive(text) {
  const f = String(text ?? "").trim().split(/\s+/).map(Number);
  if (f.length < 4 || !f.slice(0, 4).every(Number.isFinite)) return null;
  return { fiveHourPct: f[0], fiveHourResetMs: f[1] * 1000, weeklyPct: f[2], weeklyResetMs: f[3] * 1000, updatedMs: Number.isFinite(f[4]) && f[4] > 0 ? f[4] * 1000 : 0 };
}

/** #5236: a sample older than this is unknown for the 5-hour window, whatever its reset says (0 or absent updated = age unknown). */
export const ROTATOR_SAMPLE_MAX_AGE_MS = 30 * 60000;

const isExec = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
/** True when `p` (resolved) is tokenbaton's shim: `tokenbaton-exec`, or a `.tokenbaton/shim/claude`. */
export const isShim = (p) => { const r = real(p); return basename(r) === "tokenbaton-exec" || /[\\/]\.tokenbaton[\\/]shim[\\/]claude$/.test(r); };
/** Every executable `claude` on env.PATH, in PATH order. */
const claudesOnPath = (env) => String(env?.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "claude")).filter(isExec);
/** First `claude` on PATH, or null. */
export const firstClaude = (env = process.env) => claudesOnPath(env)[0] ?? null;
/** The real claude: the first `claude` on PATH that is not the shim (the shim's own rule), or null. */
export const realClaude = (env = process.env) => claudesOnPath(env).find((c) => !isShim(c)) ?? null;

/**
 * The account rotator in use (#5205): explicit `execution.account_rotator: tokenbaton` wins; `off` (or env
 * FORGEDOCK_ACCOUNT_ROTATOR=off) disables; unset auto-detects TOKENBATON_HOME or the shim first on PATH.
 * @returns {"tokenbaton"|null}
 */
export function rotatorKind({ execution = null, env = process.env, which = firstClaude } = {}) {
  const set = execution?.accountRotator;
  if (ROTATOR_KINDS.includes(set)) return set;
  if (set === "off" || String(env?.[ROTATOR_ENV] ?? "").toLowerCase() === "off") return null;
  if (env?.TOKENBATON_HOME) return "tokenbaton";
  try { const c = which(env); return c && isShim(c) ? "tokenbaton" : null; } catch { return null; }
}

/** The account a running claude uses, from /proc/<pid>/environ: TOKENBATON_ACCOUNT, else CLAUDE_CONFIG_DIR=<home>/.claude-<n>; null when unreadable. */
export function accountOfPid(pid, { procRoot = "/proc", readFile = (p) => readFileSync(p, "utf8") } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let vars;
  try { vars = String(readFile(join(procRoot, String(pid), "environ"))).split("\0"); } catch { return null; }
  const get = (k) => { const v = vars.find((x) => x.startsWith(`${k}=`)); return v === undefined ? null : v.slice(k.length + 1); };
  const t = Number(get("TOKENBATON_ACCOUNT"));
  if (get("TOKENBATON_ACCOUNT") && Number.isInteger(t) && t > 0) return t;
  const m = /[\\/]\.claude-(\d+)[\\/]?$/.exec(get("CLAUDE_CONFIG_DIR") ?? "");
  return m ? Number(m[1]) : null;
}

/** `exclude` as a Map account -> until ms (null when unknown): accepts a Set/array of numbers, a Map, or a plain object. */
export function excludeMap(exclude) {
  const out = new Map();
  if (!exclude) return out;
  const add = (n, until) => { const k = Number(n); if (Number.isInteger(k) && k > 0) out.set(k, Number.isFinite(Number(until)) && until !== null ? Number(until) : null); };
  if (exclude instanceof Map) for (const [n, u] of exclude) add(n, u);
  else if (Array.isArray(exclude) || exclude instanceof Set) for (const n of exclude) add(n, null);
  else if (typeof exclude === "object") for (const [n, u] of Object.entries(exclude)) add(n, u);
  return out;
}

const defaultExec = (cmd, args, { env, timeout = ROTATOR_CALL_TIMEOUT_MS } = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env });
  return { status: r.error ? null : r.status, stdout: String(r.stdout ?? "") };
};

/**
 * Handle on an account rotator, or null (unknown kind, or no readable state). The state dir is env.TOKENBATON_HOME
 * (as-is) unless `home` is passed, else ~/.tokenbaton.
 * @returns {null | {kind, accounts, current(), headroom(exclude), resumeAt(exclude), pick({exclude}), markLimited(n, untilMs),
 *   accountOfPid(pid), realClaude(env), accountIdentity(n), currentIdentity(), isAccount(id)}}
 */
export function openRotator({ kind, home = undefined, env = process.env, now = () => Date.now(), readFile = (p) => readFileSync(p, "utf8"), listDir = (d) => readdirSync(d), exec = defaultExec, stat = (p) => statSync(p).mtimeMs } = {}) {
  if (!ROTATOR_KINDS.includes(kind)) return null;
  const dir = home === undefined && env?.TOKENBATON_HOME ? String(env.TOKENBATON_HOME) : join(home ?? homedir(), ".tokenbaton");
  const userHome = home ?? homedir();
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
      if (!live) continue;
      const aged = live.updatedMs > 0 && now() - live.updatedMs > ROTATOR_SAMPLE_MAX_AGE_MS;
      // #5236: the polled `used.N` percent, when newer than the sample and itself fresh, replaces the 5-hour figure.
      let polled = null;
      try {
        const p = Number(String(readFile(join(dir, `used.${m[1]}`))).trim().split(/\s+/)[0]), at = stat(join(dir, `used.${m[1]}`));
        if (Number.isFinite(p) && p >= 0 && Number.isFinite(at) && at > live.updatedMs && now() - at <= ROTATOR_SAMPLE_MAX_AGE_MS) polled = p;
      } catch { polled = null; }
      out.push({ n: Number(m[1]), ...live, polledPct: polled, aged: aged && polled === null, stale: live.fiveHourResetMs <= now() || live.weeklyResetMs <= now() || (aged && polled === null) });
    }
    return out.sort((a, b) => a.n - b.n);
  };
  if (current() === null || !accounts().length) return null;
  // #5205: a window whose reset has passed is unknown (null), never 0%.
  const used = (pct, resetMs) => (resetMs <= now() ? null : pct);
  const full = (a) => { const r = []; const f = a.polledPct !== null && a.polledPct !== undefined ? a.polledPct : a.aged ? null : used(a.fiveHourPct, a.fiveHourResetMs), w = used(a.weeklyPct, a.weeklyResetMs);
    if (f !== null && f >= HEADROOM_PCT) r.push(a.fiveHourResetMs); if (w !== null && w >= 100) r.push(a.weeklyResetMs); return r; };
  /** "room" (fresh, under the caps), "stale" (a window unknown, none known full: worth one try), or "full". */
  const state = (a) => (full(a).length ? "full" : a.stale ? "stale" : "room");
  const resumeAt = (exclude) => {
    const ex = excludeMap(exclude), t = now();
    const at = accounts().map((a) => {
      if (ex.has(a.n)) { const r = [ex.get(a.n), ...full(a)].filter((x) => Number.isFinite(x) && x > t); return r.length ? Math.max(...r) : NaN; }
      return state(a) === "full" ? Math.max(...full(a)) : t;
    }).filter((x) => Number.isFinite(x) && x > 0);
    return at.length ? Math.min(...at) : null;
  };
  const localPick = (exclude) => {
    const ex = excludeMap(exclude), list = accounts().filter((a) => !ex.has(a.n));
    const fresh = list.filter((a) => state(a) === "room").sort((a, b) => (a.polledPct ?? a.fiveHourPct) - (b.polledPct ?? b.fiveHourPct) || a.n - b.n);
    if (fresh.length) return { account: fresh[0].n, stale: false };
    const stale = list.filter((a) => state(a) === "stale");
    if (stale.length) return { account: stale[0].n, stale: true };
    return { account: null, earliestReset: resumeAt(ex) };
  };
  const childEnv = () => ({ ...process.env, ...env, TOKENBATON_HOME: dir });
  const accountIdentity = (n) => backendIdentity({ backend: "cli", env: { ...env, CLAUDE_CONFIG_DIR: join(userHome, `.claude-${n}`) } });
  return {
    kind,
    /** The accounts with readable `live.N` state (`stale` when a window's reset has passed), re-read on every access. */
    get accounts() { return accounts(); },
    current,
    /** The tokenbaton state dir read. */
    dir,
    /** True when any non-excluded account has headroom (a fresh sample under the caps, or a stale one: worth a try). */
    headroom: (exclude) => { const ex = excludeMap(exclude); return accounts().some((a) => !ex.has(a.n) && state(a) !== "full"); },
    /** Epoch ms at which the first account regains headroom (now when one has it), or null when unknown; excluded ones count from their until. */
    resumeAt,
    /**
     * The account to run on next (#5205): tokenbaton#3 `--pick --json --exclude` when the CLI prints JSON (exit 2 = none),
     * else from live.N (fresh lowest use first, then stale). {account, stale} | {account:null, earliestReset}.
     */
    pick: ({ exclude } = {}) => {
      const ex = excludeMap(exclude);
      try {
        const r = exec("tokenbaton", ["--pick", "--json", ...(ex.size ? ["--exclude", [...ex.keys()].join(",")] : [])], { env: childEnv() });
        let j = null; try { j = JSON.parse(String(r?.stdout ?? "").trim()); } catch { j = null; }
        if (j && typeof j === "object") {
          const n = Number(j.account);
          if (r.status === 0 && Number.isInteger(n) && n > 0 && !ex.has(n)) return { account: n, stale: Boolean(j.stale) };
          if (r.status === 2) { const e = Number(j.earliest_reset); return { account: null, earliestReset: Number.isFinite(e) && e > 0 ? e * 1000 : resumeAt(ex) }; }
        }
      } catch { /* fall back to live.N */ }
      try { return localPick(ex); } catch { return { account: null, earliestReset: null }; }
    },
    /** Best-effort `tokenbaton-ctl mark-limited <n> --until <epoch s>`; false when unsupported. Never writes files itself. */
    markLimited: (n, untilMs) => {
      try {
        if (!Number.isInteger(n) || n <= 0) return false;
        const args = ["mark-limited", String(n), ...(Number.isFinite(untilMs) ? ["--until", String(Math.round(untilMs / 1000))] : [])];
        return exec("tokenbaton-ctl", args, { env: childEnv() })?.status === 0;
      } catch { return false; }
    },
    accountOfPid: (pid, opts) => { try { return accountOfPid(pid, opts); } catch { return null; } },
    realClaude: (e = env) => { try { return realClaude(e); } catch { return null; } },
    /** CLAUDE_CONFIG_DIR of account n. */
    configDir: (n) => join(userHome, `.claude-${n}`),
    accountIdentity,
    /** Identity of the current account; null when `current` is unreadable. */
    currentIdentity: () => { const n = current(); return n === null ? null : accountIdentity(n); },
    /** True when `id` is the identity of one of the rotator's accounts. */
    isAccount: (id) => typeof id === "string" && accounts().some((a) => accountIdentity(a.n) === id),
  };
}

/** True while a usage-limited call should be retried at once on the next account: headroom (outside `exclude`), and fewer tries than accounts. */
export function rotatorRetry(rotator, tries, exclude = null) {
  try { return Boolean(rotator) && tries < rotator.accounts.length && rotator.headroom(exclude); } catch { return false; }
}

/**
 * How orchestrate requeues a `rate_limited` lane under a rotator (#5094), or null when the host hold applies (no rotator,
 * no account with headroom outside `exclude`, unreadable state). A lane that ran on one of the rotator's accounts (or reported none) is rerun
 * at once, at most once per account; any other credential (a remote sandbox's) waits for its own reset. Neither sets a host hold.
 * #5203: `poolId` (orchestrate's `remote.identity()`, the pool hold key) rotates like a rotator account: since #5165 the pool
 * router hands each sandbox the lowest-usage tokenbaton login, so a rerun lands on another account.
 * @returns {null | {delayMs:number, rotated:boolean}}
 */
export function quotaRequeue({ rotator, r, prior = null, delayMs, exclude = null, poolId = null }) {
  if (!rotator) return null;
  try {
    if (!rotator.headroom(exclude)) return null;
    const id = r?.backendId ?? null, rotations = Number(prior?.rotations) || 0;
    if ((!id || (poolId && id === poolId) || rotator.isAccount(id)) && rotations < rotator.accounts.length) return { delayMs: 0, rotated: true };
    return { delayMs, rotated: false };
  } catch { return null; }
}
