import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { codedError } from "./config.mjs";

const APPEND_LOCK_TIMEOUT_MS = 30_000;
const OWNERLESS_LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 10;
const lockWait = new Int32Array(new SharedArrayBuffer(4));
const pendingReleases = new Map();
let pendingReleaseTimer;

function schedulePendingRelease(path, token, guard = false) {
  pendingReleases.set(path, { token, guard });
  if (pendingReleaseTimer) return;
  pendingReleaseTimer = setTimeout(() => {
    pendingReleaseTimer = undefined;
    for (const [pendingPath, pending] of [...pendingReleases]) {
      try {
        if (pending.guard) releaseGuardLock(pendingPath, pending.token);
        else releaseOwnedLock(pendingPath, pending.token);
      } catch {
        // Keep the entry for the next bounded retry.
      }
    }
    if (pendingReleases.size) {
      const [pendingPath, pending] = pendingReleases.entries().next().value;
      schedulePendingRelease(pendingPath, pending.token, pending.guard);
    }
  }, 100);
  pendingReleaseTimer.unref?.();
}

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
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null;
    throw error;
  }
  try {
    return JSON.parse(source);
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

function releaseMarkerPath(path, token) {
  return `${path}.released-${token}`;
}

function lockSnapshot(path) {
  const owner = readLockOwner(path);
  const released = owner?.token && readLockOwner(releaseMarkerPath(path, owner.token))?.token === owner.token;
  if (owner?.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
    return { identity: `owner:${owner.token || JSON.stringify(owner)}`, stale: released || processIsDead(owner.pid) };
  }
  if (owner) return { identity: `owner:${owner.token || JSON.stringify(owner)}`, stale: Boolean(released) };
  try {
    const stat = statSync(path);
    return {
      identity: `stat:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}`,
      stale: Date.now() - stat.mtimeMs >= OWNERLESS_LOCK_STALE_MS,
    };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}

function removeTemporaryFile(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      rmSync(path, { force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) return;
      Atomics.wait(lockWait, 0, 0, 1);
    }
  }
}

function publishLock(path, owner) {
  const candidatePath = `${path}.candidate-${process.pid}-${owner.token}-${randomUUID()}`;
  writeFileSync(candidatePath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
  let lastError;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        // A hard link publishes complete immutable owner metadata atomically and
        // never replaces an existing lock on POSIX or Windows.
        linkSync(candidatePath, path);
        return true;
      } catch (error) {
        if (error.code === "EEXIST") return false;
        if (!["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
        if (existsSync(path)) return false;
        lastError = error;
        Atomics.wait(lockWait, 0, 0, 1);
      }
    }
    throw lastError;
  } finally {
    removeTemporaryFile(candidatePath);
  }
}

function removeMatchingLock(path, identity) {
  let lastError;
  for (let attempt = 0; attempt < 1_000; attempt++) {
    try {
      if (lockSnapshot(path)?.identity !== identity) return false;
    } catch (error) {
      if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      lastError = error;
      Atomics.wait(lockWait, 0, 0, 1);
      continue;
    }
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      lastError = error;
      Atomics.wait(lockWait, 0, 0, 1);
    }
  }
  throw lastError;
}

function publishReleaseMarker(path, token) {
  const markerPath = releaseMarkerPath(path, token);
  const markerOwner = readLockOwner(markerPath);
  if (markerOwner?.token !== token && !publishLock(markerPath, {
    token,
    pid: process.pid,
    host: hostname(),
    acquiredAt: Date.now(),
  })) {
    if (readLockOwner(markerPath)?.token !== token) {
      throw codedError("OPENCODE_BATCH_LOCK_RELEASE", `Lock ${path} could not publish its release marker.`);
    }
  }
  return markerPath;
}

function releaseGuardLock(path, token) {
  try {
    publishReleaseMarker(path, token);
    pendingReleases.delete(path);
  } catch {
    schedulePendingRelease(path, token, true);
  }
}

function releaseOwnedLock(path, token) {
  const markerPath = releaseMarkerPath(path, token);
  if (readLockOwner(path)?.token !== token) {
    removeTemporaryFile(markerPath);
    pendingReleases.delete(path);
    return;
  }
  if (readLockOwner(markerPath)?.token !== token) {
    try {
      removeMatchingLock(path, `owner:${token}`);
      pendingReleases.delete(path);
      return;
    } catch {
      // Publish a durable handoff before allowing another process to reclaim.
    }
  }
  const releaseGuard = acquireReclaimGuard(path, `owner:${token}`);
  if (!releaseGuard) {
    throw codedError("OPENCODE_BATCH_LOCK_RELEASE", `Lock ${path} is already being released.`);
  }
  try {
    publishReleaseMarker(path, token);
    removeMatchingLock(path, `owner:${token}`);
    removeTemporaryFile(markerPath);
    pendingReleases.delete(path);
  } finally {
    releaseGuard();
  }
}

function releaseWithFallback(path, token) {
  try {
    releaseOwnedLock(path, token);
    return true;
  } catch {
    try {
      publishReleaseMarker(path, token);
    } catch {
      // Retry after the filesystem condition clears.
    }
    schedulePendingRelease(path, token);
    return false;
  }
}

function acquireReclaimGuard(path, identity) {
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  for (let generation = 1; generation <= 1_000;) {
    const guardPath = `${path}.reclaim-${key}-${generation}`;
    const guard = lockSnapshot(guardPath);
    if (guard) {
      if (!guard.stale) return null;
      generation++;
      continue;
    }
    const token = randomUUID();
    if (publishLock(guardPath, {
      token,
      pid: process.pid,
      host: hostname(),
      acquiredAt: Date.now(),
    })) return () => releaseGuardLock(guardPath, token);
  }
  return null;
}

function reclaimLock(path, expected) {
  let releaseGuard;
  try {
    const current = lockSnapshot(path);
    if (!current?.stale || current.identity !== expected.identity) return false;
    releaseGuard = acquireReclaimGuard(path, expected.identity);
    if (!releaseGuard) return false;
    const guarded = lockSnapshot(path);
    if (!guarded?.stale || guarded.identity !== expected.identity) return false;
    const removed = removeMatchingLock(path, expected.identity);
    if (removed && expected.identity.startsWith("owner:")) {
      removeTemporaryFile(releaseMarkerPath(path, expected.identity.slice("owner:".length)));
    }
    return removed;
  } catch (error) {
    if (["EBUSY", "EPERM", "EACCES"].includes(error.code)) return false;
    throw error;
  } finally {
    releaseGuard?.();
  }
}

function acquireLock(path, { timeoutMs, code, message }) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = pendingReleases.get(path);
  if (pending) {
    try {
      if (pending.guard) releaseGuardLock(path, pending.token);
      else releaseOwnedLock(path, pending.token);
    } catch {
      // The regular acquisition deadline handles peer-owned recovery.
    }
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = randomUUID();
    const owner = {
      token,
      pid: process.pid,
      host: hostname(),
      acquiredAt: Date.now(),
    };
    if (publishLock(path, owner)) {
      let released = false;
      return () => {
        if (released) return;
        released = releaseWithFallback(path, token);
      };
    }
    let observed;
    try {
      observed = lockSnapshot(path);
    } catch (error) {
      if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      if (Date.now() >= deadline) throw codedError(code, message);
      Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
      continue;
    }
    if (observed?.stale && reclaimLock(path, observed)) continue;
    if (Date.now() >= deadline) throw codedError(code, message);
    Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
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
