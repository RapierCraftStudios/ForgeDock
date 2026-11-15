// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock ci runner-health [--recover] [--json] [--repo owner/repo] [--print-units]` (#5693, parent #5687): health check and
 * watchdog recovery for the self-hosted GitHub Actions runner services on this host. No LLM anywhere.
 * - Findings: (a) a runner busy on a job whose run is completed/cancelled, (b) a runner service not active, (c) an orphaned runner
 *   container older than the job timeout, (d) disk free below `min_disk_gb` (default 10) or memory available below 1 GB.
 * - Events: each finding is POSTed best effort as a `runner_unhealthy` event (#5688 bus, via ci-emit createPoster).
 * - Recovery (`--recover`; the default is a dry run that prints the plan): restart only the affected runner's service for (a)/(b),
 *   `docker rm -f` only the orphaned containers for (c). Never reboots, never touches other services. At most one restart per
 *   service per 10 min (state file under the ci-budget cache dir). Every action is logged through `out`.
 * - Config (forge.yaml `ci`, one-level parser): `repo`, `services[]`, `min_disk_gb`, `recover`, `job_timeout_min` (default 360).
 *   A nested `runners:` object is read too. `recover: true` only makes the timer unit pass `--recover`.
 * Exit 1 when there is a finding. Every effect goes through the injected deps (gh, docker, systemctl, disk, memory, fetchImpl, now).
 */
import { readFileSync, writeFileSync, mkdirSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseForgeYaml } from "../forge-utils.mjs";
import { createPoster } from "./ci-emit.mjs";
import { cacheDir } from "./ci-budget.mjs";

export const RUNNER_HEALTH_USAGE = "usage: forgedock ci runner-health [--recover] [--json] [--repo owner/repo] [--print-units]";
export const DEFAULT_MIN_DISK_GB = 10, MIN_MEM_GB = 1, DEFAULT_JOB_TIMEOUT_MIN = 360, RESTART_COOLDOWN_MS = 10 * 60 * 1000;
const GB = 1024 ** 3;

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? [str(v)] : []);
const num = (v, d) => { const n = Number(str(v)); return str(v) && Number.isFinite(n) && n > 0 ? n : d; };

