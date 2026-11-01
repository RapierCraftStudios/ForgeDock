// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Durable batch state and detached lanes for `forgedock orchestrate` (#4121).
 *
 * A batch lives in `~/.forge/batches/<id>/` (or `FORGEDOCK_BATCH_DIR`): `plan.json` (the command), `state.json` (the
 * scheduler state, rewritten after every transition), `log.jsonl` (one line per lane update), `parallel` (live K),
 * `add` (issues added to the batch by `--add`, #4408: a cumulative JSON set the runner re-reads every pass),
 * `requeue` (`--requeue`, #4550: a cumulative JSON list of `{issue, reason, by, at}` the runner applies once each, moving a terminal issue back to pending),
 * `hold` (issues held by `--hold`, #4592: a cumulative JSON set; the runner admits none of them until `--release` or a `--resume` names them),
 * `cancel` (`{at, reason}` written by `--cancel`, #4376: the runner stops admitting and stops its local lanes; a resume clears it),
 * `lanes/<issue>.{json,log}` (each lane's result and output) and `report.json` (the final rows and printed report, written
 * when the scheduler loop returns; `forgedock orchestrate --resume` on a finished batch replays it, #4192). Every write is tmp + fsync + rename, and the root must be
 * on disk, never tmpfs. A lane is its own session (`setsid` through `detached`), so killing the dispatcher leaves it
 * running; a resumed dispatcher re-attaches to it by pid, checking `/proc/<pid>/cmdline` against its result path. These
 * detached lanes are the `local` execution (#4253); `execution.mjs` is the sandbox-provider seam for remote lanes.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const RAM_FS = new Set(["tmpfs", "ramfs"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function batchRoot(env = process.env) {
  return env.FORGEDOCK_BATCH_DIR || join(homedir(), ".forge", "batches");
}

/** `[{mount, type}]` from /proc/self/mounts; empty when unreadable (non-Linux). */
export function readMounts(file = "/proc/self/mounts") {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
      const [, mount, type] = l.split(" ");
      return { mount: mount.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))), type };
    });
  } catch { return []; }
}

/** Filesystem type of the mount that holds `path` (longest mount-point prefix); null when unknown. */
export function fsTypeOf(path, mounts = readMounts()) {
  const p = resolve(path);
  let best = null;
  for (const m of mounts) {
    const under = m.mount === "/" || p === m.mount || p.startsWith(m.mount.endsWith(sep) ? m.mount : m.mount + sep);
    if (under && (!best || m.mount.length > best.mount.length)) best = m;
  }
  return best?.type ?? null;
}

/** Throws when `path` is on a RAM filesystem: a full tmpfs truncated an earlier state file to 0 bytes. */
export function assertDiskPath(path, mounts = readMounts()) {
  const type = fsTypeOf(path, mounts);
  if (RAM_FS.has(type)) throw new Error(`batch state must be on disk, but ${path} is on ${type}; set FORGEDOCK_BATCH_DIR to a disk path`);
}

/**
 * Write `data` to `file` atomically: a reader sees the old or the new content, never a truncated file.
 * `private` creates the file 0600 and its directory 0700 (batch state can hold pinned secrets, #4751).
 */
export function writeAtomic(file, data, { private: priv = false } = {}) {
  const dir = dirname(file);
  mkdirSync(dir, priv ? { recursive: true, mode: 0o700 } : { recursive: true });
  if (priv) chmodSync(dir, 0o700);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = priv ? openSync(tmp, "w", 0o600) : openSync(tmp, "w");
  try { if (priv) fchmodSync(fd, 0o600); writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** Env names whose values never reach batch state (#4787): tokens, keys, secrets and passwords. */
export const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|(^|_)KEY$)/i;

/** @returns {{env: object, names: string[]}} `env` without secret-named keys, and the dropped names (never values). */
export function scrubEnv(env) {
  if (!env || typeof env !== "object") return { env, names: [] };
  const names = Object.keys(env).filter((k) => SECRET_ENV.test(k)).sort();
  return { env: names.length ? Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k))) : env, names };
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

const readAdded = (file) => {
  const v = readJson(file);
  return Array.isArray(v) ? [...new Set(v.filter((n) => Number.isSafeInteger(n) && n > 0))].sort((a, b) => a - b) : [];
};

/** `outcome`s `--requeue` may move back to pending (#4550). */
export const REQUEUABLE = (outcome) => ["needs-human", "invalid", "skipped", "ci-pending", "budget-exceeded", "lane-refused"].includes(outcome) || /^dependency-/.test(String(outcome));
/** Key of one requeue entry; the runner records the applied keys in state.json `requeueApplied`. */
export const requeueKey = (e) => `${e.issue}@${e.at}`;

