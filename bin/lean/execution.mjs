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
 * `remote` (#4254, sandbox-remote.mjs) reaches a runner pool or remote session through a transport (`execution.endpoint`,
 * credential `execution.token_env` from the env or the keychain). It is never a default, and a GitHub Actions endpoint
 * needs `allow_actions: true`. A sandbox that fails to start is a typed outcome, not an engine-error: `needs-human`
 * `sandbox.start_failed`, or `deferred` `sandbox.capacity` when the provider marks the error retryable. A provider that
 * sets `handle.minutes` (billable sandbox minutes) has them used as the lane's sandbox minutes (#4255 below).
 *
 * Sandbox cost and budget (#4255): a provider may implement `usage(handle, {startedAt, endedAt}) -> {minutes, cost_usd}`;
 * otherwise a lane's usage is its wall-clock minutes (from the handle's persisted `startedAt`) times
 * `execution.cost_per_minute`. `providerLanes` attaches it to every result as `sandbox: {provider, id, minutes, cost_usd}`.
 * `openExecutionBudget` enforces the hard caps (`budget_minutes`/`budget_usd` per batch, `day_budget_*` per host UTC day,
 * from the host-day store `execution-budget.json` in the sched dir): pure arithmetic, no LLM.
 *
 * Hybrid (#4256): `placeLane` places each lane from facts (lane kind, validation weight, host headroom, verify.mode);
 * orchestrate runs a remote-placed lane locally when `max_remote` or the execution budget is exhausted.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, homedir, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isLaneAlive, launchLane, writeAtomic } from "./batch.mjs";
import { schedDir } from "./sched.mjs";
import { dockerLabels, safeSegment } from "./ledger.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { resolveCredential } from "./credentials.mjs";
import { httpTransport, isActionsEndpoint, remoteProvider } from "./sandbox-remote.mjs";
import { ADMISSION_DEFAULTS } from "./admission.mjs";
import { classifyStep, heavyConfig, memAvailableMb } from "./heavy.mjs";
import { detectPins } from "./toolchain.mjs";

export const EXECUTION_MODES = Object.freeze(["local", "remote", "hybrid"]);
export const SANDBOX_PROVIDERS = Object.freeze(["local", "container", "remote"]);
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const errText = (e) => String(e?.stderr || e?.message || e).split("\n")[0].slice(0, 300);

/**
 * forge.yaml `execution:` section (block style; parseForgeYaml gives strings) → {mode, maxRemote, provider, image,
 * secrets, budget}, plus the remote provider settings `endpoint`, `tokenEnv`, `cacheStore`, `allowActions` (#4254) when set
 * (absent means null/false). Invalid values fall back to the defaults; mode defaults to local (today's behaviour). The
 * provider default is never `remote`. `budget` is the flat-key `execution.budget` (#4255): a missing, non-numeric or
 * negative cap is null (no cap).
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
  let endpoint = null;
  try { const u = new URL(str(s.endpoint)); if (u.protocol === "https:" || u.protocol === "http:") endpoint = str(s.endpoint); } catch { endpoint = null; }
  const tokenEnv = ENV_RE.test(str(s.token_env)) ? str(s.token_env) : null;
  const cacheStore = str(s.cache_store) || null;
  const allowActions = str(s.allow_actions).toLowerCase() === "true";
  const cap = (v) => { const t = str(v), x = Number(t); return t !== "" && Number.isFinite(x) && x >= 0 ? x : null; };
  const cpm = cap(s.cost_per_minute);
  const budget = { batchMinutes: cap(s.budget_minutes), batchUsd: cap(s.budget_usd), dayMinutes: cap(s.day_budget_minutes), dayUsd: cap(s.day_budget_usd),
    onBudget: str(s.on_budget) === "local" ? "local" : "stop", costPerMinute: cpm ?? 0 };
  return { mode, maxRemote, provider, image, secrets, budget, ...(endpoint ? { endpoint } : {}), ...(tokenEnv ? { tokenEnv } : {}), ...(cacheStore ? { cacheStore } : {}), ...(allowActions ? { allowActions } : {}) };
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

/** Where a `mode: remote` lane runs: remote only with `max_remote >= 1`. Hybrid is placed per lane by `placeLane` (#4256). */
export function placement(exec) {
  return exec?.mode === "remote" && Number.isInteger(exec.maxRemote) && exec.maxRemote >= 1 ? "remote" : "local";
}

