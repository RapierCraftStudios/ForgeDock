// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Durable batch state and detached lanes for `forgedock orchestrate` (#4121).
 *
 * A batch lives in `~/.forge/batches/<id>/` (or `FORGEDOCK_BATCH_DIR`): `plan.json` (the command), `state.json` (the
 * scheduler state, rewritten after every transition), `log.jsonl` (one line per lane update), `parallel` (live K),
 * `lanes/<issue>.{json,log}` (each lane's result and output) and `report.json` (the final rows and printed report, written
 * when the scheduler loop returns; `forgedock orchestrate --resume` on a finished batch replays it, #4192). Every write is tmp + fsync + rename, and the root must be
 * on disk, never tmpfs. A lane is its own session (`setsid` through `detached`), so killing the dispatcher leaves it
 * running; a resumed dispatcher re-attaches to it by pid, checking `/proc/<pid>/cmdline` against its result path. These
 * detached lanes are the `local` execution (#4253); `execution.mjs` is the sandbox-provider seam for remote lanes.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
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

/** Write `data` to `file` atomically: a reader sees the old or the new content, never a truncated file. */
export function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

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
  return {
    id, dir,
    exists: () => existsSync(f("plan.json")),
    readPlan: () => readJson(f("plan.json")),
    writePlan: (plan) => writeAtomic(f("plan.json"), JSON.stringify(plan, null, 2) + "\n"),
    store: {
      load: () => readJson(f("state.json")),
      save: (state) => writeAtomic(f("state.json"), JSON.stringify(state) + "\n"),
      log: (row) => { try { appendFileSync(f("log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n"); } catch { /* the log is advisory */ } },
    },
    /** Live K: the `parallel` file, read on every scheduler pass; null when missing or invalid. */
    readParallel: () => { try { const k = parseInt(readFileSync(f("parallel"), "utf8"), 10); return Number.isInteger(k) && k >= 1 ? k : null; } catch { return null; } },
    setParallel: (k) => {
      if (!Number.isInteger(k) || k < 1) throw new Error("parallel must be a positive integer");
      writeAtomic(f("parallel"), `${k}\n`);
    },
    /** The lane updates in `log.jsonl`, in order (unparsable lines skipped). */
    readLog: () => {
      let text = "";
      try { text = readFileSync(f("log.jsonl"), "utf8"); } catch { return []; }
      return text.split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
    },
    readReport: () => readJson(f("report.json")),
    writeReport: (report) => writeAtomic(f("report.json"), JSON.stringify(report) + "\n"),
    clearReport: () => rmSync(f("report.json"), { force: true }),
    resultFile: (n) => f(join("lanes", `${n}.json`)),
    logFile: (n) => f(join("lanes", `${n}.log`)),
  };
}

/** True when `pid` is alive and (where /proc exists) its command line names `marker`, so a reused pid is not adopted. */
export function isLaneAlive(pid, marker, { kill = process.kill.bind(process), procDir = "/proc" } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); } catch (e) { if (e?.code !== "EPERM") return false; }
  if (!existsSync(procDir)) return true;
  let cmd;
  try { cmd = readFileSync(join(procDir, String(pid), "cmdline"), "utf8"); } catch { return false; }
  return !marker || cmd.split("\0").includes(marker);
}

/**
 * Start one lane in its own session: `<bin> <script> run-issue <issue> ...args --result-file <lanes/N.json>`, output to
 * `lanes/N.log`. A stale result from an earlier attempt is removed first. @returns {{pid:number}}
 */
export function launchLane({ batch, issue, args = [], bin = process.execPath, script, cwd = process.cwd(), env = process.env, spawnFn = spawn }) {
  const rf = batch.resultFile(issue);
  mkdirSync(dirname(rf), { recursive: true });
  rmSync(rf, { force: true });
  const out = openSync(batch.logFile(issue), "a");
  try {
    // FORGEDOCK_BATCH_ID names the lane's resource ledger dir (~/.forge/ledger/<batch>/, #4179).
    const child = spawnFn(bin, [script, "run-issue", String(issue), ...args, "--result-file", rf], { cwd, env: { ...env, FORGEDOCK_BATCH_ID: batch.id }, detached: true, stdio: ["ignore", out, out] });
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

/** Lane seams for `orchestrate()`: `runOne` launches a detached lane, `adopt` re-attaches to a live one (else null). */
export function detachedLanes({ batch, laneArgs, script, cwd, env, bin, alive = isLaneAlive, pollMs, spawnFn }) {
  return {
    runOne: async (n, lane, ctx = {}) => {
      const { pid } = launchLane({ batch, issue: n, args: laneArgs(n, lane), script, cwd, env, bin, spawnFn });
      ctx.onStart?.({ pid });
      return waitLane({ batch, issue: n, pid, alive, pollMs });
    },
    adopt: async (n, rec) => {
      const rf = batch.resultFile(n);
      if (!existsSync(rf) && !alive(rec.pid, rf)) return null;
      return waitLane({ batch, issue: n, pid: rec.pid, alive, pollMs });
    },
  };
}