const readRequeueFile = (file) => {
  const v = readJson(file);
  return Array.isArray(v) ? v.filter((e) => e && Number.isSafeInteger(e.issue) && e.issue > 0 && typeof e.at === "string") : [];
};

/** The positive integers among `list` (numbers, `7`, `#7`). */
const ints = (list) => (Array.isArray(list) ? list : []).map((x) => (typeof x === "number" ? x : typeof x === "string" && /^#?\d+$/.test(x.trim()) ? parseInt(x.trim().replace("#", ""), 10) : NaN)).filter((n) => Number.isSafeInteger(n) && n > 0);

export function newBatchId(now = Date.now(), pid = process.pid) {
  return `b${new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${pid}`;
}

/** Ids of the batches under `root` (directories with a `plan.json`). */
export function listBatches(root) {
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter((n) => ID_RE.test(n) && existsSync(join(root, n, "plan.json"))).sort();
}

/** Handle on one batch directory. */
export function openBatch(root, id) {
  if (!ID_RE.test(String(id ?? ""))) throw new Error(`invalid batch id ${JSON.stringify(id)}`);
  const dir = join(root, id);
  const f = (name) => join(dir, name);
  const put = (file, data) => writeAtomic(file, data, { private: true });
  const self = {
    id, dir,
    exists: () => existsSync(f("plan.json")),
    readPlan: () => readJson(f("plan.json")),
    /** Secret-named `plan.env` keys are never written: their names go to `envSecrets`, the value is re-read from the environment on resume (#4787). */
    writePlan: (plan) => {
      const { env, names } = scrubEnv(plan?.env);
      const out = names.length ? { ...plan, env, envSecrets: [...new Set([...(plan.envSecrets ?? []), ...names])].sort() } : plan;
      put(f("plan.json"), JSON.stringify(out, null, 2) + "\n");
    },
    /** Rewrite an existing plan.json that holds secret env values (or is not 0600) as private and scrubbed; @returns the scrubbed names. */
    scrubPlan: () => {
      const plan = readJson(f("plan.json"));
      if (!plan) return [];
      const { names } = scrubEnv(plan.env);
      if (names.length) self.writePlan(plan);
      else { try { chmodSync(f("plan.json"), 0o600); } catch { /* best effort */ } }
      return names;
    },
    store: {
      load: () => readJson(f("state.json")),
      save: (state) => put(f("state.json"), JSON.stringify(state) + "\n"),
      log: (row) => { try { appendFileSync(f("log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", { mode: 0o600 }); } catch { /* the log is advisory */ } },
    },
    /** Live K: the `parallel` file, read on every scheduler pass; null when missing or invalid. */
    readParallel: () => { try { const k = parseInt(readFileSync(f("parallel"), "utf8"), 10); return Number.isInteger(k) && k >= 1 ? k : null; } catch { return null; } },
    setParallel: (k) => {
      if (!Number.isInteger(k) || k < 1) throw new Error("parallel must be a positive integer");
      put(f("parallel"), `${k}\n`);
    },
    /** Issues added by `--add` (#4408): the `add` file, sorted unique positive integers; [] when missing or invalid. */
    readAdded: () => readAdded(f("add")),
    /**
     * Merge `list` into the `add` file. Not a plain positive integer: skipped `not an integer`; already in state.json
     * `order`, in the file or earlier in `list`: skipped `already in batch`. @returns {{added:number[], skipped:Array<{issue, reason}>}}
     */
    addIssues: (list) => {
      const st = readJson(f("state.json")) ?? {};
      const have = new Set([...(st.order ?? []), ...readAdded(f("add"))]);
      const added = [], skipped = [], requeued = [];
      for (const x of Array.isArray(list) ? list : []) {
        const n = typeof x === "number" ? x : typeof x === "string" && /^#?\d+$/.test(x.trim()) ? parseInt(x.trim().replace("#", ""), 10) : NaN;
        if (!Number.isSafeInteger(n) || n < 1) { skipped.push({ issue: x, reason: "not an integer" }); continue; }
        // #4687/#4791: an issue skipped (a dependency ended) or lane-refused in the batch is re-queued, not refused; any other row is "already in batch"
        if (have.has(n) && ["skipped", "lane-refused"].includes(st.results?.[n]?.outcome) && !requeued.includes(n) && self.requeue([n], { reason: "--add", by: "operator" }).requeued.length) { requeued.push(n); continue; }
        if (have.has(n)) { skipped.push({ issue: n, reason: "already in batch" }); continue; }
        have.add(n); added.push(n);
      }
      if (added.length) put(f("add"), JSON.stringify([...new Set([...readAdded(f("add")), ...added])].sort((a, b) => a - b)) + "\n");
      return { added, skipped, requeued };
    },
    /**
     * `--requeue` (#4550): record that each issue returns to pending. Refused: not a positive integer, not in the batch's
     * `order`, no terminal result yet (`not terminal`), or already requeued and not yet applied. The needs-human label and
     * closed checks need GitHub and live in the CLI. @returns {{requeued:number[], refused:Array<{issue, reason}>}}
     */
    requeue: (list, { reason = "operator decision", by = "operator" } = {}) => {
      const st = readJson(f("state.json")) ?? {};
      const order = new Set(st.order ?? []), applied = new Set(st.requeueApplied ?? []);
      const entries = readRequeueFile(f("requeue"));
      const pend = new Set(entries.filter((e) => !applied.has(requeueKey(e))).map((e) => e.issue));
      const requeued = [], refused = [];
      for (const x of Array.isArray(list) ? list : []) {
        const n = typeof x === "number" ? x : typeof x === "string" && /^#?\d+$/.test(x.trim()) ? parseInt(x.trim().replace("#", ""), 10) : NaN;
        if (!Number.isSafeInteger(n) || n < 1) refused.push({ issue: x, reason: "not an integer" });
        else if (!order.has(n)) refused.push({ issue: n, reason: "not in batch" });
        else if (pend.has(n)) refused.push({ issue: n, reason: "already requeued" });
        else if (!REQUEUABLE(st.results?.[n]?.outcome)) refused.push({ issue: n, reason: "not terminal" });
        else { pend.add(n); requeued.push(n); }
      }
      if (requeued.length) {
        const at = new Date().toISOString();
        put(f("requeue"), JSON.stringify([...entries, ...requeued.map((issue) => ({ issue, reason: String(reason), by: String(by), at }))]) + "\n");
      }
      return { requeued, refused };
    },
    /** Every `--requeue` entry, in order; [] when missing or invalid. */
    readRequeued: () => readRequeueFile(f("requeue")),
    /** Entries the runner has not applied yet (a finished or unhosted batch with a pending requeue). */
    unrunRequeues: () => { const done = new Set(readJson(f("state.json"))?.requeueApplied ?? []); return readRequeueFile(f("requeue")).filter((e) => !done.has(requeueKey(e))); },
    /** Issues held by `--hold` (#4592): the `hold` file, sorted unique positive integers; [] when missing or invalid. */
    readHeld: () => readAdded(f("hold")),
    /** #4656: gates waiting on issues (`gates` file: [{ name, waitsOn: [n...], since? }], written by the ship/settle pre-flight); [] when missing or invalid. */
    readGates: () => { const v = readJson(f("gates")); return Array.isArray(v) ? v.filter((g) => g && typeof g.name === "string" && Array.isArray(g.waitsOn)) : []; },
    /** Merge the positive integers of `list` into the `hold` file. @returns {number[]} the issues newly held */
    holdIssues: (list) => {
      const have = new Set(readAdded(f("hold")));
      const added = [...new Set(ints(list))].filter((n) => !have.has(n)).sort((a, b) => a - b);
      if (added.length) put(f("hold"), JSON.stringify([...have, ...added].sort((a, b) => a - b)) + "\n");
      return added;
    },
    /** Remove `list` from the `hold` file. @returns {number[]} the issues that were held */
    releaseIssues: (list) => {
      const have = new Set(readAdded(f("hold")));
      const freed = [...new Set(ints(list))].filter((n) => have.has(n)).sort((a, b) => a - b);
      if (freed.length) put(f("hold"), JSON.stringify([...have].filter((n) => !freed.includes(n)).sort((a, b) => a - b)) + "\n");
      return freed;
    },
    /** `--cancel` (#4376): `{at, reason, stopRemote?}` in the `cancel` file; the runner re-reads it every pass. `stopRemote` (#4612) also asks remote lanes to stop at their checkpoint. */
    requestCancel: ({ reason = "operator", stopRemote = false } = {}) => put(f("cancel"), JSON.stringify({ at: new Date().toISOString(), reason: String(reason), ...(stopRemote === true ? { stopRemote: true } : {}) }) + "\n"),
    /** The cancel record, or null when missing or invalid. */
    readCancel: () => { const v = readJson(f("cancel")); return v && typeof v === "object" && !Array.isArray(v) && typeof v.at === "string" ? v : null; },
    clearCancel: () => rmSync(f("cancel"), { force: true }),
    /** Added issues the batch never took into its `order` (a finished or unhosted batch with pending adds). */
    unrunAdds: () => { const order = new Set(readJson(f("state.json"))?.order ?? []); return readAdded(f("add")).filter((n) => !order.has(n)); },
    /** The lane updates in `log.jsonl`, in order (unparsable lines skipped). */
    readLog: () => {
      let text = "";
      try { text = readFileSync(f("log.jsonl"), "utf8"); } catch { return []; }
      return text.split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
    },
    readReport: () => readJson(f("report.json")),
    writeReport: (report) => put(f("report.json"), JSON.stringify(report) + "\n"),
    clearReport: () => rmSync(f("report.json"), { force: true }),
    resultFile: (n) => f(join("lanes", `${n}.json`)),
    logFile: (n) => f(join("lanes", `${n}.log`)),
  };
  return self;
}

/** True when `pid` is alive and (where /proc exists) its command line names `marker`, so a reused pid is not adopted. */
export function isLaneAlive(pid, marker, { kill = process.kill.bind(process), procDir = "/proc" } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); } catch (e) { if (e?.code !== "EPERM") return false; }
  if (!existsSync(procDir)) return true;
  let cmd;
  try { cmd = readFileSync(join(procDir, String(pid), "cmdline"), "utf8"); } catch { return false; }
  if (marker && !cmd.split("\0").includes(marker)) return false;
  // A zombie (exited, not yet reaped: PID 1 may not reap) answers `kill(pid, 0)` but is not running.
  try { if (/^\d+ \(.*\) Z /s.test(readFileSync(join(procDir, String(pid), "stat"), "utf8"))) return false; } catch { /* no stat: treat as alive */ }
  return true;
}

/**
 * Start one lane in its own session: `<bin> <script> run-issue <issue> ...args --result-file <lanes/N.json>`, output to
 * `lanes/N.log`. A stale result from an earlier attempt is removed first. @returns {{pid:number}}
 */
export function launchLane({ batch, issue, args = [], bin = process.execPath, script, cwd = process.cwd(), env = process.env, spawnFn = spawn }) {
  const rf = batch.resultFile(issue);
  mkdirSync(dirname(rf), { recursive: true, mode: 0o700 });
  rmSync(rf, { force: true });
  const out = openSync(batch.logFile(issue), "a", 0o600);
  try {
    // FORGEDOCK_BATCH_ID names the lane's resource ledger dir (~/.forge/ledger/<batch>/, #4179).
    const child = spawnFn(bin, [script, "run-issue", String(issue), ...args, "--result-file", rf], { cwd, env: { ...env, FORGEDOCK_BATCH_ID: batch.id }, detached: true, windowsHide: true, stdio: ["ignore", out, out] });
    child.on?.("error", () => { /* surfaces as a dead pid without a result */ });
    child.unref?.();
    return { pid: child.pid };
  } finally { closeSync(out); }
}

/** Poll a lane until its result file appears; a lane that died without one is an engine-error. */
export async function waitLane({ batch, issue, pid, alive = isLaneAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 5000 }) {
  const rf = batch.resultFile(issue);
  for (;;) {
    const r = readJson(rf);
    if (r) return r;
    if (!alive(pid, rf)) {
      const last = readJson(rf); // it may have written the result just before exiting
      return last ?? { terminalReason: "engine-error", detail: `lane pid ${pid} exited without a result; see ${batch.logFile(issue)}` };
    }
    await sleep(pollMs);
  }
}

/**
 * Lane seams for `orchestrate()`: `runOne` launches a detached lane, `adopt` re-attaches to a live one (else null). A lane
 * that already ended resolves at once with its result file; a live one calls `ctx.onLive()` before it is awaited (#4504).
 */
export function detachedLanes({ batch, laneArgs, script, cwd, env, bin, alive = isLaneAlive, pollMs, spawnFn }) {
  return {
    runOne: async (n, lane, ctx = {}) => {
      const { pid } = launchLane({ batch, issue: n, args: laneArgs(n, lane), script, cwd, env, bin, spawnFn });
      ctx.onStart?.({ pid });
      return waitLane({ batch, issue: n, pid, alive, pollMs });
    },
    adopt: async (n, rec, ctx = {}) => {
      const rf = batch.resultFile(n);
      if (!existsSync(rf)) {
        if (!alive(rec.pid, rf)) return null;
        ctx.onLive?.();
      }
      return waitLane({ batch, issue: n, pid: rec.pid, alive, pollMs });
    },
  };
}
