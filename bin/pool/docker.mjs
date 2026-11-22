// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/** #5757: work-dir and cache sweeps walk big trees (node_modules): 10 min, not the 120 s of a small rm. */
export const SWEEP_TIMEOUT_MS = 10 * 60000;
const SWEEP_SRC = new URL("./cache-sweep.mjs", import.meta.url);

function docker(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr ?? "").slice(0, 2000); reject(err); } else resolve(String(stdout).trim());
    });
  });
}

/** The docker CLI operations the agent needs; swapped for a fake in tests. */
export const dockerCli = {
  async run(args) { return docker(["run", "-d", ...args]); },
  async inspect(name) {
    try {
      const out = await docker(["inspect", "--format", "{{json .State}}", name], { timeoutMs: 20000 });
      const s = JSON.parse(out);
      return { running: Boolean(s.Running), exitCode: s.ExitCode, startedAt: s.StartedAt, finishedAt: s.FinishedAt };
    } catch (e) {
      if (/No such (object|container)/i.test(e.stderr ?? "")) return null;
      throw e;
    }
  },
  async remove(name) { try { await docker(["rm", "-f", "-v", name], { timeoutMs: 60000 }); } catch (e) { if (!/No such container/i.test(e.stderr ?? "")) throw e; } },
  /** Signal the container's main process (the lane). False when the container is gone or already stopped. */
  async kill(name, signal = "TERM") {
    try { await docker(["kill", `--signal=${signal}`, name], { timeoutMs: 20000 }); return true; }
    catch (e) { if (/No such container|is not running/i.test(e.stderr ?? "")) return false; throw e; }
  },
  /** #5856: re-weights a running container (throttle/unthrottle a borrowed lane); a gone container is not an error. */
  async update(name, { cpuShares, memoryReservationMb }) { try { await docker(["update", "--cpu-shares", String(cpuShares), ...(memoryReservationMb ? ["--memory-reservation", `${memoryReservationMb}m`] : []), name], { timeoutMs: 20000 }); } catch (e) { if (!/No such container/i.test(e.stderr ?? "")) throw e; } },
  async listLabelled(label) {
    const out = await docker(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"], { timeoutMs: 20000 });
    return out ? out.split("\n").filter(Boolean) : [];
  },
  async removeVolume(name) { try { await docker(["volume", "rm", "-f", name], { timeoutMs: 120000 }); } catch (e) { if (!/no such volume/i.test(e.stderr ?? "")) throw e; } },
  async listVolumes(prefix) {
    const out = await docker(["volume", "ls", "-q", "--filter", `name=${prefix}`], { timeoutMs: 20000 });
    return out ? out.split("\n").filter((v) => v.startsWith(prefix)) : [];
  },
  /** Local image refs (`repo:tag`) starting with prefix; untagged images are skipped. */
  async listImages(prefix) {
    const out = await docker(["images", "--format", "{{.Repository}}:{{.Tag}}"], { timeoutMs: 30000 });
    return [...new Set(out ? out.split("\n").filter((t) => t.startsWith(prefix) && !t.endsWith(":<none>")) : [])];
  },
  async removeImage(tag) { try { await docker(["rmi", tag], { timeoutMs: 120000 }); } catch (e) { if (!/no such image/i.test(e.stderr ?? "")) throw e; } },
  /** Image refs of every container, running or exited (a ref in use must never be removed). */
  async listContainerImages() {
    const out = await docker(["ps", "-a", "--format", "{{.Image}}"], { timeoutMs: 30000 });
    return out ? [...new Set(out.split("\n").filter(Boolean))] : [];
  },
  async builderPrune(keepGb) { return docker(["builder", "prune", "-f", "--keep-storage", `${keepGb}gb`], { timeoutMs: 10 * 60000 }); },
  /** Volumes no container references (anonymous ones are named by 64 hex chars). */
  async listDanglingVolumes() {
    const out = await docker(["volume", "ls", "-q", "--filter", "dangling=true"], { timeoutMs: 30000 });
    return out ? out.split("\n").filter(Boolean) : [];
  },
  async pull(image) { return docker(["pull", "-q", image], { timeoutMs: 30 * 60000 }); },
  async load(file) { return docker(["load", "-q", "-i", file], { timeoutMs: 30 * 60000 }); },
  async hasImage(ref) { try { await docker(["image", "inspect", ref], { timeoutMs: 20000 }); return true; } catch { return false; } },
  /** {name: {cpu (cores), mem_gb}} for running containers with the label. */
  async stats(label) {
    const names = await this.listLabelled(label);
    if (!names.length) return {};
    const out = await docker(["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}", ...names], { timeoutMs: 60000 });
    const unit = { b: 1 / 2 ** 30, kib: 1 / 2 ** 20, mib: 1 / 2 ** 10, gib: 1, kb: 1e3 / 2 ** 30, mb: 1e6 / 2 ** 30, gb: 1e9 / 2 ** 30 };
    const res = {};
    for (const line of out.split("\n").filter(Boolean)) {
      const [name, cpu, mem] = line.split("\t");
      const m = /([\d.]+)\s*([a-zA-Z]+)/.exec(mem ?? "");
      res[name] = { cpu: (parseFloat(cpu) || 0) / 100, mem_gb: m ? parseFloat(m[1]) * (unit[m[2].toLowerCase()] ?? 0) : 0 };
    }
    return res;
  },
  async build(dir, tag, buildArgs = {}) { return docker(["build", "-q", "-t", tag, ...Object.entries(buildArgs).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]), dir], { timeoutMs: 45 * 60000 }); },
  /** #5696: removes one lane worktree (/cache/work/<id>) from a cache volume. */
  async removeWorkDir(volume, image, workDir) { await docker(["run", "--rm", "--network", "none", "-v", `${volume}:/cache`, "--entrypoint", "sh", image, "-c", 'rm -rf -- "$1"', "sh", workDir], { timeoutMs: SWEEP_TIMEOUT_MS }); },
  /** #5696: removes every /cache/work/* dir of a cache volume except the kept ones (full paths). */
  async pruneWorkDirs(volume, image, keep) {
    const script = 'for d in /cache/work/* /cache/work/.[!.]*; do [ -e "$d" ] || continue; for k in "$@"; do [ "$d" = "$k" ] && continue 2; done; rm -rf -- "$d"; done';
    await docker(["run", "--rm", "--network", "none", "-v", `${volume}:/cache`, "--entrypoint", "sh", image, "-c", script, "sh", ...keep], { timeoutMs: SWEEP_TIMEOUT_MS });
  },
  /** #5757: creates a volume carrying labels (idempotent: an existing volume keeps its labels). */
  async createVolume(name, labels = []) { await docker(["volume", "create", ...labels.flatMap((l) => ["--label", l]), name], { timeoutMs: 20000 }); },
  /** #5757: runs the in-volume cache sweep (bin/pool/cache-sweep.mjs) in a lane-image container; resolves its JSON result, rejects on failure or timeout. */
  async sweepCache(volume, image, opts) {
    const out = await docker(["run", "--rm", "--network", "none", "-v", `${volume}:/cache`, "-e", `CS_CACHE_SWEEP_OPTS=${JSON.stringify(opts)}`, "-e", `CS_CACHE_SWEEP_SRC=${readFileSync(SWEEP_SRC, "utf8")}`, "--entrypoint", "sh", image, "-c", 'printf %s "$CS_CACHE_SWEEP_SRC" > /tmp/cache-sweep.mjs && exec node /tmp/cache-sweep.mjs'], { timeoutMs: SWEEP_TIMEOUT_MS });
    return JSON.parse(out.split("\n").filter(Boolean).pop());
  },
  /** Removes files the root-owned lane container wrote into a bind mount, using the lane image itself. */
  async wipe(dir, image) { await docker(["run", "--rm", "--network", "none", "-v", `${dir}:/d`, "--entrypoint", "sh", image, "-c", "rm -rf /d/* /d/.[!.]* 2>/dev/null; true"], { timeoutMs: 120000 }); },
};