/** forge.yaml `ci` section -> {repo, services, minDiskGb, recover, jobTimeoutMin}; junk keeps the defaults. */
export function parseRunnerHealthConfig(cwd) {
  let sec = null;
  try { sec = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8"))?.ci; } catch { /* no forge.yaml: defaults */ }
  const base = sec && typeof sec === "object" ? sec : {};
  const s = base.runners && typeof base.runners === "object" ? { ...base, ...base.runners } : base;
  return {
    repo: str(s.repo), services: list(s.services), minDiskGb: num(s.min_disk_gb, DEFAULT_MIN_DISK_GB),
    recover: /^(true|yes|on|1)$/i.test(str(s.recover)), jobTimeoutMin: num(s.job_timeout_min, DEFAULT_JOB_TIMEOUT_MIN),
  };
}

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.error ? 127 : (r.status ?? 1), out: `${r.stdout ?? ""}`, err: `${r.stderr ?? ""}` };
};
const defaultDeps = {
  gh: async (args) => { const r = run("gh", args); if (r.code) throw new Error(r.err.trim() || `gh exit ${r.code}`); return r.out; },
  docker: async (args) => run("docker", args),
  systemctl: async (args) => run("systemctl", args),
  diskGb: () => { const s = statfsSync("/"); return (s.bavail * s.bsize) / GB; },
  memGb: () => { const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8")); return m ? (Number(m[1]) * 1024) / GB : Infinity; },
};

const finding = (kind, job, reason, extra = {}) => ({ kind, job, reason, ...extra });
const serviceFor = (runnerName, services) => services.find((s) => s.includes(`.${runnerName}.`) || s === runnerName || s === `${runnerName}.service`) ?? null;

/** (a): busy runners whose job sits in a completed/cancelled run. Needs the repo; a gh failure yields no (a) findings. */
async function stuckRunners({ gh, repo, services }) {
  const runners = JSON.parse(await gh(["api", `repos/${repo}/actions/runners`, "--paginate"])).runners ?? [];
  const busy = new Map(runners.filter((r) => r.busy).map((r) => [r.name, r]));
  if (!busy.size) return [];
  const runs = JSON.parse(await gh(["api", `repos/${repo}/actions/runs?per_page=50`])).workflow_runs ?? [];
  const out = [];
  for (const wr of runs) {
    if (!busy.size) break;
    if (wr.status !== "completed" && wr.conclusion !== "cancelled") continue;
    const jobs = JSON.parse(await gh(["api", `repos/${repo}/actions/runs/${wr.id}/jobs?filter=latest`])).jobs ?? [];
    for (const j of jobs) {
      if (j.status === "completed" || !busy.has(j.runner_name)) continue;
      const name = j.runner_name;
      out.push(finding("stuck-run", name, `runner ${name} busy on job ${j.id} of ${wr.conclusion ?? wr.status} run ${wr.id}`, { service: serviceFor(name, services), run_id: wr.id }));
      busy.delete(name);
    }
  }
  return out;
}

const parseCreated = (s) => Date.parse(str(s).replace(/\s+[A-Z]{2,5}$/, "").replace(/^(\S+) (\S+) ([+-]\d{4}).*$/, "$1T$2$3"));
const RUNNER_LABEL_RE = /actions[._]runner|github[._]actions|github[._]runner/i;

/** (c): runner-labelled containers created more than the job timeout ago. */
async function orphanContainers({ docker, timeoutMin, nowMs }) {
  const r = await docker(["ps", "--format", "{{json .}}"]);
  if (r.code) return [];
  const out = [];
  for (const line of r.out.split("\n").filter(Boolean)) {
    let c; try { c = JSON.parse(line); } catch { continue; }
    if (!RUNNER_LABEL_RE.test(str(c.Labels))) continue;
    const created = parseCreated(c.CreatedAt);
    if (Number.isFinite(created) && nowMs - created > timeoutMin * 60000) out.push(finding("orphan-container", str(c.ID), `container ${c.ID} older than ${timeoutMin} min job timeout`, { id: str(c.ID) }));
  }
  return out;
}

/** Detect (a)-(d); each detector failing on its own (gh down, no docker) is skipped, never thrown. */
export async function detectRunnerHealth(cfg, deps = {}) {
  const d = { ...defaultDeps, ...deps }, nowMs = (d.now ?? Date.now)();
  const findings = [], skipped = [];
  const guard = async (name, fn) => { try { findings.push(...await fn()); } catch (e) { skipped.push(`${name}: ${str(e.message).slice(0, 120)}`); } };
  if (cfg.repo) await guard("stuck-run", () => stuckRunners({ gh: d.gh, repo: cfg.repo, services: cfg.services }));
  else skipped.push("stuck-run: no repo configured");
  await guard("service", async () => {
    const out = [];
    for (const svc of cfg.services) {
      const r = await d.systemctl(["is-active", svc]);
      if (str(r.out) !== "active") out.push(finding("service-down", svc, `service ${svc} is ${str(r.out) || "not active"}`, { service: svc }));
    }
    return out;
  });
  await guard("orphan-container", () => orphanContainers({ docker: d.docker, timeoutMin: cfg.jobTimeoutMin, nowMs }));
  await guard("disk", async () => { const g = d.diskGb(); return g < cfg.minDiskGb ? [finding("low-disk", "host", `disk free ${g.toFixed(1)} GB < ${cfg.minDiskGb} GB`)] : []; });
  await guard("memory", async () => { const g = d.memGb(); return g < MIN_MEM_GB ? [finding("low-memory", "host", `memory available ${g.toFixed(2)} GB < ${MIN_MEM_GB} GB`)] : []; });
  return { findings, skipped };
}

/** Recovery plan: one restart per affected service (a)/(b), one rm per orphaned container (c). Disk and memory have no action. */
export function planRecovery(findings) {
  const plan = [], seen = new Set();
  for (const f of findings) {
    if ((f.kind === "stuck-run" || f.kind === "service-down") && f.service && !seen.has(f.service)) { seen.add(f.service); plan.push({ action: "restart", service: f.service, why: f.reason }); }
    if (f.kind === "orphan-container") plan.push({ action: "rm-container", id: f.id, why: f.reason });
  }
  return plan;
}

const stateFile = (dir) => join(dir, "runner-health-restarts.json");
const readState = (dir) => { try { return JSON.parse(readFileSync(stateFile(dir), "utf8")) ?? {}; } catch { return {}; } };

/** Executes the plan; returns one result line per step. Restarts honour the per-service cooldown. */
export async function applyRecovery(plan, { docker, systemctl, dir, nowMs, out }) {
  const state = readState(dir), results = [];
  for (const p of plan) {
    let msg;
    if (p.action === "restart") {
      const last = Number(state[p.service] ?? 0);
      if (nowMs - last < RESTART_COOLDOWN_MS) msg = `skip restart ${p.service}: restarted ${Math.round((nowMs - last) / 1000)} s ago (cooldown ${RESTART_COOLDOWN_MS / 60000} min)`;
      else {
        const r = await systemctl(["restart", p.service]);
        if (r.code === 0) { state[p.service] = nowMs; msg = `restarted ${p.service}`; } else msg = `restart ${p.service} failed (exit ${r.code})`;
      }
    } else {
      const r = await docker(["rm", "-f", p.id]);
      msg = r.code === 0 ? `removed container ${p.id}` : `remove container ${p.id} failed (exit ${r.code})`;
    }
    results.push({ ...p, result: msg });
    out(`recover: ${msg}`);
  }
  try { mkdirSync(dir, { recursive: true }); writeFileSync(stateFile(dir), JSON.stringify(state)); } catch { /* cache only */ }
  return results;
}

/** systemd oneshot service + 2 min timer that runs this check (the issuewatch-install.mjs renderWatchdog shape). */
export function renderRunnerHealthUnits({ node = process.execPath, cli = join(dirname(fileURLToPath(import.meta.url)), "..", "forgedock.mjs"), cwd = process.cwd(), recover = false } = {}) {
  const q = (s) => `"${String(s).replace(/(["\\])/g, "\\$1").replace(/[$%]/g, (c) => c + c)}"`;
  const service = `[Unit]
Description=forgedock ci runner-health

[Service]
Type=oneshot
WorkingDirectory=${cwd}
ExecStart=${[node, cli, "ci", "runner-health", ...(recover ? ["--recover"] : [])].map(q).join(" ")}
`;
  const timer = `[Unit]
Description=forgedock ci runner-health every 2 min

[Timer]
OnBootSec=60
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

/** `forgedock ci runner-health ...`; @returns the exit code (1 when anything is unhealthy). */
export async function ciRunnerHealthFromCli(argv, deps = {}) {
  const out = deps.out ?? ((l) => console.log(l)), cwd = deps.cwd ?? process.cwd(), env = deps.env ?? process.env;
  const valued = ["--repo"], flags = ["--recover", "--json", "--print-units"];
  const unknown = argv.find((a, i) => !flags.includes(a) && !valued.includes(a) && !valued.includes(argv[i - 1] ?? ""));
  if (unknown) throw new Error(`unknown argument ${unknown}; ${RUNNER_HEALTH_USAGE}`);
  const cfg = parseRunnerHealthConfig(cwd);
  const ri = argv.indexOf("--repo");
  if (ri >= 0) cfg.repo = str(argv[ri + 1]);
  else if (!cfg.repo) cfg.repo = str(env.GITHUB_REPOSITORY);
  if (argv.includes("--print-units")) {
    const u = renderRunnerHealthUnits({ cwd, recover: cfg.recover });
    out(`# forgedock-ci-runner-health.service\n${u.service}\n# forgedock-ci-runner-health.timer\n${u.timer}`);
    return 0;
  }
  const d = { ...defaultDeps, ...deps }, nowMs = (deps.now ?? Date.now)();
  const { findings, skipped } = await detectRunnerHealth(cfg, d);
  const poster = createPoster({ env, fetchImpl: deps.fetchImpl ?? globalThis.fetch, warn: deps.warn });
  for (const f of findings) {
    poster.post("runner_unhealthy", { repo: cfg.repo || "unknown", sha: "runner-health", run_id: String(f.run_id ?? "runner-health"), job: f.job, step: f.kind, class: "infra", lines: [f.reason] });
  }
  await poster.drain();
  const plan = planRecovery(findings);
  const doRecover = argv.includes("--recover");
  let actions = [];
  if (doRecover && plan.length) actions = await applyRecovery(plan, { docker: d.docker, systemctl: d.systemctl, dir: deps.dir ?? cacheDir(env), nowMs, out });
  if (argv.includes("--json")) out(JSON.stringify({ ok: !findings.length, findings, skipped, plan: doRecover ? undefined : plan, actions: doRecover ? actions : undefined }));
  else {
    for (const f of findings) out(`UNHEALTHY ${f.kind} ${f.job}: ${f.reason}`);
    for (const s of skipped) out(`SKIP ${s}`);
    if (!doRecover) for (const p of plan) out(`plan (dry run, pass --recover to act): ${p.action} ${p.service ?? p.id}`);
    out(`runner-health: ${findings.length ? `${findings.length} finding(s)` : "healthy"}`);
  }
  return findings.length ? 1 : 0;
}

