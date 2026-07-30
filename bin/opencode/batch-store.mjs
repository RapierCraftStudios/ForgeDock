import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { codedError } from "./config.mjs";

const APPEND_LOCK_TIMEOUT_MS = 30_000;
const OWNERLESS_LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 10;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

function safeRepo(repo) {
  return String(repo).replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function newBatchId(repo, query, now = Date.now()) {
  const timestamp = new Date(now).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const digest = createHash("sha256").update(`${repo}\0${query}\0${randomUUID()}`).digest("hex").slice(0, 10);
  return `${timestamp}-${digest}`;
}

export function batchDirectory(repo, batchId, root = join(homedir(), ".forge", "batches")) {
  if (!/^[A-Za-z0-9._-]+$/.test(batchId || "")) {
    throw codedError("OPENCODE_BATCH_INVALID", `Invalid batch id: ${batchId}`);
  }
  return resolve(root, safeRepo(repo), batchId);
}

function atomicText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, "utf8");
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function atomicJson(path, value) {
  atomicText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function batchPlanDigest(plan) {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

function readLockOwner(path) {
  try {
    return JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function processIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function lockSnapshot(path) {
  const owner = readLockOwner(path);
  if (owner?.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
    return { identity: `owner:${owner.token || JSON.stringify(owner)}`, stale: processIsDead(owner.pid) };
  }
  if (owner) return { identity: `owner:${owner.token || JSON.stringify(owner)}`, stale: false };
  try {
    const stat = statSync(path);
    return {
      identity: `stat:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}`,
      stale: Date.now() - stat.mtimeMs >= OWNERLESS_LOCK_STALE_MS,
    };
  } catch {
    return null;
  }
}

function restoreQuarantinedLock(path, quarantinePath) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      renameSync(quarantinePath, path);
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (!["EEXIST", "ENOTEMPTY", "EBUSY", "EPERM"].includes(error.code)) throw error;
      Atomics.wait(lockWait, 0, 0, 1);
    }
  }
}

function recoverQuarantine(path, quarantinePath) {
  if (!existsSync(quarantinePath)) return false;
  if (!existsSync(path)) {
    try {
      renameSync(quarantinePath, path);
      return true;
    } catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY", "EBUSY", "EPERM"].includes(error.code)) return false;
      throw error;
    }
  }
  const quarantined = lockSnapshot(quarantinePath);
  if (!quarantined?.stale) return false;
  rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function reclaimLock(path, expected, quarantinePath) {
  try {
    renameSync(path, quarantinePath);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY", "EBUSY", "EPERM"].includes(error.code)) return false;
    throw error;
  }
  const moved = lockSnapshot(quarantinePath);
  if (!moved || moved.identity !== expected.identity || !moved.stale) {
    restoreQuarantinedLock(path, quarantinePath);
    return false;
  }
  rmSync(quarantinePath, { recursive: true, force: true });
  return true;
}

function removeOwnedLock(path, token) {
  if (readLockOwner(path)?.token === token) rmSync(path, { recursive: true, force: true });
}

function acquireLock(path, { timeoutMs, code, message }) {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const quarantinePath = `${path}.reclaiming`;
  for (;;) {
    if (existsSync(quarantinePath)) {
      if (recoverQuarantine(path, quarantinePath)) continue;
      if (Date.now() >= deadline) throw codedError(code, message);
      Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
      continue;
    }
    const token = randomUUID();
    const candidatePath = `${path}.candidate-${process.pid}-${token}`;
    try {
      mkdirSync(candidatePath);
      try {
        writeFileSync(join(candidatePath, "owner.json"), `${JSON.stringify({
          token,
          pid: process.pid,
          host: hostname(),
          acquiredAt: Date.now(),
        })}\n`, "utf8");
        renameSync(candidatePath, path);
      } catch (error) {
        rmSync(candidatePath, { recursive: true, force: true });
        if (existsSync(path) || ["EEXIST", "ENOTEMPTY", "EBUSY", "EPERM"].includes(error.code)) error.code = "EEXIST";
        throw error;
      }
      if (existsSync(quarantinePath)) {
        removeOwnedLock(path, token);
        continue;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        removeOwnedLock(path, token);
        removeOwnedLock(quarantinePath, token);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const observed = lockSnapshot(path);
      if (observed?.stale && reclaimLock(path, observed, quarantinePath)) continue;
      if (Date.now() >= deadline) throw codedError(code, message);
      Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
    }
  }
}

export function createBatchStore({ repo, batchId, root } = {}) {
  const directory = batchDirectory(repo, batchId, root);
  const planPath = join(directory, "plan.json");
  const eventPath = join(directory, "events.jsonl");
  const leasePath = join(directory, "scheduler.lease");
  const appendLockPath = join(directory, "events.lock");
  return {
    directory,
    planPath,
    eventPath,
    leasePath,
    writePlan(plan) {
      if (existsSync(planPath)) throw codedError("OPENCODE_BATCH_EXISTS", `Batch ${batchId} already exists.`);
      atomicJson(planPath, plan);
    },
    readPlan() {
      if (!existsSync(planPath)) throw codedError("OPENCODE_BATCH_NOT_FOUND", `Batch ${batchId} has no persisted plan.`);
      try {
        return JSON.parse(readFileSync(planPath, "utf8"));
      } catch {
        throw codedError("OPENCODE_BATCH_CORRUPT", `Batch ${batchId} plan is not valid JSON.`);
      }
    },
    append(event) {
      const release = acquireLock(appendLockPath, {
        timeoutMs: APPEND_LOCK_TIMEOUT_MS,
        code: "OPENCODE_BATCH_BUSY",
        message: `Batch ${batchId} event log is busy; retry shortly.`,
      });
      try {
        const events = this.readEvents();
        if (existsSync(eventPath)) {
          const raw = readFileSync(eventPath, "utf8");
          const last = raw.split(/\r?\n/).filter((line) => line.trim()).at(-1);
          let repair = Boolean(raw) && !raw.endsWith("\n");
          if (last) {
            try {
              JSON.parse(last);
            } catch {
              repair = true;
            }
          }
          if (repair) {
            atomicText(eventPath, events.length ? `${events.map((item) => JSON.stringify(item)).join("\n")}\n` : "");
          }
        }
        const priorSeq = Number(events.at(-1)?.seq);
        const seq = Number.isInteger(priorSeq) && priorSeq >= 0 ? priorSeq + 1 : events.length + 1;
        appendFileSync(eventPath, `${JSON.stringify({ ...event, seq, at: Date.now() })}\n`, "utf8");
      } finally {
        release();
      }
    },
    readEvents() {
      if (!existsSync(eventPath)) return [];
      const lines = readFileSync(eventPath, "utf8").split(/\r?\n/);
      while (lines.length && !lines.at(-1).trim()) lines.pop();
      const events = [];
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        let event;
        try {
          event = JSON.parse(lines[index]);
        } catch {
          if (index === lines.length - 1) break;
          throw codedError("OPENCODE_BATCH_CORRUPT", `Batch ${batchId} event ${index + 1} is corrupt.`);
        }
        if (!Number.isInteger(event.seq) || event.seq !== events.length + 1) {
          throw codedError("OPENCODE_BATCH_CORRUPT", `Batch ${batchId} event ${index + 1} has an invalid sequence.`);
        }
        events.push(event);
      }
      return events;
    },
    acquireLease() {
      return acquireLock(leasePath, {
        timeoutMs: 0,
        code: "OPENCODE_BATCH_BUSY",
        message: `Batch ${batchId} already has an active scheduler; wait for it to finish or recover after it exits.`,
      });
    },
  };
}
