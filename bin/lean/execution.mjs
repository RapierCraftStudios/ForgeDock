// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lane execution targets (#4253): forge.yaml `execution: {mode, max_remote, provider}` and the sandbox-provider seam
 * behind `orchestrate`'s `runOne`/`adopt`.
 *
 * A provider is `{name, idFor(issue), start({issue, args, env, secrets}) -> handle, status(handle) -> running|exited|gone,
 * fetchResult(handle) -> result|null, teardown(handle) -> boolean}`. A handle is JSON (persisted in the batch state so a
 * resumed dispatcher re-attaches) with `{provider, id, issue}`; `id` is `idFor(issue)`, known before the sandbox exists.
 * `teardown` returns true only when the sandbox is gone. Providers here: `local` (today's detached child, batch.mjs) and
 * the reference `container` (an ephemeral local container with its own clone of the checkout and a read-only shared
 * cache mount). The lane inside still runs `run-issue`, so results, leases and FORGE annotations flow through GitHub; the
 * dispatcher only reads the result file.
 *
 * `providerLanes` registers each sandbox in the lane ledger (kind `sandbox`) BEFORE `start` and releases it only after
 * `teardown` returned true, on every exit path (result, failure, no result, error, adopt after a restart). A dispatcher
 * killed mid-lane leaves the entry under its dead pid: a `--resume` adopts the sandbox, `forgedock gc --apply` reaps it.
 * Secrets reach a sandbox only by NAME from `execution.secrets` (plus FORGEDOCK_BATCH_ID and GH_REPO, the target repo);
 * values never appear in argv, the handle, the ledger or the batch state.
 *
 * Sandbox cost and budget (#4255): a provider may implement `usage(handle, {startedAt, endedAt}) -> {minutes, cost_usd}`;
 * otherwise a lane's usage is its wall-clock minutes (from the handle's persisted `startedAt`) times
 * `execution.cost_per_minute`. `providerLanes` attaches it to every result as `sandbox: {provider, id, minutes, cost_usd}`.
 * `openExecutionBudget` enforces the hard caps (`budget_minutes`/`budget_usd` per batch, `day_budget_*` per host UTC day,
 * from the host-day store `execution-budget.json` in the sched dir): pure arithmetic, no LLM.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isLaneAlive, launchLane, writeAtomic } from "./batch.mjs";
import { schedDir } from "./sched.mjs";
import { dockerLabels, safeSegment } from "./ledger.mjs";

export const EXECUTION_MODES = Object.freeze(["local", "remote", "hybrid"]);
export const SANDBOX_PROVIDERS = Object.freeze(["local", "container"]);
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const errText = (e) => String(e?.stderr || e?.message || e).split("\n")[0].slice(0, 300);

/**
 * forge.yaml `execution:` section (block style; parseForgeYaml gives strings) → {mode, maxRemote, provider, image,
 * secrets, budget}. Invalid values fall back to the defaults; mode defaults to local (today's behaviour). `budget` is the
 * flat-key `execution.budget` (#4255): a missing, non-numeric or negative cap is null (no cap).
 */