const DOCS_LABELS = new Set(["docs", "documentation", "type:docs"]);

/**
 * Hybrid placement (#4256), pure: facts in, `{where: "local"|"remote", reason}` out. `exec` is parseExecution output,
 * `verifyMode` forge.yaml `verify.mode`, `labels` the issue's label names (the lane kind), `weight` from
 * `validationWeight`, `headroom` from `hostHeadroom`. In order: a non-hybrid mode keeps `placement()`; `max_remote` 0 is
 * local; `verify.mode: ci` is local (heavy validation already runs, and is billed, on CI); a docs-only lane is local; a
 * heavy-validation lane is remote; a host without headroom sends the lane remote; anything else stays on the host.
 * Capacity (`max_remote` reached, the execution budget) is applied at admission by orchestrate, which falls back to local.
 */
export function placeLane({ exec = null, verifyMode = "local", labels = [], weight = null, headroom = null } = {}) {
  const mode = exec?.mode;
  if (mode !== "hybrid") { const where = placement(exec); return { where, reason: `mode ${EXECUTION_MODES.includes(mode) ? mode : "local"}` }; }
  if (!(Number.isInteger(exec.maxRemote) && exec.maxRemote >= 1)) return { where: "local", reason: "max_remote 0" };
  if (verifyMode === "ci") return { where: "local", reason: "verify.mode ci: validation runs on CI, not billed twice" };
  const names = (Array.isArray(labels) ? labels : []).map((l) => String(l ?? "").trim().toLowerCase());
  if (names.some((l) => DOCS_LABELS.has(l))) return { where: "local", reason: "docs-only lane" };
  if (weight?.heavy === true) {
    const sig = (Array.isArray(weight.signals) ? weight.signals : []).map(String).filter(Boolean);
    return { where: "remote", reason: `heavy validation${sig.length ? `: ${sig.join(", ")}` : ""}` };
  }
  if (headroom && headroom.ok === false) return { where: "remote", reason: `host without headroom${headroom.detail ? `: ${headroom.detail}` : ""}` };
  return { where: "local", reason: "light lane, host has headroom" };
}

/** Repo files that mean a heavy validation toolchain (type checks, linters, test suites, compiles). */
const HEAVY_MARKERS = Object.freeze([
  ["tsconfig.json", "tsc"], ["Cargo.toml", "cargo"], ["go.mod", "go"], ["pyproject.toml", "python"], ["setup.cfg", "python"], ["pytest.ini", "pytest"],
  ["pom.xml", "maven"], ["build.gradle", "gradle"], ["build.gradle.kts", "gradle"],
  ["eslint.config.js", "eslint"], ["eslint.config.mjs", "eslint"], ["eslint.config.cjs", "eslint"], [".eslintrc", "eslint"], [".eslintrc.js", "eslint"], [".eslintrc.cjs", "eslint"], [".eslintrc.json", "eslint"], [".eslintrc.yml", "eslint"],
]);
const HEAVY_SCRIPTS = Object.freeze(["test", "lint", "typecheck", "type-check", "build"]);

/**
 * The repo's expected validation weight (#4256): heavy when a declared check command (forge.yaml `learned.test_commands`)
 * classifies heavy (heavy.mjs `classifyStep`), or a heavy toolchain marker or package.json test/lint/typecheck/build script
 * exists. The toolchain pin (toolchain.mjs `detectPins`) names the package manager among the signals. Zero LLM.
 */
