// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from "node:child_process";

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
  async listLabelled(label) {
    const out = await docker(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"], { timeoutMs: 20000 });
    return out ? out.split("\n").filter(Boolean) : [];
  },
  async removeVolume(name) { try { await docker(["volume", "rm", "-f", name], { timeoutMs: 120000 }); } catch (e) { if (!/no such volume/i.test(e.stderr ?? "")) throw e; } },
  async listVolumes(prefix) {
    const out = await docker(["volume", "ls", "-q", "--filter", `name=${prefix}`], { timeoutMs: 20000 });
    return out ? out.split("\n").filter((v) => v.startsWith(prefix)) : [];
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
  /** Removes files the root-owned lane container wrote into a bind mount, using the lane image itself. */
  async wipe(dir, image) { await docker(["run", "--rm", "--network", "none", "-v", `${dir}:/d`, "--entrypoint", "sh", image, "-c", "rm -rf /d/* /d/.[!.]* 2>/dev/null; true"], { timeoutMs: 120000 }); },
};