export function parseExecution(sec = {}) {
  const s = sec && typeof sec === "object" ? sec : {};
  const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
  const mode = EXECUTION_MODES.includes(str(s.mode)) ? str(s.mode) : "local";
  const n = Number(str(s.max_remote));
  const maxRemote = str(s.max_remote) !== "" && Number.isInteger(n) && n >= 0 ? n : 0;
  const provider = NAME_RE.test(str(s.provider)) ? str(s.provider) : mode === "local" ? "local" : "container";
  const image = IMAGE_RE.test(str(s.image)) ? str(s.image) : null;
  const raw = Array.isArray(s.secrets) ? s.secrets : str(s.secrets) ? str(s.secrets).split(",") : [];
  const secrets = [...new Set(raw.map((x) => String(x).trim()).filter((x) => ENV_RE.test(x)))];
  const cap = (v) => { const t = str(v), x = Number(t); return t !== "" && Number.isFinite(x) && x >= 0 ? x : null; };
  const cpm = cap(s.cost_per_minute);
  const budget = { batchMinutes: cap(s.budget_minutes), batchUsd: cap(s.budget_usd), dayMinutes: cap(s.day_budget_minutes), dayUsd: cap(s.day_budget_usd),
    onBudget: str(s.on_budget) === "local" ? "local" : "stop", costPerMinute: cpm ?? 0 };
  return { mode, maxRemote, provider, image, secrets, budget };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const nonNeg = (x) => (Number.isFinite(x) && x >= 0 ? x : null);

/** The host-day budget store: `FORGEDOCK_EXECUTION_BUDGET_FILE`, else `execution-budget.json` in the sched dir. */
export function executionBudgetFile(env = process.env) {
  return env.FORGEDOCK_EXECUTION_BUDGET_FILE || join(schedDir(env), "execution-budget.json");
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const KEEP_DAYS = 7;

/**
 * The execution budget (#4255). `record(key, {minutes, cost_usd})` adds one lane attempt to today's host total; the key
 * (`<batch>#<sandbox id>#<startedAt>`) makes a repeated record a no-op. `admit({minutes, cost_usd, running})` gets the
 * batch's settled + running usage (`running` the running part alone) and refuses once a batch cap, or a day cap with
 * today's host total plus this batch's running usage, is reached. A corrupt or unreadable day file refuses while a day
 * cap is set (a hard cap fails closed) and is ignored otherwise; it is never overwritten.
 */
export function openExecutionBudget({ budget = {}, file = executionBudgetFile(), now = () => Date.now() } = {}) {
  const b = budget ?? {};
  const dayCap = b.dayMinutes != null || b.dayUsd != null;
  const read = () => {
    let raw;
    try { raw = readFileSync(file, "utf8"); } catch (e) { return e?.code === "ENOENT" ? { ok: true, days: {} } : { ok: false }; }
    try {
      const o = JSON.parse(raw);
      if (!o || typeof o !== "object" || (o.days !== undefined && (typeof o.days !== "object" || o.days === null || Array.isArray(o.days)))) return { ok: false };
      return { ok: true, days: o.days ?? {} };
    } catch { return { ok: false }; }
  };
  const totals = (day) => {
    let minutes = 0, cost_usd = 0;
    for (const u of Object.values(day ?? {})) { minutes += nonNeg(u?.minutes) ?? 0; cost_usd += nonNeg(u?.cost_usd) ?? 0; }
    return { minutes: round1(minutes), cost_usd: round6(cost_usd) };
  };
  const dayTotals = () => { const r = read(); return r.ok ? { ok: true, day: utcDay(now()), ...totals(r.days[utcDay(now())]) } : { ok: false, day: utcDay(now()), minutes: null, cost_usd: null }; };
  return {
    file, budget: b,
    record: (key, u) => {
      const r = read();
      if (!r.ok) return false;
      const d = utcDay(now()), today = { ...(r.days[d] ?? {}) };
      if (today[key]) return false;
      today[key] = { minutes: nonNeg(u?.minutes) ?? 0, cost_usd: nonNeg(u?.cost_usd) ?? 0, at: now() };
      const days = { [d]: today };
      for (const [k, v] of Object.entries(r.days)) if (k !== d && Date.parse(k) > now() - KEEP_DAYS * 86400000) days[k] = v;
      writeAtomic(file, JSON.stringify({ v: 1, days }, null, 2) + "\n");
      return true;
    },
    dayTotals,
    admit: (u = {}) => {
      const m = nonNeg(u.minutes) ?? 0, c = nonNeg(u.cost_usd) ?? 0;
      if (b.batchMinutes != null && m >= b.batchMinutes) return { ok: false, reason: `batch sandbox minutes ${round1(m)} >= budget_minutes ${b.batchMinutes}` };
      if (b.batchUsd != null && c >= b.batchUsd) return { ok: false, reason: `batch sandbox cost $${c.toFixed(2)} >= budget_usd ${b.batchUsd}` };
      if (!dayCap) return { ok: true };
      const t = dayTotals();
      if (!t.ok) return { ok: false, reason: `host-day budget file ${file} is unreadable; fix or remove it` };
      const dm = t.minutes + (nonNeg(u.running?.minutes) ?? 0), dc = t.cost_usd + (nonNeg(u.running?.cost_usd) ?? 0);
      if (b.dayMinutes != null && dm >= b.dayMinutes) return { ok: false, reason: `host sandbox minutes today ${round1(dm)} >= day_budget_minutes ${b.dayMinutes}` };
      if (b.dayUsd != null && dc >= b.dayUsd) return { ok: false, reason: `host sandbox cost today $${dc.toFixed(2)} >= day_budget_usd ${b.dayUsd}` };
      return { ok: true };
    },
  };
}

/** Where a lane runs: remote only for `mode: remote` with `max_remote >= 1`; hybrid stays local until #4256 places it. */
export function placement(exec) {
  return exec?.mode === "remote" && Number.isInteger(exec.maxRemote) && exec.maxRemote >= 1 ? "remote" : "local";
}

/** The env a sandbox gets: FORGEDOCK_BATCH_ID, GH_REPO and the allowlisted secret names present in `env`. Nothing else. */
export function scopedEnv({ env = {}, secrets = [], batchId, repo }) {
  const out = {};
  if (batchId) out.FORGEDOCK_BATCH_ID = String(batchId);
  if (repo) out.GH_REPO = String(repo);
  for (const k of secrets) if (ENV_RE.test(k) && env[k] !== undefined && env[k] !== "") out[k] = String(env[k]);
  return out;
}

/** Today's detached child as a provider: the handle carries the pid; nothing to tear down (the lane is its own process). */
export function localProvider({ batch, script, cwd, bin, spawnFn, alive = isLaneAlive }) {
  return {
    name: "local",
    idFor: (issue) => `local-${safeSegment(batch.id)}-${issue}`,
    async start({ issue, args = [], env = process.env }) {
      const { pid } = launchLane({ batch, issue, args, script, cwd, env, ...(bin ? { bin } : {}), ...(spawnFn ? { spawnFn } : {}) });
      return { provider: "local", id: `local-${safeSegment(batch.id)}-${issue}`, issue, pid };
    },
    async status(h) { return alive(h?.pid, batch.resultFile(h?.issue)) ? "running" : "exited"; },
    async fetchResult(h) { return readJson(batch.resultFile(h?.issue)); },
    async teardown() { return true; },
  };
}

const pexec = promisify(execFile);
/** `docker <args>` with exactly `env` added to a minimal base (PATH, HOME, DOCKER_*), so `-e NAME` reads only those. */
export const runDocker = async (args, { env = {} } = {}) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "PATH" || k === "HOME" || k.startsWith("DOCKER_")));
  return (await pexec("docker", args, { env: { ...base, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 120000 })).stdout;
};