export async function validationWeight({ cwd = process.cwd(), precheckCommands = [], read = (p) => readFile(p, "utf8") } = {}) {
  const signals = [];
  const add = (s) => { if (!signals.includes(s)) signals.push(s); };
  for (const cmd of Array.isArray(precheckCommands) ? precheckCommands : []) {
    const [name, ...args] = String(cmd ?? "").trim().split(/\s+/).filter(Boolean);
    if (name && classifyStep(name, args) === "heavy") add(name.split("/").pop());
  }
  const exists = async (f) => { try { await read(join(cwd, f)); return true; } catch { return false; } };
  for (const [f, sig] of HEAVY_MARKERS) if (await exists(f)) add(sig);
  let pkg = null;
  try { pkg = JSON.parse(String(await read(join(cwd, "package.json")))); } catch { pkg = null; }
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  for (const k of HEAVY_SCRIPTS) if (typeof scripts[k] === "string" && scripts[k].trim()) add(`${k} script`);
  if (signals.length) {
    let pins = null;
    try { pins = await detectPins(cwd, { read: (p) => read(p) }); } catch { pins = null; }
    if (pins?.pm?.name) add(pins.pm.name);
  }
  return { heavy: signals.length > 0, signals };
}

/**
 * Host headroom snapshot for placement (#4256), synchronous: not ok when available memory is below the admission floor
 * (`min_free_mem_mb`) plus one heavy step (`step_mem_mb`), or the 1-min load per core exceeds `max_load_per_core` when
 * that is configured. Probes are injected; an unreadable probe does not count against the host.
 */
