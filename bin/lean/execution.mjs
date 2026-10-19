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
 * sets `handle.minutes` (billable sandbox minutes) has them copied onto the lane result as `sandbox`.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { isLaneAlive, launchLane } from "./batch.mjs";
import { dockerLabels, safeSegment } from "./ledger.mjs";
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { resolveCredential } from "./credentials.mjs";
import { httpTransport, isActionsEndpoint, remoteProvider } from "./sandbox-remote.mjs";

export const EXECUTION_MODES = Object.freeze(["local", "remote", "hybrid"]);
export const SANDBOX_PROVIDERS = Object.freeze(["local", "container", "remote"]);
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const errText = (e) => String(e?.stderr || e?.message || e).split("\n")[0].slice(0, 300);

/**
 * forge.yaml `execution:` section (block style; parseForgeYaml gives strings) → {mode, maxRemote, provider, image,
 * secrets}, plus the remote provider settings `endpoint`, `tokenEnv`, `cacheStore`, `allowActions` (#4254) when set
 * (absent means null/false). Invalid values fall back to the defaults; mode defaults to local (today's behaviour). The
 * provider default is never `remote`.
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
  return { mode, maxRemote, provider, image, secrets, ...(endpoint ? { endpoint } : {}), ...(tokenEnv ? { tokenEnv } : {}), ...(cacheStore ? { cacheStore } : {}), ...(allowActions ? { allowActions } : {}) };
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
export function providerLanes({ provider, laneArgs, ledgerFor, env = process.env, secrets = [], pollMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
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
  // Billable minutes the provider put on the handle (#4254) travel with the lane result.
  const withMinutes = (r, h) => (r && typeof r === "object" && Number.isFinite(h?.minutes) ? { ...r, sandbox: { provider: h.provider, id: h.id, minutes: h.minutes } } : r);
  // A start failure repeats on a relaunch: typed, never engine-error (#4254). Retryable (capacity) defers with backoff.
  const startFailed = (id, e) => (e?.retryable === true
    ? { terminalReason: "deferred", code: OUTCOME_CODES.SANDBOX_CAPACITY, detail: `sandbox ${id} could not start (capacity): ${errText(e)}`, ...(Number(e.retryInSeconds) > 0 ? { retryInSeconds: Number(e.retryInSeconds) } : {}) }
    : { terminalReason: "needs-human", code: OUTCOME_CODES.SANDBOX_START_FAILED, detail: `sandbox ${id} failed to start: ${errText(e)}` });
  return {
    runOne: async (n, lane, ctx = {}) => {
      const led = ledgerFor(n);
      const base = { provider: provider.name, id: provider.idFor(n), issue: n };
      // A sandbox an earlier attempt left behind (same id) goes first, or the new one could not start.
      if ((led?.entries("sandbox") ?? []).some((e) => e.value === base.id) && !(await tear(led, base))) {
        return { terminalReason: "engine-error", detail: `sandbox ${base.id} from an earlier attempt could not be torn down` };
      }
      led?.register("sandbox", base.id, { provider: provider.name, handle: base }); // before it exists
      let h = base, r, started = false;
      try {
        h = { ...base, ...(await provider.start({ issue: n, args: laneArgs(n, lane), env, secrets })) };
        started = true;
        ctx.onStart?.({ ...(Number.isInteger(h.pid) ? { pid: h.pid } : {}), handle: h, remote: true });
        r = await wait(h);
      } catch (e) {
        r = started ? { terminalReason: "engine-error", detail: `sandbox ${base.id}: ${errText(e)}` } : startFailed(base.id, e);
      }
      await tear(led, h); // every path, after the result is in (tear never throws)
      return withMinutes(r, h);
    },
    adopt: async (n, rec) => {
      const h = rec?.handle;
      if (!h?.id || h.provider !== provider.name) return null;
      const led = ledgerFor(n);
      led?.register("sandbox", h.id, { provider: provider.name, handle: { provider: h.provider, id: h.id, issue: h.issue } }); // now owned by this dispatcher
      let r;
      try {
        r = !(await provider.fetchResult(h)) && (await provider.status(h)) !== "running" ? null : await wait(h); // null: relaunched
      } catch (e) {
        r = { terminalReason: "engine-error", detail: `sandbox ${h.id}: ${errText(e)}` };
      }
      await tear(led, h);
      return withMinutes(r, h);
    },
  };
}