/**
 * Reference sandbox: `docker run -d --rm --pull never` of `image`, labelled like every ForgeDock container (#4181) plus
 * `forgedock.sandbox=1` (`labels` entries override the lane's own of the same key). The image must provide git and
 * `forgedock`. Mounts: the checkout's git dir read-only at /src (cloned into the container's own /work), the
 * shared cache dir read-only at /cache (when it exists), and the batch `lanes/` dir at /result (result + log).
 * `command(issue, args, resultPath, logPath)` overrides the in-container argv (tests run a stub lane).
 */
export function containerProvider({ batch, repo, image, gitDir, cacheDir = `${homedir()}/.forge/verify-cache`, docker = runDocker, labels = [],
  mounts = [], command = null, user = typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid()}` : null, now = () => Date.now(), ttlMs = 6 * 3600 * 1000 }) {
  const idFor = (issue) => `fdsbx-${safeSegment(batch.id)}-${issue}`;
  const defaultCommand = (issue, args, rf, log) => ["sh", "-c",
    'exec >>"$LANE_LOG" 2>&1; git -c safe.directory="*" clone -q /src /work && cd /work && exec forgedock "$@"', "sandbox", "run-issue", String(issue), ...args, "--result-file", rf];
  return {
    name: "container",
    idFor,
    async start({ issue, args = [], env = {}, secrets = [] }) {
      if (!image) throw new Error("execution.image is required for the container provider");
      if (!gitDir) throw new Error("container provider needs the checkout's git dir");
      const rf = batch.resultFile(issue);
      rmSync(rf, { force: true });
      const lanesDir = dirname(rf);
      mkdirSync(lanesDir, { recursive: true }); // docker would create a missing bind source as root
      const scoped = { ...scopedEnv({ env, secrets, batchId: batch.id, repo }), HOME: "/tmp", LANE_LOG: `/result/${issue}.log` };
      const id = idFor(issue);
      const own = dockerLabels({ batch: batch.id, lane: `sandbox-${issue}`, issue, expires: now() + ttlMs });
      const argv = ["run", "-d", "--rm", "--pull", "never", "--name", id,
        ...[...own.filter((o) => !labels.some((l) => String(l).split("=")[0] === o.split("=")[0])), ...labels, "forgedock.sandbox=1"].flatMap((l) => ["--label", l]),
        ...(user ? ["--user", user] : []),
        "-v", `${gitDir}:/src:ro`, ...(cacheDir && existsSync(cacheDir) ? ["-v", `${cacheDir}:/cache:ro`] : []), "-v", `${lanesDir}:/result`,
        ...mounts.flatMap((m) => ["-v", m]),
        ...Object.keys(scoped).flatMap((k) => ["-e", k]), // names only: docker reads each value from its own env
        image, ...(command ?? defaultCommand)(issue, args, `/result/${issue}.json`, `/result/${issue}.log`)];
      await docker(argv, { env: scoped });
      return { provider: "container", id, issue };
    },
    async status(h) {
      let s;
      try { s = String(await docker(["inspect", "-f", "{{.State.Status}}", h.id])).trim(); } catch { return "gone"; }
      return ["running", "created", "restarting"].includes(s) ? "running" : "exited";
    },
    async fetchResult(h) { return readJson(batch.resultFile(h?.issue)); },
    async teardown(h) {
      try { await docker(["rm", "-f", h.id]); return true; } catch (e) {
        if (/no such container/i.test(errText(e))) return true;
        // `--rm` may be removing it already ("removal ... already in progress"): torn down once inspect finds nothing.
        try { await docker(["inspect", "-f", "{{.Id}}", h.id]); return false; } catch { return true; }
      }
    },
  };
}

/** A provider by name; throws a typed error for an unknown one. */
export function providerByName(name, opts) {
  if (name === "local") return localProvider(opts);
  if (name === "container") return containerProvider(opts);
  const e = new Error(`unknown execution.provider ${JSON.stringify(name)} (known: ${SANDBOX_PROVIDERS.join(", ")})`);
  e.code = "execution.provider.unknown";
  throw e;
}

/**
 * Lane seams for `orchestrate()` over a provider, the same contract as batch.mjs `detachedLanes`. `ledgerFor(issue)`
 * returns that sandbox's ledger (ledger.mjs `makeLedger`).
 */
export function providerLanes({ provider, laneArgs, ledgerFor, env = process.env, secrets = [], pollMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  costPerMinute = 0, now = () => Date.now() }) {
  const cpm = nonNeg(Number(costPerMinute)) ?? 0;
  // #4255: the sandbox's usage, from the provider when it reports one, else wall clock since the handle's startedAt.
  const withUsage = async (r, h) => {
    if (!r || typeof r !== "object") return r;
    const endedAt = now(), startedAt = Number.isFinite(h?.startedAt) ? h.startedAt : endedAt;
    let u = null;
    try { u = typeof provider.usage === "function" ? await provider.usage(h, { startedAt, endedAt }) : null; } catch { u = null; }
    const minutes = nonNeg(u?.minutes) ?? round1(Math.max(0, endedAt - startedAt) / 60000);
    const cost = nonNeg(u?.cost_usd) ?? minutes * cpm;
    return { ...r, sandbox: { provider: provider.name, id: h.id, minutes: round1(minutes), cost_usd: round6(cost) } };
  };
  const tear = async (led, h) => {
    let ok = false;
    try { ok = (await provider.teardown(h)) === true; } catch { ok = false; }
    if (ok) { try { led?.release("sandbox", h.id); led?.remove(); } catch { /* the reaper retries */ } }
    return ok;
  };
  const wait = async (h) => {
    for (;;) {
      const r = await provider.fetchResult(h);
      if (r) return r;
      const st = await provider.status(h);
      if (st !== "running") {
        const last = await provider.fetchResult(h); // it may have written the result just before exiting
        return last ?? { terminalReason: "engine-error", detail: `sandbox ${h.id} ${st} without a result` };
      }
      await sleep(pollMs);
    }
  };
  return {
    runOne: async (n, lane, ctx = {}) => {
      const led = ledgerFor(n);
      const base = { provider: provider.name, id: provider.idFor(n), issue: n, startedAt: now() };
      // A sandbox an earlier attempt left behind (same id) goes first, or the new one could not start.
      if ((led?.entries("sandbox") ?? []).some((e) => e.value === base.id) && !(await tear(led, base))) {
        return { terminalReason: "engine-error", detail: `sandbox ${base.id} from an earlier attempt could not be torn down` };
      }
      led?.register("sandbox", base.id, { provider: provider.name, handle: base }); // before it exists
      let h = base, r;
      try {
        h = { ...base, ...(await provider.start({ issue: n, args: laneArgs(n, lane), env, secrets })), startedAt: base.startedAt };
        ctx.onStart?.({ ...(Number.isInteger(h.pid) ? { pid: h.pid } : {}), handle: h, remote: true });
        r = await wait(h);
      } catch (e) {
        r = { terminalReason: "engine-error", detail: `sandbox ${base.id}: ${errText(e)}` };
      } finally { await tear(led, h); }
      return withUsage(r, h);
    },
    adopt: async (n, rec) => {
      const saved = rec?.handle;
      if (!saved?.id || saved.provider !== provider.name) return null;
      // Usage runs from the sandbox's real start (persisted on the handle), not from this adopt.
      const h = { ...saved, ...(Number.isFinite(saved.startedAt) ? {} : Number.isFinite(rec?.startedAt) ? { startedAt: rec.startedAt } : {}) };
      const led = ledgerFor(n);
      led?.register("sandbox", h.id, { provider: provider.name, handle: { provider: h.provider, id: h.id, issue: h.issue, ...(Number.isFinite(h.startedAt) ? { startedAt: h.startedAt } : {}) } }); // now owned by this dispatcher
      let r;
      try {
        if (!(await provider.fetchResult(h)) && (await provider.status(h)) !== "running") { await tear(led, h); return null; } // relaunched
        r = await wait(h);
      } catch (e) {
        r = { terminalReason: "engine-error", detail: `sandbox ${h.id}: ${errText(e)}` };
      }
      await tear(led, h);
      return withUsage(r, h);
    },
  };
}