export function hostHeadroom({ cfg = {}, heavyCfg = {}, host = { memAvailableMb, loadAvg1: () => loadavg()[0], cores: () => cpus().length || 1 } } = {}) {
  const c = { ...ADMISSION_DEFAULTS, ...Object.fromEntries(Object.entries(cfg ?? {}).filter(([, v]) => v !== undefined && v !== null)) };
  const h = heavyConfig(heavyCfg ?? {});
  const probe = (fn) => { try { const v = fn?.(); return Number.isFinite(v) ? v : null; } catch { return null; } };
  if (c.enabled === false) return { ok: true, detail: "" };
  const reasons = [];
  const need = c.min_free_mem_mb + h.step_mem_mb, mem = probe(host?.memAvailableMb);
  if (mem !== null && mem < need) reasons.push(`mem ${mem} MB < ${need} MB`);
  const maxLoad = typeof c.max_load_per_core === "number" && Number.isFinite(c.max_load_per_core) ? c.max_load_per_core : null;
  if (maxLoad !== null) {
    const load = probe(host?.loadAvg1), cores = probe(host?.cores);
    if (load !== null && cores && load / cores > maxLoad) reasons.push(`load ${(load / cores).toFixed(1)}/core > ${maxLoad}`);
  }
  return { ok: reasons.length === 0, detail: reasons.join(", ") };
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

const typedError = (code, message) => Object.assign(new Error(message), { code });

/**
 * The remote transport for forge.yaml `execution` settings: `opts.transport` when injected, else `httpTransport` on
 * `exec.endpoint` with the credential `exec.tokenEnv` (env, then keychain). Throws `execution.provider.misconfigured`
 * without an endpoint, `execution.provider.actions_refused` for a GitHub Actions endpoint without `allow_actions`.
 */
export function remoteTransportFor(exec = {}, { transport = null, env = process.env, credentials = (n) => resolveCredential(n, { env }) } = {}) {
  if (transport) return transport;
  if (!exec?.endpoint) throw typedError("execution.provider.misconfigured", "execution.provider remote needs execution.endpoint");
  if (isActionsEndpoint(exec.endpoint) && exec.allowActions !== true) {
    throw typedError("execution.provider.actions_refused", "execution.endpoint is a GitHub Actions API; set execution.allow_actions: true to spend Actions minutes");
  }
  return httpTransport({ endpoint: exec.endpoint, token: exec.tokenEnv ? credentials(exec.tokenEnv) : null });
}

/** A provider by name; throws a typed error for an unknown one. `remote` reads `opts.exec` (parseExecution output). */
export function providerByName(name, opts) {
  if (name === "local") return localProvider(opts);
  if (name === "container") return containerProvider(opts);
  if (name === "remote") {
    const exec = opts?.exec ?? {};
    const env = opts?.env ?? process.env;
    return remoteProvider({ batch: opts.batch, repo: opts.repo, settings: exec, env, transport: remoteTransportFor(exec, { transport: opts?.transport, env }), ...(opts?.now ? { now: opts.now } : {}) });
  }
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
  // #4255: the sandbox's usage: the provider's `usage()`, else the billable minutes it put on the handle (#4254), else wall
  // clock since the handle's startedAt; cost is the provider's, else minutes x cost_per_minute.
  const withUsage = async (r, h) => {
    if (!r || typeof r !== "object") return r;
    const endedAt = now(), startedAt = Number.isFinite(h?.startedAt) ? h.startedAt : endedAt;
    let u = null;
    try { u = typeof provider.usage === "function" ? await provider.usage(h, { startedAt, endedAt }) : null; } catch { u = null; }
    const minutes = nonNeg(u?.minutes) ?? nonNeg(h?.minutes) ?? round1(Math.max(0, endedAt - startedAt) / 60000);
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
  // A start failure repeats on a relaunch: typed, never engine-error (#4254). Retryable (capacity) defers with backoff.
  const startFailed = (id, e) => (e?.retryable === true
    ? { terminalReason: "deferred", code: OUTCOME_CODES.SANDBOX_CAPACITY, detail: `sandbox ${id} could not start (capacity): ${errText(e)}`, ...(Number(e.retryInSeconds) > 0 ? { retryInSeconds: Number(e.retryInSeconds) } : {}) }
    : { terminalReason: "needs-human", code: OUTCOME_CODES.SANDBOX_START_FAILED, detail: `sandbox ${id} failed to start: ${errText(e)}` });
  return {
    runOne: async (n, lane, ctx = {}) => {
      const led = ledgerFor(n);
      const base = { provider: provider.name, id: provider.idFor(n), issue: n, startedAt: now() };
      // A sandbox an earlier attempt left behind (same id) goes first, or the new one could not start.
      if ((led?.entries("sandbox") ?? []).some((e) => e.value === base.id) && !(await tear(led, base))) {
        return { terminalReason: "engine-error", detail: `sandbox ${base.id} from an earlier attempt could not be torn down` };
      }
      led?.register("sandbox", base.id, { provider: provider.name, handle: base }); // before it exists
      let h = base, r, started = false;
      try {
        h = { ...base, ...(await provider.start({ issue: n, args: laneArgs(n, lane), env, secrets })) };
        if (!Number.isFinite(h.startedAt)) h.startedAt = base.startedAt;
        started = true;
        ctx.onStart?.({ ...(Number.isInteger(h.pid) ? { pid: h.pid } : {}), handle: h, remote: true });
        r = await wait(h);
      } catch (e) {
        r = started ? { terminalReason: "engine-error", detail: `sandbox ${base.id}: ${errText(e)}` } : startFailed(base.id, e);
      }
      await tear(led, h); // every path, after the result is in (tear never throws)
      return started ? withUsage(r, h) : r; // a sandbox that never started used nothing
    },
    adopt: async (n, rec, ctx = {}) => {
      const saved = rec?.handle;
      if (!saved?.id || saved.provider !== provider.name) return null;
      // Usage runs from the sandbox's real start (persisted on the handle), not from this adopt.
      const h = { ...saved, ...(Number.isFinite(saved.startedAt) ? {} : Number.isFinite(rec?.startedAt) ? { startedAt: rec.startedAt } : {}) };
      const led = ledgerFor(n);
      led?.register("sandbox", h.id, { provider: provider.name, handle: { provider: h.provider, id: h.id, issue: h.issue, ...(Number.isFinite(h.startedAt) ? { startedAt: h.startedAt } : {}) } }); // now owned by this dispatcher
      let r;
      try {
        const ended = await provider.fetchResult(h);
        if (!ended && (await provider.status(h)) !== "running") r = null; // relaunched
        else { if (!ended) ctx.onLive?.(); r = await wait(h); } // #4504: a live sandbox is awaited in the background
      } catch (e) {
        r = { terminalReason: "engine-error", detail: `sandbox ${h.id}: ${errText(e)}` };
      }
      await tear(led, h);
      return withUsage(r, h);
    },
  };
}
